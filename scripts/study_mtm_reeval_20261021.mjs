// Part A of docs/FSR_REEVAL_AND_TIGHTENING_PREREG_20261021.md (committed 7c85dab before any outcome was computed). Research only.
import { query } from '../server/db.js';
import { collapseClusterSiblings, dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';
const BASE = `actual_pnl IS NOT NULL AND origin_status IN ('ACTIVE','SHADOW') AND trade_date >= '2026-07-09' AND ib_window_stale_basis IS NOT TRUE AND stale_entry_price_basis IS NOT TRUE AND late_fill_past_expiry_basis IS NOT TRUE AND bad_bars_basis IS NOT TRUE AND resolution IS DISTINCT FROM 'NOT_FILLED'`;
const rows = (await query(`SELECT setup_type, trade_date::text d, cluster_touch_id, actual_pnl::float p, (resolution_method IN ('MARK_TO_MARKET','RECOVERY_MTM')) mtm FROM active_setups WHERE ${BASE}`)).rows;
const by = new Map(); for (const r of rows) { if (!by.has(r.setup_type)) by.set(r.setup_type, []); by.get(r.setup_type).push(r); }
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN; const ev = (rs) => collapseClusterSiblings(rs.map((r) => ({ date: r.d, pnl: r.p, cluster_touch_id: r.cluster_touch_id })));
const out = [];
for (const [t, rs] of by) { const nm = rs.filter((r) => r.mtm).length; if (nm < 20) continue; const house = ev(rs.filter((r) => !r.mtm)), all = ev(rs); const ci = all.length > 1 ? dayBlockedBootstrapCI(all, 'A' + t) : { lo: NaN, hi: NaN }, ciH = house.length > 1 ? dayBlockedBootstrapCI(house, 'H' + t) : { lo: NaN, hi: NaN };
  const sorted = [...all].sort((a, b) => a.date < b.date ? -1 : 1), k = Math.floor(sorted.length / 3), th = [sorted.slice(0, k), sorted.slice(k, 2 * k), sorted.slice(2 * k)].map((x) => x.length ? mean(x.map((e) => e.pnl)) : NaN);
  const mH = mean(house.map((e) => e.pnl)), mA = mean(all.map((e) => e.pnl)); const change = (Math.sign(mH) !== Math.sign(mA)) || (ci.lo > 0 && !(ciH.lo > 0)) || (ci.hi < 0 && !(ciH.hi < 0));
  out.push({ t, mtmShare: nm / rs.length, nHouse: house.length, mHouse: mH, loH: ciH.lo, hiH: ciH.hi, nAll: all.length, days: new Set(all.map((e) => e.date)).size, mAll: mA, lo: ci.lo, hi: ci.hi, th, change }); }
out.sort((a, b) => b.nAll - a.nAll); const f = (x) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(1) : ' n/a');
console.log(`setup_type | mtm share | house n/mean [95%] | with MTM n/days/mean [95%] | thirds | verdict changes?`);
for (const r of out) console.log(`${r.t.padEnd(36)} ${(r.mtmShare * 100).toFixed(0).padStart(3)}% | ${String(r.nHouse).padStart(4)} ${f(r.mHouse).padStart(7)} [${f(r.loH)},${f(r.hiH)}] | ${String(r.nAll).padStart(4)} ${String(r.days).padStart(3)}d ${f(r.mAll).padStart(7)} [${f(r.lo)},${f(r.hi)}] | ${r.th.map(f).join(' ')} | ${r.change ? 'YES' : ''}`);
console.log(`\n${out.length} setup_types with >=20 mark-to-market rows; verdict changes for ${out.filter((r) => r.change).length}`); process.exit(0);
