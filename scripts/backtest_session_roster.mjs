// Walk-forward: the live roster rule applied per (setup type, SESSION) instead of per setup type. Pre-registration: docs/SESSION_SPLIT_ROSTER_PREREG_20261108.md (family session_split_roster_20261108, 2 counted tests).
// Rosters are rebuilt AS OF each calendar day from rows resolved before that day's 00:00 (hr-020); scoring uses declustered fires (hr-007). Retrospective = a lead at most; `--first-forward 2026-11-09` re-runs it on later days only.
// Usage: node scripts/backtest_session_roster.mjs [--first-forward YYYY-MM-DD]   (the ledger look is logged first, hr-023)
import { query } from '../server/db.js';
import { logLook } from './lib/look_ledger.mjs';
import { evaluateType, buildRoster, holmPass, ROSTER_CORRECTION } from './calibrate_live_roster.mjs';
import { collapseClusterSiblings } from '../server/services/rigorDiagnostics.js';
import { minuteOfText } from '../server/services/bucketRoster.js';
const argv = process.argv.slice(2); const firstFwd = argv.includes('--first-forward') ? argv[argv.indexOf('--first-forward') + 1] : null;
const NB = 4000, MIN_PRIOR_DAYS = 25; let seed = 20261108; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1), sum = (a) => a.reduce((s, x) => s + x, 0);
const sessionOf = (m) => (m == null ? null : m >= 575 && m < 960 ? 'RTH' : (m >= 1110 || m < 570) ? 'GLOBEX' : null);
const lookId = await logLook({ family: 'session_split_roster_20261108', dataWindow: `explore_walkforward_2026-07-09_${firstFwd ? 'fwd' + firstFwd : 'retro'}`, kind: 'EXPLORE', tests: firstFwd ? 0 : 2, ref: `session_split_roster_${firstFwd ? 'fwd' + firstFwd : 'retro'}_${new Date().toISOString().slice(0, 10)}`, label: 'Live roster rule per (type, session RTH/Globex) vs per type: mean daily dollars and dollars per trade, day-block CI, halves rule; Holm variants and ALL reported; rosters rebuilt as of each day', script: 'scripts/backtest_session_roster.mjs', prereg: 'docs/SESSION_SPLIT_ROSTER_PREREG_20261108.md' });
console.log('ledger look', lookId ?? '(already logged today)');
const rows = (await query(`SELECT setup_type t, fired_at::text fa, COALESCE(resolved_at, fired_at)::text ra, cluster_touch_id cl, actual_pnl::float p, COALESCE(is_cluster_primary, false) prim FROM active_setups
  WHERE origin_status IN ('ACTIVE','SHADOW') AND trade_date >= '2026-07-09' AND actual_pnl IS NOT NULL AND resolution IS DISTINCT FROM 'NOT_FILLED' AND ib_window_stale_basis IS NOT TRUE AND stale_entry_price_basis IS NOT TRUE
    AND late_fill_past_expiry_basis IS NOT TRUE AND bad_bars_basis IS NOT TRUE AND stale_levels_basis IS NOT TRUE AND NOT (fired_at::time >= '16:00' AND fired_at::time < '18:00') AND setup_type NOT LIKE 'POC_ROTATION_JOIN%' ORDER BY fired_at`)).rows
  .map((r) => { const minute = minuteOfText(r.fa); return { type: r.t, date: r.fa.slice(0, 10), minute, sess: sessionOf(minute), ra: r.ra.slice(0, 19), cl: r.cl, pnl: r.p, prim: r.prim }; });
