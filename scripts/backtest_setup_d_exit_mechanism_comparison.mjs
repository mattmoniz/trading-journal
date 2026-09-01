// Setup D "big-break" population -- exit mechanism comparison (dispatched to Gemini, then
// independently re-run and corrected 2026-08-31): the original walkBreakevenTrailFn/
// walkWiderTargetFn loops started at `i = entryIdx` (the entry bar itself), one bar earlier
// than this codebase's own resolve() convention (backtest_unified.js: "Walk bars from
// entryIdx+1" -- the entry only happens at that bar's CLOSE, so evaluating that same bar's
// high/low for a stop/target hit is a look-ahead-adjacent inconsistency). Fixed here to
// start at entryIdx+1, matching resolve()/walkPnl() exactly.
import { classifyACDOpeningCall } from '../server/services/openingCallClassifier.js';
import { resolve, loadData } from './backtest_unified.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { stepBreakevenTrail } from '../server/services/breakevenTrailWalker.js';
import { stepWiderTarget, WIDER_TARGET_MULT, MAX_BARS_TO_T1_FOR_WIDER } from '../server/services/widerTargetWalker.js';

const DEFAULT_DPP = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const WALK_MAX_BARS = 240;
const WIN = { orEndMin: 585, confirmEndMin: 615 };

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
function walkBreakevenTrailFn(bars, entryIdx, params) {
  let state = {};
  for (let i = entryIdx + 1; i < bars.length && i <= entryIdx + WALK_MAX_BARS; i++) {
    const res = stepBreakevenTrail(state, bars[i], params);
    state = res.state;
    if (res.resolution) return pnl(params.entry, res.resolution.priceAtRes, params.long);
  }
  const cutoff = bars[Math.min(bars.length - 1, entryIdx + WALK_MAX_BARS)];
  return pnl(params.entry, cutoff.close, params.long);
}
function walkWiderTargetFn(bars, entryIdx, params) {
  let state = { widening: false };
  let barCount = 1;
  for (let i = entryIdx + 1; i < bars.length && i <= entryIdx + WALK_MAX_BARS; i++) {
    const res = stepWiderTarget(state, bars[i], { ...params, barCount });
    state = res.state;
    if (res.resolution) return pnl(params.entry, res.resolution.priceAtRes, params.long);
    barCount++;
  }
  const cutoff = bars[Math.min(bars.length - 1, entryIdx + WALK_MAX_BARS)];
  return pnl(params.entry, cutoff.close, params.long);
}

