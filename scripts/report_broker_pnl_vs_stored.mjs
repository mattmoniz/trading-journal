// Read-only report (2026-10-06): live trades' stored P&L vs P&L derived from the broker's fills.
// Writes nothing. A trade is "cannot derive" when either fill price is missing, never guessed.
// Run: node scripts/report_broker_pnl_vs_stored.mjs
import { query } from '../server/db.js';
import { brokerPnlFromFills } from '../server/services/sierraChart/brokerPnl.js';

const rows = (await query(`
  SELECT s.id, s.setup_type, s.trade_date::text AS d, s.actual_pnl::float AS stored,
    e.side AS entry_side, e.avg_fill_price::float AS entry_avg, e.status AS entry_status,
    x.avg_fill_price::float AS exit_avg, x.purpose AS exit_purpose, x.status AS exit_status
  FROM active_setups s
  JOIN order_placements e ON e.setup_id = s.id AND e.purpose = 'ENTRY' AND e.status = 'FILLED'
  LEFT JOIN LATERAL (
    SELECT purpose, status, avg_fill_price FROM order_placements o
    WHERE o.setup_id = s.id AND o.purpose IN ('STOP','EXIT') AND o.status = 'FILLED'
    ORDER BY o.id DESC LIMIT 1) x ON TRUE
  WHERE s.origin_status = 'ACTIVE' AND s.trade_date >= '2026-09-28'
  ORDER BY s.id`)).rows;

// Some older rows hold the broker's raw integer price (e.g. 3043725 = 30437.25). Those are flagged,
// never converted here, so the report cannot silently mix units.
const rawUnits = (v) => v != null && Math.abs(v) > 1000000;
let derivable = 0, sumStored = 0, sumBroker = 0, cannot = 0, rawFlagged = 0;
console.log('setup    setup_type                 stored    broker   note');
for (const r of rows) {
  if (rawUnits(r.entry_avg) || rawUnits(r.exit_avg)) {
    rawFlagged++;
    console.log(`${String(r.id).padEnd(8)} ${r.setup_type.padEnd(26)} ${String(r.stored ?? '-').padEnd(9)} ${'n/a'.padEnd(8)} stored fill is raw broker units (not converted), needs repair`);
    continue;
  }
  const broker = brokerPnlFromFills({ entrySide: r.entry_side, entryAvg: r.entry_avg, exitAvg: r.exit_avg });
  if (broker == null) {
    cannot++;
    console.log(`${String(r.id).padEnd(8)} ${r.setup_type.padEnd(26)} ${String(r.stored ?? '-').padEnd(9)} ${'n/a'.padEnd(8)} cannot derive (entry avg ${r.entry_avg ?? 'NULL'}, exit avg ${r.exit_avg ?? 'NULL'})`);
    continue;
  }
  derivable++; sumStored += r.stored ?? 0; sumBroker += broker;
  const diff = (r.stored ?? 0) - broker;
  console.log(`${String(r.id).padEnd(8)} ${r.setup_type.padEnd(26)} ${String(r.stored ?? '-').padEnd(9)} ${broker.toFixed(2).padEnd(8)} ${Math.abs(diff) < 0.5 ? 'match' : `differs by ${diff.toFixed(2)}`}`);
}
console.log(`\nlive trades with a filled entry: ${rows.length}; derivable from broker fills: ${derivable}; cannot derive: ${cannot}`);
console.log(`raw-units rows flagged for repair: ${rawFlagged}`);
console.log(`over derivable trades: stored total ${sumStored.toFixed(2)}, broker total ${sumBroker.toFixed(2)}`);
process.exit(0);
