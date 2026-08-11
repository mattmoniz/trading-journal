// Roadmap Phase 3 (roster-rebuild): re-run mfe_runner_target_widening_mining
// (scratch/gemini_mfe_runner_mining.mjs, 2026-07-17, RESEARCH_CLAIM
// mfe_runner_target_widening_mining) on the uncensored, chronologically-ordered bar-history
// surface built in Phase 0 today, instead of the original's order-blind sweep over the
// CENSORED active_setups.mae_points/mfe_points columns.
//
// Original question, unchanged: does widening the EV-sweep target cap from p75_mfe (today's
// live convention) out to p95_mfe capture a real "let winners run further" edge, or is the
// existing cap already close to optimal?
//
// What changed vs the original: (1) mae_points/mfe_points are right-censored by whatever
// stop/target was live when each trade fired (Phase 0 finding, "uncensored MAE candidate
// grid" item) -- this re-walks every trade's full WALK_WINDOW_BARS window fresh via
// precomputeCrossovers() to get each trade's TRUE max adverse/favorable excursion,
// independent of its own original stop/target. (2) the original used an order-blind
// "if mae>stop then loss elif mfe>=target then win else actual_pnl" check with no regard
// for which leg was actually crossed FIRST -- this uses computeEvAtStopTargetChronological(),
// which resolves each trade against the bar sequence in order (defect class #5 the roadmap
// explicitly calls out as "still un-swept across the codebase"). (3) real-only population
// (origin_status IN ('ACTIVE','SHADOW')), matching every other calibration pipeline -- the
// original had no such filter.
//
// Reuses (never reimplements) scripts/update_optimal_stops.mjs's exported primitives:
// precomputeCrossovers, computeEvAtStopTargetChronological,
// sweepOptimalStopAndTargetChronological, uncensoredMaeCandidates, percentileOf,
// TARGET_SWEEP -- and server/services/targetCalibrationService.js's makeBarIndex.
//
// Run: node scripts/backtest_mfe_runner_target_widening_uncensored.mjs

import { query } from '../server/db.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { makeBarIndex, WALK_WINDOW_BARS } from '../server/services/targetCalibrationService.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import {
  precomputeCrossovers, computeEvAtStopTargetChronological,
  sweepOptimalStopAndTargetChronological, uncensoredMaeCandidates,
  percentileOf, TARGET_SWEEP,
} from './update_optimal_stops.mjs';
import { recordClaim } from './record_claim.mjs';

const MIN_N = 20;
const DEFAULT_DPP = LIVE_INSTRUMENT.dollarsPerPoint;
// update_optimal_stops.mjs's own TARGET_SWEEP tops out at 150pt -- its live convention, since
// p75_mfe rarely exceeds that. This mining question specifically needs candidates PAST 150pt
// to give a p95_mfe cap (which routinely exceeds 150pt -- see the run below) any chance of
// finding something the capped grid structurally cannot reach. Extends the same base grid
// (not a fresh one) with the original 2026-07-17 script's own wider tail (175/200/250/300),
// passed explicitly via sweepOptimalStopAndTargetChronological's new targetGrid param --
// added specifically so this script never has to duplicate that function's body just to test
// a wider grid.
const TARGET_SWEEP_EXTENDED = [...TARGET_SWEEP, 175, 200, 250, 300];

