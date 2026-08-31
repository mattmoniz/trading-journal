// Roadmap Setup D ("Opening Drive") — Stage 2. Extends Stage 1
// (backtest_setup_d_opening_drive_stage1.mjs) with two new arms, dispatched to Gemini and
// independently re-verified by re-running directly (2026-08-31, see docs/OPEN_THREADS.md).
// Arm A: re-derives Stage 1's existing pullback-to-boundary entry on current data.
// Arm B (NEW): immediate entry at confirm-window close, no pullback wait -- tests whether
// "capitalize on the break itself" beats waiting for a cheaper re-entry.
// Arm C (NEW): volume-building composite-strength tercile split on each arm's own entries,
// using the real computeVolumeBuildingMeasures()/getVolumeBaseline() from touchQuality.js --
// reused, not reimplemented, per this codebase's "export the real function" rule.
//
// Only VARIANT_15MIN (Stage 1 already established 15-min beats 5-min).
//
// Run: node scripts/backtest_setup_d_opening_drive_stage2.mjs

import { query } from '../server/db.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { classifyACDOpeningCall } from '../server/services/openingCallClassifier.js';
import { resolve, loadData } from './backtest_unified.js';
import { TARGET_SWEEP } from './update_optimal_stops.mjs';
import { getVolumeBaseline, computeVolumeBuildingMeasures } from '../server/services/touchQuality.js';

const DEFAULT_DPP = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const WALK_MAX_BARS = 240;
const MIN_N = 20;
const TARGET_SWEEP_EXTENDED = [...TARGET_SWEEP, 175, 200, 250, 300];

const WIN = { orEndMin: 585, confirmEndMin: 615 };  // OR 9:30-9:45, confirm 9:30-10:15 (scaled 1:3)

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
function walkMfe(bars, entryIdx, direction, entry, stop, target) {
  const res = resolve(bars, entryIdx, direction, entry, stop, target, WALK_MAX_BARS);
  return res.mfe || 0;
}
function percentileOf(sortedArr, p) {
  if (!sortedArr.length) return null;
  return sortedArr[Math.min(sortedArr.length - 1, Math.floor(sortedArr.length * p))];
}

