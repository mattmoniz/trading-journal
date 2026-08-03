// backtest_grind_detector.mjs — tests the "Grind Detector" dynamic exit mechanism
// (tighten the stop when time passes without proportional progress toward target)
// against IB_BEARISH_TURBULENT's real trades.
//
// Built from scratch/deepseek_grind_detector_test_design.md (the "frozen" spec) after a
// Claude+Gemini+DeepSeek audit/debate caught and fixed 3 real bugs in that spec BEFORE
// this script was written -- see docs/OPEN_THREADS.md's 2026-08-03 "Grind Detector" entry
// and scratch/deepseek_self_audit_grind_detector.md Section 6 for the full account.
//
// READ-ONLY against active_setups/OPTIMAL_STOP/SETUP_STATUS -- never writes to them.
// Persists only to performance_audit signal_type='GRIND_DETECTOR_TEST' (a new signal_type,
// cannot collide with any live-read row).

import { query } from '../server/db.js';
import { directionFromType, replayBars } from '../server/services/maeMfeReplay.js';
import { computeRigor, computeReplication } from '../server/services/rigorDiagnostics.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import fs from 'fs';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const WALK_WINDOW_BARS = 390; // matches backtest_breakeven_trail.mjs convention
const M = 5; // minimum bar gate, frozen (Section 3.6/3.7 of the design doc)
const CAL_N = 25; // chronological calibration set size (first 25 of 39)

// 6-point grid, frozen per the design doc's Section 3.7 follow-up round.
const GRID = [];
for (const grindThreshold of [0.10, 0.30, 0.50]) {
  for (const decayRate of [0.05, 0.20]) {
    GRID.push({ grindThreshold, decayRate });
  }
}

// Extension 1 (design doc, pinned 2026-08-03): the exact 37 IB_BEARISH_TURBULENT trade IDs
// qualifying under this script's own population query at design time -- pinned so a future
// re-run can't silently test a different population if derive_day_types.js's classification
// rules ever change retroactively. NOTE: 37, not 39 -- the 39 figure used earlier in this
// design thread included 2 TIME_EXPIRED-resolution trades that this script's own scope
// boundary #6 deliberately excludes (no clean baseline resolution price to compare against).
const PINNED_TURBULENT_TRADE_IDS = [
  71158, 71161, 71216, 71278, 71353, 71370, 71373, 71403, 71465,
  82521, 82554, 82564, 82570, 82628, 82636, 82646, 82653, 82656, 82686, 82698,
  82759, 82774, 82823, 82835, 82978, 83032, 83053, 83185, 83315, 83438, 83452,
  83584, 83626, 83632, 83644, 83704, 83897,
];

