// scripts/backtest_rth_vwap_fade.mjs
//
// Historical backfill + calibration for RTH_VWAP_FADE_LONG/SHORT — the ordinary
// close-range (15pt) VWAP touch, distinct from VWAP_MAGNET's far-away sigma trigger (see
// scripts/backtest_vwap_magnet.mjs, same session). Built 2026-07-28 directly from user
// pushback ("what about fades off the vwap? those are trades too") after VWAP_MAGNET's
// backfill alone was treated as covering "the VWAP fade" — it only covers the rare
// extreme-departure case, not the far more common ordinary touch every other level in
// keepLevelsAll (server/routes/acd.js) gets.
//
// Reuses the REAL live math:
//   - computeRunningVwapSeries (server/services/developingValueService.js) -- same as
//     RTH_VWAP_FADE's live earlyVwap.
//   - resolve() (scripts/backtest_unified.js).
// Direction-from-approach-side matches keepLevelsAll's OWN convention exactly (verified
// directly against server/routes/acd.js ~line 6004: `approachDir = last5[0].close <
// currentPrice ? 'FROM_BELOW' : 'FROM_ABOVE'`, `isLong = approachDir === 'FROM_ABOVE'`) --
// price recently rising into the level from below -> SHORT (fade the rally); price
// recently falling into the level from above -> LONG (fade the decline).
//
// Stop=90pt/target=40pt matches keepLevelsAll's own STOP/TARGET fallback constants (used
// for any level with no calibration yet, acd.js ~line 5414-5415) -- not a fresh guess.
//
// SIMPLIFICATION (matches every other standalone level backfill's own established
// convention -- e.g. scripts/backfill_monthly_vwap_yearly_poc.mjs, scripts/
// repair_weekly_vwap_window_mismatch.mjs): first touch anywhere in RTH, once per day, NOT
// modeling keepLevelsAll's live multi-level "highest-EV wins the poll" priority contest --
// every level's own calibration in this codebase is built the same standalone way.
//
// Run: node scripts/backtest_rth_vwap_fade.mjs [--dry-run]

import { query } from '../server/db.js';
import { getTradingDays, getRTHBars } from './backtest_confluence.js';
import { resolve } from './backtest_unified.js';
import { computeRunningVwapSeries } from '../server/services/developingValueService.js';

const DRY_RUN = process.argv.includes('--dry-run');
const STOP = 90, TARGET = 40;
const TARGET_TYPES = ['RTH_VWAP_FADE_LONG', 'RTH_VWAP_FADE_SHORT'];

async function run() {
  console.log(`Backfill RTH_VWAP_FADE_LONG/SHORT${DRY_RUN ? ' [DRY RUN]' : ''}`);

  if (!DRY_RUN) {
    await query(`DROP TABLE IF EXISTS active_setups_rth_vwap_fade_backfill_backup_20260728`);
    await query(`
      CREATE TABLE active_setups_rth_vwap_fade_backfill_backup_20260728 AS
      SELECT * FROM active_setups WHERE setup_type = ANY($1) AND resolution_method = 'BACKFILL'
    `, [TARGET_TYPES]);
    const cnt = await query(`SELECT COUNT(*) FROM active_setups_rth_vwap_fade_backfill_backup_20260728`);
    console.log(`Backed up ${cnt.rows[0].count} pre-existing backfill row(s) (expect 0 -- brand new setup)`);
    const del = await query(`DELETE FROM active_setups WHERE setup_type = ANY($1) AND resolution_method = 'BACKFILL'`, [TARGET_TYPES]);
    console.log(`Deleted ${del.rowCount} row(s) before re-running`);
  }

  const days = await getTradingDays();
  console.log(`Processing ${days.length} trading days`);

  let inserted = 0;
  const stats = { RTH_VWAP_FADE_LONG: { n: 0, wins: 0, expired: 0, pnl: 0 }, RTH_VWAP_FADE_SHORT: { n: 0, wins: 0, expired: 0, pnl: 0 } };

  for (const d of days) {
    const bars = await getRTHBars(d);
    if (bars.length < 30) continue;
    const vwapSeries = computeRunningVwapSeries(bars);

    let fired = false;
    for (let i = 2; i < bars.length && !fired; i++) {
      const vwap = vwapSeries[i];
      if (vwap == null) continue;
      const dist = Math.abs(bars[i].close - vwap);
      if (dist > 15) continue;

      const back5 = bars[Math.max(0, i - 5)];
      const isLong = !(back5.close < bars[i].close); // FROM_ABOVE -> LONG, matching keepLevelsAll exactly
      const direction = isLong ? 'LONG' : 'SHORT';
      const entry = bars[i].close;
      const stop = isLong ? entry - STOP : entry + STOP;
      const target = isLong ? entry + TARGET : entry - TARGET;
      const setupType = isLong ? 'RTH_VWAP_FADE_LONG' : 'RTH_VWAP_FADE_SHORT';

      const res = resolve(bars, i, direction, entry, stop, target, 240);
      const resolution = res.result === 'EXPIRED' ? 'TIME_EXPIRED' : res.result;
      const status = resolution === 'TIME_EXPIRED' ? 'EXPIRED' : 'RESOLVED';
      const pnl = res.result === 'EXPIRED' ? 0 : res.pnl;
      const resolvedIdx = Math.min(bars.length - 1, i + Math.max(1, res.barsHeld));
      const resolvedAt = resolution === 'TIME_EXPIRED' ? null : bars[resolvedIdx].ts;

      stats[setupType].n++;
      if (resolution === 'TARGET_HIT') stats[setupType].wins++;
      if (resolution === 'TIME_EXPIRED') stats[setupType].expired++;
      stats[setupType].pnl += pnl;

      if (!DRY_RUN) {
        await query(`
          INSERT INTO active_setups (
            trade_date, setup_type, fired_at, expires_at, resolved_at, status, resolution,
            entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label,
            structural_level_touched, structural_level_type, price_at_detection,
            actual_pnl, resolution_method, origin_status, mae_points, mfe_points, replay_resolution
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
          ON CONFLICT DO NOTHING
        `, [
          d, setupType, bars[i].ts, `${d} 16:00:00`, resolvedAt, status, resolution,
          entry, entry, stop, target, `T1: ${TARGET}pt (RTH VWAP fade)`,
          Math.round(vwap * 100) / 100, 'RTH_VWAP', entry,
          Math.round((pnl ?? 0) * 100) / 100, 'BACKFILL', 'BACKFILL',
          Math.round(res.mae * 100) / 100, Math.round(res.mfe * 100) / 100, resolution,
        ]);
      }
      inserted++;
      fired = true; // one touch per day, matching every other standalone level backfill
    }
  }

  console.log(`\n${DRY_RUN ? 'Would insert' : 'Inserted'}: ${inserted}`);
  for (const [type, s] of Object.entries(stats)) {
    const resolved = s.n - s.expired;
    const wr = resolved > 0 ? (s.wins / resolved * 100).toFixed(1) : 'n/a';
    const ev = s.n > 0 ? (s.pnl / s.n).toFixed(2) : 'n/a';
    console.log(`  ${type}: N=${s.n} (${s.expired} expired) WR=${wr}% EV=$${ev}`);
  }
  console.log(`\nNext: run scripts/backtest_setup_status.mjs and scripts/update_optimal_stops.mjs to calibrate real SETUP_STATUS/OPTIMAL_STOP rows from this data.`);
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