async function main() {
  console.log('[setup_d_stage2] Loading bar/ACD data...');
  const { barsByDate, acdByDate, dates } = await loadData();

  const armATouches = [];
  const armBTouches = [];

  for (const date of dates) {
    let bars = barsByDate.get(date);
    const acd = acdByDate.get(date);
    if (!bars || !acd) continue;

    bars = bars.map(b => ({ ...b, volume: b.bid_vol + b.ask_vol, mod: Number(b.tod) }));

    const orBars = bars.filter(b => b.tod >= 570 && b.tod < WIN.orEndMin);
    const confirmBars = bars.filter(b => b.tod >= 570 && b.tod < WIN.confirmEndMin);
    if (orBars.length < 3 || confirmBars.length < 5) continue;
    const orH = Math.max(...orBars.map(b => b.high));
    const orL = Math.min(...orBars.map(b => b.low));

    const call = classifyACDOpeningCall(confirmBars, orH, orL);
    if (!call || call.type !== 'OPEN_DRIVE') continue;

    const dir = call.driveDirection;
    const isLong = dir === 'UP';

    const confirmEndIdx = bars.findIndex(b => b.tod >= WIN.confirmEndMin);
    if (confirmEndIdx === -1) continue;

    armBTouches.push({
      date, bars, entryIdx: confirmEndIdx, entry: bars[confirmEndIdx].close,
      direction: isLong ? 'LONG' : 'SHORT'
    });

    let entryIdx = null;
    for (let i = confirmEndIdx; i < bars.length && bars[i].tod < 960; i++) {
      const px = bars[i].close;
      const hit = isLong
        ? (px >= orH - 15 && px <= orH + 5)
        : (px <= orL + 15 && px >= orL - 5);
      if (hit) { entryIdx = i; break; }
    }

    if (entryIdx != null) {
      armATouches.push({
        date, bars, entryIdx, entry: bars[entryIdx].close, direction: isLong ? 'LONG' : 'SHORT'
      });
    }
  }

  function sweepArm(touches, label) {
    if (touches.length < MIN_N) return { insufficientN: true, n: touches.length, label };
    const maes = touches.map(t => {
      const res = resolve(t.bars, t.entryIdx, t.direction, t.entry, t.direction === 'LONG' ? t.entry - 1000 : t.entry + 1000, t.direction === 'LONG' ? t.entry + 1000 : t.entry - 1000, WALK_MAX_BARS);
      return res.mae;
    }).sort((a, b) => a - b);
    const stopCandidates = [0.25, 0.40, 0.50, 0.60, 0.75].map(pct => ({ value: percentileOf(maes, pct), pct })).filter(c => c.value > 0);

    const sorted = [...touches].sort((a, b) => a.date.localeCompare(b.date));
    const splitIdx = Math.floor(sorted.length * (2 / 3));
    const train = sorted.slice(0, splitIdx), test = sorted.slice(splitIdx);

    let best = null;
    for (const { value: stopVal, pct } of stopCandidates) {
      const stop = Math.round(stopVal);
      const requiredN = Math.ceil(MIN_N / (1 - pct));
      if (train.length < requiredN) continue;
      for (const target of TARGET_SWEEP_EXTENDED) {
        let sum = 0;
        for (const t of train) {
          sum += walkPnl(t.bars, t.entryIdx, t.direction, t.entry, t.direction === 'LONG' ? t.entry - stop : t.entry + stop, t.direction === 'LONG' ? t.entry + target : t.entry - target);
        }
        const ev = sum / train.length;
        if (!best || ev > best.ev) best = { stop, target, ev };
      }
    }
    if (!best) return { insufficientN: true, n: touches.length, label };

    let oosSum = 0;
    for (const t of test) {
      oosSum += walkPnl(t.bars, t.entryIdx, t.direction, t.entry, t.direction === 'LONG' ? t.entry - best.stop : t.entry + best.stop, t.direction === 'LONG' ? t.entry + best.target : t.entry - best.target);
    }
    const oosEv = test.length ? oosSum / test.length : 0;

    const fullEvents = sorted.map(t => ({
      date: t.date,
      pnl: walkPnl(t.bars, t.entryIdx, t.direction, t.entry, t.direction === 'LONG' ? t.entry - best.stop : t.entry + best.stop, t.direction === 'LONG' ? t.entry + best.target : t.entry - best.target)
    }));
    const rigor = computeRigor(fullEvents, { dateField: 'date', pnlFn: e => e.pnl });
    return {
      label, n: touches.length, nTrain: train.length, nTest: test.length,
      stop: best.stop, target: best.target, isEv: best.ev, oosEv,
      rigorClean: rigor.clean, top5DayPct: rigor.top5DayPct, thirds: rigor.thirds, touches
    };
  }

  const armA_res = sweepArm(armATouches, 'ArmA_pullback');
  const armB_res = sweepArm(armBTouches, 'ArmB_immediate');

  console.log(`\n=== Arm A (Baseline Pullback) ===`);
  if (armA_res.insufficientN) console.log(`Insufficient N=${armA_res.n}`);
  else console.log(`N=${armA_res.n}, stop=${armA_res.stop}, target=${armA_res.target}, IS_EV=$${armA_res.isEv.toFixed(2)}, OOS_EV=$${armA_res.oosEv.toFixed(2)}, rigor.clean=${armA_res.rigorClean}, thirds=${JSON.stringify(armA_res.thirds)}`);

  console.log(`\n=== Arm B (NEW Immediate Entry) ===`);
  if (armB_res.insufficientN) console.log(`Insufficient N=${armB_res.n}`);
  else console.log(`N=${armB_res.n}, stop=${armB_res.stop}, target=${armB_res.target}, IS_EV=$${armB_res.isEv.toFixed(2)}, OOS_EV=$${armB_res.oosEv.toFixed(2)}, rigor.clean=${armB_res.rigorClean}, thirds=${JSON.stringify(armB_res.thirds)}`);

  const armAByDate = new Map(armATouches.map(t => [t.date, t]));
  let slippageSum = 0;
  let slippageCount = 0;
  for (const tB of armBTouches) {
    const tA = armAByDate.get(tB.date);
    if (tA) {
      const slip = tB.direction === 'LONG' ? (tB.entry - tA.entry) : (tA.entry - tB.entry);
      slippageSum += slip;
      slippageCount++;
    }
  }
  const avgSlippage = slippageCount > 0 ? (slippageSum / slippageCount) : 0;
  console.log(`\nArm B entry vs Arm A average points-of-slippage: ${avgSlippage.toFixed(2)} pts (on ${slippageCount} matched days)`);

  console.log(`\n=== Arm C (Volume Building Magnitude Split) ===`);

  const VOL_BUILD_APPROACH_BARS = 10;
  async function evalVolumeSplit(armRes, armName) {
    if (armRes.insufficientN) return;

    const uniqueDates = [...new Set(armRes.touches.map(t => t.date))];
    const scoredTouches = [];

    for (const d of uniqueDates) {
      const baseline = await getVolumeBaseline(query, d);
      const touchesOnDate = armRes.touches.filter(t => t.date === d);
      for (const t of touchesOnDate) {
        if (t.entryIdx >= 2 * VOL_BUILD_APPROACH_BARS) {
          const measures = computeVolumeBuildingMeasures(t.bars, t.entryIdx, baseline);
          const compScore = (measures.avgVolZ || 0) + (measures.volZTrend || 0) + (measures.avgDayVolZ || 0) + (measures.dayVolZTrend || 0);
          if (measures.avgVolZ != null) {
            scoredTouches.push({ ...t, compScore });
          }
        }
      }
    }

    if (!scoredTouches.length) {
      console.log(`${armName}: No touches could be scored for volume building.`);
      return;
    }

    scoredTouches.sort((a, b) => a.compScore - b.compScore);
    const n = scoredTouches.length;
    const third = Math.floor(n / 3);
    const bottom = scoredTouches.slice(0, third);
    const mid = scoredTouches.slice(third, 2 * third);
    const top = scoredTouches.slice(2 * third);

    const evalSet = (set) => {
      let evSum = 0;
      let mfeSum = 0;
      for (const t of set) {
        const p = walkPnl(t.bars, t.entryIdx, t.direction, t.entry, t.direction === 'LONG' ? t.entry - armRes.stop : t.entry + armRes.stop, t.direction === 'LONG' ? t.entry + armRes.target : t.entry - armRes.target);
        const m = walkMfe(t.bars, t.entryIdx, t.direction, t.entry, t.direction === 'LONG' ? t.entry - armRes.stop : t.entry + armRes.stop, t.direction === 'LONG' ? t.entry + armRes.target : t.entry - armRes.target);
        evSum += p;
        mfeSum += m;
      }
      return { n: set.length, ev: evSum / set.length, mfe: mfeSum / set.length };
    };

    const bRes = evalSet(bottom);
    const mRes = evalSet(mid);
    const tRes = evalSet(top);

    console.log(`\n${armName} Volume Terciles (n scored=${n}/${armRes.touches.length}, stop=${armRes.stop}, target=${armRes.target}):`);
    console.log(`  Bottom: N=${bRes.n}, EV=$${bRes.ev.toFixed(2)}, mean MFE=${bRes.mfe.toFixed(2)} pts`);
    console.log(`  Middle: N=${mRes.n}, EV=$${mRes.ev.toFixed(2)}, mean MFE=${mRes.mfe.toFixed(2)} pts`);
    console.log(`  Top:    N=${tRes.n}, EV=$${tRes.ev.toFixed(2)}, mean MFE=${tRes.mfe.toFixed(2)} pts`);
  }

  await evalVolumeSplit(armA_res, 'Arm A');
  await evalVolumeSplit(armB_res, 'Arm B');

  // Decomposition (2026-08-31, user question: "are Arm A and Arm B addressing the same
  // trade just differently?"): split Arm B's touches into OVERLAP (same date also has an
  // Arm A pullback entry -- literally the same trade, entered worse) vs EXCLUSIVE (the
  // pullback never happened at all -- Arm A structurally cannot take this trade, pure
  // forfeited opportunity per Stage 1's own "never pulled back" finding). Then re-run the
  // volume-building tercile split WITHIN each subgroup separately, using Arm B's own
  // already-chosen stop/target (armB_res.stop/target, no re-sweep) -- to see whether the
  // volume-building "rescue" found above is coming from re-discovering Arm A's own good
  // days (not real incremental edge) or from the exclusive population (genuinely new edge).
  console.log(`\n=== Decomposition: Arm B overlap-with-A vs exclusive-to-B ===`);
  const armADates = new Set(armATouches.map(t => t.date));
  const overlapTouches = armBTouches.filter(t => armADates.has(t.date));
  const exclusiveTouches = armBTouches.filter(t => !armADates.has(t.date));
  console.log(`Overlap (same day as an Arm A entry): N=${overlapTouches.length}`);
  console.log(`Exclusive (Arm A never pulled back this day): N=${exclusiveTouches.length}`);

  function evalGroup(touches, stop, target) {
    if (!touches.length) return { n: 0, ev: 0, mfe: 0 };
    let evSum = 0, mfeSum = 0;
    for (const t of touches) {
      const stopPrice = t.direction === 'LONG' ? t.entry - stop : t.entry + stop;
      const targetPrice = t.direction === 'LONG' ? t.entry + target : t.entry - target;
      evSum += walkPnl(t.bars, t.entryIdx, t.direction, t.entry, stopPrice, targetPrice);
      mfeSum += walkMfe(t.bars, t.entryIdx, t.direction, t.entry, stopPrice, targetPrice);
    }
    return { n: touches.length, ev: evSum / touches.length, mfe: mfeSum / touches.length };
  }

  const overlapRes = evalGroup(overlapTouches, armB_res.stop, armB_res.target);
  const exclusiveRes = evalGroup(exclusiveTouches, armB_res.stop, armB_res.target);
  console.log(`\nArm B, overlap subgroup (Arm B's stop/target=${armB_res.stop}/${armB_res.target}): N=${overlapRes.n}, EV=$${overlapRes.ev.toFixed(2)}, mean MFE=${overlapRes.mfe.toFixed(2)}pt`);
  console.log(`Arm B, exclusive subgroup: N=${exclusiveRes.n}, EV=$${exclusiveRes.ev.toFixed(2)}, mean MFE=${exclusiveRes.mfe.toFixed(2)}pt`);

  // Head-to-head on the overlap set only: what does Arm A itself score on EXACTLY these
  // same overlap dates (using Arm A's own stop/target), vs Arm B's entry on those same dates?
  const overlapDates = new Set(overlapTouches.map(t => t.date));
  const armAOnOverlapDates = armATouches.filter(t => overlapDates.has(t.date));
  const armAOnOverlapRes = evalGroup(armAOnOverlapDates, armA_res.stop, armA_res.target);
  console.log(`\nHead-to-head on the ${overlapDates.size} overlap dates: Arm A's own entry+exit scores EV=$${armAOnOverlapRes.ev.toFixed(2)} (N=${armAOnOverlapRes.n}) vs Arm B's entry+exit on the SAME dates EV=$${overlapRes.ev.toFixed(2)} (N=${overlapRes.n}).`);

  // Now volume-building terciles WITHIN each subgroup (reuse Arm B's already-computed
  // compScore where available -- recompute cleanly here since evalVolumeSplit() didn't
  // expose scoredTouches outside its own closure).
  async function scoreTouches(touches) {
    const uniqueDates = [...new Set(touches.map(t => t.date))];
    const baselineByDate = new Map();
    for (const d of uniqueDates) baselineByDate.set(d, await getVolumeBaseline(query, d));
    const scored = [];
    for (const t of touches) {
      if (t.entryIdx >= 2 * VOL_BUILD_APPROACH_BARS) {
        const baseline = baselineByDate.get(t.date);
        const measures = computeVolumeBuildingMeasures(t.bars, t.entryIdx, baseline);
        if (measures.avgVolZ != null) {
          const compScore = measures.avgVolZ + measures.volZTrend + measures.avgDayVolZ + measures.dayVolZTrend;
          scored.push({ ...t, compScore });
        }
      }
    }
    return scored;
  }
  function tercileSplit(scored) {
    const sorted = [...scored].sort((a, b) => a.compScore - b.compScore);
    const third = Math.floor(sorted.length / 3);
    return { bottom: sorted.slice(0, third), mid: sorted.slice(third, 2 * third), top: sorted.slice(2 * third) };
  }

  const overlapScored = await scoreTouches(overlapTouches);
  const exclusiveScored = await scoreTouches(exclusiveTouches);
  const overlapTerciles = tercileSplit(overlapScored);
  const exclusiveTerciles = tercileSplit(exclusiveScored);

  console.log(`\nOverlap subgroup volume-building terciles (n scored=${overlapScored.length}/${overlapTouches.length}):`);
  for (const [name, set] of [['Bottom', overlapTerciles.bottom], ['Middle', overlapTerciles.mid], ['Top', overlapTerciles.top]]) {
    const r = evalGroup(set, armB_res.stop, armB_res.target);
    console.log(`  ${name}: N=${r.n}, EV=$${r.ev.toFixed(2)}, mean MFE=${r.mfe.toFixed(2)}pt`);
  }
  console.log(`\nExclusive subgroup volume-building terciles (n scored=${exclusiveScored.length}/${exclusiveTouches.length}):`);
  for (const [name, set] of [['Bottom', exclusiveTerciles.bottom], ['Middle', exclusiveTerciles.mid], ['Top', exclusiveTerciles.top]]) {
    const r = evalGroup(set, armB_res.stop, armB_res.target);
    console.log(`  ${name}: N=${r.n}, EV=$${r.ev.toFixed(2)}, mean MFE=${r.mfe.toFixed(2)}pt`);
  }
}

main().then(() => {
  console.log('\nDone.');
  process.exit(0);
}).catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
