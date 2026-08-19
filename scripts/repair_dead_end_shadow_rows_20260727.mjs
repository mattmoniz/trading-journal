// repair_dead_end_shadow_rows_20260727.mjs
//
// Backfills the historical dead-end rows exposed by the SUPPRESSED_FADE/DOW_SUPPRESSED/
// S2_DOUBLE_COUNTER/TREND_COUNTER_FADE insert-path fix (2026-07-27, docs/OPEN_THREADS.md) --
// rows that fired with only setup_type/fired_at/price_at_detection, never got a real
// entry/stop/target, and were force-closed by expireStaleSetups()'s NO_EXPIRY_SET backstop
// with actual_pnl left permanently null. The live fix stops new rows from happening; this
// script retroactively gives the existing dead rows the same entry/stop/target a live
// candidate would have gotten (using the CURRENT OPTIMAL_STOP calibration for that
// setup_type -- not necessarily identical to whatever was calibrated on that historical
// date, but the same defensible best-available-estimate convention this codebase already
// uses for other retroactive backfills), then walks real historical price_bars_primary bars
// from fired_at through that trading day's RTH close to determine what actually happened.
//
// Run: node scripts/repair_dead_end_shadow_rows_20260727.mjs [--dry-run]

import { query } from '../server/db.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { inferDirection } from '../server/config/setupTypes.js';

const DRY_RUN = process.argv.includes('--dry-run');
const PT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMM = LIVE_INSTRUMENT.commissionPerRoundTrip;

// Fixed 2026-08-19 (gap_direction_bug_survives_calendarview_and_repair_script): the old
// bare-substring check mis-orients any _GAP_UP/_GAP_DOWN conditional-variant setup (e.g.
// WPP_FADE_SHORT_GAP_UP matched "_UP" -> LONG, wrong -- it's a SHORT). This script is
// re-runnable, so a future re-run against a _GAP_* row would have computed a wrong
// direction and written a wrong repair. Reuses the canonical inferDirection() instead of a
// 3rd local copy of this exact bug.
function isLongSetup(setupType) {
  return inferDirection(setupType) === 'LONG';
}

