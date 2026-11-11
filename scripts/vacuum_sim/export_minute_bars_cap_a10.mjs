// Read-only: NQ minute bars 2026-06-14 .. 2026-10-10 (exclusive end) for the A10 stop/expiry simulation (prices only). Naive ET strings.
import fs from 'fs';
import { query } from '../../server/db.js';
const r = await query(`SELECT to_char(ts,'YYYY-MM-DD HH24:MI:SS') t, open::float o, high::float h, low::float l, close::float c FROM price_bars_primary WHERE symbol='NQ' AND ts >= '2026-06-14'::date AND ts < '2026-10-10'::date ORDER BY ts`);
fs.writeFileSync('scratch/capitulation_replay_20261109/a10_minute_bars.tsv', r.rows.map((x) => `${x.t}\t${x.o}\t${x.h}\t${x.l}\t${x.c}`).join('\n')); console.log('minute bars', r.rows.length); process.exit(0);
