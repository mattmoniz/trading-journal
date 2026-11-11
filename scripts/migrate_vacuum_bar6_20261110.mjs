#!/usr/bin/env node
// One-time idempotent migration (docs/DB_MIGRATION_PROTOCOL.md): forward flag of the bar-6 checkpoint of the liquidity pull (formerly 'vacuum') trade on vacuum_live_events.
// ADD COLUMN IF NOT EXISTS only (additive, nullable, no default, no rewrite, no backfill here); written by scripts/vacuum_live/shadow.py (b6_src 'LIVE') and scripts/vacuum_live/backfill_bar6_20261110.py (b6_src 'BACKFILL').
// Gates nothing: no order code reads these columns (docs/VACUUM_BAR6_EXIT_PREREG_20261110.md next-step tree).
import { query } from '../server/db.js';
const cols = [['b6_status', 'varchar(14)'], ['b6_close', 'numeric(10,2)'], ['b6_net_a', 'numeric(9,2)'], ['b6_net_b', 'numeric(9,2)'], ['b6_net_c', 'numeric(9,2)'], ['b6_src', 'varchar(8)'], ['b6_at', 'timestamp']];
for (const [c, t] of cols) await query(`ALTER TABLE vacuum_live_events ADD COLUMN IF NOT EXISTS ${c} ${t}`);
const r = await query(`SELECT column_name, data_type, character_maximum_length FROM information_schema.columns WHERE table_name='vacuum_live_events' AND column_name LIKE 'b6\\_%' ORDER BY ordinal_position`);
console.log(JSON.stringify(r.rows)); process.exit(0);
