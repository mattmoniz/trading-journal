#!/usr/bin/env node
// Additive, idempotent (ADD COLUMN IF NOT EXISTS, nullable): signal-bar and next-bar OHLC on vacuum_live_events for the secondary S2 (wick) and S3 (stall) arms of the capitulation overlay. STAGED: apply with scratch/staged_vacuum_ohlc_20261109/APPLY.sh.
import { query } from '../server/db.js';
for (const c of ['sig_open numeric(10,2)', 'sig_high numeric(10,2)', 'sig_low numeric(10,2)', 'nxt_high numeric(10,2)', 'nxt_low numeric(10,2)', 'nxt_close numeric(10,2)']) await query(`ALTER TABLE vacuum_live_events ADD COLUMN IF NOT EXISTS ${c}`);
const r = await query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name='vacuum_live_events'`); console.log(r.rows[0].n, 'columns'); process.exit(0);
