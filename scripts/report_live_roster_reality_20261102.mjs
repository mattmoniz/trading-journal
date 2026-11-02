// Read-only descriptive report: what the REAL live roster (origin_status='ACTIVE', primary rows) actually did, by family and session, with day-blocked intervals.
// Standing rules applied: is_cluster_primary only; basis-flagged rows excluded; 16:00-18:00 post-close rows excluded; POC_ROTATION_JOIN and AMT_TELL reported SEPARATELY (2026-10-11/12 confound boundary);
// two windows (>= 2026-10-12 = the current mechanism combination; >= 2026-09-17 = context). Descriptive, not a claim of edge. Usage: node scripts/report_live_roster_reality_20261102.mjs
import { query } from '../server/db.js';
import { mulberry32, hashSeed } from '../server/services/rigorDiagnostics.js';
const WINDOWS = [['>= 2026-10-12 (current mechanism combination)', '2026-10-12'], ['>= 2026-09-17 (context)', '2026-09-17']];
const family = (t) => /^AMT_TELL/.test(t) ? 'AMT_TELL (Stage 2)' : /^POC_ROTATION_JOIN/.test(t) ? 'POC_ROTATION_JOIN' : /FLUSH/.test(t) ? 'FLUSH' : /^MOMENTUM_CHASE/.test(t) ? 'MOMENTUM_CHASE' : /_OVERNIGHT$/.test(t) ? 'LEVEL_FADE (overnight names)' : 'LEVEL_FADE / other';
function ci(rows, seed) {
  const g = new Map(); for (const r of rows) (g.get(r.d) || g.set(r.d, []).get(r.d)).push(r.pnl); const arr = [...g.values()], m = arr.length, rng = mulberry32(hashSeed(seed)); if (m < 3) return [NaN, NaN];
  const out = []; for (let i = 0; i < 2000; i++) { let s = 0, n = 0; for (let k = 0; k < m; k++) { const a = arr[(rng() * m) | 0]; for (const v of a) { s += v; n++; } } out.push(s / n); } out.sort((x, y) => x - y); return [out[50], out[1949]];
}
for (const [label, from] of WINDOWS) {
  const r = await query(`SELECT setup_type, trade_date::text d, is_rth, actual_pnl::float AS pnl, resolution_method FROM active_setups
    WHERE origin_status='ACTIVE' AND (is_cluster_primary IS NULL OR is_cluster_primary = true) AND actual_pnl IS NOT NULL AND trade_date >= $1
      AND ib_window_stale_basis IS NOT TRUE AND stale_entry_price_basis IS NOT TRUE AND late_fill_past_expiry_basis IS NOT TRUE AND bad_bars_basis IS NOT TRUE AND stale_levels_basis IS NOT TRUE
      AND NOT (fired_at::time >= '16:00' AND fired_at::time < '18:00')`, [from]);
  const rows = r.rows.map(x => ({ ...x, fam: family(x.setup_type), sess: x.is_rth ? 'RTH' : 'Globex' }));
  console.log(`\n==== window ${label}: ${rows.length} real primary trades on ${new Set(rows.map(x => x.d)).size} trading days; total $${rows.reduce((s, x) => s + x.pnl, 0).toFixed(0)}`);
  console.log('family | session | N | days | win% | mean/trade | 95% CI (day-blocked) | total $ | worst day $ | top-5-day share of profit | mark-to-market %');
  const keys = [...new Set(rows.map(x => x.fam + '|' + x.sess))].sort();
  for (const k of keys) {
    const g = rows.filter(x => x.fam + '|' + x.sess === k), n = g.length, days = new Set(g.map(x => x.d)).size, tot = g.reduce((s, x) => s + x.pnl, 0), mean = tot / n;
    const byDay = new Map(); for (const x of g) byDay.set(x.d, (byDay.get(x.d) || 0) + x.pnl); const dv = [...byDay.values()].sort((a, b) => b - a), pos = dv.filter(v => v > 0).reduce((s, v) => s + v, 0);
    const top5 = pos > 0 ? (100 * dv.slice(0, 5).filter(v => v > 0).reduce((s, v) => s + v, 0) / pos).toFixed(0) + '%' : 'n/a';
    const [lo, hi] = ci(g, label + k); const mtm = (100 * g.filter(x => x.resolution_method === 'MARK_TO_MARKET').length / n).toFixed(0);
    console.log(`${k.replace('|', ' | ')} | ${n} | ${days} | ${(100 * g.filter(x => x.pnl > 0).length / n).toFixed(0)}% | ${mean.toFixed(2)} | [${lo.toFixed(1)}, ${hi.toFixed(1)}] | ${tot.toFixed(0)} | ${Math.min(...dv).toFixed(0)} | ${top5} | ${mtm}%`);
  }
}
// Section 2 (added 2026-11-02): ACTIVE (live-visible, real orders) versus SHADOW (tracked, no order) for the two families the trader mentioned, and the per-day lines since POC join was forced SHADOW (2026-10-21).
console.log('\n==== ACTIVE vs SHADOW, POC_ROTATION_JOIN and FLUSH, primary rows, trade_date >= 2026-10-12 (same exclusions as above) ====');
const r2 = await query(`SELECT setup_type, origin_status, trade_date::text d, is_rth, actual_pnl::float AS pnl FROM active_setups WHERE origin_status IN ('ACTIVE','SHADOW') AND (is_cluster_primary IS NULL OR is_cluster_primary = true) AND actual_pnl IS NOT NULL AND trade_date >= '2026-10-12'
  AND (setup_type LIKE 'POC_ROTATION_JOIN%' OR setup_type LIKE '%FLUSH%') AND ib_window_stale_basis IS NOT TRUE AND stale_entry_price_basis IS NOT TRUE AND late_fill_past_expiry_basis IS NOT TRUE AND bad_bars_basis IS NOT TRUE AND stale_levels_basis IS NOT TRUE AND NOT (fired_at::time >= '16:00' AND fired_at::time < '18:00')`);
const grp = new Map(); for (const x of r2.rows) { const k = `${family(x.setup_type)} | ${x.origin_status} | ${x.is_rth ? 'RTH' : 'Globex'}`; (grp.get(k) || grp.set(k, []).get(k)).push(x); }
console.log('family | origin | session | N | days | win% | mean/trade | total $');
for (const [k, g] of [...grp.entries()].sort()) { const tot = g.reduce((s, x) => s + x.pnl, 0); console.log(`${k} | ${g.length} | ${new Set(g.map(x => x.d)).size} | ${(100 * g.filter(x => x.pnl > 0).length / g.length).toFixed(0)}% | ${(tot / g.length).toFixed(2)} | ${tot.toFixed(0)}`); }
console.log('\nper-day since 2026-10-21 (POC join forced SHADOW): date | family | origin | session | N | total $');
const pd = new Map(); for (const x of r2.rows.filter(x => x.d >= '2026-10-21')) { const k = `${x.d} | ${family(x.setup_type)} | ${x.origin_status} | ${x.is_rth ? 'RTH' : 'Globex'}`; (pd.get(k) || pd.set(k, []).get(k)).push(x.pnl); }
for (const [k, v] of [...pd.entries()].sort()) console.log(`${k} | ${v.length} | ${v.reduce((a, b) => a + b, 0).toFixed(0)}`);
process.exit(0);
