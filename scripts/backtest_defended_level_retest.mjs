// scripts/backtest_defended_level_retest.mjs
// ═══════════════════════════════════════════════════════════════════════
// DEFENDED-LEVEL RETEST — tests whether requiring a failed-bounce/weakening
// signature before entering a level-fade beats blind immediate entry.
// See docs/DEFENDED_LEVEL_RETEST_SPEC.md for the full design, and
// RESEARCH_CLAIM defended_level_retest_confirmation_entry_negative (2026-08-12)
// for the result: negative across an 8-way window/variant sweep, confirmed via
// computeReplication(). Resolved OPEN_DECISION
// wait_for_held_ground_confirmation_before_fade_entry.
//
// touchId (date+entryIdx) can collide on same-bar confluent touches of
// different levels, undercounting the coverage-cost population by ~1% -- known,
// does not affect the qualitative conclusion (see the RESEARCH_CLAIM note).
//
// Reuses the real detectLevelFades/resolve/aggregate/loadData/floorPivots/
// pdIbMid from scripts/backtest_unified.js via import (not a duplicate copy —
// an earlier draft of this file did copy them; switched to import 2026-08-12
// after confirming byte-identity, per the "export the real function" rule).
// Run: node scripts/backtest_defended_level_retest.mjs
// ═══════════════════════════════════════════════════════════════════════

import { query } from '../server/db.js';
import { computeReplication } from '../server/services/rigorDiagnostics.js';
import { loadData, detectLevelFades, resolve, aggregate, floorPivots, pdIbMid } from './backtest_unified.js';

function checkDefended(bars, touchIdx, direction, levelPrice, windowSize, variant) {
  const isShort = direction === 'SHORT';
  
  let attempts = [];
  let state = 'WAIT_START'; 
  let curAttempt = null;

  for (let i = touchIdx; i <= Math.min(bars.length - 1, touchIdx + windowSize); i++) {
    const b = bars[i];
    const prevB = i > 0 ? bars[i-1] : b;
    const delta = b.close - prevB.close;
    const isUp = isShort ? delta > 0 : delta < 0;
    const isDown = isShort ? delta < 0 : delta > 0;

    if (state === 'WAIT_START') {
      if (isUp) {
        curAttempt = { startIdx: i, endIdx: i };
        state = 'IN_RUN';
      }
    } else if (state === 'IN_RUN') {
      if (isUp) {
        curAttempt.endIdx = i;
      } else {
        state = 'WAIT_FAIL';
        let high = -Infinity, low = Infinity;
        for (let k = curAttempt.startIdx; k <= curAttempt.endIdx; k++) {
          high = Math.max(high, bars[k].high);
          low = Math.min(low, bars[k].low);
        }
        curAttempt.extent = high - low;
        curAttempt.midpoint = (high + low) / 2;
        
        if (isDown) {
          const closedBelowLevel = isShort ? (b.close < levelPrice) : (b.close > levelPrice);
          const closedBelowMid = isShort ? (b.close < curAttempt.midpoint) : (b.close > curAttempt.midpoint);
          if (closedBelowLevel || closedBelowMid) {
            curAttempt.failDelta = Math.abs(delta);
            curAttempt.failIdx = i;
            attempts.push(curAttempt);
            if (attempts.length >= 2) {
              const last = attempts[attempts.length - 1];
              const prior = attempts[attempts.length - 2];
              const weakening = variant === 1 ? (last.extent < prior.extent) : (last.failDelta < prior.failDelta);
              return { 
                completed: true, 
                weakening,
                completionIdx: i, 
                attempts 
              };
            }
            state = 'WAIT_START';
            curAttempt = null;
          }
        }
      }
    } else if (state === 'WAIT_FAIL') {
      if (isDown) {
        const closedBelowLevel = isShort ? (b.close < levelPrice) : (b.close > levelPrice);
        const closedBelowMid = isShort ? (b.close < curAttempt.midpoint) : (b.close > curAttempt.midpoint);
        if (closedBelowLevel || closedBelowMid) {
          curAttempt.failDelta = Math.abs(delta);
          curAttempt.failIdx = i;
          attempts.push(curAttempt);
          if (attempts.length >= 2) {
            const last = attempts[attempts.length - 1];
            const prior = attempts[attempts.length - 2];
            const weakening = variant === 1 ? (last.extent < prior.extent) : (last.failDelta < prior.failDelta);
            return { 
              completed: true, 
              weakening,
              completionIdx: i, 
              attempts 
            };
          }
          state = 'WAIT_START';
          curAttempt = null;
        }
      } else if (isUp) {
         curAttempt = { startIdx: i, endIdx: i };
         state = 'IN_RUN';
      }
    }
  }
  return { completed: false, weakening: false, completionIdx: -1, attempts };
}