function median(arr) {
  const s = arr.filter(x => x != null).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Baseline: fixed stop/target replay via the real, imported replayBars() -- never
// reimplemented. Returns resolution + exact $ pnl for the trade's own recorded stop/target.
function computeBaseline(trade, bars, direction) {
  const entry = (trade.entry_zone_low + trade.entry_zone_high) / 2;
  const result = replayBars(bars, entry, trade.stop_level, trade.t1_level, direction);
  let resolutionPrice;
  if (result.replayResolution === 'STOP_HIT') resolutionPrice = trade.stop_level;
  else if (result.replayResolution === 'TARGET_HIT') resolutionPrice = trade.t1_level;
  else resolutionPrice = bars.length ? bars[bars.length - 1].close : entry;
  const signedPoints = direction === 'LONG' ? (resolutionPrice - entry) : (entry - resolutionPrice);
  const pnlDollars = signedPoints * PNL_PER_POINT - COMMISSION;
  return { resolution: result.replayResolution, barsToResolution: result.barsToResolution, pnlPoints: signedPoints, pnlDollars };
}

// Grind Detector simulation -- SHORT-only (IB_BEARISH), per the corrected Section 4
// pseudocode. The two bugs fixed during audit are marked explicitly below; do not
// reintroduce either while refactoring.
function simulateGrindDetector(trade, bars, medianBarsToResWinners, grindThreshold, decayRate, direction) {
  if (direction !== 'SHORT') {
    throw new Error(`simulateGrindDetector is SHORT-only (design doc limitation #4) -- got direction=${direction} for trade id=${trade.id}`);
  }
  const entry = (trade.entry_zone_low + trade.entry_zone_high) / 2;
  const baseStop = trade.stop_level;   // ABOVE entry for SHORT
  const target = trade.t1_level;       // BELOW entry for SHORT
  const stopDist = Math.abs(baseStop - entry);
  const targetDist = Math.abs(entry - target);

  let currentStop = baseStop;
  let prevStop = baseStop;
  let resolution = 'EXPIRED';
  let barsToRes = bars.length;
  let resolutionPrice = null;
  let triggered = false;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const barN = i + 1;

    const stopHit = bar.high >= currentStop;
    const targetHit = bar.low <= target;

    if (stopHit || targetHit) {
      // Same-bar conflict: conservative tiebreak, matches replayBars()'s own convention.
      resolution = (stopHit) ? 'STOP_HIT' : 'TARGET_HIT';
      resolutionPrice = stopHit ? currentStop : target;
      barsToRes = barN;
      break;
    }

    if (barN > M) {
      const close = bar.close;
      const targetCovered = Math.max(0, Math.min(1, (entry - close) / targetDist));
      const timeElapsed = barN / medianBarsToResWinners;
      const grindScore = timeElapsed - targetCovered;

      if (grindScore > grindThreshold) {
        triggered = true;
        const excess = grindScore - grindThreshold;
        const tightening = excess * stopDist * decayRate;
        // FIX (compounding bug): from baseStop, never from currentStop.
        const newStop = baseStop - tightening;
        currentStop = Math.max(newStop, entry);        // floor: never past entry
        // FIX (ratchet-direction bug): min() for SHORT, not max().
        currentStop = Math.min(currentStop, prevStop);
      }
    }
    prevStop = currentStop;
  }

  if (resolution === 'EXPIRED') {
    resolutionPrice = bars.length ? bars[bars.length - 1].close : entry;
  }
  const pnlPoints = entry - resolutionPrice; // SHORT: positive = profit
  const pnlDollars = pnlPoints * PNL_PER_POINT - COMMISSION;
  return { resolution, barsToRes, pnlPoints, pnlDollars, finalStop: currentStop, triggered };
}

