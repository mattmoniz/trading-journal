#!/usr/bin/env node
// Additive, idempotent (ADD COLUMN IF NOT EXISTS, all nullable) after the Argon review of 2026-11-09 (docs/ARGON_REVIEW_AUDIT_ROWS28_31_20261109.md): the STRICT signal (80th percentile extension) and the scale-free wide boundary tag, both SECONDARY (not counted).
import { query } from '../server/db.js';
for (const c of ['near_boundary_stopw boolean', 'boundary_dist_stopw numeric(9,3)', 'stop_width numeric(9,2)', 'sig80_event_id bigint', 'sig80_fired_at timestamp', 'sig80_ext numeric(8,4)', 'sig80_exit_px numeric(10,2)', 'sig80_virt_pnl numeric(10,2)', 'sig80_delta numeric(10,2)'])
  await query(`ALTER TABLE capitulation_exit_shadow ADD COLUMN IF NOT EXISTS ${c}`);
const r = await query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name='capitulation_exit_shadow'`); console.log(r.rows[0].n, 'columns'); process.exit(0);
