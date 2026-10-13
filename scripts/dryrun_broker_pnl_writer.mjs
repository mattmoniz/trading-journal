// DRY RUN (2026-10-06): runs recordBrokerPnlForSetup's logic against real trades with a fake writer,
// so nothing is written. Shows what would be recorded and what would be skipped, and why.
import { query } from '../server/db.js';
import { recordBrokerPnlForSetup } from '../server/services/sierraChart/brokerPnlWriter.js';
const ids = (await query(`SELECT DISTINCT s.id FROM active_setups s JOIN order_placements e ON e.setup_id=s.id AND e.purpose='ENTRY' AND e.status='FILLED'
  WHERE s.origin_status='ACTIVE' AND s.trade_date >= '2026-09-28' ORDER BY s.id`)).rows.map(r => r.id);
const real = { query };
for (const id of ids) {
  const writes = [];
  const fake = { query: async (sql, p) => (sql.includes('UPDATE') ? (writes.push(p), { rows: [] }) : real.query(sql, p)) };
  const r = await recordBrokerPnlForSetup(id, fake);
  console.log(`${String(id).padEnd(8)} ${r.written ? `WOULD WRITE broker_pnl=${r.pnl.toFixed(2)}` : `skip: ${r.reason}`}`);
}
console.log(`\n${ids.length} trade(s) checked. Nothing written.`);
process.exit(0);
