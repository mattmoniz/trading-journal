// Read-only (2026-11-02): why do the model P&L and the broker fills disagree? Compare the model's holding period (fired_at -> resolved_at) with the broker's (entry fill -> exit fill) per live trade since 2026-09-17.
import { query } from '../server/db.js';
import { brokerPnlFromFills } from '../server/services/sierraChart/brokerPnl.js';
const rows = (await query(`
  SELECT s.id, s.setup_type, s.trade_date::text d, s.actual_pnl::float stored, s.resolution_method rm, extract(epoch FROM s.fired_at)::float f0, extract(epoch FROM s.resolved_at)::float f1,
    e.side es, e.avg_fill_price::float ea, extract(epoch FROM e.last_update_at)::float et, x.avg_fill_price::float xa, extract(epoch FROM x.last_update_at)::float xt, x.purpose xp
  FROM active_setups s JOIN order_placements e ON e.setup_id = s.id AND e.purpose='ENTRY' AND e.status='FILLED'
  JOIN LATERAL (SELECT * FROM order_placements o WHERE o.setup_id = s.id AND o.purpose IN ('STOP','EXIT','TARGET') AND o.status='FILLED' ORDER BY o.id DESC LIMIT 1) x ON TRUE
  WHERE s.origin_status='ACTIVE' AND s.trade_date >= '2026-09-17' AND s.actual_pnl IS NOT NULL AND s.resolved_at IS NOT NULL ORDER BY s.id`)).rows
  .map((r) => ({ ...r, fill: brokerPnlFromFills({ entrySide: r.es, entryAvg: r.ea, exitAvg: r.xa }), modelHold: (r.f1 - r.f0) / 60, brokerHold: (r.xt - r.et) / 60, exitLate: (r.xt - r.f1) / 60 })).filter((r) => r.fill != null);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
console.log(`trades ${rows.length}; median model hold ${med(rows.map((r) => r.modelHold)).toFixed(1)} min; median broker hold ${med(rows.map((r) => r.brokerHold)).toFixed(1)} min`);
const late = rows.filter((r) => r.exitLate > 5), early = rows.filter((r) => r.exitLate < -5), same = rows.filter((r) => Math.abs(r.exitLate) <= 5);
const rep = (lab, g) => console.log(`${lab}: N ${g.length}, model total $${g.reduce((s, r) => s + r.stored, 0).toFixed(0)}, fills total $${g.reduce((s, r) => s + r.fill, 0).toFixed(0)}, mean model-fill $${(g.reduce((s, r) => s + r.stored - r.fill, 0) / (g.length || 1)).toFixed(1)}, within $5 ${(100 * g.filter((r) => Math.abs(r.stored - r.fill) <= 5).length / (g.length || 1)).toFixed(0)}%`);
console.log('\nbroker exit fill relative to the model resolved_at:'); rep('exit within +/-5 min of the model', same); rep('exit MORE THAN 5 min LATER than the model', late); rep('exit MORE THAN 5 min EARLIER than the model', early);
console.log('LATE exit (broker exit > 5 min after the model close):', late.map((r) => r.d + ' id ' + r.id).join('; '));
console.log('EARLY exit (broker exit > 5 min before the model close):', early.map((r) => r.d + ' id ' + r.id).join('; '));
const gap = rows.filter((r) => Math.abs(r.stored - r.fill) > 25); console.log(`\ntrades with |model - fill| > $25: ${gap.length}; of those, exit later by > 5 min: ${gap.filter((r) => r.exitLate > 5).length}, earlier by > 5 min: ${gap.filter((r) => r.exitLate < -5).length}, same time: ${gap.filter((r) => Math.abs(r.exitLate) <= 5).length}`);
console.log('by resolution_method among late exits:', Object.fromEntries([...new Set(late.map((r) => r.rm))].map((k) => [k, late.filter((r) => r.rm === k).length])));
for (const r of [...rows].sort((a, b) => Math.abs(b.fill - b.stored) - Math.abs(a.fill - a.stored)).slice(0, 10)) console.log(`  ${r.id} ${r.setup_type} ${r.d} model ${r.stored} fill ${r.fill.toFixed(1)} model hold ${r.modelHold.toFixed(0)}m broker hold ${r.brokerHold.toFixed(0)}m exit ${r.exitLate.toFixed(0)}m after model close, ${r.rm}/${r.xp}`);
const ex = rows.filter((r) => Math.abs(r.fill - r.stored) <= 400); const out2 = rows.filter((r) => Math.abs(r.fill - r.stored) > 400);
console.log(`\nwithout the ${out2.length} trades with a model-fill gap over $400 (model $${out2.reduce((s, r) => s + r.stored, 0).toFixed(0)}, fills $${out2.reduce((s, r) => s + r.fill, 0).toFixed(0)}): N ${ex.length}, model $${ex.reduce((s, r) => s + r.stored, 0).toFixed(0)}, fills $${ex.reduce((s, r) => s + r.fill, 0).toFixed(0)}`);
process.exit(0);
