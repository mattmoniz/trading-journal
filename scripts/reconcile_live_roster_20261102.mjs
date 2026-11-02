// Read-only reconciliation of the live roster (2026-11-02): per trade, the stored model P&L (actual_pnl), the broker_pnl column and the P&L derived from the broker's ENTRY/EXIT fills (order_placements), since 2026-09-17.
// Writes nothing. Usage: node scripts/reconcile_live_roster_20261102.mjs
import { query } from '../server/db.js';
import { brokerPnlFromFills } from '../server/services/sierraChart/brokerPnl.js';
const rows = (await query(`
  SELECT s.id, s.setup_type, s.trade_date::text d, s.is_rth, s.actual_pnl::float stored, s.broker_pnl::float bcol, s.pnl_source, s.resolution_method rm, s.is_cluster_primary prim,
    e.side es, e.avg_fill_price::float ea, x.avg_fill_price::float xa, x.purpose xp
  FROM active_setups s
  JOIN order_placements e ON e.setup_id = s.id AND e.purpose='ENTRY' AND e.status='FILLED'
  LEFT JOIN LATERAL (SELECT purpose, avg_fill_price FROM order_placements o WHERE o.setup_id = s.id AND o.purpose IN ('STOP','EXIT','TARGET') AND o.status='FILLED' ORDER BY o.id DESC LIMIT 1) x ON TRUE
  WHERE s.origin_status='ACTIVE' AND s.trade_date >= '2026-09-17' AND s.actual_pnl IS NOT NULL ORDER BY s.id`)).rows;
const fam = (t) => /^AMT_TELL/.test(t) ? 'AMT_TELL' : /^POC_ROTATION_JOIN/.test(t) ? 'POC_JOIN' : /_OVERNIGHT$/.test(t) ? 'FADE_overnight' : 'FADE_other';
const out = rows.map((r) => ({ ...r, fam: fam(r.setup_type), fill: (r.ea > 1e6 || r.xa > 1e6) ? null : brokerPnlFromFills({ entrySide: r.es, entryAvg: r.ea, exitAvg: r.xa }) }));
const der = out.filter((r) => r.fill != null);
console.log(`ACTIVE rows with a filled entry since 2026-09-17: ${out.length}; fill-derivable (entry+exit fills): ${der.length}; with broker_pnl column: ${out.filter((r) => r.bcol != null).length}; primary-flag false: ${out.filter((r) => r.prim === false).length}`);
const stat = (g, a, b) => { const d = g.map((r) => r[a] - r[b]); const m = d.reduce((s, v) => s + v, 0) / d.length; const sd = Math.sqrt(d.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, d.length - 1)); return { n: g.length, mean: m, sd, within5: d.filter((v) => Math.abs(v) <= 5).length / d.length, tot: d.reduce((s, v) => s + v, 0) }; };
const show = (lab, s) => console.log(`${lab}: N ${s.n}, mean diff ${s.mean.toFixed(2)}, SD ${s.sd.toFixed(1)}, within $5 ${(100 * s.within5).toFixed(0)}%, total diff ${s.tot.toFixed(0)}`);
console.log('\nstored (model) minus FILL-derived P&L:'); show('ALL', stat(der, 'stored', 'fill')); for (const f of ['AMT_TELL', 'POC_JOIN', 'FADE_overnight', 'FADE_other']) { const g = der.filter((r) => r.fam === f); if (g.length) show(f.padEnd(15), stat(g, 'stored', 'fill')); }
const withB = der.filter((r) => r.bcol != null); console.log('\nbroker_pnl COLUMN minus FILL-derived P&L (rows with both):'); if (withB.length) { show('ALL', stat(withB, 'bcol', 'fill')); console.log('pnl_source values:', Object.fromEntries([...new Set(withB.map((r) => r.pnl_source))].map((k) => [String(k), withB.filter((r) => r.pnl_source === k).length]))); }
const big = der.filter((r) => Math.abs(r.stored - r.fill) > 25).sort((a, b) => Math.abs(b.stored - b.fill) - Math.abs(a.stored - a.fill)); console.log(`\nlargest model-vs-fill gaps (> $25): ${big.length} trades; resolution mix:`, Object.fromEntries([...new Set(big.map((r) => r.rm))].map((k) => [String(k), big.filter((r) => r.rm === k).length])));
for (const r of big.slice(0, 12)) console.log(`  ${r.id} ${r.setup_type} ${r.d} stored ${r.stored} fill ${r.fill.toFixed(1)} bcol ${r.bcol} rm ${r.rm} exit ${r.xp}`);
console.log('\nTOTALS over fill-derivable trades: model $' + der.reduce((s, r) => s + r.stored, 0).toFixed(0) + ', fills $' + der.reduce((s, r) => s + r.fill, 0).toFixed(0));
for (const f of ['AMT_TELL', 'POC_JOIN', 'FADE_overnight', 'FADE_other']) { const g = der.filter((r) => r.fam === f); if (g.length) console.log(`  ${f.padEnd(15)} N ${String(g.length).padStart(3)}  model $${g.reduce((s, r) => s + r.stored, 0).toFixed(0).padStart(6)}  fills $${g.reduce((s, r) => s + r.fill, 0).toFixed(0).padStart(6)}  mean/trade by fills $${(g.reduce((s, r) => s + r.fill, 0) / g.length).toFixed(2)}`); }
const noFill = out.filter((r) => r.fill == null); console.log(`\nrows WITHOUT derivable fills: ${noFill.length}; by family:`, Object.fromEntries([...new Set(noFill.map((r) => r.fam))].map((k) => [k, noFill.filter((r) => r.fam === k).length])), 'their model total $' + noFill.reduce((s, r) => s + r.stored, 0).toFixed(0));
process.exit(0);
