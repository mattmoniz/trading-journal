// Walk-forward comparison of the session x time-block PROMOTION arm (BUCKET) against the pooled live roster rule (POOLED) and take-everything (ALL). Pre-registration: docs/BUCKET_ROSTER_PREREG_20261108.md (family bucket_roster_20261108, 2 counted tests).
// Every roster is rebuilt AS OF each calendar day from rows resolved before that day's 00:00 (no look-ahead, hr-020); scoring uses declustered fires (is_cluster_primary, hr-007). Retrospective = a LEAD at most; re-run on later days is the forward confirmation.
// Usage: node scripts/backtest_bucket_roster.mjs [--first-forward 2026-11-09]   (the ledger look is logged first, hr-023)
import { query } from '../server/db.js';
import { logLook } from './lib/look_ledger.mjs';
import { evaluateType, buildRoster } from './calibrate_live_roster.mjs';
import { collapseClusterSiblings } from '../server/services/rigorDiagnostics.js';
import { cellDayObservations, fitBucketModel, cellDecision, bucketOfMinute, minuteOfText, Z80 } from '../server/services/bucketRoster.js';
const argv = process.argv.slice(2); const firstFwd = argv.includes('--first-forward') ? argv[argv.indexOf('--first-forward') + 1] : null;
const NB = 4000, MIN_PRIOR_DAYS = 25; let seed = 20261108; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1), sum = (a) => a.reduce((s, x) => s + x, 0);
const lookId = await logLook({ family: 'bucket_roster_20261108', dataWindow: `explore_walkforward_2026-07-09_${firstFwd ? 'fwd' + firstFwd : 'retro'}`, kind: 'EXPLORE', tests: firstFwd ? 0 : 2, ref: `bucket_roster_walkforward_${firstFwd ? 'fwd' + firstFwd : 'retro'}_${new Date().toISOString().slice(0, 10)}`, label: 'Session x time-block partial-pooling promotion arm vs the pooled live roster rule and take-all: mean daily dollars and dollars per trade, day-block CI, halves rule; rosters rebuilt as of each day', script: 'scripts/backtest_bucket_roster.mjs', prereg: 'docs/BUCKET_ROSTER_PREREG_20261108.md' });
console.log('ledger look', lookId ?? '(already logged today)');
const rows = (await query(`SELECT setup_type t, fired_at::text fa, COALESCE(resolved_at, fired_at)::text ra, cluster_touch_id cl, actual_pnl::float p, COALESCE(is_cluster_primary, false) prim FROM active_setups
  WHERE origin_status IN ('ACTIVE','SHADOW') AND trade_date >= '2026-07-09' AND actual_pnl IS NOT NULL AND resolution IS DISTINCT FROM 'NOT_FILLED' AND ib_window_stale_basis IS NOT TRUE AND stale_entry_price_basis IS NOT TRUE
    AND late_fill_past_expiry_basis IS NOT TRUE AND bad_bars_basis IS NOT TRUE AND stale_levels_basis IS NOT TRUE AND NOT (fired_at::time >= '16:00' AND fired_at::time < '18:00') AND setup_type NOT LIKE 'POC_ROTATION_JOIN%' ORDER BY fired_at`)).rows
  .map((r) => ({ type: r.t, date: r.fa.slice(0, 10), minute: minuteOfText(r.fa), ra: r.ra.slice(0, 19), cluster_touch_id: r.cl, pnl: r.p, prim: r.prim }));
