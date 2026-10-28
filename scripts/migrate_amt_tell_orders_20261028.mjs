#!/usr/bin/env node
// One-time migration (idempotent), Stage 2 of the live tell detector: link a logged virtual trade to the active_setups row that carries its real order, and record WHY a tell was not ordered.
//   amt_tell_trades.active_setup_id  -- the active_setups row written by server/services/amtTellOrders.js (NULL = never ordered); unique when set
//   amt_tell_trades.order_state      -- NULL (not considered yet) | LINKED | SKIPPED_STALE | SKIPPED_BUSY | SKIPPED_PRICE | SKIPPED_DUP | SKIPPED_DISABLED
// Only the V1 book under the split bar reading is ever considered (docs/AMT_TELL_LIVE_PROJECT_SPEC_20261028.md section 11). Both columns are new and nullable, existing rows are untouched.
import { query } from '../server/db.js';
async function main() {
  await query(`ALTER TABLE amt_tell_trades ADD COLUMN IF NOT EXISTS active_setup_id integer`);
  await query(`ALTER TABLE amt_tell_trades ADD COLUMN IF NOT EXISTS order_state varchar(16)`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_amt_tell_trades_active_setup ON amt_tell_trades (active_setup_id) WHERE active_setup_id IS NOT NULL`);
  const c = await query(`SELECT column_name, data_type, character_maximum_length FROM information_schema.columns WHERE table_name='amt_tell_trades' AND column_name IN ('active_setup_id','order_state') ORDER BY 1`);
  console.log(c.rows);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
