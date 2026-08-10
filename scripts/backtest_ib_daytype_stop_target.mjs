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
// FIXED 2026-08-10 (OPEN_DECISION day_type_alpha_stop_needs_origin_status_filter):
// this script had never been origin_status-filtered -- confirmed real-data composition
// before touching anything (grouped by (setup_type, day_type, origin_status)):
// IB_BULLISH_TURBULENT was 5% real (1 of 20 rows), IB_BULLISH_TREND 24%, IB_BEARISH_BALANCE
// 17%, IB_BULLISH_BALANCE 49% -- only IB_BEARISH_TREND (85%) and IB_BEARISH_TURBULENT (56%)
// were already real-data-dominated. Every "non-real" row here was UNKNOWN (pre-2026-07-09,
// unrecoverable), not BACKFILL -- IB_BULLISH/IB_BEARISH have been live since early in this
// system's life, predating the BACKFILL-era synthetic seeding, so this is a different
// contamination SOURCE than update_optimal_stops.mjs's main population had, but the same
// class of problem: a stop/target computed partly from data that doesn't reflect a real,
// live-observed touch.
//
// Now reuses computeStopTargetForType()/computeVolatilityDefaultRatios() from
// update_optimal_stops.mjs (exported 2026-08-09/10 specifically so this script and
// test_invariants.mjs don't hand-copy the decision tree a 3rd/4th time) -- called with
// canComputeVolDefault forced to false, which makes the shared function naturally reduce to
// "sweep on real data if realNStop>=MIN_N, otherwise return the insufficient-data sentinel"
// -- exactly this script's own pre-existing "skip thin buckets, fall back to the blended
// row" convention, with zero new logic needed for that branch. Deliberately NOT giving
// day-type buckets their own volatility-scaled-default: a thin day-type bucket already has a
// good fallback (the blended, non-day-type OPTIMAL_STOP row, which gets its own vol-default
// from the main script if IT is real-N-thin) -- layering a second, day-type-local synthetic
// default on top would add complexity without a clear benefit over that existing fallback.
//
// volScaleRatio/targetStopRatio (used only if the rare insufficient_data_no_fallback edge
// case's caller wanted them -- it doesn't here, canComputeVolDefault is always false) are
// still computed and passed through for interface compatibility with computeStopTargetForType,
// pooled from the MAIN (whole-system) OPTIMAL_STOP population, not a day-type-local one --
// more robust than deriving a ratio from just 2 setup_types' own thin buckets.
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
import { DEFAULT_DPP, computeStopTargetForType, computeVolatilityDefaultRatios } from './update_optimal_stops.mjs';
import { inferDirection } from '../server/config/setupTypes.js';
import { makeBarIndex } from '../server/services/targetCalibrationService.js';

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

  // Real (origin_status-filtered), day-type-joined trades -- the actual fix. Matches
  // update_optimal_stops.mjs's own rawResReal WHERE clause exactly, plus the day-type join.
  const tradesRes = await query(`
    SELECT a.setup_type, d.day_type, a.mae_points::float, a.mfe_points::float, a.actual_pnl::float,
      a.fired_at, a.entry_zone_low::float, a.entry_zone_high::float
    FROM active_setups a
    JOIN acd_daily_log d ON d.trade_date = a.trade_date
    WHERE a.setup_type = ANY($1)
      AND a.mae_points IS NOT NULL AND a.mfe_points IS NOT NULL AND a.actual_pnl IS NOT NULL
      AND a.mae_points <= 300 AND a.mfe_points <= 300
      AND a.status = 'RESOLVED' AND a.replay_resolution IN ('TARGET_HIT', 'STOP_HIT')
      AND a.origin_status IN ('ACTIVE', 'SHADOW')
      AND d.day_type IS NOT NULL
    ORDER BY a.fired_at ASC
  `, [SETUP_TYPES]);

  const byCell = {};
  for (const t of tradesRes.rows) {
    const key = `${t.setup_type}_${t.day_type}`;
    (byCell[key] ??= []).push(t);
  }
  console.log(`Found ${Object.keys(byCell).length} (setup_type, day_type) cells with real (origin_status-filtered) data.`);

  // Bars for the chronological sweep + noise-floor guard -- same as update_optimal_stops.mjs.
  console.log('Loading NQ bars for the chronological sweep...');
  const barsRes = await query(`SELECT ts, high::float as high, low::float as low FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
  const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), high: b.high, low: b.low }));
  const firstIndexAfter = makeBarIndex(allBars);

  const medianBarRangeRes = await query(`
    SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (high - low)) as median_range
    FROM price_bars_primary WHERE symbol='NQ' AND ts >= NOW() - INTERVAL '30 days'
  `);
  const medianBarRange = +medianBarRangeRes.rows[0].median_range;
  const NOISE_FLOOR_PT = 1.5 * medianBarRange;

  // volScaleRatio/targetStopRatio computed for interface compatibility only -- see the
  // header comment on why day-type buckets never actually use the volatility-default path
  // (canComputeVolDefault is forced false below). Pooled from the MAIN, whole-system
  // OPTIMAL_STOP population (not a day-type-local one).
  const priorRes = await query(`
    SELECT DISTINCT ON (signal_name) signal_name, optimal_stop, optimal_target
    FROM performance_audit WHERE signal_type = 'OPTIMAL_STOP'
    ORDER BY signal_name, run_date DESC
  `);
  const priorStoredByType = Object.fromEntries(priorRes.rows.map(r => [r.signal_name, { stop: parseFloat(r.optimal_stop), target: parseFloat(r.optimal_target) }]));
  const realNCountRes = await query(`
    SELECT setup_type, COUNT(*) as n FROM active_setups
    WHERE mae_points IS NOT NULL AND mfe_points IS NOT NULL AND actual_pnl IS NOT NULL
      AND mae_points <= 300 AND mfe_points <= 300
      AND resolution IN ('TARGET_HIT', 'STOP_HIT', 'TIME_EXPIRED')
      AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL
      AND origin_status IN ('ACTIVE', 'SHADOW')
    GROUP BY setup_type
  `);
  const realNByType = Object.fromEntries(realNCountRes.rows.map(r => [r.setup_type, +r.n]));
  const { volScaleRatio, targetStopRatio, ceilingRatio } = computeVolatilityDefaultRatios({ priorStoredByType, realNByType, medianBarRange, minN: MIN_N });

  let upserted = 0, skipped = 0, todayRow;
  for (const [signalName, trades] of Object.entries(byCell)) {
    const setupType = signalName.replace(/_(BALANCE|TREND|TURBULENT)$/, '');
    const { stopDpp, targetDpp } = dppByType[setupType] || { stopDpp: DEFAULT_DPP, targetDpp: DEFAULT_DPP };
    const direction = inferDirection(setupType);

    const decision = computeStopTargetForType({
      realTradesStop: trades, direction, allBars, firstIndexAfter, stopDpp, targetDpp,
      noiseFloorPt: NOISE_FLOOR_PT, volScaleRatio, targetStopRatio, ceilingRatio, medianBarRange,
      canComputeVolDefault: false, // day-type buckets fall back to the blended row when thin, not a synthetic default -- see header comment
    });

    if (decision.targetMethod === 'insufficient_data_no_fallback') {
      console.log(`  SKIP ${signalName}: real N=${trades.length} < MIN_N=${MIN_N} — falls back to blended OPTIMAL_STOP row live`);
      skipped++;
      continue;
    }

    const wr = trades.filter(t => t.actual_pnl > 0).length / trades.length;
    const notes = JSON.stringify({
      method: `day-type-conditioned ${decision.targetMethod}`, setup_type: setupType,
      real_n: trades.length,
      ...(decision.cappedByRiskCeiling ? { risk_capping: {
        capped_by_risk_ceiling: true, uncapped_stop: decision.uncappedStop,
        uncapped_target: decision.uncappedTarget, uncapped_ev: decision.uncappedEv != null ? +decision.uncappedEv.toFixed(2) : null,
        risk_ceiling_pt: decision.riskCeiling,
      } } : {}),
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
    `, [todayRow, signalName, trades.length, +(wr * 100).toFixed(1), decision.optEV != null ? +decision.optEV.toFixed(2) : null, decision.optStop, decision.optTarget, notes]);
    console.log(`  WROTE ${signalName}: real N=${trades.length} stop=${decision.optStop} target=${decision.optTarget} ev=$${decision.optEV != null ? decision.optEV.toFixed(2) : 'n/a'} method=${decision.targetMethod}`);
    upserted++;
  }

  console.log(`\nDone. ${upserted} day-type-conditioned OPTIMAL_STOP row(s) upserted, ${skipped} skipped (real N below floor, falls back to blended row).`);
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
