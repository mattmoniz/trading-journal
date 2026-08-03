// =============================================================================
// Day-type-conditioned OPTIMAL_STOP calibration for IB_BEARISH/IB_BULLISH.
//
// Resolves OPEN_DECISION ib_bearish_optimal_stop_not_day_type_conditioned: the
// execution-efficiency audit (2026-07-27) found IB_BEARISH's real realized EV
// ($7.77-$8.37) sat well ABOVE its blended OPTIMAL_STOP calibrated EV (-$15.98) —
// working theory was that sweepOptimalStopAndTarget() fits one flat stop/target
// blind to day-type, but IB_BEARISH's own SETUP_STATUS day-type breakdown already
// shows a real split (BALANCE -$24.68/trade, TURBULENT +$63.07, TREND +$4.33). This
// script tests that theory directly: sweep stop/target SEPARATELY per (setup_type,
// day_type) instead of blended, and persist a row for any bucket that clears the
// same MIN_N=20 floor sweepOptimalStopAndTarget() already enforces.
//
// Reuses the REAL, already-validated sweepOptimalStopAndTarget()/computeEvAtStopTarget()
// from update_optimal_stops.mjs (CLAUDE.md's "export the real function, never
// reimplement" rule) — this script only differs in how the trade population is
// partitioned (by day_type in addition to setup_type), not in the sweep math itself.
//
// Writes signal_type='OPTIMAL_STOP' rows keyed `{setup_type}_{day_type}` (e.g.
// IB_BEARISH_TURBULENT), matching backtest_day_type_alpha.js's existing
// `{setup_type}_{day_type}` naming convention. acd.js's ibOpt lookup checks this
// day-type-specific key FIRST, falling back to the blended `{setup_type}` row if
// the day-type bucket doesn't exist or hasn't cleared MIN_N — so a thin day-type
// bucket never blocks live firing, it just doesn't get its own sharper calibration
// yet (same graceful-fallback shape as every other OPTIMAL_STOP consumer).
//
// Run manually or add to run_weekly_backtests.sh alongside update_optimal_stops.mjs.
// =============================================================================

import { query } from '../server/db.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { sweepOptimalStopAndTarget, DEFAULT_DPP } from './update_optimal_stops.mjs';

const MIN_N = 20;
const SETUP_TYPES = ['IB_BEARISH', 'IB_BULLISH'];

