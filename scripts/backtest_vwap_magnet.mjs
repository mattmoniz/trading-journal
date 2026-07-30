// scripts/backtest_vwap_magnet.mjs
//
// Historical backfill + calibration for VWAP_MAGNET_LONG/SHORT (RTH). Built 2026-07-28
// per direct user request that VWAP-based setups "need to be tracked historically...
// same for all setups... they are a level like every other level" -- VWAP_MAGNET has
// been live-wired since well before this session but only ever accumulated forward
// touches (N=17/3 real as of 2026-07-28), never backfilled against history the way
// every other level-fade family in this codebase already has been.
//
// Reuses the REAL live detection math, does not reimplement it:
//   - computeRunningVwapSeries (server/services/developingValueService.js) -- the same
//     cumulative typical-price-weighted-by-volume calculation acd.js's live earlyVwap uses.
//   - getTrailingVwapStd (server/services/queries.js) -- the exact live threshold source,
//     already no-lookahead by construction (only reads session_analysis rows strictly
//     before `date`).
//   - resolve() (scripts/backtest_unified.js) -- the same stop/target bar-walk every other
//     level-fade backfill in this codebase uses.
// Stop=30pt, T1=20pt exactly match server/routes/acd.js's live vwapMagnetSetup
// construction (~line 5310-5338). Resolves as a plain single-target trade -- the live
// setup's "scale out: half at 20pt, runner..." description text has never been
// mechanically enforced (the live INSERT never sets runner_trail_width/extend_target_level),
// so a flat resolve() is what actually happens to a live row today, not a simplification.
//
// A trade can re-fire later the same day after resolving (matching live's own genuine
// re-touch capability, docs/OPEN_THREADS.md 2026-07-17) -- the scan cursor advances past
// each detected trade's own resolution point before continuing to look for the next
// threshold crossing, never re-using bars already claimed by an open trade.
//
// Run: node scripts/backtest_vwap_magnet.mjs [--dry-run]

import { query } from '../server/db.js';
import { getTradingDays, getRTHBars } from './backtest_confluence.js';
import { resolve } from './backtest_unified.js';
import { computeRunningVwapSeries } from '../server/services/developingValueService.js';
import { getTrailingVwapStd } from '../server/services/queries.js';

const DRY_RUN = process.argv.includes('--dry-run');
const STOP = 30, T1 = 20;
const TARGET_TYPES = ['VWAP_MAGNET_LONG', 'VWAP_MAGNET_SHORT'];

async function run() {
  console.log(`Backfill VWAP_MAGNET_LONG/SHORT (RTH)${DRY_RUN ? ' [DRY RUN]' : ''}`);

  if (!DRY_RUN) {
    await query(`DROP TABLE IF EXISTS active_setups_vwap_magnet_backfill_backup_20260728`);
    await query(`
      CREATE TABLE active_setups_vwap_magnet_backfill_backup_20260728 AS
      SELECT * FROM active_setups WHERE setup_type = ANY($1) AND resolution_method = 'BACKFILL'
    `, [TARGET_TYPES]);
    const cnt = await query(`SELECT COUNT(*) FROM active_setups_vwap_magnet_backfill_backup_20260728`);
    console.log(`Backed up ${cnt.rows[0].count} pre-existing backfill row(s) (expect 0 -- never backfilled before)`);
    const del = await query(`DELETE FROM active_setups WHERE setup_type = ANY($1) AND resolution_method = 'BACKFILL'`, [TARGET_TYPES]);
    console.log(`Deleted ${del.rowCount} row(s) before re-running`);
  }

  const days = await getTradingDays();
  console.log(`Processing ${days.length} trading days`);

  let inserted = 0;
  const stats = { VWAP_MAGNET_LONG: { n: 0, wins: 0, expired: 0, pnl: 0 }, VWAP_MAGNET_SHORT: { n: 0, wins: 0, expired: 0, pnl: 0 } };

  for (const d of days) {
    const bars = await getRTHBars(d);
    if (bars.length < 30) continue;
    const vwapSeries = computeRunningVwapSeries(bars);
    const std = await getTrailingVwapStd(d, 30);

    let i = 2; // matches live gate (allRthBarsRow.rows.length >= 3, 0-indexed)
    while (i < bars.length) {
      const vwap = vwapSeries[i];
      if (vwap == null) { i++; continue; }
      const dist = bars[i].close - vwap;
      if (Math.abs(dist) < std.threshold) { i++; continue; }

      const isLong = dist < 0;
      const direction = isLong ? 'LONG' : 'SHORT';
      const entry = bars[i].close;
      const stop = isLong ? entry - STOP : entry + STOP;
      const target = isLong ? entry + T1 : entry - T1;
      const setupType = isLong ? 'VWAP_MAGNET_LONG' : 'VWAP_MAGNET_SHORT';

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
          entry, entry, stop, target, `T1: ${T1}pt (VWAP magnet)`,
          Math.round(vwap * 100) / 100, 'RTH_VWAP', entry,
          Math.round((pnl ?? 0) * 100) / 100, 'BACKFILL', 'BACKFILL',
          Math.round(res.mae * 100) / 100, Math.round(res.mfe * 100) / 100, resolution,
        ]);
      }
      inserted++;
      i = resolvedIdx + 1;
    }
  }

  console.log(`\n${DRY_RUN ? 'Would insert' : 'Inserted'}: ${inserted}`);
  for (const [type, s] of Object.entries(stats)) {
    const resolved = s.n - s.expired;
    const wr = resolved > 0 ? (s.wins / resolved * 100).toFixed(1) : 'n/a';
    const ev = s.n > 0 ? (s.pnl / s.n).toFixed(2) : 'n/a';
    console.log(`  ${type}: N=${s.n} (${s.expired} expired) WR=${wr}% EV=$${ev}`);
  }
  console.log(`\nNext: run scripts/backtest_setup_status.mjs and scripts/update_optimal_stops.mjs (already scheduled weekly, auto-discover new setup_types) to calibrate real SETUP_STATUS/OPTIMAL_STOP rows from this data.`);
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