const days = [...new Set(rows.map((r) => r.date))].sort();
const scored = days.filter((d, i) => i >= MIN_PRIOR_DAYS && (!firstFwd || d >= firstFwd));
console.log(`${rows.length} rows on ${days.length} days; scored days ${scored.length} (${scored[0]}..${scored[scored.length - 1]})`);
let prevPassing = firstFwd ? undefined : null;
const perDay = []; const takes = { POOLED: [], BUCKET: [], ALL: [] }; const bucketOnly = new Map(), pooledOnly = new Map(); const bucketStats = new Map();
const priorDay = (d) => days[days.indexOf(d) - 1];
for (const D of scored) {
  const fit = rows.filter((r) => r.ra < D);                                                    // resolved strictly before this day's 00:00
  const byType = new Map(); for (const r of fit) (byType.get(r.type) || byType.set(r.type, []).get(r.type)).push(r);
  const evals = new Map(); for (const [t, rs] of byType) evals.set(t, evaluateType(collapseClusterSiblings(rs.map((r) => ({ date: r.date, pnl: r.pnl, cluster_touch_id: r.cluster_touch_id }))), t));
  const roles = buildRoster(evals, prevPassing ?? null, new Set(), false); const pooled = new Set(roles.keys()); prevPassing = new Set([...roles].filter(([, v]) => v.role === 'passing').map(([k]) => k));
  const model = fitBucketModel(cellDayObservations(fit));
  const today = rows.filter((r) => r.date === D && r.prim);
  const row = { D, POOLED: 0, BUCKET: 0, ALL: 0, nP: 0, nB: 0, nA: 0 };
  for (const r of today) {
    const b = bucketOfMinute(r.minute); if (!b) continue;                                       // hard-excluded zones are not tradeable in any arm
    const inP = pooled.has(r.type), dec = cellDecision(model, r.type, b), inB = dec.pass;
    row.ALL += r.pnl; row.nA++; takes.ALL.push(r.pnl);
    if (inP) { row.POOLED += r.pnl; row.nP++; takes.POOLED.push(r.pnl); }
    if (inB) { row.BUCKET += r.pnl; row.nB++; takes.BUCKET.push(r.pnl); const s = bucketStats.get(b) || { n: 0, sum: 0, pn: 0, ps: 0 }; s.n++; s.sum += r.pnl; bucketStats.set(b, s); }
    if (inP) { const s = bucketStats.get(b) || { n: 0, sum: 0, pn: 0, ps: 0 }; s.pn++; s.ps += r.pnl; bucketStats.set(b, s); }
    if (inB && !inP) bucketOnly.set(r.type, (bucketOnly.get(r.type) || 0) + 1); if (inP && !inB) pooledOnly.set(r.type, (pooledOnly.get(r.type) || 0) + 1);
  }
  perDay.push(row);
}
const active = perDay.filter((r) => r.nP > 0 || r.nB > 0); const dd = active.map((r) => r.BUCKET - r.POOLED);
const bootMean = (vals) => { const out = []; for (let k = 0; k < NB; k++) { let s = 0; for (let i = 0; i < vals.length; i++) s += vals[Math.floor(rnd() * vals.length)]; out.push(s / vals.length); } return out.sort((a, b) => a - b); };
const b1 = bootMean(dd), sd = Math.sqrt(mean(b1.map((x) => (x - mean(b1)) ** 2))), q = (a, p) => a[Math.floor(p * (a.length - 1))];
console.log(`\nDETECTABLE EFFECT (2.8 x SE), mean daily dollars: T1 ${(2.8 * sd).toFixed(1)} (printed before results)`);
const t1 = mean(dd), h = Math.floor(active.length / 2), hv = [mean(dd.slice(0, h)), mean(dd.slice(h))];
const perTrade = (key, nk, idx) => sum(idx.map((i) => active[i][key])) / Math.max(1, sum(idx.map((i) => active[i][nk])));
const bt2 = []; for (let k = 0; k < NB; k++) { const idx = Array.from({ length: active.length }, () => Math.floor(rnd() * active.length)); bt2.push(perTrade('BUCKET', 'nB', idx) - perTrade('POOLED', 'nP', idx)); } bt2.sort((a, b) => a - b);
const all = Array.from({ length: active.length }, (_, i) => i), t2 = perTrade('BUCKET', 'nB', all) - perTrade('POOLED', 'nP', all);
console.log(`active days (either arm takes a trade): ${active.length}; first look cadence is forward 60 / 120 / 250 days`);
console.log(`T1 BUCKET minus POOLED, mean daily dollars: ${t1 >= 0 ? '+' : ''}${t1.toFixed(2)}, CI97.5 [${q(b1, 0.0125).toFixed(2)}, ${q(b1, 0.9875).toFixed(2)}]; halves ${hv[0].toFixed(2)} / ${hv[1].toFixed(2)}`);
console.log(`T2 BUCKET minus POOLED, dollars PER TRADE (sum/N): ${t2 >= 0 ? '+' : ''}${t2.toFixed(2)}, CI97.5 [${q(bt2, 0.0125).toFixed(2)}, ${q(bt2, 0.9875).toFixed(2)}]`);
const lead = q(b1, 0.0125) > 0 && hv[0] > 0 && hv[1] > 0; console.log(`VERDICT (prereg section 4): ${lead ? 'LEAD' : 'NOT SHOWN'} [T1 lower bound above 0: ${q(b1, 0.0125) > 0}; both halves positive: ${hv[0] > 0 && hv[1] > 0}]${firstFwd ? '  (FORWARD run from ' + firstFwd + ')' : '  (retrospective: a lead at most)'}`);
console.log('\n--- REPORTED, NOT COUNTED ---');
for (const [k, nk] of [['POOLED', 'nP'], ['BUCKET', 'nB'], ['ALL', 'nA']]) { const v = takes[k]; const dsum = perDay.map((r) => r[k]); console.log(`${k.padEnd(7)} trades ${v.length}, per trade ${(sum(v) / Math.max(1, v.length)).toFixed(2)}, win rate ${(100 * v.filter((x) => x > 0).length / Math.max(1, v.length)).toFixed(0)}%, avg win ${mean(v.filter((x) => x > 0)).toFixed(1)}, avg loss ${mean(v.filter((x) => x <= 0)).toFixed(1)}, total ${sum(v).toFixed(0)}, days with trades ${perDay.filter((r) => r[nk] > 0).length}, worst day ${Math.min(...dsum).toFixed(0)}`); }
{ const pa = (k, nk, idx) => sum(idx.map((i) => perDay[i][k])) / Math.max(1, sum(idx.map((i) => perDay[i][nk]))); const allI = perDay.map((_, i) => i);   // EXPLORATORY, not counted (outside the 2 pre-registered tests): does a roster as of the previous day beat taking every fire?
  for (const [k, nk] of [['POOLED', 'nP'], ['BUCKET', 'nB']]) { const bs = []; for (let b = 0; b < NB; b++) { const idx = Array.from({ length: perDay.length }, () => Math.floor(rnd() * perDay.length)); bs.push(pa(k, nk, idx) - pa('ALL', 'nA', idx)); } bs.sort((x, y) => x - y); console.log(`EXPLORATORY ${k} minus ALL, dollars per trade over all ${perDay.length} scored days: ${(pa(k, nk, allI) - pa('ALL', 'nA', allI)).toFixed(2)}, CI95 [${q(bs, 0.025).toFixed(2)}, ${q(bs, 0.975).toFixed(2)}]`); } }
console.log('BUCKET arm by bucket (n, dollars) vs POOLED in the same bucket (n, dollars):'); for (const [b, s] of [...bucketStats].sort()) console.log(`  ${b.padEnd(13)} BUCKET ${s.n} / ${s.sum.toFixed(0)}   POOLED ${s.pn} / ${s.ps.toFixed(0)}`);
console.log('fires taken by BUCKET only, by type (top 8):', [...bucketOnly].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t, n]) => `${t}:${n}`).join(' ')); console.log('fires taken by POOLED only, by type (top 8):', [...pooledOnly].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t, n]) => `${t}:${n}`).join(' '));
process.exit(0);
