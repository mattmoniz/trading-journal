// 2026-11-09: link columns for the Sim1 order wiring of the expansion rule (server/services/vacuumLiveOrders.js). Additive only: two nullable columns on vacuum_live_events (the shadow table written by scripts/vacuum_live/shadow.py).
// order_state: NULL = not yet considered, LINKED, or SKIPPED_* (window/stale/busy/price/disarmed/disabled/dup). Safe to re-run.
import { query } from '../server/db.js';
await query(`ALTER TABLE vacuum_live_events ADD COLUMN IF NOT EXISTS active_setup_id integer, ADD COLUMN IF NOT EXISTS order_state varchar(24)`);
const r = await query(`SELECT column_name FROM information_schema.columns WHERE table_name='vacuum_live_events' AND column_name IN ('active_setup_id','order_state')`);
console.log('columns present:', r.rows.map((x) => x.column_name).join(', '));
process.exit(0);
