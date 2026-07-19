// Corrected Layer 1 target calibration (see docs/TARGET_CALIBRATION_SPEC.md for the full
// design conversation this came out of). Replaces the two flaws in the LIVE
// sweepOptimalTarget() (scripts/update_optimal_stops.mjs):
//
//   1. It picks from a fixed point grid (TARGET_SWEEP = [10..150]) capped at p75_mfe --
//      and mfe_points is truncated the instant the ORIGINAL target resolves, so the live
//      calibration has never seen genuine post-target continuation (OPEN_DECISION
//      optimal_target_blind_to_post_resolution_continuation, 2026-07-19).
//   2. It's chronologically order-blind: computeEvAtStopTarget checks "did MAE exceed
//      stop" and "did MFE reach target" as two independent facts with no notion of which
//      happened first.
//
// v2.2 (2026-07-19, third pass): the core methodology (chronological resimulation,
// thin-tail gate, anchored candidate grid, plateau check, OOS split, rigor check) is now
// SHARED with the live pipeline via server/services/targetCalibrationService.js, wired
// into scripts/update_optimal_stops.mjs itself so future weekly/daily runs automatically
// re-evaluate every setup_type against this methodology -- no more manually-maintained
// "18 setups" list. This script is now the STANDALONE AUDIT/COMPARISON tool: same shared
// core, writes to TARGET_SWEEP_V2 (informational) rather than live OPTIMAL_STOP, useful
// for inspecting the full candidate grid and exclusion reasons for any setup_type without
// touching production data.
//
// Run: node scripts/backtest_target_sweep_v2.mjs
import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeCorrectedTarget, MIN_N } from '../server/services/targetCalibrationService.js';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;

async function main() {
  console.log('Loading current live OPTIMAL_STOP (stop held fixed, only re-deriving target)...');
  const optRes = await query(`
    SELECT DISTINCT ON (signal_name) signal_name as setup_type, optimal_stop, optimal_target
    FROM performance_audit WHERE signal_type='OPTIMAL_STOP'
    ORDER BY signal_name, run_date DESC
  `);
  const optMap = {};
  for (const r of optRes.rows) optMap[r.setup_type] = { stop: parseFloat(r.optimal_stop), oldTarget: parseFloat(r.optimal_target) };
  console.log(`${Object.keys(optMap).length} setup_types with a live OPTIMAL_STOP row.`);

  console.log('Loading eligible trades (entry+stop+resolution known, clean mae/mfe)...');
  const tradesRes = await query(`
    SELECT setup_type, fired_at, resolved_at, entry_zone_low::float as entry_zone_low,
      entry_zone_high::float as entry_zone_high, stop_level::float as stop_level,
      t1_level::float as t1_level, actual_pnl::float as actual_pnl, resolution
    FROM active_setups
    WHERE resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED') AND mae_points IS NOT NULL AND mfe_points IS NOT NULL
      AND mae_points <= 300 AND mfe_points <= 300 AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL
    ORDER BY fired_at ASC
  `);
  const allTrades = tradesRes.rows;
  console.log(`${allTrades.length} eligible trades.`);

  const byType = {};
  for (const t of allTrades) (byType[t.setup_type] ||= []).push(t);

  console.log('Loading NQ price bars...');
  const barsRes = await query(`SELECT ts, high::float as high, low::float as low FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
  const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), high: b.high, low: b.low }));
  console.log(`${allBars.length} bars loaded.`);

  const results = {};
  const exclusions = {};
  const setupTypes = Object.keys(byType).filter(st => optMap[st] && byType[st].length >= MIN_N);
  console.log(`Sweeping ${setupTypes.length} setup_types with N>=${MIN_N} and a live stop...`);

  for (const setupType of setupTypes) {
    const trades = byType[setupType];
    const stop = optMap[setupType].stop;
    const oldTarget = optMap[setupType].oldTarget;
    const direction = inferDirection(setupType);
    if (!direction) continue;
    const long = direction === 'LONG';

    const result = computeCorrectedTarget({ trades, allBars, stop, oldTarget, long, pnlPerPoint: PNL_PER_POINT, commission: COMMISSION });
    if (result.exclusionReason) {
      exclusions[setupType] = result;
      continue;
    }
    results[setupType] = { stop, oldTarget, ...result };
    console.log(`${setupType}: stop=${stop} oldTarget=${oldTarget} (baselineEv=$${result.baselineEv}) -> NEW target=${result.bestTarget} fullEv=$${result.fullEv} oosEv=$${result.oosEv} (N=${result.n}, targetHits=${result.targetHits})`);
  }

  const funnel = { total: setupTypes.length, survived: Object.keys(results).length, excluded: Object.keys(exclusions).length };
  console.log('\nFunnel:', JSON.stringify(funnel));
  console.log('\nPer-setup exclusion reasons:');
  for (const [st, ex] of Object.entries(exclusions)) console.log(`  ${st}: ${ex.exclusionReason} -- ${ex.exclusionDetail}`);

  const today = (await query(`SELECT CURRENT_DATE::text as d`)).rows[0].d;
  for (const [setupType, r] of Object.entries(results)) {
    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, ev_per_trade, notes)
      VALUES ($1, 0, 'TARGET_SWEEP_V2', $2, $3, $4, $5)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
        SET sample_size=EXCLUDED.sample_size, ev_per_trade=EXCLUDED.ev_per_trade, notes=EXCLUDED.notes
    `, [today, setupType, r.n, r.fullEv, JSON.stringify(r)]);
  }
  console.log(`\nPersisted ${Object.keys(results).length} rows to performance_audit (signal_type='TARGET_SWEEP_V2').`);

  // Self-cleaning (CLAUDE.md hard rule, 2026-07-19): delete anything this run didn't
  // produce, so a setup that stops surviving can never leave a silently-stale row behind.
  const survivorNames = Object.keys(results);
  const staleRes = await query(`
    DELETE FROM performance_audit WHERE signal_type='TARGET_SWEEP_V2' AND NOT (signal_name = ANY($1))
    RETURNING signal_name
  `, [survivorNames]);
  if (staleRes.rows.length) console.log(`Cleaned up ${staleRes.rows.length} stale row(s) no longer surviving: ${staleRes.rows.map(r => r.signal_name).join(', ')}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