async function runOnce(w, v, loaded) {
  const { barsByDate, acdByDate, dvlByDate, dates, levelPricesByDate } = loaded;

  const pops = {
    NEVER_WAITED: [],
    WAITED_NO_SIGNATURE: [],
    WAITED_SIGNATURE_TIMING: [],
    FAILED_ATTEMPTS_NO_WEAKENING: [],
    DEFENDED_CONFIRMED: []
  };

  for (let di = 5; di < dates.length; di++) {
    const date = dates[di];
    const bars  = barsByDate.get(date);
    const acd   = acdByDate.get(date);
    if (!bars || !acd || !bars.length) continue;

    const prevDate = dates[di-1];
    const prevDvl  = dvlByDate.get(prevDate);
    const prevBars = barsByDate.get(prevDate);
    const prevAcd  = acdByDate.get(prevDate);

    const pdVAH = prevDvl?.vah ?? null;
    const pdVAL = prevDvl?.val ?? null;
    const pdPOC = prevDvl?.poc ?? null;
    const orH   = acd.or_high, orL = acd.or_low;
    if (!orH || !orL) continue;

    let fpLevels = {};
    if (prevDvl?.session_high && prevDvl?.session_low && prevDvl?.session_close) {
      fpLevels = floorPivots(prevDvl.session_high, prevDvl.session_low, prevDvl.session_close);
    }
    const pdIb = pdIbMid(prevBars);
    const pdOrMid = prevAcd?.or_high && prevAcd?.or_low ? (prevAcd.or_high + prevAcd.or_low) / 2 : null;
    
    const lp = levelPricesByDate.get(date) || {};
    const fadeLevels = {
      PD_POC:      lp.PD_POC      ?? pdPOC,
      PD_VAH:      lp.PD_VAH      ?? pdVAH,
      PD_VAL:      lp.PD_VAL      ?? pdVAL,
      PD_HIGH:     lp.PD_HIGH     ?? null,
      PD_LOW:      lp.PD_LOW      ?? null,
      PD_CLOSE:    lp.PD_CLOSE    ?? null,
      PD_IB_HIGH:  lp.PD_IB_HIGH  ?? null,
      PD_IB_LOW:   lp.PD_IB_LOW   ?? null,
      PD_IB_MID:   lp.PD_IB_MID   ?? pdIb,
      PD_OR_MID:   pdOrMid,
      PD_SESSION_MID: lp.PD_SESSION_MID ?? (prevDvl?.session_high && prevDvl?.session_low ? (prevDvl.session_high + prevDvl.session_low) / 2 : null),
      FLOOR_PIVOT: lp.FLOOR_PIVOT ?? fpLevels.FLOOR_PIVOT ?? null,
      FLOOR_R1:    lp.FLOOR_R1    ?? fpLevels.FLOOR_R1    ?? null,
      FLOOR_R2:    lp.FLOOR_R2    ?? null,
      FLOOR_R3:    lp.FLOOR_R3    ?? null,
      FLOOR_S1:    lp.FLOOR_S1    ?? fpLevels.FLOOR_S1    ?? null,
      FLOOR_S2:    lp.FLOOR_S2    ?? null,
      FLOOR_S3:    lp.FLOOR_S3    ?? null,
      OR5_HIGH:    orH,
      OR5_LOW:     orL,
    };

    const isMonday = new Date(date + 'T12:00:00').getDay() === 1;
    const touches = detectLevelFades(bars, fadeLevels, isMonday);

    for (const touch of touches) {
      touch.touchId = `${date}_${touch.entryIdx}`;
      const name = touch.type.replace('_SHORT', '').replace('_LONG', '');
      const entryObj = fadeLevels[name];
      const levelPrice = (entryObj !== null && typeof entryObj === 'object') ? entryObj.price : entryObj;

      // 1. NEVER_WAITED
      let res = resolve(bars, touch.entryIdx, touch.direction, touch.entry, touch.stop, touch.target);
      pops.NEVER_WAITED.push({ date, ...touch, ...res });

      // 2. WAITED_NO_SIGNATURE (window end)
      const wEndIdx = Math.min(bars.length - 1, touch.entryIdx + w);
      if (wEndIdx > touch.entryIdx) {
        const wEndB = bars[wEndIdx];
        const wEndStop = touch.direction === 'LONG' ? wEndB.close - touch.stopPts : wEndB.close + touch.stopPts;
        const wEndTarget = touch.direction === 'LONG' ? wEndB.close + touch.targetPts : wEndB.close - touch.targetPts;
        res = resolve(bars, wEndIdx, touch.direction, wEndB.close, wEndStop, wEndTarget);
        pops.WAITED_NO_SIGNATURE.push({ date, ...touch, ...res, entryIdx: wEndIdx });
      }

      const chk = checkDefended(bars, touch.entryIdx, touch.direction, levelPrice, w, v);
      
      // 3. WAITED_SIGNATURE_TIMING
      const timingIdx = chk.completed ? chk.completionIdx : wEndIdx;
      if (timingIdx > touch.entryIdx) {
        const tB = bars[timingIdx];
        const tStop = touch.direction === 'LONG' ? tB.close - touch.stopPts : tB.close + touch.stopPts;
        const tTarget = touch.direction === 'LONG' ? tB.close + touch.targetPts : tB.close - touch.targetPts;
        res = resolve(bars, timingIdx, touch.direction, tB.close, tStop, tTarget);
        pops.WAITED_SIGNATURE_TIMING.push({ date, ...touch, ...res, entryIdx: timingIdx });
      }

      if (chk.completed) {
        const cB = bars[chk.completionIdx];
        const cStop = touch.direction === 'LONG' ? cB.close - touch.stopPts : cB.close + touch.stopPts;
        const cTarget = touch.direction === 'LONG' ? cB.close + touch.targetPts : cB.close - touch.targetPts;
        res = resolve(bars, chk.completionIdx, touch.direction, cB.close, cStop, cTarget);
        
        if (chk.weakening) {
          // 5. DEFENDED_CONFIRMED
          pops.DEFENDED_CONFIRMED.push({ date, ...touch, ...res, entryIdx: chk.completionIdx });
        } else {
          // 4. FAILED_ATTEMPTS_NO_WEAKENING
          pops.FAILED_ATTEMPTS_NO_WEAKENING.push({ date, ...touch, ...res, entryIdx: chk.completionIdx });
        }
      }
    }
  }

  function report(name, trades) {
    if (!trades.length) return `${name.padEnd(30)} | N=0`;
    const st = aggregate(trades);
    const wr = (st.wins / st.decided * 100).toFixed(1);
    return `${name.padEnd(30)} | N=${String(st.n).padStart(4)} | WR=${wr}% | EV=$${st.evPerTrade.toFixed(2)} | PnL=$${st.totalPnl.toFixed(0)}`;
  }

  console.log(`\n--- STEP 1 SIMULATION (W=${w} V=${v}) ---`);
  console.log(report('NEVER_WAITED', pops.NEVER_WAITED));
  console.log(report('WAITED_NO_SIGNATURE', pops.WAITED_NO_SIGNATURE));
  console.log(report('WAITED_SIGNATURE_TIMING', pops.WAITED_SIGNATURE_TIMING));
  console.log(report('FAILED_ATTEMPTS_NO_WEAKEN', pops.FAILED_ATTEMPTS_NO_WEAKENING));
  console.log(report('DEFENDED_CONFIRMED', pops.DEFENDED_CONFIRMED));

  // Coverage Cost calculation
  const confirmedTouchIds = new Set(pops.DEFENDED_CONFIRMED.map(t => t.touchId));
  const missedTrades = pops.NEVER_WAITED.filter(t => !confirmedTouchIds.has(t.touchId));
  const missedStats = aggregate(missedTrades);

  console.log('1. Coverage cost:');
  const filteredOutPct = ((missedTrades.length / pops.NEVER_WAITED.length) * 100).toFixed(1);
  console.log(`   DEFENDED_CONFIRMED filters out ${filteredOutPct}% of touches (${missedTrades.length} touches).`);
  if (missedStats) {
    console.log(`   Missed Trades (Blind Entry EV): N=${missedStats.n}, WR=${(missedStats.wins / missedStats.decided * 100).toFixed(1)}%, EV=$${missedStats.evPerTrade.toFixed(2)}, PnL=$${missedStats.totalPnl.toFixed(0)}`);
  }

  const confirmedStats = aggregate(pops.DEFENDED_CONFIRMED);
  const noWeakenStats = aggregate(pops.FAILED_ATTEMPTS_NO_WEAKENING);
  const timingStats = aggregate(pops.WAITED_SIGNATURE_TIMING);

  return {
    w, v,
    neverWaited: aggregate(pops.NEVER_WAITED),
    waitedNoSignature: aggregate(pops.WAITED_NO_SIGNATURE),
    waitedSignatureTiming: timingStats,
    failedAttemptsNoWeaken: noWeakenStats,
    defendedConfirmed: confirmedStats,
    missed: missedStats,
  };
}