const days = [...new Set(rows.map((r) => r.date))].sort(); const scored = days.filter((d, i) => i >= MIN_PRIOR_DAYS && (!firstFwd || d >= firstFwd));
console.log(`${rows.length} rows on ${days.length} days; scored days ${scored.length} (${scored[0]}..${scored[scored.length - 1]})`);
// evaluate the live rule on a keying of the fit rows; returns Map key -> eval (with p)
function evalKeys(fit, keyFn) {
  const by = new Map(); for (const r of fit) { const k = keyFn(r); if (k == null) continue; (by.get(k) || by.set(k, []).get(k)).push(r); }
  const ev = new Map(); for (const [k, rs] of by) ev.set(k, evaluateType(collapseClusterSiblings(rs.map((r) => ({ date: r.date, pnl: r.pnl, cluster_touch_id: r.cl }))), k)); return ev;
}
function rosterOf(evals, prev, holm) {
  const e2 = new Map(); for (const [k, e] of evals) e2.set(k, { ...e });
  if (holm) { const keep = holmPass([...e2].filter(([, e]) => !e.thin).map(([k, e]) => ({ key: k, p: e.p })), ROSTER_CORRECTION.alpha); for (const [k, e] of e2) if (!e.thin) e.holmPass = keep.has(k); }
  const roles = buildRoster(e2, prev, new Set(), false); return { set: new Set(roles.keys()), passing: new Set([...roles].filter(([, v]) => v.role === 'passing').map(([k]) => k)) };
}
const ARMS = ['POOLED_OLD', 'SESSION_OLD', 'POOLED_HOLM', 'SESSION_HOLM', 'ALL']; const prev = Object.fromEntries(ARMS.map((a) => [a, null]));
const perDay = [], takes = Object.fromEntries(ARMS.map((a) => [a, []])), bySess = Object.fromEntries(ARMS.map((a) => [a, { RTH: [0, 0], GLOBEX: [0, 0] }])); const sessOnly = new Map(), poolOnly = new Map();
for (const D of scored) {
  const fit = rows.filter((r) => r.ra < D);
  const evType = evalKeys(fit, (r) => r.type), evSess = evalKeys(fit.filter((r) => r.sess), (r) => `${r.type}|${r.sess}`);
  const R = {}; for (const [arm, ev, holm] of [['POOLED_OLD', evType, false], ['SESSION_OLD', evSess, false], ['POOLED_HOLM', evType, true], ['SESSION_HOLM', evSess, true]]) { R[arm] = rosterOf(ev, prev[arm], holm); prev[arm] = R[arm].passing; }
  const row = { D }; for (const a of ARMS) { row[a] = 0; row['n' + a] = 0; }
  for (const r of rows.filter((x) => x.date === D && x.prim && x.sess)) {
    const inA = { ALL: true, POOLED_OLD: R.POOLED_OLD.set.has(r.type), POOLED_HOLM: R.POOLED_HOLM.set.has(r.type), SESSION_OLD: R.SESSION_OLD.set.has(`${r.type}|${r.sess}`), SESSION_HOLM: R.SESSION_HOLM.set.has(`${r.type}|${r.sess}`) };
    for (const a of ARMS) if (inA[a]) { row[a] += r.pnl; row['n' + a]++; takes[a].push(r.pnl); bySess[a][r.sess][0]++; bySess[a][r.sess][1] += r.pnl; }
    if (inA.SESSION_OLD && !inA.POOLED_OLD) sessOnly.set(`${r.type}|${r.sess}`, (sessOnly.get(`${r.type}|${r.sess}`) || 0) + 1); if (inA.POOLED_OLD && !inA.SESSION_OLD) poolOnly.set(`${r.type}|${r.sess}`, (poolOnly.get(`${r.type}|${r.sess}`) || 0) + 1);
  }
  perDay.push(row);
}
const active = perDay.filter((r) => r.nPOOLED_OLD > 0 || r.nSESSION_OLD > 0), dd = active.map((r) => r.SESSION_OLD - r.POOLED_OLD);
const bootMean = (vals) => { const out = []; for (let k = 0; k < NB; k++) { let s = 0; for (let i = 0; i < vals.length; i++) s += vals[Math.floor(rnd() * vals.length)]; out.push(s / vals.length); } return out.sort((a, b) => a - b); };
const q = (a, p) => a[Math.floor(p * (a.length - 1))], b1 = bootMean(dd), sd = Math.sqrt(mean(b1.map((x) => (x - mean(b1)) ** 2)));
console.log(`\nDETECTABLE EFFECT (2.8 x SE), mean daily dollars: T1 ${(2.8 * sd).toFixed(1)} (printed before results)`);
const t1 = mean(dd), h = Math.floor(active.length / 2), hv = [mean(dd.slice(0, h)), mean(dd.slice(h))];
const pt = (a, b, idx) => sum(idx.map((i) => active[i][a])) / Math.max(1, sum(idx.map((i) => active[i][b]))); const all = active.map((_, i) => i);
const bt2 = []; for (let k = 0; k < NB; k++) { const idx = Array.from({ length: active.length }, () => Math.floor(rnd() * active.length)); bt2.push(pt('SESSION_OLD', 'nSESSION_OLD', idx) - pt('POOLED_OLD', 'nPOOLED_OLD', idx)); } bt2.sort((a, b) => a - b);
const t2 = pt('SESSION_OLD', 'nSESSION_OLD', all) - pt('POOLED_OLD', 'nPOOLED_OLD', all);
console.log(`active days (either arm takes a trade): ${active.length}`);
console.log(`T1 SESSION_OLD minus POOLED_OLD, mean daily dollars: ${t1 >= 0 ? '+' : ''}${t1.toFixed(2)}, CI97.5 [${q(b1, 0.0125).toFixed(2)}, ${q(b1, 0.9875).toFixed(2)}]; halves ${hv[0].toFixed(2)} / ${hv[1].toFixed(2)}`);
console.log(`T2 SESSION_OLD minus POOLED_OLD, dollars PER TRADE (sum/N): ${t2 >= 0 ? '+' : ''}${t2.toFixed(2)}, CI97.5 [${q(bt2, 0.0125).toFixed(2)}, ${q(bt2, 0.9875).toFixed(2)}]`);
const lead = q(b1, 0.0125) > 0 && hv[0] > 0 && hv[1] > 0; console.log(`VERDICT (prereg section 3): ${lead ? 'LEAD' : 'NOT SHOWN'} [T1 lower bound above 0: ${q(b1, 0.0125) > 0}; both halves positive: ${hv[0] > 0 && hv[1] > 0}]${firstFwd ? '  (FORWARD run from ' + firstFwd + ')' : '  (retrospective: a lead at most)'}`);
console.log('\n--- REPORTED, NOT COUNTED ---');
for (const a of ARMS) { const v = takes[a], dsum = perDay.map((r) => r[a]); console.log(`${a.padEnd(13)} trades ${v.length}, per trade ${(sum(v) / Math.max(1, v.length)).toFixed(2)}, win ${(100 * v.filter((x) => x > 0).length / Math.max(1, v.length)).toFixed(0)}%, avg win ${mean(v.filter((x) => x > 0)).toFixed(1)}, avg loss ${mean(v.filter((x) => x <= 0)).toFixed(1)}, total ${sum(v).toFixed(0)}, days with trades ${perDay.filter((r) => r['n' + a] > 0).length}, worst day ${Math.min(...dsum).toFixed(0)}`); }
console.log('by session (n / dollars):'); for (const a of ARMS) console.log(`  ${a.padEnd(13)} RTH ${bySess[a].RTH[0]} / ${bySess[a].RTH[1].toFixed(0)}   GLOBEX ${bySess[a].GLOBEX[0]} / ${bySess[a].GLOBEX[1].toFixed(0)}`);
console.log('cells SESSION_OLD takes that POOLED_OLD does not (fires):', [...sessOnly].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t, n]) => `${t}:${n}`).join(' ')); console.log('cells POOLED_OLD takes that SESSION_OLD does not (fires):', [...poolOnly].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t, n]) => `${t}:${n}`).join(' '));
// heterogeneity: types with >= 5 days in BOTH sessions, over everything resolved (not as-of)
{ const by = new Map(); for (const r of rows) { if (!r.sess) continue; const k = `${r.type}|${r.sess}`; (by.get(k) || by.set(k, []).get(k)).push(r); }
  const cell = new Map(); for (const [k, rs] of by) { const ev = collapseClusterSiblings(rs.map((r) => ({ date: r.date, pnl: r.pnl, cluster_touch_id: r.cl }))); cell.set(k, { n: ev.length, days: new Set(ev.map((e) => e.date)).size, mean: mean(ev.map((e) => e.pnl)) }); }
  const types = [...new Set(rows.map((r) => r.type))].filter((t) => cell.get(`${t}|RTH`)?.days >= 5 && cell.get(`${t}|GLOBEX`)?.days >= 5);
  console.log(`\nHETEROGENEITY: ${types.length} types with at least 5 days in BOTH sessions (all resolved rows, not as-of):`); let lower = 0;
  for (const t of types.sort()) { const a = cell.get(`${t}|RTH`), g = cell.get(`${t}|GLOBEX`); if (g.mean < a.mean) lower++; console.log(`  ${t.padEnd(34)} RTH ${a.mean.toFixed(1).padStart(7)} (n${a.n}/${a.days}d)   GLOBEX ${g.mean.toFixed(1).padStart(7)} (n${g.n}/${g.days}d)   diff ${(g.mean - a.mean).toFixed(1).padStart(7)}`); }
  console.log(`share of those types whose Globex mean is below their RTH mean: ${types.length ? (100 * lower / types.length).toFixed(0) : 'n/a'}% (${lower} of ${types.length})`); }
process.exit(0);