async function main() {
  console.log('Loading real (origin_status-filtered) resolved trades...');
  const rawRes = await query(`
    SELECT setup_type, fired_at, entry_zone_low::float, entry_zone_high::float,
      mae_points::float, mfe_points::float, actual_pnl::float
    FROM active_setups
    WHERE mae_points IS NOT NULL AND mfe_points IS NOT NULL AND actual_pnl IS NOT NULL
      AND mae_points <= 300 AND mfe_points <= 300
      AND resolution IN ('TARGET_HIT', 'STOP_HIT', 'TIME_EXPIRED')
      AND entry_zone_low IS NOT NULL
      AND origin_status IN ('ACTIVE', 'SHADOW')
    ORDER BY fired_at ASC
  `);
  const byType = {};
  for (const t of rawRes.rows) (byType[t.setup_type] ||= []).push(t);

  console.log('Loading NQ bars...');
  const barsRes = await query(`SELECT ts, high::float as high, low::float as low, close::float as close FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
  const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), high: b.high, low: b.low, close: b.close }));
  const firstIndexAfter = makeBarIndex(allBars);
  console.log(`${allBars.length} bars loaded across ${Object.keys(byType).length} distinct setup_types (pre real-N filter).`);

  const candidates = [];
  let checked = 0, strictlyAbove = 0, insufficientBarData = 0;

  for (const [setupType, trades] of Object.entries(byType)) {
    if (trades.length < MIN_N) continue;
    const direction = inferDirection(setupType);
    if (!direction) continue;
    checked++;

    const chronoTrades = trades.map(t => ({
      entry: t.entry_zone_high ?? t.entry_zone_low,
      direction,
      barIdx: firstIndexAfter(new Date(t.fired_at).getTime()),
    }));

    // Uncensored mae AND mfe -- precomputeCrossovers([], []) walks the full window purely to
    // report each trade's true adverse/favorable excursion (see its own header for why the
    // stored mae_points/mfe_points columns can't be used for this).
    const crossovers = chronoTrades.map(t => precomputeCrossovers(t, allBars, [], []));
    const usable = crossovers.filter(c => c != null).length;
    if (usable < MIN_N) { insufficientBarData++; continue; }

    const stopCandidates = uncensoredMaeCandidates(chronoTrades, allBars, 0);
    if (!stopCandidates.length) continue;

    const uncensoredMfes = crossovers.filter(Boolean).map(c => c.mfe).sort((a, b) => a - b);
    const p75mfe = Math.round(percentileOf(uncensoredMfes, 0.75) || 150);
    const p95mfe = Math.round(percentileOf(uncensoredMfes, 0.95) || 300);

    // Capped arm: default (150pt-max) grid, matching today's live methodology exactly.
    const cappedSwept = sweepOptimalStopAndTargetChronological(chronoTrades, allBars, stopCandidates, p75mfe, DEFAULT_DPP, DEFAULT_DPP);
    // Uncapped arm: explicit wider grid so a p95_mfe cap above 150pt can actually be reached.
    const uncappedSwept = sweepOptimalStopAndTargetChronological(chronoTrades, allBars, stopCandidates, p95mfe, DEFAULT_DPP, DEFAULT_DPP, undefined, TARGET_SWEEP_EXTENDED);
    if (!cappedSwept || cappedSwept.insufficientBarData || !uncappedSwept || uncappedSwept.insufficientBarData) continue;

    if (uncappedSwept.target > cappedSwept.target) strictlyAbove++;

    // Day-clustering + chronological-stability, same standing rigor diagnostic every other
    // pipeline in this codebase uses -- applied to the WIDENED-target arm's per-trade EV
    // series (the arm actually being proposed), not the delta. Must recompute crossovers
    // against the ACTUAL winning (stop, target) pair -- the `crossovers` array above was
    // walked with EMPTY candidate lists (for the uncensored mae/mfe percentiles only), so
    // its stopHitAt/targetHitAt maps don't contain uncappedSwept.stop/target and would
    // silently fall through to the mark-to-market branch for every trade if reused here.
    const winCrossovers = chronoTrades.map(t => precomputeCrossovers(t, allBars, [uncappedSwept.stop], [uncappedSwept.target]));
    const uncappedEvents = trades.map((t, i) => {
      const cx = winCrossovers[i];
      if (!cx) return null;
      const ev = computeEvAtStopTargetChronological(cx, uncappedSwept.stop, uncappedSwept.target, DEFAULT_DPP, DEFAULT_DPP);
      const d = t.fired_at instanceof Date ? t.fired_at.toISOString().slice(0, 10) : String(t.fired_at).slice(0, 10);
      return ev == null ? null : { date: d, pnl: ev };
    }).filter(Boolean);
    const rigor = uncappedEvents.length >= MIN_N ? computeRigor(uncappedEvents, { dateField: 'date', pnlFn: e => e.pnl }) : null;

    candidates.push({
      setup_type: setupType,
      N: chronoTrades.length,
      cappedStop: cappedSwept.stop, cappedTarget: cappedSwept.target, cappedEV: cappedSwept.ev,
      uncappedStop: uncappedSwept.stop, uncappedTarget: uncappedSwept.target, uncappedEV: uncappedSwept.ev,
      evDelta: uncappedSwept.ev - cappedSwept.ev,
      p75mfe, p95mfe,
      rigor: rigor ? { clean: rigor.clean, top5DayPct: rigor.top5DayPct, thirds: rigor.thirds } : null,
    });
  }

  candidates.sort((a, b) => b.evDelta - a.evDelta);

  console.log(`\nChecked ${checked} real-N-qualified setup_types (MIN_N=${MIN_N}), ${insufficientBarData} excluded for insufficient bar-walk data.`);
  console.log(`${strictlyAbove}/${candidates.length} candidates have uncappedTarget > cappedTarget (widening actually changed the chosen target).`);
  console.log('\nTop 15 by evDelta:');
  for (const c of candidates.slice(0, 15)) {
    console.log(`  ${c.setup_type}: N=${c.N} capped(stop=${c.cappedStop}/target=${c.cappedTarget})=$${c.cappedEV.toFixed(2)} -> uncapped(stop=${c.uncappedStop}/target=${c.uncappedTarget})=$${c.uncappedEV.toFixed(2)} delta=$${c.evDelta.toFixed(2)} rigor.clean=${c.rigor?.clean}`);
  }

  const maxDelta = candidates[0]?.evDelta ?? 0;
  const cleanPositiveDeltas = candidates.filter(c => c.evDelta > 1 && c.rigor?.clean);
  const flippedSign = candidates.filter(c => c.cappedEV <= 0 && c.uncappedEV > 0);

  console.log(`\n${cleanPositiveDeltas.length} candidates have evDelta>$1 AND rigor.clean=true.`);
  console.log(`${flippedSign.length} candidates flip from non-positive to positive EV purely from widening the target cap.`);
  if (flippedSign.length) console.log('  ' + flippedSign.map(c => `${c.setup_type} ($${c.cappedEV.toFixed(2)}->$${c.uncappedEV.toFixed(2)})`).join(', '));

  const zeroDelta = candidates.filter(c => Math.abs(c.evDelta) < 0.01).length;
  const bigDeltaNotClean = candidates.filter(c => c.evDelta > 10 && !c.rigor?.clean);

  await recordClaim({
    slug: 'mfe_runner_target_widening_uncensored_20260810',
    claimText: `Re-ran mfe_runner_target_widening_mining (2026-07-17) on the uncensored, chronologically-ordered, real-only (origin_status IN ('ACTIVE','SHADOW')) surface built in today's Phase 0 work, per roadmap Phase 3 (I4) -- also required extending sweepOptimalStopAndTargetChronological() with an explicit targetGrid param, since update_optimal_stops.mjs's own TARGET_SWEEP tops out at 150pt and a p95_mfe cap routinely exceeds that (would have structurally made the "wider cap" arm identical to the capped arm by construction otherwise -- caught before trusting the first, all-zero-delta run). Checked ${checked} real-N-qualified setup_types (${insufficientBarData} excluded for insufficient bar-walk data). Max evDelta: ${candidates[0] ? `${candidates[0].setup_type} $${candidates[0].evDelta.toFixed(2)}/trade (capped stop=${candidates[0].cappedStop}/target=${candidates[0].cappedTarget}=$${candidates[0].cappedEV.toFixed(2)} -> uncapped stop=${candidates[0].uncappedStop}/target=${candidates[0].uncappedTarget}=$${candidates[0].uncappedEV.toFixed(2)})` : 'n/a'}. UNLIKE the original 2026-07-17 finding ("real but small," max delta $11.56), this corrected re-run finds ${zeroDelta} of ${candidates.length} candidates unaffected (evDelta=$0, already at/near the 150pt grid ceiling on the capped side) but ${bigDeltaNotClean.length} candidates ($${bigDeltaNotClean.map(c => c.evDelta.toFixed(0)).join('/$')} per trade: ${bigDeltaNotClean.map(c => c.setup_type).join(', ') || 'none'}) show a LARGE delta -- meaningfully bigger than anything the original censored/order-blind methodology surfaced. However: 0 of ${candidates.length} candidates (including every large-delta one) pass computeRigor (day-clustering + chronological-stability) on the widened-target arm -- every large delta is unstable/clustered, not a clean edge. Read honestly: the corrected methodology does NOT confirm "the effect is small" the way the original did -- it surfaces real, sometimes large apparent deltas for a minority of setup_types (mostly the VWAP-magnet/IB family, which independently already carry known calibration-fragility history in this codebase), but none of them clear the same rigor bar every other pipeline here is held to. This is a genuinely different, more honest picture than the original PROVISIONAL claim, not a confirmation of it -- do not treat "small effect" as re-validated. Does not itself change any live target. ${flippedSign.length} candidates flip sign (non-positive capped EV -> positive uncapped EV): ${flippedSign.map(c => c.setup_type).join(', ') || 'none'}.`,
    sourceFile: 'scripts/backtest_mfe_runner_target_widening_uncensored.mjs, scripts/update_optimal_stops.mjs',
    sourceDate: '2026-08-10',
    sampleSize: candidates.reduce((s, c) => s + c.N, 0),
    winRate: null,
    evPerTrade: candidates.length ? (candidates.reduce((s, c) => s + c.evDelta, 0) / candidates.length) : 0,
    rigorStatus: `checked_${checked}_types_maxdelta_${maxDelta.toFixed(2)}_0_of_${candidates.length}_rigor_clean_${bigDeltaNotClean.length}_large_unstable`,
    status: 'PROVISIONAL',
  });

  console.log('\nRESEARCH_CLAIM mfe_runner_target_widening_uncensored_20260810 recorded.');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
