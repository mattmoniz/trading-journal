// Setup D ("Opening Drive") — Stage 4: hybrid entry rule combining the existing pullback
// entry (Stage 1, validated) with an immediate entry gated on drive magnitude (Stage 3
// discriminator, found this session: AUC=0.300 full-sample, 0.293/0.329 train/test OOS).
//
// Methodology, addressing the known risks of thresholding a 205-observation sample:
// - Threshold candidates are PRE-REGISTERED and small in number (median split, tercile split,
//   a couple of round OR-range multiples) -- not a fine grid search, to avoid manufacturing
//   false precision out of noise (train fold is only ~136 observations).
// - Threshold is picked using ONLY the chronological TRAIN fold's EV. The TEST fold is
//   touched exactly once, at the end, to report the real OOS number.
// - Each sub-rule keeps its OWN already-validated stop/target (pullback path: 85/150 from
//   Stage 1/2; immediate-entry path: 159/80 from Stage 2) rather than re-sweeping the
//   combined population -- one fewer free parameter fit on an already-thin sample.
// - Reports whether the effect holds even on drives with ample remaining session time, to
//   check it isn't just "no time left to retrace" (a definitional/tautological risk flagged
//   before building this).
//
// Run: node scripts/backtest_setup_d_opening_drive_stage4_hybrid.mjs

import { classifyACDOpeningCall } from '../server/services/openingCallClassifier.js';
import { resolve, loadData } from './backtest_unified.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';

const DEFAULT_DPP = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const WALK_MAX_BARS = 240;
const WIN = { orEndMin: 585, confirmEndMin: 615 };

// Already-validated stop/target pairs from Stage 1/2 -- kept fixed, not re-swept here.
const PULLBACK_STOP = 85, PULLBACK_TARGET = 150;
const IMMEDIATE_STOP = 159, IMMEDIATE_TARGET = 80;

function pnl(entry, exitPrice, long) {
  const signedPoints = long ? (exitPrice - entry) : (entry - exitPrice);
  return signedPoints * DEFAULT_DPP - COMMISSION;
}
function walkPnl(bars, entryIdx, direction, entry, stop, target) {
  const res = resolve(bars, entryIdx, direction, entry, stop, target, WALK_MAX_BARS);
  if (res.result !== 'EXPIRED') return res.pnl;
  const cutoff = bars[Math.min(bars.length - 1, entryIdx + WALK_MAX_BARS)];
  return pnl(entry, cutoff.close, direction === 'LONG');
}

