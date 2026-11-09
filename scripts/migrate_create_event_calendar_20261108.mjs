#!/usr/bin/env node
// One-time (idempotent) creation + load of the macro EVENT CALENDAR (Opus architecture review 2026-11-08, item 3: a calendar of scheduled releases is the main known width driver the HAR-X range model lacks).
// Checked first per docs/DB_MIGRATION_PROTOCOL.md: a NEW table only (CREATE IF NOT EXISTS + INSERT ... ON CONFLICT DO NOTHING), no existing table touched, nothing overwritten, so no backup table is needed. Not the same as macro_events
// (live actual/forecast rows, 19 rows from 2026-06): this holds SCHEDULED release dates 2023-2026 for research and as a model input. Sources (fetched 2026-11-08, official pages, nothing typed from memory):
//   FOMC: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm  (decision = last day of the meeting, statement 14:00 ET; SEP meetings flagged)
//   CPI and Employment Situation (nonfarm payrolls): https://www.bls.gov/schedule/{2023,2024,2025,2026}/home.htm (08:30 ET)
//   EARLY_CLOSE (13:15 ET) and HOLIDAY_SHORT (13:00 ET session end): derived from our own data, sessions in daily_rth_stats with 225 / 210 one-minute bars, not from a calendar.
import { query } from '../server/db.js';
await query(`CREATE TABLE IF NOT EXISTS event_calendar (
  event_date date NOT NULL,
  event_type varchar(16) NOT NULL,       -- FOMC_DECISION | CPI | NFP | EARLY_CLOSE | HOLIDAY_SHORT
  event_time_et varchar(5),              -- 'HH:MM' ET of the release, null for EARLY_CLOSE
  ref text,                              -- reference month for CPI / NFP, 'SEP' for a projections meeting, n_bars for EARLY_CLOSE
  source text NOT NULL,
  loaded_at timestamp NOT NULL DEFAULT localtimestamp,
  PRIMARY KEY (event_date, event_type)
)`);
const FOMC = { '2023-02-01': 0, '2023-03-22': 1, '2023-05-03': 0, '2023-06-14': 1, '2023-07-26': 0, '2023-09-20': 1, '2023-11-01': 0, '2023-12-13': 1,
  '2024-01-31': 0, '2024-03-20': 1, '2024-05-01': 0, '2024-06-12': 1, '2024-07-31': 0, '2024-09-18': 1, '2024-11-07': 0, '2024-12-18': 1,
  '2025-01-29': 0, '2025-03-19': 1, '2025-05-07': 0, '2025-06-18': 1, '2025-07-30': 0, '2025-09-17': 1, '2025-10-29': 0, '2025-12-10': 1,
  '2026-01-28': 0, '2026-03-18': 1, '2026-04-29': 0, '2026-06-17': 1, '2026-07-29': 0, '2026-09-16': 1, '2026-10-28': 0, '2026-12-09': 1 };
const CPI = [['2023-01-12', 'Dec 2022'], ['2023-02-14', 'Jan 2023'], ['2023-03-14', 'Feb 2023'], ['2023-04-12', 'Mar 2023'], ['2023-05-10', 'Apr 2023'], ['2023-06-13', 'May 2023'], ['2023-07-12', 'Jun 2023'], ['2023-08-10', 'Jul 2023'], ['2023-09-13', 'Aug 2023'], ['2023-10-12', 'Sep 2023'], ['2023-11-14', 'Oct 2023'], ['2023-12-12', 'Nov 2023'],
  ['2024-01-11', 'Dec 2023'], ['2024-02-13', 'Jan 2024'], ['2024-03-12', 'Feb 2024'], ['2024-04-10', 'Mar 2024'], ['2024-05-15', 'Apr 2024'], ['2024-06-12', 'May 2024'], ['2024-07-11', 'Jun 2024'], ['2024-08-14', 'Jul 2024'], ['2024-09-11', 'Aug 2024'], ['2024-10-10', 'Sep 2024'], ['2024-11-13', 'Oct 2024'], ['2024-12-11', 'Nov 2024'],
  ['2025-01-15', 'Dec 2024'], ['2025-02-12', 'Jan 2025'], ['2025-03-12', 'Feb 2025'], ['2025-04-10', 'Mar 2025'], ['2025-05-13', 'Apr 2025'], ['2025-06-11', 'May 2025'], ['2025-07-15', 'Jun 2025'], ['2025-08-12', 'Jul 2025'], ['2025-09-11', 'Aug 2025'], ['2025-10-24', 'Sep 2025'], ['2025-12-18', 'Nov 2025'],
  ['2026-01-13', 'Dec 2025'], ['2026-02-13', 'Jan 2026'], ['2026-03-11', 'Feb 2026'], ['2026-04-10', 'Mar 2026'], ['2026-05-12', 'Apr 2026'], ['2026-06-10', 'May 2026'], ['2026-07-14', 'Jun 2026'], ['2026-08-12', 'Jul 2026'], ['2026-09-11', 'Aug 2026'], ['2026-10-14', 'Sep 2026'], ['2026-11-10', 'Oct 2026'], ['2026-12-10', 'Nov 2026']];
