// pilot_ml_phase1_constant_multiplier_grid_20261007.mjs — Phase 0 pretest for the proposed
// ML-learned stop/target idea (Phase 1 of the model-learned-stop/target-on-top-of-OPTIMAL_STOP
// thread, scoped 2026-10-07, DeepSeek design critique same day). NOT scheduled, one-off.
//
// Question: before building any per-touch model, does a flat CONSTANT multiplier on the
// existing, already-validated OPTIMAL_STOP (stop,target) pair beat the baseline (1.0x) at all?
// This is DeepSeek's own "cheapest possible pretest" gate: if no constant beats 1.0x
// meaningfully, any per-touch model's job is a much higher bar (it has to beat a baseline that's
// already optimal), and the whole idea is close to dead on arrival without ever training a model.
//
// Method: real trades (REAL_TRADE_FILTER, is_cluster_primary-deduped, actually filled), each
// re-walked bar-by-bar at 4 candidate (stop,target) pairs = baseline OPTIMAL_STOP scaled by
// 0.8x/1.0x/1.2x/1.4x (single scalar on the pair, preserving the risk:reward ratio -- per
// DeepSeek's explicit warning against independent stop/target multipliers reintroducing the
// asymmetric-geometry placebo trap). Reuses precomputeCrossovers()/computeEvAtStopTargetChronological()
// from update_optimal_stops.mjs directly (no reimplementation) -- same no-lookahead, same
// WALK_WINDOW_BARS=390 cross-day window as the live calibration. Significance: day-blocked
// bootstrap CI on the PER-TRADE paired difference (ev_m - ev_1.0x), not an independent-group
// comparison -- the pairing is real (same trade, same bars, only the stop/target differ), so a
// paired-difference CI is both the correct statistic and the higher-powered one.
//
// NOT done in this pass (deliberately, to keep this the "cheap" half of DeepSeek's 2-part
// gate): the shuffle-placebo screen, which needs a real per-touch model to shuffle against --
// that's the next step only if this constant-grid result shows real room.

