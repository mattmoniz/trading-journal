// Weekly scorecard for the live ML checkpoint on trades it never saw (docs/ROSTER_SELECTION_AND_ML_SCORECARD_PREREG_20261021.md, Part 2).
// Stores one performance_audit row (signal_type 'ML_UNSEEN_SCORECARD'). Gate rule (frozen): the ML may be PROPOSED for a gating role only if, in two consecutive weekly runs,
// (a) >= 20 distinct unseen days, (b) policy minus random approval has its day-blocked 95% interval above zero, (c) the score-vs-P&L Spearman correlation has its day-blocked interval above zero.
// When that happens an OPEN_DECISION is flagged for the user. This script never changes any live behavior.
import { query } from '../server/db.js';
import { mulberry32, hashSeed } from '../server/services/rigorDiagnostics.js';
import { flagDecision } from './flag_decision.mjs';
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const rank = (a) => { const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length); let i = 0; while (i < idx.length) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const avg = (i + j) / 2; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1; } return r; };
const spearman = (x, y) => { const rx = rank(x), ry = rank(y), mx = mean(rx), my = mean(ry); let n = 0, dx = 0, dy = 0; for (let i = 0; i < rx.length; i++) { n += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; } return n / Math.sqrt(dx * dy); };
async function main() {
  const today = (await query(`SELECT CURRENT_DATE::text AS d`)).rows[0].d;   // trading-day date from the database (America/New_York), never JS toISOString
  const ck = process.env.SCORECARD_MODEL ? (await query(`SELECT model_version, trained_at::text t FROM ml_models WHERE model_version=$1`, [process.env.SCORECARD_MODEL])).rows[0]
    : (await query(`SELECT model_version, trained_at::text t FROM ml_models WHERE is_checkpoint ORDER BY trained_at DESC LIMIT 1`)).rows[0];   // SCORECARD_MODEL: test/backfill against another model; use with --dry
  if (!ck) throw new Error('no checkpoint model');
  const rows = (await query(`SELECT a.trade_date::text d, a.is_rth, a.actual_pnl::float p, v.verdict, v.probability::float prob FROM ml_verdicts v JOIN active_setups a ON a.id = v.active_setup_id
    WHERE v.model_version = $1 AND a.fired_at >= $2::timestamp + interval '3 days' AND a.origin_status IN ('ACTIVE','SHADOW') AND a.is_cluster_primary IS NOT FALSE AND a.actual_pnl IS NOT NULL
      AND a.ib_window_stale_basis IS NOT TRUE AND a.stale_entry_price_basis IS NOT TRUE AND a.late_fill_past_expiry_basis IS NOT TRUE AND a.bad_bars_basis IS NOT TRUE AND a.resolution IS DISTINCT FROM 'NOT_FILLED'
      AND NOT (a.fired_at::time >= '16:00' AND a.fired_at::time < '18:00')`, [ck.model_version, ck.t])).rows;
  const days = new Set(rows.map((r) => r.d)).size;
  const base = { checkpoint: ck.model_version, trained_at: ck.t, unseen_trades: rows.length, unseen_days: days };
  let notes;
  if (rows.length < 100) notes = { ...base, pass: false, reason: 'too few unseen trades' };
  else {
    const take = rows.filter((r) => r.verdict === 'TAKE'), frac = take.length / rows.length, all = mean(rows.map((r) => r.p));
    const byDay = new Map(); rows.forEach((r, i) => (byDay.get(r.d) || byDay.set(r.d, []).get(r.d)).push(i));
    const dayKeys = [...byDay.keys()], rng = mulberry32(hashSeed('mlscore' + ck.model_version + days));
    const g = (r) => (r.verdict === 'TAKE' ? r.p : 0) - frac * r.p; const diffs = [], rhos = [];
    for (let b = 0; b < 1000; b++) { const idx = []; for (let k = 0; k < dayKeys.length; k++) idx.push(...byDay.get(dayKeys[Math.floor(rng() * dayKeys.length)])); diffs.push(mean(idx.map((i) => g(rows[i])))); rhos.push(spearman(idx.map((i) => rows[i].prob), idx.map((i) => rows[i].p))); }
    diffs.sort((a, b) => a - b); rhos.sort((a, b) => a - b); const lo = (a) => a[Math.floor(0.025 * a.length)], hi = (a) => a[Math.floor(0.975 * a.length)];
    const rho = spearman(rows.map((r) => r.prob), rows.map((r) => r.p)); const polMinusRand = mean(rows.map(g));
    const pass = days >= 20 && lo(diffs) > 0 && lo(rhos) > 0;
    notes = { ...base, take_share: +frac.toFixed(3), take_all_mean: +all.toFixed(2), take_mean: +mean(take.map((r) => r.p)).toFixed(2), veto_mean: +mean(rows.filter((r) => r.verdict !== 'TAKE').map((r) => r.p)).toFixed(2), policy_minus_random: +polMinusRand.toFixed(2), policy_minus_random_ci: [+lo(diffs).toFixed(2), +hi(diffs).toFixed(2)], spearman: +rho.toFixed(3), spearman_ci: [+lo(rhos).toFixed(3), +hi(rhos).toFixed(3)], pass };
  }
  // INFORMATIONAL per-session split (added 2026-10-25): the unseen-trade evidence so far has the gate helping RTH and hurting Globex, consistent with the documented RTH->Globex sign reversal.
  // Not part of the frozen gate rule (pass/fail above is unchanged); it only accrues forward evidence for a possible RTH-only scope.
  if (rows.length >= 100) {
    const sessionStat = (sub) => {
      if (sub.length < 30) return { n: sub.length, note: 'too few' };
      const take = sub.filter((r) => r.verdict === 'TAKE'), frac = take.length / sub.length, g2 = (r) => (r.verdict === 'TAKE' ? r.p : 0) - frac * r.p;
      const bd = new Map(); sub.forEach((r, i) => (bd.get(r.d) || bd.set(r.d, []).get(r.d)).push(i)); const dk = [...bd.keys()], rg = mulberry32(hashSeed('mlscore-session' + ck.model_version + sub.length)), ds = [];
      for (let b = 0; b < 1000; b++) { const idx = []; for (let k = 0; k < dk.length; k++) idx.push(...bd.get(dk[Math.floor(rg() * dk.length)])); ds.push(mean(idx.map((i) => g2(sub[i])))); }
      ds.sort((x, y) => x - y);
      return { n: sub.length, days: dk.length, take_share: +frac.toFixed(3), take_all_mean: +mean(sub.map((r) => r.p)).toFixed(2), take_mean: take.length ? +mean(take.map((r) => r.p)).toFixed(2) : null, policy_minus_random: +mean(sub.map(g2)).toFixed(2), policy_minus_random_ci: [+ds[Math.floor(0.025 * ds.length)].toFixed(2), +ds[Math.floor(0.975 * ds.length)].toFixed(2)] };
    };
    notes.by_session = { RTH: sessionStat(rows.filter((r) => r.is_rth === true)), GLOBEX: sessionStat(rows.filter((r) => r.is_rth !== true)) };
  }
  if (process.argv.includes('--dry')) { console.log('DRY', JSON.stringify(notes)); return; }
  await query(`INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, notes) VALUES (CURRENT_DATE, 1, 'ML_UNSEEN_SCORECARD', 'LATEST', $1, $2) ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET notes = EXCLUDED.notes, sample_size = EXCLUDED.sample_size`, [rows.length, JSON.stringify(notes)]);
  console.log('ML_UNSEEN_SCORECARD', JSON.stringify(notes));
  if (notes.pass) {
    const prev = (await query(`SELECT notes FROM performance_audit WHERE signal_type='ML_UNSEEN_SCORECARD' AND signal_name='LATEST' AND run_date < CURRENT_DATE ORDER BY run_date DESC LIMIT 1`)).rows[0];
    const p = prev ? (typeof prev.notes === 'string' ? JSON.parse(prev.notes) : prev.notes) : null;
    if (p?.pass && p.checkpoint === ck.model_version) { await flagDecision({ slug: `ml_gate_rule_passed_${today.replace(/-/g, '')}`, sourceFile: 'scripts/ml_unseen_scorecard.mjs', sourceDate: today, priority: 'MEDIUM', decisionText: `The standing ML gate rule passed in two consecutive weekly scorecards for checkpoint ${ck.model_version}: on ${rows.length} unseen trades over ${days} days, policy minus random approval ${notes.policy_minus_random} (95% ${notes.policy_minus_random_ci}) and score-P&L Spearman ${notes.spearman} (95% ${notes.spearman_ci}). Decision for the user: whether to give the ML any gating role (it is log-only today); nothing changes automatically. See docs/ROSTER_SELECTION_AND_ML_SCORECARD_PREREG_20261021.md.` }); console.log('gate rule passed twice: decision flagged'); }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
