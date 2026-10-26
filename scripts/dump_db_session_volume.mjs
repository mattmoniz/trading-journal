// Dumps full-session volume per trade date from price_bars_primary to scratch/db_session_volume_20261026.json (the reconciliation target for build_vap_daily_20261026.py).
import fs from 'fs';
import { query } from '../server/db.js';
const r = (await query(`SELECT (CASE WHEN EXTRACT(hour FROM ts) >= 18 THEN ts::date + 1 ELSE ts::date END)::text d, SUM(volume)::float v, COUNT(*)::int n FROM price_bars_primary WHERE symbol='NQ' AND ts >= '2023-03-01' AND ts < CURRENT_DATE + interval '17 hours' AND NOT (EXTRACT(hour FROM ts) = 17) GROUP BY 1 ORDER BY 1`)).rows;
const o = {}; for (const x of r) o[x.d] = { v: x.v, n: x.n }; fs.writeFileSync('scratch/db_session_volume_20261026.json', JSON.stringify(o)); console.log(r.length, r[0], r[r.length - 1]);
process.exit(0);