async function main() {
  const targets = await query(`
    SELECT id, setup_type, price_at_detection::float as price_at_detection,
      fired_at::text as fired_at, trade_date::text as trade_date, suppression_reason
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW') AND resolution='NO_EXPIRY_SET' AND actual_pnl IS NULL
      AND entry_zone_low IS NULL AND stop_level IS NULL AND t1_level IS NULL
    ORDER BY fired_at
  `);
  console.log(`Found ${targets.rows.length} dead-end rows to repair${DRY_RUN ? ' [DRY RUN]' : ''}`);

  if (!DRY_RUN) {
    await query(`CREATE TABLE IF NOT EXISTS active_setups_dead_end_repair_backup_20260727 AS
      SELECT * FROM active_setups WHERE id = ANY($1)`,
      [targets.rows.map(r => r.id)]);
    console.log(`Backed up ${targets.rows.length} rows to active_setups_dead_end_repair_backup_20260727`);
  }

  const optCache = {};
  let fixed = 0, targetHit = 0, stopHit = 0, stillUnresolved = 0;

  for (const row of targets.rows) {
    if (!(row.setup_type in optCache)) {
      const optRes = await query(`
        SELECT optimal_stop::float as stop, optimal_target::float as target
        FROM performance_audit WHERE signal_type='OPTIMAL_STOP' AND signal_name=$1
        ORDER BY run_date DESC LIMIT 1
      `, [row.setup_type]);
      optCache[row.setup_type] = optRes.rows[0] || { stop: 90, target: 40 };
    }
    const { stop: stopPts, target: targetPts } = optCache[row.setup_type];
    const isLong = isLongSetup(row.setup_type);
    const entry = row.price_at_detection;
    const stopLevel = isLong ? entry - stopPts : entry + stopPts;
    const t1Level = isLong ? entry + targetPts : entry - targetPts;

    // Walk real bars from fired_at through the next RTH close (16:00 ET) -- rolled to the
    // FOLLOWING day when fired_at itself is already past that cutoff (a handful of
    // SUPPRESSED_FADE rows fired minutes after 4PM, right at the RTH/Globex boundary --
    // capping strictly at same-day 960min left zero eligible bars for those even though
    // real data existed, found via test_invariants.mjs check [7] still failing after the
    // first repair pass).
    const barsRes = await query(`
      SELECT ts::text as ts, high::float as high, low::float as low, close::float as close
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts > $1::timestamp
        AND ts <= ($1::timestamp::date + INTERVAL '1 day' + INTERVAL '16 hours')
      ORDER BY ts ASC
    `, [row.fired_at]);

    let resolution = null, actualPnl = null, priceAtRes = null, resolvedAt = null, maeP = null, mfeP = null;
    let maxAdverse = 0, maxFavorable = 0;
    for (const bar of barsRes.rows) {
      const adverse = isLong ? entry - bar.low : bar.high - entry;
      const favorable = isLong ? bar.high - entry : entry - bar.low;
      if (adverse > maxAdverse) maxAdverse = adverse;
      if (favorable > maxFavorable) maxFavorable = favorable;
      const hitStop = isLong ? bar.low <= stopLevel : bar.high >= stopLevel;
      const hitTarget = isLong ? bar.high >= t1Level : bar.low <= t1Level;
      if (hitStop && hitTarget) { resolution = 'STOP_HIT'; priceAtRes = stopLevel; resolvedAt = bar.ts; break; }
      if (hitStop) { resolution = 'STOP_HIT'; priceAtRes = stopLevel; resolvedAt = bar.ts; break; }
      if (hitTarget) { resolution = 'TARGET_HIT'; priceAtRes = t1Level; resolvedAt = bar.ts; break; }
    }
    if (!resolution && barsRes.rows.length) {
      // Ran to end of window without hitting either -- mark-to-market at last close,
      // matching the TIME_EXPIRED mark-to-market convention fixed 2026-07-20.
      const lastClose = barsRes.rows[barsRes.rows.length - 1].close;
      resolution = 'TIME_EXPIRED';
      priceAtRes = lastClose;
      resolvedAt = barsRes.rows[barsRes.rows.length - 1].ts;
    }
    if (!resolution) { stillUnresolved++; continue; } // no bars at all for that window -- leave untouched

    if (resolution === 'TARGET_HIT') { actualPnl = targetPts * PT - COMM; targetHit++; }
    else if (resolution === 'STOP_HIT') { actualPnl = -(stopPts * PT + COMM); stopHit++; }
    else { const signedPts = isLong ? priceAtRes - entry : entry - priceAtRes; actualPnl = signedPts * PT - COMM; }
    maeP = Math.round(maxAdverse * 100) / 100;
    mfeP = Math.round(maxFavorable * 100) / 100;

    if (!DRY_RUN) {
      await query(`
        UPDATE active_setups SET
          entry_zone_low=$2, entry_zone_high=$2, stop_level=$3, t1_level=$4, t1_label=$5,
          resolution=$6, resolution_method='RETROACTIVE_REPAIR', actual_pnl=$7,
          price_at_resolution=$8, resolved_at=$9::timestamp, mae_points=$10, mfe_points=$11,
          updated_at=NOW()
        WHERE id=$1
      `, [row.id, entry, stopLevel, t1Level, `T1: ${targetPts}pt · Stop: ${stopPts}pt (retroactive repair)`,
          resolution, Math.round(actualPnl * 100) / 100, priceAtRes, resolvedAt, maeP, mfeP]);
    }
    fixed++;
  }

  console.log(`\nDone. ${fixed} rows repaired (${targetHit} TARGET_HIT, ${stopHit} STOP_HIT, ${fixed - targetHit - stopHit} TIME_EXPIRED), ${stillUnresolved} left untouched (no bar data for their window).`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