async function run() {
  console.log('IB day-type-conditioned OPTIMAL_STOP calibration starting...');

  // Real per-setup_type $/pt (instrument property, not day-type dependent — reuse
  // the blended value already established for these 2 setup_types, don't recompute
  // per day-type bucket).
  const dppRes = await query(`
    SELECT setup_type,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(actual_pnl) / NULLIF(ABS(entry_zone_low - stop_level), 0))
        FILTER (WHERE replay_resolution = 'STOP_HIT')                                    AS stop_dpp,
      COUNT(*) FILTER (WHERE replay_resolution = 'STOP_HIT')                             AS n_stop,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(actual_pnl) / NULLIF(ABS(t1_level - entry_zone_low), 0))
        FILTER (WHERE replay_resolution = 'TARGET_HIT')                                  AS target_dpp,
      COUNT(*) FILTER (WHERE replay_resolution = 'TARGET_HIT')                           AS n_target
    FROM active_setups
    WHERE status = 'RESOLVED' AND entry_zone_low IS NOT NULL
      AND stop_level IS NOT NULL AND t1_level IS NOT NULL
      AND actual_pnl IS NOT NULL AND setup_type = ANY($1)
    GROUP BY setup_type
  `, [SETUP_TYPES]);
  const dppByType = {};
  for (const r of dppRes.rows) {
    dppByType[r.setup_type] = {
      stopDpp:   (+r.n_stop   >= MIN_N && r.stop_dpp   != null) ? +r.stop_dpp   : DEFAULT_DPP,
      targetDpp: (+r.n_target >= MIN_N && r.target_dpp != null) ? +r.target_dpp : DEFAULT_DPP,
    };
  }

  // Real resolved trades joined to day_type, same population convention as
  // update_optimal_stops.mjs's own rawByType query (status='RESOLVED' AND
  // replay_resolution IN ('TARGET_HIT','STOP_HIT')), plus the DAY_TYPE_ALPHA
  // convention of requiring a real (non-null) day_type.
  const tradesRes = await query(`
    SELECT a.setup_type, d.day_type, a.mae_points::float, a.mfe_points::float, a.actual_pnl::float
    FROM active_setups a
    JOIN acd_daily_log d ON d.trade_date = a.trade_date
    WHERE a.setup_type = ANY($1)
      AND a.mae_points IS NOT NULL AND a.mfe_points IS NOT NULL AND a.actual_pnl IS NOT NULL
      AND a.mae_points <= 300 AND a.mfe_points <= 300
      AND a.status = 'RESOLVED' AND a.replay_resolution IN ('TARGET_HIT', 'STOP_HIT')
      AND d.day_type IS NOT NULL
  `, [SETUP_TYPES]);

  const byCell = {};
  for (const t of tradesRes.rows) {
    const key = `${t.setup_type}_${t.day_type}`;
    (byCell[key] ??= []).push(t);
  }

  console.log(`Found ${Object.keys(byCell).length} (setup_type, day_type) cells with any data.`);

  // Percentiles via SQL PERCENTILE_CONT, grouped by (setup_type, day_type) — matches
  // update_optimal_stops.mjs's own statsRes query exactly (linear interpolation, NOT
  // the discrete nearest-rank method a manual sort+Math.floor(p*N) index would give).
  // Caught on DeepSeek review 2026-08-03: the two methods are not equivalent and can
  // select a different candidate at sparse distribution boundaries, changing which
  // stop survives the thin-tail gate.
  const pctRes = await query(`
    SELECT a.setup_type || '_' || d.day_type as signal_name,
      ROUND(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY a.mae_points)::numeric, 1) AS p25_mae,
      ROUND(PERCENTILE_CONT(0.40) WITHIN GROUP (ORDER BY a.mae_points)::numeric, 1) AS p40_mae,
      ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY a.mae_points)::numeric, 1) AS p50_mae,
      ROUND(PERCENTILE_CONT(0.60) WITHIN GROUP (ORDER BY a.mae_points)::numeric, 1) AS p60_mae,
      ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY a.mae_points)::numeric, 1) AS p75_mae,
      ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY a.mfe_points)::numeric, 1) AS p75_mfe
    FROM active_setups a
    JOIN acd_daily_log d ON d.trade_date = a.trade_date
    WHERE a.setup_type = ANY($1)
      AND a.mae_points IS NOT NULL AND a.mfe_points IS NOT NULL AND a.actual_pnl IS NOT NULL
      AND a.mae_points <= 300 AND a.mfe_points <= 300
      AND a.status = 'RESOLVED' AND a.replay_resolution IN ('TARGET_HIT', 'STOP_HIT')
      AND d.day_type IS NOT NULL
    GROUP BY a.setup_type, d.day_type
  `, [SETUP_TYPES]);
  const pctByCell = Object.fromEntries(pctRes.rows.map(r => [r.signal_name, r]));

  let upserted = 0, todayRow;
  for (const [signalName, trades] of Object.entries(byCell)) {
    if (trades.length < MIN_N) {
      console.log(`  SKIP ${signalName}: N=${trades.length} < MIN_N=${MIN_N} — falls back to blended OPTIMAL_STOP row live`);
      continue;
    }
    const setupType = signalName.replace(/_(BALANCE|TREND|TURBULENT)$/, '');
    const { stopDpp, targetDpp } = dppByType[setupType] || { stopDpp: DEFAULT_DPP, targetDpp: DEFAULT_DPP };

    const pcts = pctByCell[signalName];
    const maeCandidates = [
      { value: pcts.p25_mae, pct: 0.25 }, { value: pcts.p40_mae, pct: 0.40 },
      { value: pcts.p50_mae, pct: 0.50 }, { value: pcts.p60_mae, pct: 0.60 },
      { value: pcts.p75_mae, pct: 0.75 },
    ].map(c => ({ ...c, value: parseFloat(c.value) })).filter(c => !isNaN(c.value) && c.value > 0);
    const p75mfe = Math.round(parseFloat(pcts.p75_mfe) || 35);

    const swept = sweepOptimalStopAndTarget(trades, maeCandidates, p75mfe, stopDpp, targetDpp);
    if (!swept) {
      console.log(`  SKIP ${signalName}: N=${trades.length} but no candidate cleared the thin-tail gate`);
      continue;
    }

    const wr = trades.filter(t => t.actual_pnl > 0).length / trades.length;
    const notes = JSON.stringify({
      method: 'day-type-conditioned EV-sweep', setup_type: setupType,
      real_n: trades.length,
    });

    if (!todayRow) {
      todayRow = (await query(`SELECT CURRENT_DATE::text as today`)).rows[0].today;
    }
    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, optimal_stop, optimal_target, notes)
      VALUES ($1, 9999, 'OPTIMAL_STOP', $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
        SET sample_size = EXCLUDED.sample_size, win_rate = EXCLUDED.win_rate,
            ev_per_trade = EXCLUDED.ev_per_trade, optimal_stop = EXCLUDED.optimal_stop,
            optimal_target = EXCLUDED.optimal_target, notes = EXCLUDED.notes
    `, [todayRow, signalName, trades.length, +(wr * 100).toFixed(1), +swept.ev.toFixed(2), swept.stop, swept.target, notes]);
    console.log(`  WROTE ${signalName}: N=${trades.length} stop=${swept.stop} target=${swept.target} ev=$${swept.ev.toFixed(2)} (blended EV was different — see OPTIMAL_STOP row for ${setupType})`);
    upserted++;
  }

  console.log(`\nDone. ${upserted} day-type-conditioned OPTIMAL_STOP row(s) upserted.`);
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