async function main() {
  const { rows: [{ today }] } = await query(`SELECT CURRENT_DATE::text as today`);
  console.log(`[grind_detector] run_date=${today}`);

  // ── 1. Trade population (IB_BEARISH, all real-origin resolved trades, joined to day_type) ──
  const tradesRes = await query(`
    SELECT a.id, a.trade_date::text as trade_date, a.fired_at, a.setup_type,
      a.entry_zone_low::float as entry_zone_low,
      COALESCE(a.entry_zone_high, a.entry_zone_low)::float as entry_zone_high,
      a.stop_level::float as stop_level, a.t1_level::float as t1_level,
      a.actual_pnl::float as actual_pnl, a.replay_resolution, a.origin_status, d.day_type
    FROM active_setups a
    JOIN acd_daily_log d ON d.trade_date = a.trade_date
    WHERE a.setup_type = 'IB_BEARISH'
      AND a.origin_status IN ('ACTIVE','SHADOW')
      AND a.status IN ('RESOLVED','EXPIRED')
      AND a.replay_resolution IN ('TARGET_HIT','STOP_HIT')
      AND a.entry_zone_low IS NOT NULL AND a.stop_level IS NOT NULL AND a.t1_level IS NOT NULL
      AND a.actual_pnl IS NOT NULL
    ORDER BY a.trade_date ASC, a.fired_at ASC
  `);
  const allTrades = tradesRes.rows;
  // Primary population is the PINNED trade ID list (Extension 1), not a live day_type join --
  // this is what actually protects the test from silently shifting if classification rules
  // change later. BALANCE/TREND controls stay on the dynamic join (not required to pin by
  // the design doc, lower stakes as controls rather than the primary tested population).
  const turbulent = allTrades.filter(t => PINNED_TURBULENT_TRADE_IDS.includes(t.id));
  const balance = allTrades.filter(t => t.day_type === 'BALANCE');
  const trend = allTrades.filter(t => t.day_type === 'TREND');
  console.log(`[grind_detector] population: TURBULENT=${turbulent.length} (pinned), BALANCE=${balance.length}, TREND=${trend.length}`);

  // Drift check: does today's live day_type join still agree with the pinned list?
  const liveTurbulentIds = allTrades.filter(t => t.day_type === 'TURBULENT').map(t => t.id).sort((a, b) => a - b);
  const pinnedSorted = [...PINNED_TURBULENT_TRADE_IDS].sort((a, b) => a - b);
  const idsMatch = liveTurbulentIds.length === pinnedSorted.length && liveTurbulentIds.every((id, i) => id === pinnedSorted[i]);
  if (!idsMatch) {
    console.warn(`[grind_detector] WARNING: live day_type='TURBULENT' join (n=${liveTurbulentIds.length}) no longer matches the pinned trade ID list (n=${pinnedSorted.length}) -- derive_day_types.js's classification rules may have changed since 2026-08-03. Results below still use the PINNED list, not the live join, so this test remains reproducible -- but investigate before trusting a future re-run's "current" population as equivalent to this one.`);
  } else {
    console.log(`[grind_detector] drift check OK: live day_type join still matches the pinned trade ID list exactly.`);
  }

  if (turbulent.length !== PINNED_TURBULENT_TRADE_IDS.length) {
    console.error(`[grind_detector] ABORT: expected all ${PINNED_TURBULENT_TRADE_IDS.length} pinned trade IDs to be present in the live query result, found ${turbulent.length}. A pinned trade may have been deleted or its data corrupted -- investigate before proceeding.`);
    process.exit(1);
  }
  if (turbulent.length < CAL_N + 3) {
    console.error(`[grind_detector] ABORT: TURBULENT population (${turbulent.length}) too small for a ${CAL_N}-trade calibration set.`);
    process.exit(1);
  }

  // Pinned snapshot metadata (Extension 1/2 from the design doc's isolation constraints).
  const pinnedTradeIds = turbulent.map(t => t.id);
  const { rows: [{ maxts }] } = await query(`SELECT MAX(ts)::text as maxts FROM price_bars_primary WHERE symbol='NQ'`);
  const { rows: [{ rowcount }] } = await query(`SELECT COUNT(*)::int as rowcount FROM price_bars_primary WHERE symbol='NQ'`);
  console.log(`[grind_detector] pinned ${pinnedTradeIds.length} TURBULENT trade IDs; bars_last_verified_at=${maxts}`);

  // Extension 3: mid-test population drift guard (informational only, non-blocking).
  const { rows: openRows } = await query(`SELECT COUNT(*)::int as n FROM active_setups WHERE setup_type='IB_BEARISH' AND status NOT IN ('RESOLVED','EXPIRED')`);
  if (openRows[0].n > 0) {
    console.warn(`[grind_detector] WARNING: ${openRows[0].n} unresolved IB_BEARISH position(s) exist right now -- excluded from this test (N stays pinned at snapshot).`);
  }

  // ── 2. Load all NQ price bars once, binary-search per trade (matches breakeven_trail) ──
  console.log('[grind_detector] loading price bars...');
  const barsRes = await query(`SELECT ts, high::float as high, low::float as low, close::float as close FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
  const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), high: b.high, low: b.low, close: b.close }));

  function firstIndexAfter(firedAt) {
    const t = new Date(firedAt).getTime();
    let lo = 0, hi = allBars.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (allBars[mid].ts <= t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
  function getForwardBars(firedAt) {
    const startIdx = firstIndexAfter(firedAt);
    return allBars.slice(startIdx, startIdx + WALK_WINDOW_BARS);
  }

  // ── 3. Chronological split + baseline replay (real replayBars(), never reimplemented) ──
  const calibration = turbulent.slice(0, CAL_N);
  const heldOut = turbulent.slice(CAL_N);
  console.log(`[grind_detector] chronological split: calibration=${calibration.length}, heldOut=${heldOut.length}`);

  function attachBaseline(trades) {
    return trades.map(t => {
      const direction = directionFromType(t.setup_type);
      const bars = getForwardBars(t.fired_at);
      const baseline = computeBaseline(t, bars, direction);
      return { ...t, direction, bars, baseline };
    });
  }
  const calWithBaseline = attachBaseline(calibration);
  const heldOutWithBaseline = attachBaseline(heldOut);

  // ── 4. medianBarsToResolutionWinners -- calibration-set TARGET_HIT trades ONLY. ──
  // FIX (lookahead bug): never fall back to full-sample -- abort instead if <3 winners.
  const calWinners = calWithBaseline.filter(t => t.baseline.resolution === 'TARGET_HIT');
  if (calWinners.length < 3) {
    console.error(`[grind_detector] ABORT (Gate 0): only ${calWinners.length} TARGET_HIT trades in the ${CAL_N}-trade calibration set -- cannot compute a reliable medianBarsToResolutionWinners without leaking held-out data. See design doc Section 3.5.`);
    process.exit(1);
  }
  const medianBarsToResWinners = median(calWinners.map(t => t.baseline.barsToResolution));
  console.log(`[grind_detector] medianBarsToResolutionWinners (calibration TARGET_HIT only, n=${calWinners.length}) = ${medianBarsToResWinners}`);

  // ── 5. Gate 1: descriptive grindScore separation (winners vs losers), calibration set ──
  console.log('\n[grind_detector] Gate 1: descriptive separation check');
  const checkpoints = [5, 10, 15, 20, 25];
  const separationTable = [];
  for (const cp of checkpoints) {
    const targetVals = [], stopVals = [];
    for (const t of calWithBaseline) {
      if (t.baseline.barsToResolution < cp) continue; // already resolved by this checkpoint
      const bar = t.bars[cp - 1];
      if (!bar) continue;
      const entry = (t.entry_zone_low + t.entry_zone_high) / 2;
      const targetDist = Math.abs(entry - t.t1_level);
      const targetCovered = Math.max(0, Math.min(1, (entry - bar.close) / targetDist));
      const grindScore = (cp / medianBarsToResWinners) - targetCovered;
      (t.baseline.resolution === 'TARGET_HIT' ? targetVals : stopVals).push(grindScore);
    }
    const meanT = targetVals.length ? targetVals.reduce((a, b) => a + b, 0) / targetVals.length : null;
    const meanS = stopVals.length ? stopVals.reduce((a, b) => a + b, 0) / stopVals.length : null;
    separationTable.push({ bar: cp, meanTargetHit: meanT, meanStopHit: meanS, nTarget: targetVals.length, nStop: stopVals.length });
    console.log(`  bar=${cp}  TARGET_HIT mean=${meanT?.toFixed(3) ?? 'n/a'} (n=${targetVals.length})  STOP_HIT mean=${meanS?.toFixed(3) ?? 'n/a'} (n=${stopVals.length})`);
  }
  const separates = separationTable.every(r => r.meanTargetHit == null || r.meanStopHit == null || r.meanStopHit > r.meanTargetHit);
  console.log(`  Gate 1 result: ${separates ? 'PASS (STOP_HIT consistently higher grindScore)' : 'FAIL (no consistent separation)'}`);

  // ── 6. Parameter sweep on calibration set -- pick combo maximizing calibration avg $ pnl ──
  console.log('\n[grind_detector] parameter sweep (6-point grid, calibration set)');
  let best = null;
  for (const { grindThreshold, decayRate } of GRID) {
    const results = calWithBaseline.map(t => simulateGrindDetector(t, t.bars, medianBarsToResWinners, grindThreshold, decayRate, t.direction));
    const avgPnl = results.reduce((a, r) => a + r.pnlDollars, 0) / results.length;
    console.log(`  threshold=${grindThreshold} decay=${decayRate}  cal avg pnl=$${avgPnl.toFixed(2)}`);
    if (!best || avgPnl > best.avgPnl) best = { grindThreshold, decayRate, avgPnl };
  }
  console.log(`  BEST: threshold=${best.grindThreshold} decay=${best.decayRate} (cal avg pnl=$${best.avgPnl.toFixed(2)})`);

  const baselineCalEv = calWithBaseline.reduce((a, t) => a + t.baseline.pnlDollars, 0) / calWithBaseline.length;
  console.log(`  baseline (no grind) cal avg pnl=$${baselineCalEv.toFixed(2)}`);

  // ── 7. Gate 2: held-out EV improvement with the best combo ──
  console.log('\n[grind_detector] Gate 2: held-out EV improvement');
  const heldOutGrind = heldOutWithBaseline.map(t => ({
    trade: t,
    grind: simulateGrindDetector(t, t.bars, medianBarsToResWinners, best.grindThreshold, best.decayRate, t.direction),
  }));
  const baselineHeldoutEv = heldOutWithBaseline.reduce((a, t) => a + t.baseline.pnlDollars, 0) / heldOutWithBaseline.length;
  const grindHeldoutEv = heldOutGrind.reduce((a, r) => a + r.grind.pnlDollars, 0) / heldOutGrind.length;
  const gate2Pass = grindHeldoutEv > baselineHeldoutEv;
  console.log(`  baseline heldout ev=$${baselineHeldoutEv.toFixed(2)}  grind heldout ev=$${grindHeldoutEv.toFixed(2)}  Gate 2: ${gate2Pass ? 'PASS' : 'FAIL'}`);

  // ── 8. Gate 3: computeRigor on held-out per-trade P&L DELTAS ──
  console.log('\n[grind_detector] Gate 3: computeRigor on held-out deltas');
  const heldOutDeltas = heldOutGrind.map(r => ({ date: r.trade.trade_date, pnl: r.grind.pnlDollars - r.trade.baseline.pnlDollars }));
  const rigor = computeRigor(heldOutDeltas, { dateField: 'date', pnlFn: e => e.pnl });
  console.log(`  rigor: clustered=${rigor.clustered} stable=${rigor.stable} clean=${rigor.clean}`);
  const gate3Pass = rigor.clean === true;

  // ── 9. Gate 4: computeReplication across day-types (control test) ──
  // Reuses the TURBULENT-calibrated medianBarsToResWinners for BALANCE/TREND too --
  // resolves the ambiguity Gemini's audit flagged: this tests whether the SAME calibrated
  // mechanism (including its pace reference) generalizes, not a re-tuned one per day-type.
  console.log('\n[grind_detector] Gate 4: computeReplication across day-types');
  function evDeltaForPopulation(trades) {
    if (!trades.length) return { n: 0, value: 0 };
    const withBaseline = attachBaseline(trades);
    const deltas = withBaseline.map(t => {
      const g = simulateGrindDetector(t, t.bars, medianBarsToResWinners, best.grindThreshold, best.decayRate, t.direction);
      return g.pnlDollars - t.baseline.pnlDollars;
    });
    return { n: deltas.length, value: deltas.reduce((a, b) => a + b, 0) / deltas.length };
  }
  const turbulentDelta = evDeltaForPopulation(turbulent);
  const balanceDelta = evDeltaForPopulation(balance);
  const trendDelta = evDeltaForPopulation(trend);
  console.log(`  TURBULENT delta=$${turbulentDelta.value.toFixed(2)} (n=${turbulentDelta.n})  BALANCE delta=$${balanceDelta.value.toFixed(2)} (n=${balanceDelta.n})  TREND delta=$${trendDelta.value.toFixed(2)} (n=${trendDelta.n})`);

  const units = [
    { id: 'TURBULENT', metric: turbulentDelta },
    { id: 'BALANCE', metric: balanceDelta },
    { id: 'TREND', metric: trendDelta },
  ];
  const repl = computeReplication(units, { idFn: u => u.id, metricFn: u => u.metric, selectedIds: ['TURBULENT'] });
  console.log(`  replicates=${repl.replicates}`);

  // ── 10. Diagnostics (always reported, never a gate) ──
  let winnersKilled = 0, winnersSaved = 0, losersImproved = 0, losersWorsened = 0, neverTriggered = 0, totalStopReduction = 0, triggeredCount = 0;
  for (const r of heldOutGrind) {
    const b = r.trade.baseline, g = r.grind;
    if (b.resolution === 'TARGET_HIT' && g.resolution === 'STOP_HIT') winnersKilled++;
    if (b.resolution === 'STOP_HIT' && g.resolution === 'TARGET_HIT') winnersSaved++;
    if (b.resolution === 'STOP_HIT') { if (g.pnlDollars > b.pnlDollars) losersImproved++; else if (g.pnlDollars < b.pnlDollars) losersWorsened++; }
    if (!g.triggered) neverTriggered++; else { triggeredCount++; totalStopReduction += (r.trade.stop_level - g.finalStop); }
  }
  console.log(`\n[grind_detector] diagnostics (held-out, n=${heldOutGrind.length}): winnersKilled=${winnersKilled} winnersSaved=${winnersSaved} losersImproved=${losersImproved} losersWorsened=${losersWorsened} neverTriggered=${neverTriggered} avgStopReduction=${triggeredCount ? (totalStopReduction / triggeredCount).toFixed(2) : 'n/a'}pt`);

  const allGatesPass = separates && gate2Pass && gate3Pass;
  const recommendation = allGatesPass ? (repl.replicates ? 'PROMISING_GENERALIZES' : 'PROMISING_TURBULENT_ONLY') : 'NO_EFFECT';
  console.log(`\n[grind_detector] FINAL: gate1=${separates} gate2=${gate2Pass} gate3=${gate3Pass} gate4_replicates=${repl.replicates} -> recommendation=${recommendation}`);

  // ── 11. Persist (READ-ONLY against active_setups/OPTIMAL_STOP/SETUP_STATUS) ──
  const notes = {
    mechanism: 'grind_detector',
    snapshot_run_date: today,
    pinned_day_type: 'TURBULENT',
    pinned_trade_ids: pinnedTradeIds,
    calibration_n: calibration.length,
    heldout_n: heldOut.length,
    baseline_cal_ev: +baselineCalEv.toFixed(2),
    baseline_heldout_ev: +baselineHeldoutEv.toFixed(2),
    grind_cal_ev: +best.avgPnl.toFixed(2),
    grind_heldout_ev: +grindHeldoutEv.toFixed(2),
    best_grind_threshold: best.grindThreshold,
    best_decay_rate: best.decayRate,
    min_bar_gate_M: M,
    median_bars_to_resolution_winners_cal: medianBarsToResWinners,
    gates: { gate1_separation: separates, gate2_heldout_ev_improved: gate2Pass, gate3_rigor_clean: gate3Pass, gate4_replicates: repl.replicates },
    diagnostics: { winners_killed: winnersKilled, winners_saved: winnersSaved, losers_improved: losersImproved, losers_worsened: losersWorsened, avg_stop_reduction_pts: triggeredCount ? +(totalStopReduction / triggeredCount).toFixed(2) : null, trades_never_triggered_grind: neverTriggered },
    control_deltas: { balance: balanceDelta, trend: trendDelta },
    price_bars_source: 'price_bars_primary',
    price_bars_symbol_filter: 'NQ',
    bars_last_verified_at: maxts,
    bars_row_count: rowcount,
    known_limitations: ['heldout N=14 underpowered for chronological-thirds stability', 'no walk-forward recalibration on expanding window', 'SHORT-only validation'],
  };

  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, optimal_stop, optimal_target, recommendation, notes)
    VALUES ($1, 0, 'GRIND_DETECTOR_TEST', $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
      SET sample_size=EXCLUDED.sample_size, win_rate=EXCLUDED.win_rate, ev_per_trade=EXCLUDED.ev_per_trade,
          optimal_stop=EXCLUDED.optimal_stop, optimal_target=EXCLUDED.optimal_target,
          recommendation=EXCLUDED.recommendation, notes=EXCLUDED.notes
  `, [today, `IB_BEARISH_TURBULENT_GRIND_${today}`, turbulent.length, null, +grindHeldoutEv.toFixed(2), best.grindThreshold, 50, recommendation, JSON.stringify(notes)]);

  for (const [label, delta] of [['BALANCE', balanceDelta], ['TREND', trendDelta]]) {
    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, ev_per_trade, notes)
      VALUES ($1, 0, 'GRIND_DETECTOR_TEST', $2, $3, $4, $5)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
        SET sample_size=EXCLUDED.sample_size, ev_per_trade=EXCLUDED.ev_per_trade, notes=EXCLUDED.notes
    `, [today, `IB_BEARISH_${label}_GRIND_${today}`, delta.n, +delta.value.toFixed(2), JSON.stringify({ mechanism: 'grind_detector', control_for: 'IB_BEARISH_TURBULENT', best_grind_threshold: best.grindThreshold, best_decay_rate: best.decayRate })]);
  }

  console.log(`\n[grind_detector] persisted to performance_audit (signal_type='GRIND_DETECTOR_TEST'). Done.`);
}

main().catch(e => { console.error(e); process.exit(1); });
