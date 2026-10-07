// One-time ledger record (2026-10-07). The split/combined-format comparison test (test_sim1_combined_format.mjs)
// left a real SELL fill at 31347.50 on Sim1 (COMBTEST order, filled at market despite a 40000 limit -- the
// same instant-fill bug). Flattened with a market BUY at 31352.00. Both setup_id NULL, no owning setup.
// Usage: node scripts/record_sim1_leftover_test_trade_20261007.mjs [--apply]
import { query } from '../server/db.js';
const apply = process.argv.includes('--apply');
const rows = [
  { cid: 'COMBTEST-FILL-20261007', side: 'SELL', px: 31347.50, note: 'combined-vs-split format comparison test, SELL LIMIT @40000, filled at market (Sim1)' },
  { cid: 'FLATSIM1-FILL-20261007', side: 'BUY', px: 31352.00, note: 'manual flatten closing the above' },
];
for (const r of rows) {
  const ex = await query(`SELECT id FROM order_placements WHERE client_order_id = $1`, [r.cid]);
  if (ex.rows.length) { console.log(`${r.cid} already recorded, id ${ex.rows[0].id}`); continue; }
  if (!apply) { console.log(`dry run: would insert ${r.side} 1 MNQZ6.CME @${r.px} (${r.cid})`); continue; }
  const ins = await query(`
    INSERT INTO order_placements (purpose, setup_id, client_order_id, symbol, exchange, side, order_type, quantity, trade_account, status, filled_quantity, avg_fill_price, position_open, raw_last_order_update, submitted_at)
    VALUES ('EXIT', NULL, $1, 'MNQZ6.CME', '', $2, 'MARKET', 1, 'Sim1', 'FILLED', 1, $3, false, $4, NOW())
    RETURNING id`, [r.cid, r.side, r.px, JSON.stringify({ manual: true, note: r.note })]);
  console.log(`inserted ${r.cid} id ${ins.rows[0].id}`);
}
process.exit(0);
