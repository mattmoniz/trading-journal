// One-time ledger record (2026-10-07). Records the manual MARKET SELL 1 MNQZ6.CME on Sim1 that filled
// at 31500.25 (flattening the open long from setup 131378's stop). Inserted with setup_id NULL because
// no app setup owns it; reconcileAgainstBroker/checkPositionInvariant count null-setup rows after the
// baseline (see reconciliation.js). submitted_at is the recording time, not the real order time.
// Usage: node scripts/record_manual_flatten_20261007.mjs [--apply]   (default is dry run)
import { query } from '../server/db.js';

const apply = process.argv.includes('--apply');
const CLIENT_ORDER_ID = 'MANUAL-FLATTEN-20261007';
const existing = await query(`SELECT id FROM order_placements WHERE client_order_id = $1`, [CLIENT_ORDER_ID]);
if (existing.rows.length > 0) { console.log('already recorded, id', existing.rows[0].id); process.exit(0); }
const row = {
  purpose: 'EXIT', setup_id: null, client_order_id: CLIENT_ORDER_ID, symbol: 'MNQZ6.CME', exchange: '',
  side: 'SELL', order_type: 'MARKET', quantity: 1, price1: null, price2: null, trade_account: 'Sim1',
  status: 'FILLED', filled_quantity: 1, avg_fill_price: 31500.25, position_open: false,
  raw_last_order_update: JSON.stringify({ manual: true, note: 'one-off flatten, sent from a standalone DTC session; fill from the session transcript (Trade simulation fill, Bid 31500.25 Ask 31500.75)' }),
};
console.log('would insert:', row);
if (!apply) { console.log('dry run -- rerun with --apply to insert.'); process.exit(0); }
const r = await query(`
  INSERT INTO order_placements (purpose, setup_id, client_order_id, symbol, exchange, side, order_type, quantity, price1, price2, trade_account, status, filled_quantity, avg_fill_price, position_open, raw_last_order_update, submitted_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, NOW())
  RETURNING id`,
  [row.purpose, row.setup_id, row.client_order_id, row.symbol, row.exchange, row.side, row.order_type, row.quantity, row.price1, row.price2, row.trade_account, row.status, row.filled_quantity, row.avg_fill_price, row.position_open, row.raw_last_order_update]);
console.log('inserted id', r.rows[0].id);
process.exit(0);
