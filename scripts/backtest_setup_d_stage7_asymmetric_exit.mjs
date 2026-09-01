import { classifyACDOpeningCall } from '../server/services/openingCallClassifier.js';
import { resolve, loadData } from './backtest_unified.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';

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

function timeWalkPnl(bars, entryIdx, direction, entry, stop, holdMinutes) {
  const dummyTarget = direction === 'LONG' ? entry + 99999 : entry - 99999;
  const res = resolve(bars, entryIdx, direction, entry, stop, dummyTarget, holdMinutes);
  if (res.result === 'STOP_HIT') return res.pnl;
  const cutoffIdx = Math.min(bars.length - 1, entryIdx + holdMinutes);
  const cutoff = bars[cutoffIdx];
  return pnl(entry, cutoff.close, direction === 'LONG');
}

function evalOos(pop, stopPts, targetPts) {
  const events = [];
  let sum = 0;
  for (const r of pop) {
    const stopPx = r.long ? r.entry - stopPts : r.entry + stopPts;
    const targetPx = r.long ? r.entry + targetPts : r.entry - targetPts;
    const val = walkPnl(r.bars, r.entryIdx, r.direction, r.entry, stopPx, targetPx);
    events.push({ date: r.date, pnl: val });
    sum += val;
  }
  return { ev: sum / pop.length, events };
}

function evalOosTime(pop, stopPts, holdMinutes) {
  const events = [];
  let sum = 0;
  for (const r of pop) {
    const stopPx = r.long ? r.entry - stopPts : r.entry + stopPts;
    const val = timeWalkPnl(r.bars, r.entryIdx, r.direction, r.entry, stopPx, holdMinutes);
    events.push({ date: r.date, pnl: val });
    sum += val;
  }
  return { ev: sum / pop.length, events };
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

  const sortedRecords = [...records].sort((a, b) => a.date.localeCompare(b.date));
  
  const longRecords = sortedRecords.filter(r => r.long);
  const shortRecords = sortedRecords.filter(r => !r.long);

  console.log(`Total N=${sortedRecords.length} (Long=${longRecords.length}, Short=${shortRecords.length})`);

  const targets = [80, 120, 160, 200, 250, 300, 350, 400, 500, 750, 1000];
  const stops = [120, 159, 200, 250];

  let shortWinningStop = null;

  for (const [dirName, pop] of [['LONG', longRecords], ['SHORT', shortRecords]]) {
    const splitIdx = Math.floor(pop.length * (2 / 3));
    const train = pop.slice(0, splitIdx);
    const test = pop.slice(splitIdx);

    console.log(`\n======================================================`);
    console.log(`--- TEST A: ${dirName} OPTIMIZATION ---`);
    console.log(`Population N=${pop.length} (train=${train.length}, test=${test.length})`);
    if (train.length < 20 || test.length < 20) {
      console.log(`WARNING: Population for ${dirName} is thin, N < 20 in train or test. Results may be noisy.`);
    }

    let bestTrainEv = -Infinity;
    let bestConfig = null;

    for (const t of targets) {
      for (const s of stops) {
        let sum = 0;
        for (const r of train) {
          const stopPx = r.long ? r.entry - s : r.entry + s;
          const targetPx = r.long ? r.entry + t : r.entry - t;
          sum += walkPnl(r.bars, r.entryIdx, r.direction, r.entry, stopPx, targetPx);
        }
        const ev = sum / train.length;
        console.log(`  Target=${t}, Stop=${s} => EV=$${ev.toFixed(2)}`);
        if (ev > bestTrainEv) {
          bestTrainEv = ev;
          bestConfig = { t, s };
        }
      }
    }

    console.log(`Winner on Train: Target=${bestConfig.t}, Stop=${bestConfig.s} (EV=$${bestTrainEv.toFixed(2)})`);

    if (dirName === 'SHORT') {
      shortWinningStop = bestConfig.s;
    }

    const baselineTest = evalOos(test, 159, 80);
    const winnerTest = evalOos(test, bestConfig.s, bestConfig.t);

    console.log(`OOS EV for Baseline (159/80): $${baselineTest.ev.toFixed(2)}`);
    console.log(`OOS EV for Winner (${bestConfig.s}/${bestConfig.t}): $${winnerTest.ev.toFixed(2)}`);

    if (baselineTest.events.length > 0) {
      console.log(`\nRigor check for Baseline (159/80) OOS:`);
      const rigor = computeRigor(baselineTest.events, { dateField: 'date', pnlFn: e => e.pnl });
      console.log(`  clean=${rigor.clean}, top5DayPct=${rigor.top5DayPct}, thirds=${JSON.stringify(rigor.thirds)}`);
    }

    if (winnerTest.events.length > 0) {
      console.log(`\nRigor check for Winner (${bestConfig.s}/${bestConfig.t}) OOS:`);
      const rigor = computeRigor(winnerTest.events, { dateField: 'date', pnlFn: e => e.pnl });
      console.log(`  clean=${rigor.clean}, top5DayPct=${rigor.top5DayPct}, thirds=${JSON.stringify(rigor.thirds)}`);
    }
  }

  // --- TEST B: TIME-BASED EXIT FOR SHORTS ---
  console.log(`\n======================================================`);
  console.log(`--- TEST B: TIME-BASED EXIT FOR SHORTS ---`);
  
  const shortSplitIdx = Math.floor(shortRecords.length * (2 / 3));
  const shortTest = shortRecords.slice(shortSplitIdx);
  
  console.log(`Using winning stop from Test A SHORT optimization: ${shortWinningStop}`);
  console.log(`Evaluating on test set N=${shortTest.length}`);
  
  const timeWindows = [45, 60, 90];
  
  for (const time of timeWindows) {
    const timeTest = evalOosTime(shortTest, shortWinningStop, time);
    console.log(`Time-based Exit (Hold ${time}m or Stop ${shortWinningStop}pt) OOS EV: $${timeTest.ev.toFixed(2)}`);
    if (timeTest.events.length > 0) {
        const rigor = computeRigor(timeTest.events, { dateField: 'date', pnlFn: e => e.pnl });
        console.log(`  Rigor: clean=${rigor.clean}, top5DayPct=${rigor.top5DayPct}, thirds=${JSON.stringify(rigor.thirds)}`);
    }
  }

}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
