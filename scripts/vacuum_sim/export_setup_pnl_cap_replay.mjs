// Read-only export of actual_pnl (DOLLARS per 1 MNQ) for the capitulation replay rows. OUTCOME-BEARING: only the --go replay reads the file it writes (look first, hr-023).
import fs from 'fs';
import { query } from '../../server/db.js';
const ids = JSON.parse(fs.readFileSync('scratch/capitulation_replay_20261109/rows.json')).map((x) => x.id);
const r = await query(`SELECT id, actual_pnl::float pnl FROM active_setups WHERE id = ANY($1)`, [ids]);
fs.writeFileSync('scratch/capitulation_replay_20261109/row_pnl.json', JSON.stringify(r.rows)); console.log('pnl rows', r.rows.length); process.exit(0);
