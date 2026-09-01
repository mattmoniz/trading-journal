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

  // ---- TEST 1: WIDER FIXED-TARGET SWEEP ----
  console.log('\n--- TEST 1: WIDER FIXED-TARGET SWEEP ---');
  const t1Targets = [60, 80, 100, 120, 150, 180, 200, 250];
  const t1Stops = [120, 159, 200];
  
  let bestTrainEv = -Infinity;
  let bestConfig = null;
  
  console.log('Train Grid:');
  for (const t of t1Targets) {
    for (const s of t1Stops) {
      let sum = 0;
      for (const r of train) {
        const stopPx = r.long ? r.entry - s : r.entry + s;
        const targetPx = r.long ? r.entry + t : r.entry - t;
        sum += walkPnl(r.bars, r.entryIdx, r.direction, r.entry, stopPx, targetPx);
      }
      const ev = sum / train.length;
      console.log(`  T=${t}, S=${s}: EV=$${ev.toFixed(2)}`);
      if (ev > bestTrainEv) {
        bestTrainEv = ev;
        bestConfig = { t, s };
      }
    }
  }
  
  console.log(`\nWinner on Train: Target=${bestConfig.t}, Stop=${bestConfig.s} (EV=$${bestTrainEv.toFixed(2)})`);

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

  const baselineTest = evalOos(test, 159, 80);
  const winnerTest = evalOos(test, bestConfig.s, bestConfig.t);
  
  console.log(`Baseline 159/80 OOS EV: $${baselineTest.ev.toFixed(2)}`);
  console.log(`Winner ${bestConfig.s}/${bestConfig.t} OOS EV: $${winnerTest.ev.toFixed(2)}`);

  console.log(`\nRigor check for Baseline 159/80 OOS:`);
  if (baselineTest.events.length > 0) {
    const rigor = computeRigor(baselineTest.events, { dateField: 'date', pnlFn: e => e.pnl });
    console.log(`  clean=${rigor.clean}, top5DayPct=${rigor.top5DayPct}, thirds=${JSON.stringify(rigor.thirds)}`);
  }

  console.log(`\nRigor check for Winner ${bestConfig.s}/${bestConfig.t} OOS:`);
  if (winnerTest.events.length > 0) {
    const rigor = computeRigor(winnerTest.events, { dateField: 'date', pnlFn: e => e.pnl });
    console.log(`  clean=${rigor.clean}, top5DayPct=${rigor.top5DayPct}, thirds=${JSON.stringify(rigor.thirds)}`);
  }

  // ---- TEST 2: RE-ENTRY AFTER EXIT ----
  console.log('\n--- TEST 2: RE-ENTRY AFTER EXIT ---');
  
  const test2Events = [];
  let totalBaselineEV = 0;
  let totalReentryEV = 0;
  let reentriesTriggered = 0;
  
  let stopHitInitialN = 0, stopHitInitialEV = 0;
  let targetHitInitialN = 0, targetHitInitialEV = 0;
  let expiredInitialN = 0, expiredInitialEV = 0;

  for (const r of sorted) {
    let currentLegs = 0;
    let dayTotalPnl = 0;
    
    // Leg 1
    const stopPts = 159, targetPts = 80;
    let stopPx = r.long ? r.entry - stopPts : r.entry + stopPts;
    let targetPx = r.long ? r.entry + targetPts : r.entry - targetPts;
    
    const res = resolve(r.bars, r.entryIdx, r.direction, r.entry, stopPx, targetPx, WALK_MAX_BARS);
    
    let leg1Pnl = 0;
    if (res.result !== 'EXPIRED') {
      leg1Pnl = res.pnl;
    } else {
      const cutoff = r.bars[Math.min(r.bars.length - 1, r.entryIdx + WALK_MAX_BARS)];
      leg1Pnl = pnl(r.entry, cutoff.close, r.long);
    }
    
    dayTotalPnl += leg1Pnl;
    totalBaselineEV += leg1Pnl;
    
    let legResolution = res.result;
    let legResIdx = r.entryIdx + res.barsHeld;
    let legExitPrice = null;
    
    if (res.result === 'TARGET_HIT') legExitPrice = targetPx;
    if (res.result === 'STOP_HIT') legExitPrice = stopPx;
    
    let hasReentered = false;
    let pnlAddedFromReentry = 0;

    currentLegs = 1;
    
    while (currentLegs < 3 && legResolution !== 'EXPIRED' && legResIdx < r.bars.length) {
      // scan for new extreme
      let foundEntryIdx = -1;
      for (let j = legResIdx + 1; j < Math.min(r.bars.length, r.entryIdx + WALK_MAX_BARS); j++) {
        if (r.long && r.bars[j].close > legExitPrice) {
          foundEntryIdx = j; break;
        } else if (!r.long && r.bars[j].close < legExitPrice) {
          foundEntryIdx = j; break;
        }
      }
      
      if (foundEntryIdx !== -1) {
        hasReentered = true;
        const entry2 = r.bars[foundEntryIdx].close;
        const stopPx2 = r.long ? entry2 - stopPts : entry2 + stopPts;
        const targetPx2 = r.long ? entry2 + targetPts : entry2 - targetPts;
        
        const res2 = resolve(r.bars, foundEntryIdx, r.direction, entry2, stopPx2, targetPx2, WALK_MAX_BARS - (foundEntryIdx - r.entryIdx));
        
        let legPnl = 0;
        if (res2.result !== 'EXPIRED') {
          legPnl = res2.pnl;
        } else {
          const cutoffIdx = Math.min(r.bars.length - 1, r.entryIdx + WALK_MAX_BARS);
          const cutoff = r.bars[cutoffIdx];
          legPnl = pnl(entry2, cutoff.close, r.long);
        }
        
        dayTotalPnl += legPnl;
        pnlAddedFromReentry += legPnl;
        
        legResolution = res2.result;
        legResIdx = foundEntryIdx + res2.barsHeld;
        if (res2.result === 'TARGET_HIT') legExitPrice = targetPx2;
        if (res2.result === 'STOP_HIT') legExitPrice = stopPx2;
        currentLegs++;
      } else {
        break; // no new extreme found
      }
    }
    
    if (hasReentered) reentriesTriggered++;
    totalReentryEV += dayTotalPnl;
    
    if (res.result === 'STOP_HIT') {
      stopHitInitialN++;
      stopHitInitialEV += pnlAddedFromReentry;
    } else if (res.result === 'TARGET_HIT') {
      targetHitInitialN++;
      targetHitInitialEV += pnlAddedFromReentry;
    } else {
      expiredInitialN++;
      expiredInitialEV += pnlAddedFromReentry;
    }

    test2Events.push({ date: r.date, pnl: dayTotalPnl });
  }
  
  console.log(`\nRe-entry Sweep over N=${sorted.length} classified days`);
  console.log(`Single-entry (Baseline) EV: $${(totalBaselineEV / sorted.length).toFixed(2)}`);
  console.log(`With Re-entries EV: $${(totalReentryEV / sorted.length).toFixed(2)}`);
  console.log(`Trigger rate: ${reentriesTriggered}/${sorted.length} (${((reentriesTriggered/sorted.length)*100).toFixed(1)}%) days had >=1 re-entry`);
  
  console.log(`\nBreakdown of *added PnL* by First Position Resolution:`);
  console.log(`  After STOP_HIT: N=${stopHitInitialN}, Added EV per bucket-N: $${stopHitInitialN ? (stopHitInitialEV / stopHitInitialN).toFixed(2) : 0}`);
  console.log(`  After TARGET_HIT: N=${targetHitInitialN}, Added EV per bucket-N: $${targetHitInitialN ? (targetHitInitialEV / targetHitInitialN).toFixed(2) : 0}`);
  console.log(`  After EXPIRED: N=${expiredInitialN}, Added EV per bucket-N: $${expiredInitialN ? (expiredInitialEV / expiredInitialN).toFixed(2) : 0}`);

  // Stability check chronological first vs second half
  const t2Split = Math.floor(test2Events.length / 2);
  const t2First = test2Events.slice(0, t2Split);
  const t2Second = test2Events.slice(t2Split);
  const e1 = t2First.reduce((sum, e) => sum + e.pnl, 0) / t2First.length;
  const e2 = t2Second.reduce((sum, e) => sum + e.pnl, 0) / t2Second.length;
  
  console.log(`\nStability check (First half N=${t2First.length} vs Second half N=${t2Second.length}):`);
  console.log(`  First half Re-entry EV: $${e1.toFixed(2)}`);
  console.log(`  Second half Re-entry EV: $${e2.toFixed(2)}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
