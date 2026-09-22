// User question, 2026-09-22: can the system use "Expand" (the live volume-building-strength
// gauge) and "Vol Watch" (the volume-piling gauge) to detect which overnight sessions are
// trending vs not, and conditionally switch OVERNIGHT_ORDERFLOW_LONG/SHORT to a trailing exit
// only on the non-trending ones (since research_overnight_orderflow_trail_exit.mjs found a
// uniform trail hurts overall, by clipping the big trend days that drive the whole edge)?
//
// "Vol Watch" (server/services/volumePileGauge.js) is ruled out on inspection alone, before
// running anything: its own live-endpoint comment already states "a live volume spike alone
// does not predict continuation" -- confirmed negative in RESEARCH_CLAIM
// directional_orderflow_ride_no_stop_negative_20260921 (heavy one-sided Globex volume reads as
// exhaustion/climax, not continuation). Using it as a trend-detector here would be reusing a
// signal for the one purpose it's already been tested for and failed at.
//
// "Expand" (server/services/acdLiveCalibration.js's computeLiveVolumeBuildingSignal(), the
// same composite z-score behind quick-check.html's "Expand" chip) is a genuinely different,
// ALREADY-VALIDATED signal: docs/VOLUME_BUILDING_EXPANSION_SIGNAL_SPEC.md confirmed it predicts
// a BIGGER swing coming soon, in EITHER direction (non-directional). That's a plausible
// trend-vs-chop classifier for THIS purpose -- untested for it specifically, so tested here.
//
// Reuses fetchTrades()'s real N=53 population + sessionBarsAtEntry (added alongside this
// script, same commit) and calls the REAL, live computeLiveVolumeBuildingSignal() -- no
// reimplementation, per this codebase's "export the real function" rule. One honest caveat:
// this calls TODAY's calibration/baseline row for every historical date (the function's own
// design, shared with every other caller), not a point-in-time reconstruction -- acceptable
// for an exploratory Phase 0 test, same as every other retrospective use of this function.
import { fetchTrades } from './calibrate_overnight_orderflow_entry.mjs';
import { computeLiveVolumeBuildingSignal } from '../server/services/acdLiveCalibration.js';
import { dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const DOLLAR_PER_PT = 2, COMMISSION = 2;
const BASELINE_STOP = 700, BASELINE_EXIT = '13:30';
const TRAIL_ARM = 150, TRAIL_WIDTH = 80; // the best cell found in the prior script

function simBaseline(t) {
  const mae = t.maeAtExitIdx[BASELINE_EXIT];
  if (mae >= BASELINE_STOP) return -BASELINE_STOP;
  return (t.priceAtExit(BASELINE_EXIT) - t.entryPrice) * t.direction;
}

function simTrail(t, bars) {
  const long = t.direction === 1;
  let armed = false, peak = null, stop = long ? t.entryPrice - BASELINE_STOP : t.entryPrice + BASELINE_STOP;
  const exitIdx = t.exitIdxByTime[BASELINE_EXIT];
  for (let i = t.entryIdx; i <= exitIdx; i++) {
    const b = bars[i];
    if (!b) continue;
    if (!armed) {
      const stopHit = long ? b.low <= stop : b.high >= stop;
      if (stopHit) return -BASELINE_STOP;
      const favorableExtreme = long ? b.high - t.entryPrice : t.entryPrice - b.low;
      if (favorableExtreme >= TRAIL_ARM) {
        armed = true; peak = long ? b.high : b.low; stop = t.entryPrice;
        const sameBar = long ? b.low <= stop : b.high >= stop;
        if (sameBar) return 0;
      }
      continue;
    }
    if (long && b.high > peak) peak = b.high;
    if (!long && b.low < peak) peak = b.low;
    const candidateStop = long ? peak - TRAIL_WIDTH : peak + TRAIL_WIDTH;
    if (long && candidateStop > stop) stop = candidateStop;
    if (!long && candidateStop < stop) stop = candidateStop;
    const trailHit = long ? b.low <= stop : b.high >= stop;
    if (trailHit) return (stop - t.entryPrice) * t.direction;
  }
  return (t.priceAtExit(BASELINE_EXIT) - t.entryPrice) * t.direction;
}

function dollarSummary(captures, dates, label) {
  const dollars = captures.map((c) => c * DOLLAR_PER_PT - COMMISSION);
  const mean = dollars.reduce((a, b) => a + b, 0) / dollars.length;
  const ci = dayBlockedBootstrapCI(dates.map((date, i) => ({ date, pnl: captures[i] })), `regime_${label}`, { dateField: 'date' });
  return { label, n: captures.length, meanDollarPerDay: +mean.toFixed(2), ci: { lo: +ci.lo.toFixed(1), hi: +ci.hi.toFixed(1) } };
}

async function main() {
  const { trades, bars } = await fetchTrades();
  console.log(`Population: N=${trades.length}\n`);

  console.log('Step 1: pull the real live "Expand" composite-strength reading at each trade\'s own 12am entry moment...');
  const withExpand = [];
  for (const t of trades) {
    const sessionBars = t.sessionBarsAtEntry.map((b) => ({
      mod: parseInt(b.timeStr.slice(0, 2), 10) * 60 + parseInt(b.timeStr.slice(3, 5), 10),
      volume: b.bid_volume + b.ask_volume,
    }));
    const signal = await computeLiveVolumeBuildingSignal(t.tDay, sessionBars);
    withExpand.push({ ...t, compositeStrength: signal.compositeStrength });
  }
  const scored = withExpand.filter((t) => t.compositeStrength != null);
  console.log(`  ${scored.length}/${trades.length} trades have a real compositeStrength reading (rest too early in the session's own bar history).`);

  if (scored.length < 20) {
    console.log('ABORT: too few scored trades to test a regime split meaningfully.');
    process.exit(0);
  }

  console.log('\nStep 2: does Expand-at-entry predict which nights become the big movers?');
  const mfe = scored.map((t) => t.mfeAtExitIdx[BASELINE_EXIT]);
  const strength = scored.map((t) => t.compositeStrength);
  const n = scored.length;
  const meanX = strength.reduce((a, b) => a + b, 0) / n, meanY = mfe.reduce((a, b) => a + b, 0) / n;
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) { const dx = strength[i] - meanX, dy = mfe[i] - meanY; num += dx * dy; denX += dx * dx; denY += dy * dy; }
  const corr = num / Math.sqrt(denX * denY);
  console.log(`  Pearson corr(compositeStrength at entry, eventual MFE by ${BASELINE_EXIT}) = ${corr.toFixed(3)} (N=${n})`);

  const sortedByStrength = [...scored].sort((a, b) => a.compositeStrength - b.compositeStrength);
  const half = Math.floor(n / 2);
  const lowGroup = sortedByStrength.slice(0, half), highGroup = sortedByStrength.slice(n - half);
  const meanMfeLow = lowGroup.reduce((s, t) => s + t.mfeAtExitIdx[BASELINE_EXIT], 0) / lowGroup.length;
  const meanMfeHigh = highGroup.reduce((s, t) => s + t.mfeAtExitIdx[BASELINE_EXIT], 0) / highGroup.length;
  console.log(`  LOW-Expand half (n=${lowGroup.length}): mean MFE = ${meanMfeLow.toFixed(1)}pt`);
  console.log(`  HIGH-Expand half (n=${highGroup.length}): mean MFE = ${meanMfeHigh.toFixed(1)}pt`);

  console.log('\nStep 3: regime-conditioned exit -- trail on LOW-Expand nights only, hold flat on HIGH-Expand nights.');
  const flatAll = dollarSummary(scored.map(simBaseline), scored.map((t) => t.tDay), 'flat_all_scored_subset');
  console.log('  Flat-always baseline (scored subset only, for apples-to-apples):', flatAll);

  const regimeCaptures = scored.map((t) => (t.compositeStrength < 0 ? simTrail(t, bars) : simBaseline(t)));
  const regime = dollarSummary(regimeCaptures, scored.map((t) => t.tDay), 'regime_conditioned');
  console.log('  Regime-conditioned (trail if compositeStrength<0 else flat):', regime);

  const trailAll = dollarSummary(scored.map((t) => simTrail(t, bars)), scored.map((t) => t.tDay), 'trail_always_scored_subset');
  console.log('  Trail-always (scored subset, for comparison):', trailAll);

  const verdict = regime.meanDollarPerDay > flatAll.meanDollarPerDay ? 'IMPROVES' : 'DOES_NOT_IMPROVE';
  console.log(`\nVerdict: regime-conditioned exit ${verdict} on flat-always (delta $${(regime.meanDollarPerDay - flatAll.meanDollarPerDay).toFixed(2)}/day, corr=${corr.toFixed(3)})`);

  await recordClaim({
    slug: 'overnight_orderflow_expand_regime_exit_20260922',
    claimText: `User question (2026-09-22): can "Expand" (computeLiveVolumeBuildingSignal, the same composite behind quick-check.html's Expand chip -- already-validated as a non-directional "bigger swing coming" signal per docs/VOLUME_BUILDING_EXPANSION_SIGNAL_SPEC.md) classify which OVERNIGHT_ORDERFLOW_LONG/SHORT nights are trend-shaped (hold flat, per research_overnight_orderflow_trail_exit.mjs's finding that trailing hurts overall) vs chop-shaped (where trailing might help)? "Vol Watch" (volumePileGauge.js) was ruled out without testing -- its own header and RESEARCH_CLAIM directional_orderflow_ride_no_stop_negative_20260921 already establish elevated Globex volume does NOT predict continuation, so using it as a trend detector reuses a signal for the exact purpose it already failed at. Tested Expand instead: pulled the REAL compositeStrength reading (via the live function, not reimplemented) at each of N=${n} scored trades' (of ${trades.length} total) own 12am entry moment, correlated against eventual MFE by ${BASELINE_EXIT}: Pearson r=${corr.toFixed(3)}. LOW-Expand half mean MFE=${meanMfeLow.toFixed(1)}pt vs HIGH-Expand half mean MFE=${meanMfeHigh.toFixed(1)}pt. Regime-conditioned exit (trail on compositeStrength<0 nights, flat otherwise) vs flat-always on the same scored subset: $${regime.meanDollarPerDay}/day vs $${flatAll.meanDollarPerDay}/day (delta $${(regime.meanDollarPerDay - flatAll.meanDollarPerDay).toFixed(2)}/day). Verdict: ${verdict}. Population thin (N=${n} scored) -- treat as a first look, not a promotion-ready result.`,
    sourceFile: 'scripts/research_overnight_orderflow_regime_exit.mjs',
    sourceDate: '2026-09-22',
    sampleSize: n,
    winRate: null,
    evPerTrade: regime.meanDollarPerDay - flatAll.meanDollarPerDay,
    rigorStatus: `n=${n}_thin_single_split_no_holdout`,
    status: 'PROVISIONAL',
  });
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