async function main() {
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

    if (driveMag < 0.479) continue;

    const entry = confirmCloseBar.close;
    const firedMod = confirmCloseBar.mod;

    records.push({ date, bars, direction, entryIdx: confirmEndIdx, entry, firedMod, long: isLong });
  }

  const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date));
  const splitIdx = Math.floor(sorted.length * (2 / 3));
  const train = sorted.slice(0, splitIdx);
  const test = sorted.slice(splitIdx);
  console.log(`Total N=${sorted.length} (train=${train.length}, test=${test.length})`);

  function evalBaseline(pop) {
    let sum = 0;
    const stopPts = 159, targetPts = 80;
    const events = [];
    for (const r of pop) {
      const stopPx = r.long ? r.entry - stopPts : r.entry + stopPts;
      const targetPx = r.long ? r.entry + targetPts : r.entry - targetPts;
      const val = walkPnl(r.bars, r.entryIdx, r.direction, r.entry, stopPx, targetPx);
      sum += val;
      events.push({ date: r.date, pnl: val });
    }
    return { ev: sum / pop.length, events };
  }

  const baseTrain = evalBaseline(train);
  const baseTest = evalBaseline(test);
  console.log(`Baseline 159/80: Train EV=$${baseTrain.ev.toFixed(2)}, Test EV=$${baseTest.ev.toFixed(2)}`);

  const c1Targets = [100, 120, 150];
  const c1Stops = [120, 159];
  let c1Best = { ev: -Infinity, config: null };
  console.log('\n--- Candidate 1 (Fixed Stop/Target) Train Grid ---');
  for (const t of c1Targets) {
    for (const s of c1Stops) {
      let sum = 0;
      for (const r of train) {
        const stopPx = r.long ? r.entry - s : r.entry + s;
        const targetPx = r.long ? r.entry + t : r.entry - t;
        sum += walkPnl(r.bars, r.entryIdx, r.direction, r.entry, stopPx, targetPx);
      }
      const ev = sum / train.length;
      console.log(`T=${t}, S=${s}: EV=$${ev.toFixed(2)}`);
      if (ev > c1Best.ev) c1Best = { ev, config: { target: t, stop: s } };
    }
  }

  let c1TestSum = 0;
  const c1TestEvents = [];
  for (const r of test) {
    const s = c1Best.config.stop, t = c1Best.config.target;
    const stopPx = r.long ? r.entry - s : r.entry + s;
    const targetPx = r.long ? r.entry + t : r.entry - t;
    const val = walkPnl(r.bars, r.entryIdx, r.direction, r.entry, stopPx, targetPx);
    c1TestSum += val;
    c1TestEvents.push({ date: r.date, pnl: val });
  }
  const c1TestEv = c1TestSum / test.length;
  console.log(`Candidate 1 Winner: T=${c1Best.config.target} S=${c1Best.config.stop}`);
  console.log(`Candidate 1 OOS Test EV=$${c1TestEv.toFixed(2)}`);

  const c2T1s = [60, 80];
  const c2Trails = [30, 50, 70];
  const c2Stops = [120, 159];
  let c2Best = { ev: -Infinity, config: null };
  console.log('\n--- Candidate 2 (Breakeven Trail) Train Grid ---');
  for (const t1 of c2T1s) {
    for (const trail of c2Trails) {
      for (const stopPts of c2Stops) {
        let sum = 0;
        for (const r of train) {
          const stopPx = r.long ? r.entry - stopPts : r.entry + stopPts;
          const t1Px = r.long ? r.entry + t1 : r.entry - t1;
          const params = { entry: r.entry, stop: stopPx, t1: t1Px, trailWidth: trail, long: r.long, firedMod: r.firedMod };
          sum += walkBreakevenTrailFn(r.bars, r.entryIdx, params);
        }
        const ev = sum / train.length;
        console.log(`T1=${t1}, Trail=${trail}, Stop=${stopPts}: EV=$${ev.toFixed(2)}`);
        if (ev > c2Best.ev) c2Best = { ev, config: { t1, trail, stop: stopPts } };
      }
    }
  }

  let c2TestSum = 0;
  const c2TestEvents = [];
  for (const r of test) {
    const s = c2Best.config.stop, t1 = c2Best.config.t1, trail = c2Best.config.trail;
    const stopPx = r.long ? r.entry - s : r.entry + s;
    const t1Px = r.long ? r.entry + t1 : r.entry - t1;
    const params = { entry: r.entry, stop: stopPx, t1: t1Px, trailWidth: trail, long: r.long, firedMod: r.firedMod };
    const val = walkBreakevenTrailFn(r.bars, r.entryIdx, params);
    c2TestSum += val;
    c2TestEvents.push({ date: r.date, pnl: val });
  }
  const c2TestEv = c2TestSum / test.length;
  console.log(`Candidate 2 Winner: T1=${c2Best.config.t1} Trail=${c2Best.config.trail} Stop=${c2Best.config.stop}`);
  console.log(`Candidate 2 OOS Test EV=$${c2TestEv.toFixed(2)}`);

  const c3T1s = [60, 80];
  const c3Mults = [WIDER_TARGET_MULT, 2.0];
  const c3MaxBars = [MAX_BARS_TO_T1_FOR_WIDER, 10];
  const c3Stops = [159];
  let c3Best = { ev: -Infinity, config: null };
  console.log('\n--- Candidate 3 (Wider Target) Train Grid ---');
  for (const t1 of c3T1s) {
    for (const mult of c3Mults) {
      for (const maxBars of c3MaxBars) {
        for (const stopPts of c3Stops) {
          let sum = 0;
          for (const r of train) {
            const stopPx = r.long ? r.entry - stopPts : r.entry + stopPts;
            const t1Px = r.long ? r.entry + t1 : r.entry - t1;
            const widerTargetPx = r.long ? r.entry + (t1 * mult) : r.entry - (t1 * mult);
            const params = { entry: r.entry, stop: stopPx, t1: t1Px, widerTarget: widerTargetPx, long: r.long, barCount: 1, maxBarsToT1: maxBars, firedMod: r.firedMod, pressureReading: null, pressureThreshold: null };
            sum += walkWiderTargetFn(r.bars, r.entryIdx, params);
          }
          const ev = sum / train.length;
          console.log(`T1=${t1}, Mult=${mult}, MaxBars=${maxBars}, Stop=${stopPts}: EV=$${ev.toFixed(2)}`);
          if (ev > c3Best.ev) c3Best = { ev, config: { t1, mult, maxBars, stop: stopPts } };
        }
      }
    }
  }

  let c3TestSum = 0;
  const c3TestEvents = [];
  for (const r of test) {
    const s = c3Best.config.stop, t1 = c3Best.config.t1, mult = c3Best.config.mult, maxBars = c3Best.config.maxBars;
    const stopPx = r.long ? r.entry - s : r.entry + s;
    const t1Px = r.long ? r.entry + t1 : r.entry - t1;
    const widerTargetPx = r.long ? r.entry + (t1 * mult) : r.entry - (t1 * mult);
    const params = { entry: r.entry, stop: stopPx, t1: t1Px, widerTarget: widerTargetPx, long: r.long, barCount: 1, maxBarsToT1: maxBars, firedMod: r.firedMod, pressureReading: null, pressureThreshold: null };
    const val = walkWiderTargetFn(r.bars, r.entryIdx, params);
    c3TestSum += val;
    c3TestEvents.push({ date: r.date, pnl: val });
  }
  const c3TestEv = c3TestSum / test.length;
  console.log(`Candidate 3 Winner: T1=${c3Best.config.t1} Mult=${c3Best.config.mult} MaxBars=${c3Best.config.maxBars} Stop=${c3Best.config.stop}`);
  console.log(`Candidate 3 OOS Test EV=$${c3TestEv.toFixed(2)}`);

  console.log('\n--- Result Summary ---');
  console.log(`Baseline 159/80 -> OOS EV: $${baseTest.ev.toFixed(2)}`);
  console.log(`Cand 1 Winner -> OOS EV: $${c1TestEv.toFixed(2)}`);
  console.log(`Cand 2 Winner -> OOS EV: $${c2TestEv.toFixed(2)}`);
  console.log(`Cand 3 Winner -> OOS EV: $${c3TestEv.toFixed(2)}`);

  const winners = [
    { name: 'Baseline 159/80', ev: baseTest.ev, events: baseTest.events },
    { name: 'Candidate 1', ev: c1TestEv, events: c1TestEvents },
    { name: 'Candidate 2', ev: c2TestEv, events: c2TestEvents },
    { name: 'Candidate 3', ev: c3TestEv, events: c3TestEvents },
  ];
  winners.sort((a, b) => b.ev - a.ev);
  const topWinner = winners[0];

  if (topWinner.events.length > 0) {
    const rigor = computeRigor(topWinner.events, { dateField: 'date', pnlFn: e => e.pnl });
    console.log(`\nBest strategy rigor check (${topWinner.name}) on TEST fold (N=${topWinner.events.length}):`);
    console.log(`rigor.clean=${rigor.clean}, top5DayPct=${rigor.top5DayPct}, thirds=${JSON.stringify(rigor.thirds)}`);
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
