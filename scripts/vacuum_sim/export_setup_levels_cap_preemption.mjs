// Read-only: entry / stop / t1 price levels for the replay rows (no P&L, no resolution price).
import fs from 'fs';
import { query } from '../../server/db.js';
const r = await query(`SELECT id, price_at_detection::float p0, stop_level::float stp, t1_level::float t1 FROM active_setups WHERE id = ANY($1)`, [JSON.parse(fs.readFileSync('scratch/capitulation_replay_20261109/rows.json')).map(x => x.id)]);
fs.writeFileSync('scratch/capitulation_replay_20261109/row_levels.json', JSON.stringify(r.rows)); console.log('levels', r.rows.length); process.exit(0);
