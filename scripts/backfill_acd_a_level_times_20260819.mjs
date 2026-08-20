// One-off backfill: acd_daily_log.a_up_time/a_down_time have been NULL for every historical
// row since inception -- resolves OPEN_DECISION a_level_time_columns_never_populated. The 4
// live INSERT sites (server/index.js's autoComputeTodayACD/autoBulkBackfillIfEmpty,
// server/routes/acd.js's /acd/autocompute + its batch sibling) were fixed 2026-08-19 to persist
// computeACDFromBars()'s own aUpTime/aDownTime going forward; this script fills in existing rows.
//
// Safety: acd_daily_log does not store or_minutes/sustain_minutes per row (only a_multiplier),
// so a blind re-run of computeACDFromBars() with today's "best" params could silently disagree
// with whatever params were live when an older row was actually computed. Per
// docs/DB_MIGRATION_PROTOCOL.md, this only trusts a recomputed aUpTime/aDownTime when the
// recompute's aUpLevel/aDownLevel/aUpFired/aDownFired all match the already-stored values
// exactly (levels rounded to the same 2dp computeACDFromBars itself uses) -- any mismatch is
// skipped and reported, never silently written. Only fills NULL columns, never overwrites a
// non-null value, so no backup table needed (nothing existing gets destroyed).
//
// Dry run (default): node scripts/backfill_acd_a_level_times_20260819.mjs
// Apply:              node scripts/backfill_acd_a_level_times_20260819.mjs --apply

import { query } from '../server/db.js';
import { computeACDFromBars, getBestACDParams } from '../server/services/acdService.js';

const APPLY = process.argv.includes('--apply');

async function main() {
  const { orMins, aMult, sustainMins } = await getBestACDParams();
  console.log(`Using params: orMins=${orMins} aMult=${aMult} sustainMins=${sustainMins}`);

  const rows = await query(`
    SELECT trade_date::text as trade_date, a_up_level, a_down_level, a_up_fired, a_down_fired
    FROM acd_daily_log
    WHERE (a_up_fired AND a_up_time IS NULL) OR (a_down_fired AND a_down_time IS NULL)
    ORDER BY trade_date
  `);
  console.log(`${rows.rows.length} row(s) with a fired A-level and no recorded time.`);

  let matched = 0, mismatched = 0, noBars = 0;
  const mismatches = [];

  for (const row of rows.rows) {
    const result = await computeACDFromBars(row.trade_date, orMins, aMult, sustainMins);
    if (!result) { noBars++; continue; }

    const levelsMatch =
      Math.abs(result.aUpLevel - parseFloat(row.a_up_level)) < 0.01 &&
      Math.abs(result.aDownLevel - parseFloat(row.a_down_level)) < 0.01;
    const firedMatch = result.aUpFired === row.a_up_fired && result.aDownFired === row.a_down_fired;

    if (!levelsMatch || !firedMatch) {
      mismatched++;
      mismatches.push({ trade_date: row.trade_date, stored: row, recomputed: { aUpLevel: result.aUpLevel, aDownLevel: result.aDownLevel, aUpFired: result.aUpFired, aDownFired: result.aDownFired } });
      continue;
    }

    matched++;
    if (APPLY) {
      await query(`UPDATE acd_daily_log SET a_up_time = COALESCE(a_up_time, $2), a_down_time = COALESCE(a_down_time, $3) WHERE trade_date = $1`,
        [row.trade_date, result.aUpTime, result.aDownTime]);
    }
  }

  console.log(`\nMatched (safe to backfill): ${matched}`);
  console.log(`Mismatched (skipped, params/level disagreement): ${mismatched}`);
  console.log(`No bar data: ${noBars}`);
  if (mismatches.length) {
    console.log('\nMismatched dates:');
    for (const m of mismatches) console.log(`  ${m.trade_date}: stored a_up_level=${m.stored.a_up_level} a_down_level=${m.stored.a_down_level} a_up_fired=${m.stored.a_up_fired} a_down_fired=${m.stored.a_down_fired} vs recomputed a_up_level=${m.recomputed.aUpLevel} a_down_level=${m.recomputed.aDownLevel} a_up_fired=${m.recomputed.aUpFired} a_down_fired=${m.recomputed.aDownFired}`);
  }
  console.log(APPLY ? '\nApplied.' : '\nDry run only -- re-run with --apply to write.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
