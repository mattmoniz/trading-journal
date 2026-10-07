// One-time ledger record (2026-10-07, second flatten). Manual MARKET SELL 2 MNQZ6.CME on Sim1 filled at
// 31491.75, closing the 2-contract long left open after the 20:36 exits. Inserted with setup_id NULL
// (no owning setup). submitted_at is the recording time, not the real order time.
// Usage: node scripts/record_manual_flatten_20261007b.mjs [--apply]   (default is dry run)
import { query } from '../server/db.js';
const apply = process.argv.includes('--apply');
const CID = 'MANUAL-FLATTEN2-20261007';
const ex = await query(`SELECT id FROM order_placements WHERE client_order_id = $1`, [CID]);
if (ex.rows.length) { console.log('already recorded, id', ex.rows[0].id); process.exit(0); }
if (!apply) { console.log('dry run: would insert SELL 2 MNQZ6.CME @31491.75 Sim1 (manual). Rerun with --apply.'); process.exit(0); }
const r = await query(`
  INSERT INTO order_placements (purpose, setup_id, client_order_id, symbol, exchange, side, order_type, quantity, trade_account, status, filled_quantity, avg_fill_price, position_open, raw_last_order_update, submitted_at)
  VALUES ('EXIT', NULL, $1, 'MNQZ6.CME', '', 'SELL', 'MARKET', 2, 'Sim1', 'FILLED', 2, 31491.75, false, $2, NOW())
  RETURNING id`, [CID, JSON.stringify({ manual: true, note: 'one-off flatten of 2-contract long, Trade simulation fill Bid 31491.75 Ask 31492.25' })]);
console.log('inserted id', r.rows[0].id);
process.exit(0);