async function main() {
  console.log('[setup_d_stage4] Loading bar/ACD data...');
  const { barsByDate, acdByDate, dates } = await loadData();

  const records = [];
  for (const date of dates) {
    let bars = barsByDate.get(date);
    const acd = acdByDate.get(date);
    if (!bars || !acd) continue;
    bars = bars.map(b => ({ ...b, mod: Number(b.tod) }));

    const orBars = bars.filter(b => b.tod >= 570 && b.tod < WIN.orEndMin);
    const confirmBars = bars.filter(b => b.tod >= 570 && b.tod < WIN.confirmEndMin);
    if (orBars.length < 3 || confirmBars.length < 5) continue;
    const orH = Math.max(...orBars.map(b => b.high));
    const orL = Math.min(...orBars.map(b => b.low));
    const orRange = orH - orL || 1;

    const call = classifyACDOpeningCall(confirmBars, orH, orL);
    if (!call || call.type !== 'OPEN_DRIVE') continue;
    const isLong = call.driveDirection === 'UP';
    const direction = isLong ? 'LONG' : 'SHORT';

    const confirmEndIdx = bars.findIndex(b => b.tod >= WIN.confirmEndMin);
    if (confirmEndIdx === -1) continue;
    const confirmCloseBar = bars[confirmEndIdx];

    const driveMag = isLong
      ? (confirmCloseBar.close - orH) / orRange
      : (orL - confirmCloseBar.close) / orRange;

    // Pullback-path entry (Arm A): first bar from confirm-close whose close enters the
    // asymmetric band around the boundary.
    let pullbackIdx = null;
    for (let i = confirmEndIdx; i < bars.length && bars[i].tod < 960; i++) {
      const px = bars[i].close;
      const hit = isLong ? (px >= orH - 15 && px <= orH + 5) : (px <= orL + 15 && px >= orL - 5);
      if (hit) { pullbackIdx = i; break; }
    }

    const remainingBars = bars.length - 1 - confirmEndIdx; // proxy for "time left in the session"

    records.push({
      date, bars, direction, driveMag, remainingBars,
      immediateEntryIdx: confirmEndIdx, immediateEntry: confirmCloseBar.close,
      pullbackEntryIdx: pullbackIdx, pullbackEntry: pullbackIdx != null ? bars[pullbackIdx].close : null,
    });
  }

  console.log(`Total qualifying classified drives: N=${records.length}`);

  const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date));
  const splitIdx = Math.floor(sorted.length * (2 / 3));
  const train = sorted.slice(0, splitIdx), test = sorted.slice(splitIdx);
  console.log(`Chronological split: train N=${train.length}, test N=${test.length}`);

  // Existing baseline (pullback-only, no hybrid change) for a given population.
  function pullbackOnlyEv(pop) {
    const withPullback = pop.filter(r => r.pullbackEntryIdx != null);
    if (!withPullback.length) return { n: 0, ev: 0 };
    let sum = 0;
    for (const r of withPullback) {
      const stopPrice = r.direction === 'LONG' ? r.pullbackEntry - PULLBACK_STOP : r.pullbackEntry + PULLBACK_STOP;
      const targetPrice = r.direction === 'LONG' ? r.pullbackEntry + PULLBACK_TARGET : r.pullbackEntry - PULLBACK_TARGET;
      sum += walkPnl(r.bars, r.pullbackEntryIdx, r.direction, r.pullbackEntry, stopPrice, targetPrice);
    }
    // Days that never pull back contribute $0 (no trade at all today) to the baseline's
    // per-classified-drive-day EV -- the honest denominator for comparing against the hybrid.
    return { n: pop.length, nTraded: withPullback.length, ev: sum / pop.length };
  }

  // Hybrid: above threshold -> immediate entry; below threshold -> existing pullback rule
  // (which itself may never fire if the pullback never happens -- $0 that day).
  function hybridEv(pop, threshold) {
    let sum = 0;
    for (const r of pop) {
      if (r.driveMag >= threshold) {
        const stopPrice = r.direction === 'LONG' ? r.immediateEntry - IMMEDIATE_STOP : r.immediateEntry + IMMEDIATE_STOP;
        const targetPrice = r.direction === 'LONG' ? r.immediateEntry + IMMEDIATE_TARGET : r.immediateEntry - IMMEDIATE_TARGET;
        sum += walkPnl(r.bars, r.immediateEntryIdx, r.direction, r.immediateEntry, stopPrice, targetPrice);
      } else if (r.pullbackEntryIdx != null) {
        const stopPrice = r.direction === 'LONG' ? r.pullbackEntry - PULLBACK_STOP : r.pullbackEntry + PULLBACK_STOP;
        const targetPrice = r.direction === 'LONG' ? r.pullbackEntry + PULLBACK_TARGET : r.pullbackEntry - PULLBACK_TARGET;
        sum += walkPnl(r.bars, r.pullbackEntryIdx, r.direction, r.pullbackEntry, stopPrice, targetPrice);
      }
      // else: below threshold AND never pulled back -- no trade, $0, exactly the current
      // live behavior for that day (honest, not swept under the rug).
    }
    return sum / pop.length;
  }

  // Pre-registered threshold candidates (train-fold distribution only) -- no fine grid search.
  const trainMags = train.map(r => r.driveMag).sort((a, b) => a - b);
  const median = trainMags[Math.floor(trainMags.length / 2)];
  const p67 = trainMags[Math.floor(trainMags.length * (2 / 3))]; // tercile split
  const candidates = [
    { label: 'median split', value: median },
    { label: 'tercile split (p67)', value: p67 },
    { label: '0.5 OR-range', value: 0.5 },
    { label: '0.6 OR-range', value: 0.6 },
  ];

  console.log('\n=== Threshold selection (TRAIN fold only) ===');
  const baselineTrain = pullbackOnlyEv(train);
  console.log(`Baseline (pullback-only), train: N=${baselineTrain.n}, traded=${baselineTrain.nTraded}, EV/classified-day=$${baselineTrain.ev.toFixed(2)}`);
  let best = null;
  for (const c of candidates) {
    const ev = hybridEv(train, c.value);
    console.log(`  ${c.label} (threshold=${c.value.toFixed(3)}): hybrid EV/classified-day=$${ev.toFixed(2)}`);
    if (!best || ev > best.ev) best = { ...c, ev };
  }
  console.log(`Winning threshold (train): ${best.label} = ${best.value.toFixed(3)}`);

  console.log('\n=== OOS evaluation on the untouched TEST fold (threshold fixed from train) ===');
  const baselineTest = pullbackOnlyEv(test);
  const hybridTestEv = hybridEv(test, best.value);
  console.log(`Baseline (pullback-only), test: N=${baselineTest.n}, traded=${baselineTest.nTraded}, EV/classified-day=$${baselineTest.ev.toFixed(2)}`);
  console.log(`Hybrid (threshold=${best.value.toFixed(3)}), test: EV/classified-day=$${hybridTestEv.toFixed(2)}`);
  console.log(`Lift on test fold: $${(hybridTestEv - baselineTest.ev).toFixed(2)}/classified-day`);

  // Rigor check on the hybrid strategy's per-trade PnL series (only days it actually trades).
  const fullEvents = [];
  for (const r of sorted) {
    if (r.driveMag >= best.value) {
      const stopPrice = r.direction === 'LONG' ? r.immediateEntry - IMMEDIATE_STOP : r.immediateEntry + IMMEDIATE_STOP;
      const targetPrice = r.direction === 'LONG' ? r.immediateEntry + IMMEDIATE_TARGET : r.immediateEntry - IMMEDIATE_TARGET;
      fullEvents.push({ date: r.date, pnl: walkPnl(r.bars, r.immediateEntryIdx, r.direction, r.immediateEntry, stopPrice, targetPrice) });
    } else if (r.pullbackEntryIdx != null) {
      const stopPrice = r.direction === 'LONG' ? r.pullbackEntry - PULLBACK_STOP : r.pullbackEntry + PULLBACK_STOP;
      const targetPrice = r.direction === 'LONG' ? r.pullbackEntry + PULLBACK_TARGET : r.pullbackEntry - PULLBACK_TARGET;
      fullEvents.push({ date: r.date, pnl: walkPnl(r.bars, r.pullbackEntryIdx, r.direction, r.pullbackEntry, stopPrice, targetPrice) });
    }
  }
  const rigor = computeRigor(fullEvents, { dateField: 'date', pnlFn: e => e.pnl });
  console.log(`\nHybrid strategy full-sample trade count: N=${fullEvents.length}, rigor.clean=${rigor.clean}, top5DayPct=${rigor.top5DayPct}, thirds=${JSON.stringify(rigor.thirds)}`);

  // Tautology check: does the immediate-entry population above threshold still show an edge
  // when restricted to days with plenty of remaining session bars (i.e. it's not just "no
  // time left to retrace")?
  const aboveThreshold = sorted.filter(r => r.driveMag >= best.value);
  const remBarsSorted = aboveThreshold.map(r => r.remainingBars).sort((a, b) => a - b);
  const medianRemaining = remBarsSorted[Math.floor(remBarsSorted.length / 2)];
  const ampleTime = aboveThreshold.filter(r => r.remainingBars >= medianRemaining);
  const tightTime = aboveThreshold.filter(r => r.remainingBars < medianRemaining);
  function evalImmediate(pop) {
    if (!pop.length) return { n: 0, ev: 0 };
    let sum = 0;
    for (const r of pop) {
      const stopPrice = r.direction === 'LONG' ? r.immediateEntry - IMMEDIATE_STOP : r.immediateEntry + IMMEDIATE_STOP;
      const targetPrice = r.direction === 'LONG' ? r.immediateEntry + IMMEDIATE_TARGET : r.immediateEntry - IMMEDIATE_TARGET;
      sum += walkPnl(r.bars, r.immediateEntryIdx, r.direction, r.immediateEntry, stopPrice, targetPrice);
    }
    return { n: pop.length, ev: sum / pop.length };
  }
  console.log(`\nTautology check (above-threshold population, split by remaining session bars at confirm-close, median=${medianRemaining}):`);
  console.log(`  Ample time remaining: ${JSON.stringify(evalImmediate(ampleTime))}`);
  console.log(`  Less time remaining:  ${JSON.stringify(evalImmediate(tightTime))}`);
}

main().then(() => { console.log('\nDone.'); process.exit(0); }).catch(e => { console.error('FATAL:', e); process.exit(1); });