const NFP = [['2023-01-06', 'Dec 2022'], ['2023-02-03', 'Jan 2023'], ['2023-03-10', 'Feb 2023'], ['2023-04-07', 'Mar 2023'], ['2023-05-05', 'Apr 2023'], ['2023-06-02', 'May 2023'], ['2023-07-07', 'Jun 2023'], ['2023-08-04', 'Jul 2023'], ['2023-09-01', 'Aug 2023'], ['2023-10-06', 'Sep 2023'], ['2023-11-03', 'Oct 2023'], ['2023-12-08', 'Nov 2023'],
  ['2024-01-05', 'Dec 2023'], ['2024-02-02', 'Jan 2024'], ['2024-03-08', 'Feb 2024'], ['2024-04-05', 'Mar 2024'], ['2024-05-03', 'Apr 2024'], ['2024-06-07', 'May 2024'], ['2024-07-05', 'Jun 2024'], ['2024-08-02', 'Jul 2024'], ['2024-09-06', 'Aug 2024'], ['2024-10-04', 'Sep 2024'], ['2024-11-01', 'Oct 2024'], ['2024-12-06', 'Nov 2024'],
  ['2025-01-10', 'Dec 2024'], ['2025-02-07', 'Jan 2025'], ['2025-03-07', 'Feb 2025'], ['2025-04-04', 'Mar 2025'], ['2025-05-02', 'Apr 2025'], ['2025-06-06', 'May 2025'], ['2025-07-03', 'Jun 2025'], ['2025-08-01', 'Jul 2025'], ['2025-09-05', 'Aug 2025'], ['2025-11-20', 'Sep 2025'], ['2025-12-16', 'Nov 2025'],
  ['2026-01-09', 'Dec 2025'], ['2026-02-11', 'Jan 2026'], ['2026-03-06', 'Feb 2026'], ['2026-04-03', 'Mar 2026'], ['2026-05-08', 'Apr 2026'], ['2026-06-05', 'May 2026'], ['2026-07-02', 'Jun 2026'], ['2026-08-07', 'Jul 2026'], ['2026-09-04', 'Aug 2026'], ['2026-10-02', 'Sep 2026'], ['2026-11-06', 'Oct 2026'], ['2026-12-04', 'Nov 2026']];
const FED = 'federalreserve.gov/monetarypolicy/fomccalendars.htm 2026-11-08', BLS = (d) => `bls.gov/schedule/${d.slice(0, 4)}/home.htm 2026-11-08`;
const rows = [...Object.entries(FOMC).map(([d, sep]) => [d, 'FOMC_DECISION', '14:00', sep ? 'SEP' : null, FED]), ...CPI.map(([d, r]) => [d, 'CPI', '08:30', r, BLS(d)]), ...NFP.map(([d, r]) => [d, 'NFP', '08:30', r, BLS(d)])];
let n = 0; for (const r of rows) n += (await query(`INSERT INTO event_calendar (event_date, event_type, event_time_et, ref, source) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, r)).rowCount;
// Derived from our own bars: 225 one-minute bars = a 13:15 ET early close (day before / after a holiday), 210 = a holiday session that ends 13:00 ET; sessions with 250-384 bars are DATA GAPS (the first days of the dataset), not events, and are not loaded.
const ec = await query(`INSERT INTO event_calendar (event_date, event_type, event_time_et, ref, source) SELECT trade_date, CASE WHEN n_bars = 225 THEN 'EARLY_CLOSE' ELSE 'HOLIDAY_SHORT' END, CASE WHEN n_bars = 225 THEN '13:15' ELSE '13:00' END, n_bars::text, 'derived: daily_rth_stats n_bars (225 early close, 210 holiday session)' FROM daily_rth_stats WHERE n_bars IN (210, 225) AND trade_date >= '2023-03-01' ON CONFLICT DO NOTHING`);
const c = await query(`SELECT event_type, COUNT(*)::int n, MIN(event_date)::text a, MAX(event_date)::text b FROM event_calendar GROUP BY 1 ORDER BY 1`); console.table(c.rows);
console.log(`inserted ${n + ec.rowCount} new rows`); process.exit(0);
