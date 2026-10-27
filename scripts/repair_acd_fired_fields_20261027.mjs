// Second ACD repair (2026-10-27): on the 51 dates whose opening range was repaired (scratch/acd_or_repaired_dates_20261027.json), recompute the fields that were still computed against the old prices:
// a_up_fired/a_down_fired/times, c_*_confirmed, daily_score, session_close (production computeACDFromBars, same columns POST /api/acd/autocompute writes, each row's OWN stored a_multiplier kept)
// and acd_setup_events (delete the date's rows, rescan with production scanAndSaveSetupEvents). day_type is done separately by scripts/derive_day_types.js. Backups first.
import fs from 'fs';
import { query } from '../server/db.js';
import { computeACDFromBars, getBestACDParams, scanAndSaveSetupEvents } from '../server/services/acdService.js';
const dates = JSON.parse(fs.readFileSync('scratch/acd_or_repaired_dates_20261027.json')); const best = await getBestACDParams();
await query(`CREATE TABLE IF NOT EXISTS acd_daily_log_fired_repair_backup_20261027 AS SELECT * FROM acd_daily_log WHERE trade_date = ANY($1::date[])`.replace('$1', `'{${dates.join(',')}}'`));
await query(`CREATE TABLE IF NOT EXISTS acd_setup_events_repair_backup_20261027 AS SELECT * FROM acd_setup_events WHERE trade_date = ANY('{${dates.join(',')}}'::date[])`);
let upd = 0, ev = 0;
for (const d of dates) {
  const cur = (await query(`SELECT a_multiplier::float m FROM acd_daily_log WHERE trade_date=$1`, [d])).rows[0];
  const r = await computeACDFromBars(d, best.orMins, cur.m || best.aMult, best.sustainMins); if (!r) { console.log(d, 'no result'); continue; }
  await query(`UPDATE acd_daily_log SET a_up_fired=$2, a_down_fired=$3, a_up_time=$4, a_down_time=$5, c_up_confirmed=$6, c_down_confirmed=$7, daily_score=$8, session_close=$9 WHERE trade_date=$1`, [d, r.aUpFired, r.aDownFired, r.aUpTime, r.aDownTime, r.cUpConfirmed, r.cDownConfirmed, r.score, r.sessionClose]); upd++;
  await query(`DELETE FROM acd_setup_events WHERE trade_date=$1`, [d]); await scanAndSaveSetupEvents(d);
  ev += (await query(`SELECT COUNT(*)::int n FROM acd_setup_events WHERE trade_date=$1`, [d])).rows[0].n;
}
console.log(`updated ${upd} of ${dates.length} rows; events rebuilt: ${ev} rows`);
const b = (await query(`SELECT COUNT(*)::int n FROM acd_setup_events_repair_backup_20261027`)).rows[0].n; console.log('old event rows backed up:', b);
process.exit(0);
