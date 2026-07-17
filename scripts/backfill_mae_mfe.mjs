// =============================================================================
// Backfill MAE/MFE for all active_setups rows that are missing it.
// Replays bar-by-bar from fired_at to end of RTH session.
// Safe to re-run — only touches rows where mae_points IS NULL.
// =============================================================================

import { query } from '../server/db.js';
import { replayBars, directionFromType } from '../server/services/maeMfeReplay.js';

const BATCH_REPORT_EVERY = 100;

async function main() {
  console.log('='.repeat(80));
  console.log('BACKFILL MAE/MFE — active_setups');
  console.log('='.repeat(80));

  // 1. Fetch all setups needing backfill
  const setupsRes = await query(`
    SELECT id, trade_date, setup_type, fired_at,
           entry_zone_low::float                                    AS entry_low,
           COALESCE(entry_zone_high, entry_zone_low)::float         AS entry_high,
           stop_level::float                                        AS stop,
           t1_level::float                                          AS t1
    FROM active_setups
    WHERE mae_points IS NULL
      AND entry_zone_low IS NOT NULL
      AND stop_level     IS NOT NULL
      AND t1_level       IS NOT NULL
      AND fired_at       IS NOT NULL
    ORDER BY trade_date, fired_at
  `);

  const setups = setupsRes.rows;
  console.log(`Setups needing backfill: ${setups.length}`);
  if (setups.length === 0) {
    console.log('Nothing to do.');
    process.exit(0);
  }

  // 2. Batch-load bars by date (one DB round-trip per unique date)
  const dates = [...new Set(setups.map(s => s.trade_date))];
  console.log(`Loading bars for ${dates.length} unique dates...`);

  const barsByDate = {};
  for (const d of dates) {
    const res = await query(`
      SELECT ts, open::float, high::float, low::float, close::float
      FROM price_bars_primary
      WHERE symbol = 'NQ'
        AND ts::date = $1
        AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 960
      ORDER BY ts
    `, [d]);
    barsByDate[d] = res.rows;
  }
  console.log('Bars loaded.\n');

  // 3. Replay each setup, collect updates
  let processed = 0, updated = 0, skipped = 0;

  for (const setup of setups) {
    processed++;

    const entry     = (setup.entry_low + setup.entry_high) / 2;
    const stop      = setup.stop;
    const t1        = setup.t1;
    const direction = directionFromType(setup.setup_type);
    const firedAt   = new Date(setup.fired_at);

    const allBars   = barsByDate[setup.trade_date] ?? [];
    const bars      = allBars.filter(b => new Date(b.ts) >= firedAt);

    const result    = replayBars(bars, entry, stop, t1, direction);

    if (!result) {
      skipped++;
      continue;
    }

    await query(`
      UPDATE active_setups SET
        mae_points          = $2,
        mfe_points          = $3,
        bars_to_resolution  = $4,
        resolution_bar_time = $5,
        replay_resolution   = $6,
        updated_at          = NOW()
      WHERE id = $1
    `, [
      setup.id,
      result.mae,
      result.mfe,
      result.barsToResolution,
      result.resolutionBarTime,
      result.replayResolution,
    ]);

    updated++;

    if (processed % BATCH_REPORT_EVERY === 0) {
      console.log(`  ${processed}/${setups.length} processed, ${updated} updated, ${skipped} skipped (inverted levels / no bars)`);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log(`DONE. ${updated} rows updated, ${skipped} skipped, ${processed} total processed.`);
  console.log('='.repeat(80));
  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
