// RTH (09:30-16:00 ET) high/low per trade date from price_bars_primary for the sealed window, used by extract_volbars_20261028.py --holdout as its price check (the DB RTH VOLUME is inflated about 2.7x on some mid-2025 dates, so the volume check cannot be used there).
// Output scratch/db_rth_hilo_holdout_20261103.json {date: [high, low]}. Both ts bounds given (cv-009).
import { query } from '../../server/db.js';
import fs from 'fs';
const r = await query(`SELECT ts::date::text AS d, MAX(high)::float AS h, MIN(low)::float AS l FROM price_bars_primary
  WHERE symbol='NQ' AND ts >= '2025-05-19' AND ts < '2026-10-21' AND ts::time >= '09:30' AND ts::time < '16:00' GROUP BY 1 ORDER BY 1`);
const o = {}; for (const x of r.rows) o[x.d] = [x.h, x.l];
fs.writeFileSync(new URL('../../scratch/db_rth_hilo_holdout_20261103.json', import.meta.url), JSON.stringify(o)); console.log(Object.keys(o).length, 'dates'); process.exit(0);
