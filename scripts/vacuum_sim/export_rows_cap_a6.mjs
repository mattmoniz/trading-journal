// Read-only export for the capitulation-exit replay A6 (all real setup rows, 2026 depth-era window). GEOMETRY ONLY here (no P&L); the P&L file is written separately by export_pnl_cap_a6.mjs and read only by --go.
import fs from 'fs';
import { query } from '../../server/db.js';
const r = await query(`SELECT id, setup_type, bet_class, origin_status, trade_date::text td, fired_at::text f, resolved_at::text rs, expires_at::text exp, COALESCE(price_at_detection, entry_zone_high)::float p0, stop_level::float stp, t1_level::float t1
  FROM active_setups WHERE trade_date BETWEEN '2026-06-15' AND '2026-10-09' AND origin_status IN ('ACTIVE','SHADOW') AND is_cluster_primary AND resolved_at IS NOT NULL AND setup_type !~ '^VACUUM_EXP' AND setup_type !~ '^TURN_'
  AND NOT (trade_date BETWEEN '2026-07-09' AND '2026-09-16' AND fired_at::time >= '16:00' AND fired_at::time < '18:00') ORDER BY fired_at`);
const adrCache = new Map();
async function adr20(td) {           // same definition as capitulation_exit_shadow.mjs: mean RTH high-low of the 20 latest RTH sessions strictly before the trade date; both ts bounds (cv-009)
  if (adrCache.has(td)) return adrCache.get(td);
  const q = await query(`SELECT h - l AS rng FROM (SELECT ts::date d, max(high) h, min(low) l FROM price_bars_primary WHERE symbol='NQ' AND ts >= ($1::date - 50) AND ts < $1::date AND ts::time >= '09:30' AND ts::time < '16:00' GROUP BY 1) q ORDER BY d DESC LIMIT 20`, [td]);
  const v = q.rows.length >= 15 ? q.rows.reduce((a, x) => a + Number(x.rng), 0) / q.rows.length : null; adrCache.set(td, v); return v;
}
for (const x of r.rows) x.adr = await adr20(x.td);
fs.mkdirSync('scratch/capitulation_replay_20261109', { recursive: true });
fs.writeFileSync('scratch/capitulation_replay_20261109/a6_rows.json', JSON.stringify(r.rows)); console.log('a6 rows', r.rows.length);
const p = await query(`SELECT id, actual_pnl::float pnl FROM active_setups WHERE id = ANY($1)`, [r.rows.map(x => x.id)]);
fs.writeFileSync('scratch/capitulation_replay_20261109/a6_pnl.json', JSON.stringify(p.rows)); console.log('a6 pnl file written (not read before --go)'); process.exit(0);
