/**
 * backfill_developing_value.js
 *
 * One-time backfill of developing_value_log across all historical NQ RTH
 * sessions, sequential (each session's migration is computed vs the
 * previously-persisted session). Safe to re-run (ON CONFLICT DO UPDATE).
 */
import { query } from '../server/db.js';
import { computeAndPersistSession } from '../server/services/developingValueService.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

async function main() {
  const sessQ = await query(`
    SELECT ts::date::text AS trade_date, COUNT(*) AS bars
    FROM price_bars
    WHERE symbol='NQ' AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
      AND ts::date < CURRENT_DATE
    GROUP BY ts::date HAVING COUNT(*) >= 60
    ORDER BY ts::date
  `);
  console.log(`Sessions to backfill: ${sessQ.rows.length}`);

  let done = 0;
  for (const row of sessQ.rows) {
    const r = await computeAndPersistSession(row.trade_date);
    if (r) done++;
  }
  console.log(`Done: ${done}/${sessQ.rows.length}`);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
