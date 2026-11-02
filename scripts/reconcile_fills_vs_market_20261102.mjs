// Read-only (2026-11-02): are the broker fill records themselves sane? For every live trade since 2026-09-17, compare the ENTRY and EXIT order's avg_fill_price with the one-minute bar of the fill time (price_bars_primary, both timestamp bounds), and the filled quantity of entry vs exit.
import { query } from '../server/db.js';
import { brokerPnlFromFills } from '../server/services/sierraChart/brokerPnl.js';
const rows = (await query(`
  SELECT s.id, s.setup_type, s.trade_date::text d, s.actual_pnl::float stored, s.resolution_method rm,
    e.side es, e.avg_fill_price::float ea, e.filled_quantity eq, e.symbol esym, e.last_update_at::text et,
    x.avg_fill_price::float xa, x.filled_quantity xq, x.symbol xsym, x.last_update_at::text xt, x.purpose xp, x.status xs
  FROM active_setups s
  JOIN order_placements e ON e.setup_id = s.id AND e.purpose='ENTRY' AND e.status='FILLED'
  LEFT JOIN LATERAL (SELECT * FROM order_placements o WHERE o.setup_id = s.id AND o.purpose IN ('STOP','EXIT','TARGET') AND o.status='FILLED' ORDER BY o.id DESC LIMIT 1) x ON TRUE
  WHERE s.origin_status='ACTIVE' AND s.trade_date >= '2026-09-17' AND s.actual_pnl IS NOT NULL ORDER BY s.id`)).rows;
async function barAt(ts) {   // the minute bar containing ts (naive ET), padded by one minute each side
  const r = await query(`SELECT min(low)::float lo, max(high)::float hi FROM price_bars_primary WHERE symbol='NQ' AND ts >= ($1::timestamp - interval '1 minute') AND ts < ($1::timestamp + interval '2 minutes')`, [ts]); return r.rows[0];
}
const TOL = 3.0; const out = []; let nb = 0;
for (const r of rows) {
  if (r.xa == null || r.ea > 1e6 || r.xa > 1e6) continue;
  const be = await barAt(r.et), bx = await barAt(r.xt); const okE = be.lo != null && r.ea >= be.lo - TOL && r.ea <= be.hi + TOL, okX = bx.lo != null && r.xa >= bx.lo - TOL && r.xa <= bx.hi + TOL;
  const fill = brokerPnlFromFills({ entrySide: r.es, entryAvg: r.ea, exitAvg: r.xa }); out.push({ ...r, fill, okE, okX, noBar: be.lo == null || bx.lo == null, qtyMismatch: r.eq !== r.xq || r.eq !== 1, symMismatch: r.esym !== r.xsym });
}
const n = out.length, f = (g) => g.length;
console.log(`trades with entry and exit fills: ${n}`);
console.log(`entry fill within the bar range +/-${TOL}: ${f(out.filter((r) => r.okE))}; exit fill within range: ${f(out.filter((r) => r.okX))}; both: ${f(out.filter((r) => r.okE && r.okX))}; no market bar found at the fill time: ${f(out.filter((r) => r.noBar))}`);
console.log(`quantity not 1 or entry/exit quantity differ: ${f(out.filter((r) => r.qtyMismatch))}; symbol differs between entry and exit: ${f(out.filter((r) => r.symMismatch))}`);
const good = out.filter((r) => r.okE && r.okX && !r.qtyMismatch && !r.symMismatch), bad = out.filter((r) => !(r.okE && r.okX && !r.qtyMismatch && !r.symMismatch));
const stat = (g) => { const d = g.map((r) => r.stored - r.fill); const m = d.reduce((s, v) => s + v, 0) / (d.length || 1); return `N ${g.length}, mean(model - fill) ${m.toFixed(2)}, within $5 ${(100 * d.filter((v) => Math.abs(v) <= 5).length / (d.length || 1)).toFixed(0)}%, model total $${g.reduce((s, r) => s + r.stored, 0).toFixed(0)}, fill total $${g.reduce((s, r) => s + r.fill, 0).toFixed(0)}`; };
console.log('\nSANE fills (entry and exit inside the market bar, quantity 1, same symbol): ' + stat(good)); console.log('SUSPECT fills: ' + stat(bad));
console.log('\nsuspect rows by reason: entry off-market ' + f(bad.filter((r) => !r.okE)) + ', exit off-market ' + f(bad.filter((r) => !r.okX)) + ', qty ' + f(bad.filter((r) => r.qtyMismatch)) + ', symbol ' + f(bad.filter((r) => r.symMismatch)));
for (const r of bad.sort((a, b) => Math.abs(b.fill - b.stored) - Math.abs(a.fill - a.stored)).slice(0, 10)) console.log(`  ${r.id} ${r.setup_type} ${r.d} stored ${r.stored} fill ${r.fill.toFixed(1)} entry ${r.ea}@${r.et} (${r.esym} q${r.eq}) exit ${r.xa}@${r.xt} (${r.xsym} q${r.xq}) ${r.xp}`);
const fam = (t) => /^AMT_TELL/.test(t) ? 'AMT_TELL' : /^POC_ROTATION_JOIN/.test(t) ? 'POC_JOIN' : /_OVERNIGHT$/.test(t) ? 'FADE_overnight' : 'FADE_other';
console.log('\nSANE-fill roster by family (fills = broker truth, model = stored):');
for (const k of ['AMT_TELL', 'POC_JOIN', 'FADE_overnight', 'FADE_other']) { const g = good.filter((r) => fam(r.setup_type) === k); if (g.length) console.log(`  ${k.padEnd(15)} N ${String(g.length).padStart(3)} model $${g.reduce((s, r) => s + r.stored, 0).toFixed(0).padStart(6)} fills $${g.reduce((s, r) => s + r.fill, 0).toFixed(0).padStart(6)} mean fills/trade $${(g.reduce((s, r) => s + r.fill, 0) / g.length).toFixed(2)} win ${(100 * g.filter((r) => r.fill > 0).length / g.length).toFixed(0)}%`); }
process.exit(0);
