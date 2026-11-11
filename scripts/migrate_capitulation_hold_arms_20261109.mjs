#!/usr/bin/env node
// One-time idempotent migration (docs/DB_MIGRATION_PROTOCOL.md): ADDITIVE nullable columns only on capitulation_exit_shadow (61 rows, a shadow log nothing else writes): the replace-the-target arms C0 and H (docs/CAPITULATION_REPLACE_TARGET_FORWARD_PREREG_20261109.md).
// Existing columns, indexes and the early-exit arm (sig_*, virt_pnl, delta_pnl, state) are untouched.
import { query } from '../server/db.js';
const cols = [
  ['stop_px', 'numeric(10,2)'], ['expires_at', 'timestamp'],
  ['c0_state', 'varchar(8)'], ['c0_exit_at', 'timestamp'], ['c0_exit_px', 'numeric(10,2)'], ['c0_pnl', 'numeric(10,2)'],
  ['h_state', 'varchar(8)'], ['h_exit_at', 'timestamp'], ['h_exit_px', 'numeric(10,2)'], ['h_pnl', 'numeric(10,2)'], ['h_sig_event_id', 'bigint'],
  ['hc0_delta', 'numeric(10,2)'], ['ha_delta', 'numeric(10,2)'], ['hold_arms_at', 'timestamp'],
];
for (const [c, t] of cols) await query(`ALTER TABLE capitulation_exit_shadow ADD COLUMN IF NOT EXISTS ${c} ${t}`);
const r = await query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name='capitulation_exit_shadow'`); console.log(r.rows[0].n, 'columns'); process.exit(0);
