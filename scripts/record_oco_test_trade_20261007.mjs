// One-time ledger record (2026-10-07). The OCO live test (test_oco_submission's companion live
// script) left a real SELL fill at 31266.75 (parent order TESTPARENT, filled unexpectedly at
// market despite a 33000 limit) and a BUY flatten at 31272.00 (manual cleanup). Both setup_id NULL,
// no owning setup. Net: short opened then closed, -$10.50 before commission.
// Usage: node scripts/record_oco_test_trade_20261007.mjs [--apply]
import { query } from '../server/db.js';
const apply = process.argv.includes('--apply');
const rows = [
  { cid: 'TESTPARENT-OCO-FILL-20261007', side: 'SELL', px: 31266.75, note: 'OCO live test parent, SELL LIMIT @33000, filled at market (sim fills resting orders at market)' },
  { cid: 'MANUAL-FLATTEN-OCO-TEST-20261007', side: 'BUY', px: 31272.00, note: 'manual flatten closing the above' },
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
