// Read-only export of the setup rows for the capitulation replay Phase 1 (no P&L column is selected).
import fs from 'fs';
import { query } from '../../server/db.js';
const r = await query(`SELECT id, setup_type, bet_class, origin_status, is_cluster_primary, trade_date::text td, fired_at::text f, resolved_at::text rs
  FROM active_setups WHERE ((trade_date BETWEEN '2023-03-07' AND '2025-05-16') OR (trade_date BETWEEN '2026-06-15' AND '2026-10-09'))
  AND setup_type !~ '^VACUUM_EXP' AND setup_type ~ '_(LONG|SHORT)' AND origin_status IN ('BACKFILL','ACTIVE','SHADOW') AND is_cluster_primary AND resolved_at IS NOT NULL
  AND NOT (trade_date BETWEEN '2026-07-09' AND '2026-09-16' AND fired_at::time >= '16:00' AND fired_at::time < '18:00') ORDER BY fired_at`);
fs.writeFileSync('scratch/capitulation_replay_20261109/rows.json', JSON.stringify(r.rows)); console.log('rows', r.rows.length); process.exit(0);
