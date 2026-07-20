// One-time backfill: re-run the full patternMemoryUpdate pipeline (populateDailyLog ->
// updateConditionMemory -> recalculatePatternStats -> updateSetupMoveStats) for every
// historical trade_date, now that populateDailyLog's session_pnl uses the CumPL-diff
// method (PRO accounts only) instead of a raw SUM(pnl). Idempotent (every write in the
// pipeline is an UPSERT), backed up first — see docs/DB_BACKUP_CATALOG.md.
import { query } from '../server/db.js';
import { runNightlyUpdate } from '../server/services/patternMemoryUpdate.js';

async function main() {
  const datesRes = await query(`SELECT DISTINCT trade_date::text as d FROM daily_performance_log ORDER BY d ASC`);
  const dates = datesRes.rows.map(r => r.d);
  console.log(`Reprocessing ${dates.length} dates...`);
  let done = 0, changed = 0, errors = 0;
  for (const date of dates) {
    const before = await query(`SELECT session_pnl FROM daily_performance_log WHERE trade_date=$1`, [date]);
    const beforeVal = before.rows[0]?.session_pnl;
    const result = await runNightlyUpdate(date);
    if (result?.error) { console.error(`  ERROR ${date}: ${result.error}`); errors++; continue; }
    const after = await query(`SELECT session_pnl FROM daily_performance_log WHERE trade_date=$1`, [date]);
    const afterVal = after.rows[0]?.session_pnl;
    if (parseFloat(beforeVal) !== parseFloat(afterVal)) changed++;
    done++;
    if (done % 50 === 0) console.log(`  ${done}/${dates.length} (${date})`);
  }
  console.log(`Done. ${done} processed, ${changed} session_pnl values changed, ${errors} errors.`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
