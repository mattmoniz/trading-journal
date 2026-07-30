// scripts/backtest_globex_vwap_magnet.mjs
//
// Historical backfill + calibration for GLOBEX_VWAP_MAGNET_LONG/SHORT — the Globex
// sibling of VWAP_MAGNET_LONG/SHORT (see scripts/backtest_vwap_magnet.mjs, same
// session). Built 2026-07-28 directly from a user request that the 24hr VWAP be
// tracked historically "like every other level" — this setup was only wired live for
// the first time this same session (server/routes/acd.js's detectGlobexSetup()), so
// unlike VWAP_MAGNET it has ZERO live history at all; this script is its bootstrap.
//
// Reuses the REAL live detection math, does not reimplement it:
//   - getGlobex24hrBars / getTrailing24hrVwapStd (server/services/queries.js) — the exact
//     functions the live GLOBEX_VWAP_MAGNET candidate uses, themselves a relocation of
//     morningBrief.js's already-validated 24hr-VWAP logic (no lookahead by construction).
//   - computeRunningVwapSeries (server/services/developingValueService.js).
//   - resolve() (scripts/backtest_unified.js).
// Stop=30pt, T1=20pt match the live fallback in acd.js's detectGlobexSetup() (used until
// OPTIMAL_STOP has real calibrated values, exactly the widerOptMap[type]?.stop ?? 30
// pattern every other wider-window overnight level already follows).
//
// KNOWN CAVEAT (see OPEN_DECISION vwap_magnet_repeated_whipsaw_on_trend_days): on a
// session where price moves persistently away from VWAP faster than VWAP can catch up,
// this setup can re-fire repeatedly after each stop-out, and a handful of extreme days
// can dominate the aggregate N. This is left un-suppressed here deliberately — the
// standard backtest_setup_status.mjs rigor pipeline (day-clustering + chronological
// stability) is what should catch it, not a hand-patched cap in this script.
//
// Run: node scripts/backtest_globex_vwap_magnet.mjs [--dry-run]

import { query } from '../server/db.js';
import { getTradingDays } from './backtest_confluence.js';
import { resolve } from './backtest_unified.js';
import { computeRunningVwapSeries } from '../server/services/developingValueService.js';
import { getTrailing24hrVwapStd, getGlobex24hrBars } from '../server/services/queries.js';

const DRY_RUN = process.argv.includes('--dry-run');
const STOP = 30, T1 = 20;
const TARGET_TYPES = ['GLOBEX_VWAP_MAGNET_LONG', 'GLOBEX_VWAP_MAGNET_SHORT'];

async function run() {
  console.log(`Backfill GLOBEX_VWAP_MAGNET_LONG/SHORT${DRY_RUN ? ' [DRY RUN]' : ''}`);

  if (!DRY_RUN) {
    await query(`DROP TABLE IF EXISTS active_setups_globex_vwap_magnet_backfill_backup_20260728`);
    await query(`
      CREATE TABLE active_setups_globex_vwap_magnet_backfill_backup_20260728 AS
      SELECT * FROM active_setups WHERE setup_type = ANY($1) AND resolution_method = 'BACKFILL'
    `, [TARGET_TYPES]);
    const cnt = await query(`SELECT COUNT(*) FROM active_setups_globex_vwap_magnet_backfill_backup_20260728`);
    console.log(`Backed up ${cnt.rows[0].count} pre-existing backfill row(s) (expect 0 -- brand new setup)`);
    const del = await query(`DELETE FROM active_setups WHERE setup_type = ANY($1) AND resolution_method = 'BACKFILL'`, [TARGET_TYPES]);
    console.log(`Deleted ${del.rowCount} row(s) before re-running`);
  }

  const days = await getTradingDays();
  console.log(`Processing ${days.length} trading days`);

  let inserted = 0;
  const stats = { GLOBEX_VWAP_MAGNET_LONG: { n: 0, wins: 0, expired: 0, pnl: 0 }, GLOBEX_VWAP_MAGNET_SHORT: { n: 0, wins: 0, expired: 0, pnl: 0 } };

  for (const d of days) {
    const bars = await getGlobex24hrBars(d);
    if (bars.length < 60) continue;
    const vwapSeries = computeRunningVwapSeries(bars);
    const std = await getTrailing24hrVwapStd(d, 30);

    let i = 4; // small warm-up so the running VWAP isn't dominated by the first bar or two
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
      const setupType = isLong ? 'GLOBEX_VWAP_MAGNET_LONG' : 'GLOBEX_VWAP_MAGNET_SHORT';

      const res = resolve(bars, i, direction, entry, stop, target, 1440);
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
          d, setupType, bars[i].ts, `${d} 09:30:00`, resolvedAt, status, resolution,
          entry, entry, stop, target, `T1: ${T1}pt (Globex VWAP magnet)`,
          Math.round(vwap * 100) / 100, 'GLOBEX_VWAP', entry,
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