import { query } from '../server/db.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { makeBarIndex, WALK_WINDOW_BARS } from '../server/services/targetCalibrationService.js';
import { precomputeCrossovers, computeEvAtStopTargetChronological } from './update_optimal_stops.mjs';
import { dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';
import { REAL_TRADE_FILTER } from './backtest_setup_status.mjs';

const DPP = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const MULTIPLIERS = [0.8, 1.0, 1.2, 1.4];

async function main() {
  console.log('=== Phase 0 pretest: constant-multiplier grid over OPTIMAL_STOP ===\n');

  // 1. Latest real OPTIMAL_STOP row per setup_type -- the DISTINCT ON dedup convention this
  // codebase requires for any performance_audit read (a bare filter silently returns every
  // historical run's row once more than one has accumulated).
  const optRes = await query(`
    SELECT DISTINCT ON (signal_name) signal_name as setup_type,
      optimal_stop::float as stop, optimal_target::float as target
    FROM performance_audit
    WHERE signal_type = 'OPTIMAL_STOP'
    ORDER BY signal_name, run_date DESC, id DESC
  `);
  const baselineByType = {};
  for (const r of optRes.rows) {
    if (r.stop > 0 && r.target > 0) baselineByType[r.setup_type] = { stop: r.stop, target: r.target };
  }
  console.log(`OPTIMAL_STOP baselines available for ${Object.keys(baselineByType).length} setup_types`);

  // 2. CLUSTER-CONFLUENCE VARIANT (2026-10-07): deliberately the FULL REAL_TRADE_FILTER
  // population, NOT deduped to is_cluster_primary -- this is the DeepSeek-specified
  // cluster-level confluence test, which needs every sibling's own fill-gated EV too.
  // actual_pnl IS NOT NULL already excludes NOT_FILLED phantom siblings (the 2026-09-25
  // fill-gate fix), so every row here genuinely traded through its own entry.
  const tradesRes = await query(`
    SELECT id, setup_type, fired_at, entry_zone_low::float, entry_zone_high::float, actual_pnl::float,
      cluster_touch_id, confluence_score_at_detection::float as confluence
    FROM active_setups
    WHERE ${REAL_TRADE_FILTER}
      AND entry_zone_low IS NOT NULL AND actual_pnl IS NOT NULL
      AND ml_pd_features IS NOT NULL AND ml_intraday_features IS NOT NULL
    ORDER BY fired_at ASC
  `);
  console.log(`${tradesRes.rows.length} real resolved trades (pre setup_type/baseline filter)`);

  // 3. All NQ bars, once.
  const barsRes = await query(`SELECT ts, high::float as high, low::float as low, close::float as close FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
  const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), high: b.high, low: b.low, close: b.close }));
  const firstIndexAfter = makeBarIndex(allBars);
  console.log(`${allBars.length} NQ bars loaded\n`);

  const perTrade = []; // { date, setup_type, ev: {0.8:.., 1.0:.., 1.2:.., 1.4:..} }
  let skippedNoDirection = 0, skippedNoBaseline = 0, skippedNoBars = 0, skippedNoCrossover = 0;

  for (const t of tradesRes.rows) {
    const direction = inferDirection(t.setup_type);
    if (!direction) { skippedNoDirection++; continue; }
    const baseline = baselineByType[t.setup_type];
    if (!baseline) { skippedNoBaseline++; continue; }
    const entry = t.entry_zone_high ?? t.entry_zone_low;
    const barIdx = firstIndexAfter(new Date(t.fired_at).getTime());
    if (barIdx >= allBars.length) { skippedNoBars++; continue; }

    const pairs = MULTIPLIERS.map(m => ({
      m, stop: Math.round(baseline.stop * m), target: Math.round(baseline.target * m),
    }));
    const stopCandidates = pairs.map(p => p.stop);
    const targetCandidates = pairs.map(p => p.target);

    const crossovers = precomputeCrossovers({ barIdx, direction, entry }, allBars, stopCandidates, targetCandidates, WALK_WINDOW_BARS);
    if (!crossovers) { skippedNoCrossover++; continue; }

    const ev = {};
    let anyNull = false;
    for (const p of pairs) {
      const e = computeEvAtStopTargetChronological(crossovers, p.stop, p.target, DPP, DPP, COMMISSION);
      if (e == null) anyNull = true;
      ev[p.m] = e;
    }
    if (anyNull) continue;

    perTrade.push({
      id: t.id,
      date: new Date(t.fired_at).toISOString().slice(0, 10),
      setup_type: t.setup_type,
      cluster_touch_id: t.cluster_touch_id,
      confluence: t.confluence,
      ev,
    });
  }

  console.log(`Skipped: ${skippedNoDirection} no-direction, ${skippedNoBaseline} no-baseline, ${skippedNoBars} no-bars, ${skippedNoCrossover} no-crossover`);
  console.log(`Usable trades: ${perTrade.length}\n`);

  if (perTrade.length < 20) {
    console.log('FATAL: fewer than 20 usable trades, cannot proceed.');
    process.exit(1);
  }

  const distinctDates = new Set(perTrade.map(t => t.date)).size;
  console.log(`Distinct dates: ${distinctDates}`);
  const bySetupType = {};
  for (const t of perTrade) bySetupType[t.setup_type] = (bySetupType[t.setup_type] || 0) + 1;
  const topType = Object.entries(bySetupType).sort((a, b) => b[1] - a[1])[0];
  console.log(`Top setup_type: ${topType[0]} (${topType[1]}/${perTrade.length} = ${(100 * topType[1] / perTrade.length).toFixed(1)}%)\n`);

  console.log('--- Pooled EV per multiplier ---');
  for (const m of MULTIPLIERS) {
    const evs = perTrade.map(t => t.ev[m]);
    const mean = evs.reduce((a, b) => a + b, 0) / evs.length;
    const wins = evs.filter(e => e > 0).length;
    console.log(`  ${m}x: mean $${mean.toFixed(2)}/trade, WR ${(100 * wins / evs.length).toFixed(1)}%, N=${evs.length}`);
  }

  console.log('\n--- Paired difference vs 1.0x (day-blocked bootstrap 95% CI) ---');
  const results = {};
  for (const m of MULTIPLIERS) {
    if (m === 1.0) continue;
    const diffEvents = perTrade.map(t => ({ date: t.date, pnl: t.ev[m] - t.ev[1.0] }));
    const meanDiff = diffEvents.reduce((a, b) => a + b.pnl, 0) / diffEvents.length;
    const ci = dayBlockedBootstrapCI(diffEvents, `ml_phase0_multiplier_${m}`, { dateField: 'date' });
    const excludesZero = ci.lo > 0 || ci.hi < 0;
    console.log(`  ${m}x vs 1.0x: mean diff $${meanDiff.toFixed(2)}/trade, CI=[$${ci.lo.toFixed(2)}, $${ci.hi.toFixed(2)}]${excludesZero ? '  <<< excludes zero' : ''}`);
    results[m] = { meanDiff, ci, excludesZero };
  }

  console.log('\n=== VERDICT ===');
  const anyRealWin = Object.values(results).some(r => r.excludesZero && r.meanDiff > 0);
  const anyRealLoss = Object.values(results).some(r => r.excludesZero && r.meanDiff < 0);
  if (!anyRealWin) {
    console.log('No constant multiplier beats 1.0x (OPTIMAL_STOP as-is) with a CI that excludes zero.');
    console.log('Per DeepSeek\'s own gate: this is the "no constant helps" half of the kill condition.');
    console.log('Combined with the fact the shuffle-placebo screen was NOT run this pass, the honest');
    console.log('reading is: no evidence of room for Phase 1 from this cheap screen, but the per-touch');
    console.log('(not constant) claim is not yet directly tested -- do not treat this alone as a full kill.');
  } else {
    console.log('At least one constant multiplier shows a real (CI-excluding-zero) improvement over 1.0x.');
    console.log('This means there IS room in the asymmetry space -- exactly what DeepSeek flagged as the');
    console.log('placebo risk. Before concluding per-touch signal exists, this now NEEDS the shuffle-placebo');
    console.log('screen (does a per-touch model beat just applying the best constant everywhere?).');
  }
  if (anyRealLoss) {
    console.log('Note: at least one multiplier is REAL AND WORSE than 1.0x -- OPTIMAL_STOP\'s own sizing');
    console.log('already sits in a locally-good spot in at least that direction.');
  }

  console.log('\nNote on scope: this is a pooled, cross-roster, single-scalar screen. Per-trial count for');
  console.log(`a deflated-Sharpe check on this specific grid = ${MULTIPLIERS.length - 1} comparisons tested.`);

  // Export per-trade EV-at-multiplier table for the shuffle-placebo step (needs the real
  // ML feature set joined by id, done in Python).
  const fs = await import('fs');
  const header = 'id,date,setup_type,cluster_touch_id,confluence,ev_0.8,ev_1.0,ev_1.2,ev_1.4\n';
  const lines = perTrade.map(t => `${t.id},${t.date},${t.setup_type},${t.cluster_touch_id ?? ''},${t.confluence ?? ''},${t.ev[0.8]},${t.ev[1.0]},${t.ev[1.2]},${t.ev[1.4]}`);
  fs.writeFileSync('scratch/ml_cluster_confluence_ev_20261007.csv', header + lines.join('\n') + '\n');
  console.log(`\nExported ${perTrade.length} rows to scratch/ml_cluster_confluence_ev_20261007.csv`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