async function sweep() {
  console.log('Loading data (once, reused across all 8 window/variant combinations)...');
  const { barsByDate, acdByDate, dvlByDate, dates } = await loadData();
  const lpResult = await query(
    `SELECT trade_date::text, level_name, price::float FROM level_prices WHERE trade_date >= $1 AND trade_date <= $2`,
    [dates[0], dates[dates.length - 1]]
  );
  const levelPricesByDate = new Map();
  for (const row of lpResult.rows) {
    if (!levelPricesByDate.has(row.trade_date)) levelPricesByDate.set(row.trade_date, {});
    levelPricesByDate.get(row.trade_date)[row.level_name] = row.price;
  }
  const loaded = { barsByDate, acdByDate, dvlByDate, dates, levelPricesByDate };

  const windows = [4, 6, 8, 10];
  const variants = [1, 2];
  const results = [];
  for (const w of windows) {
    for (const v of variants) {
      const r = await runOnce(w, v, loaded);
      results.push(r);
    }
  }

  console.log('\n\n=== SWEEP SUMMARY (DEFENDED_CONFIRMED per window/variant) ===');
  for (const r of results) {
    const s = r.defendedConfirmed;
    if (!s || !s.n) { console.log(`  W=${String(r.w).padStart(2)} V=${r.v}  N=0`); continue; }
    console.log(`  W=${String(r.w).padStart(2)} V=${r.v}  N=${String(s.n).padStart(4)}  WR=${(s.wins/s.decided*100).toFixed(1)}%  EV=$${s.evPerTrade.toFixed(2)}  PnL=$${s.totalPnl.toFixed(0)}`);
  }

  // Real computeReplication call: each (w,v) combo is a "unit" with its own {n, value}
  // metric (DEFENDED_CONFIRMED's N and EV). Selected = W6V2, matching the user's own
  // real chart example -- checking whether the OTHER 7 (window, variant) combinations
  // (held out, not cherry-picked) still point the same direction.
  const units = results
    .filter(r => r.defendedConfirmed && r.defendedConfirmed.n > 0)
    .map(r => ({
      id: `w${r.w}_v${r.v}`,
      metric: { n: r.defendedConfirmed.n, value: r.defendedConfirmed.evPerTrade },
    }));
  const replication = computeReplication(units, {
    idFn: u => u.id,
    metricFn: u => u.metric,
    selectedIds: ['w6_v2'],
  });
  console.log('\n=== REPLICATION CHECK (W=6/V=2 selected vs. the other 7 held out) ===');
  console.log(JSON.stringify(replication, null, 2));

  console.log('\n\n=== FULL REPORT, ALL 5 POPULATIONS, ALL 8 COMBOS ===');
  for (const r of results) {
    console.log(`\n--- W=${r.w} V=${r.v} ---`);
    for (const [label, s] of [['NEVER_WAITED', r.neverWaited], ['WAITED_NO_SIGNATURE', r.waitedNoSignature],
      ['WAITED_SIGNATURE_TIMING', r.waitedSignatureTiming], ['FAILED_ATTEMPTS_NO_WEAKEN', r.failedAttemptsNoWeaken],
      ['DEFENDED_CONFIRMED', r.defendedConfirmed], ['MISSED (coverage cost)', r.missed]]) {
      if (!s || !s.n) { console.log(`  ${label.padEnd(28)} N=0`); continue; }
      console.log(`  ${label.padEnd(28)} N=${String(s.n).padStart(4)}  WR=${(s.wins/s.decided*100).toFixed(1)}%  EV=$${s.evPerTrade.toFixed(2)}  PnL=$${s.totalPnl.toFixed(0)}`);
    }
  }

  process.exit(0);
}

sweep().catch(e => { console.error(e); process.exit(1); });
