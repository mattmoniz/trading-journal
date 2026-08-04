import { query } from '../server/db.js';
import pool from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';
import { computeRunningVwapSeries } from '../server/services/developingValueService.js';
import { sweepOptimalStopAndTarget, DEFAULT_DPP } from './update_optimal_stops.mjs';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';

const RTH_START = 570, RTH_END = 960;

// Load 1-minute bars for NQ RTH
async function loadBars() {
  const r = await query(`
    SELECT ts::text as ts, ts::date::text as trade_date,
      open::float, high::float, low::float, close::float, COALESCE(volume,0)::float as volume,
      (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as mod
    FROM price_bars_primary
    WHERE symbol = 'NQ' 
      AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN ${RTH_START} AND ${RTH_END}
    ORDER BY ts
  `);
  return r.rows;
}

function buildDailyBars(rthBars) {
  const byDate = new Map();
  for (const b of rthBars) {
    if (!byDate.has(b.trade_date)) byDate.set(b.trade_date, []);
    byDate.get(b.trade_date).push(b);
  }
  return byDate;
}

function build5MinBars(bars1m) {
  const bars5m = [];
  let current5m = null;
  
  for (const b of bars1m) {
    // RTH starts at 570. 5-min intervals: [570-574], [575-579], etc.
    const intervalIdx = Math.floor((b.mod - RTH_START) / 5);
    const intervalStart = RTH_START + intervalIdx * 5;
    
    if (!current5m || current5m.mod !== intervalStart) {
      if (current5m) bars5m.push(current5m);
      current5m = {
        ts: b.ts, trade_date: b.trade_date, mod: intervalStart,
        open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
        bars1m: [b]
      };
    } else {
      current5m.high = Math.max(current5m.high, b.high);
      current5m.low = Math.min(current5m.low, b.low);
      current5m.close = b.close;
      current5m.volume += b.volume;
      current5m.ts = b.ts; // latest ts
      current5m.bars1m.push(b);
    }
  }
  if (current5m) bars5m.push(current5m);
  return bars5m;
}

function rawExcursion(bars1m, entryIdx, direction) {
  let mae = 0, mfe = 0;
  const entry = bars1m[entryIdx].open; // open of the 1m bar
  
  // walk to the end of the session
  for (let i = entryIdx; i < bars1m.length; i++) {
    const b = bars1m[i];
    const favorable = direction === 'LONG' ? b.high - entry : entry - b.low;
    const adverse = direction === 'LONG' ? entry - b.low : b.high - entry;
    mfe = Math.max(mfe, favorable);
    mae = Math.max(mae, adverse);
  }
  return { mae, mfe };
}

async function run() {
  const { rows: dateRows } = await query(`SELECT CURRENT_DATE::text as today`);
  const todayDate = dateRows[0].today;

  console.log('Loading 1-min RTH bars...');
  const bars1m = await loadBars();
  console.log(`Loaded ${bars1m.length} 1-min RTH bars.`);

  const daily1m = buildDailyBars(bars1m);
  const K_VALUES = [1, 2, 3];
  
  const candidatesByCell = {}; // "K_LONG": [], "K_SHORT": []
  const controlByCell = {};
  
  for (const K of K_VALUES) {
    candidatesByCell[`${K}_LONG`] = [];
    candidatesByCell[`${K}_SHORT`] = [];
    controlByCell[`${K}_LONG`] = [];
    controlByCell[`${K}_SHORT`] = [];
  }
  
  let totalSessions = 0;
  for (const [date, session1m] of daily1m.entries()) {
    totalSessions++;
    const session5m = build5MinBars(session1m);
    
    // canonical computeRunningVwapSeries weights by b.volume
    const vwapSeries = computeRunningVwapSeries(session5m);
    
    for (let i = 0; i < session5m.length; i++) {
      session5m[i].vwap = vwapSeries[i];
      session5m[i].isAbove = session5m[i].close > session5m[i].vwap;
      session5m[i].isBelow = session5m[i].close < session5m[i].vwap;
      
      // We need to know which 1-minute bar comes AFTER this 5-minute bar
      // session5m[i] ends at some 1-minute bar. The next 1-minute bar in the session is:
      let next1mIdx = -1;
      const last1m = session5m[i].bars1m[session5m[i].bars1m.length - 1];
      const foundIdx = session1m.findIndex(b => b.ts === last1m.ts);
      if (foundIdx >= 0 && foundIdx + 1 < session1m.length) {
        next1mIdx = foundIdx + 1;
      }
      session5m[i].next1mIdx = next1mIdx;
    }
    
    for (const K of K_VALUES) {
      for (let i = K; i < session5m.length - 1; i++) {
        const next1mIdx = session5m[i].next1mIdx;
        if (next1mIdx === -1) continue; // no next 1m bar available
        
        // Check for hold K bars
        let holdLong = true;
        let holdShort = true;
        for (let j = 0; j < K; j++) {
          if (!session5m[i - j].isAbove) holdLong = false;
          if (!session5m[i - j].isBelow) holdShort = false;
        }
        
        // The bar before the hold period must be on the OTHER side to constitute a "cross"
        const barBeforeCross = session5m[i - K];
        const isCrossLong = holdLong && barBeforeCross && barBeforeCross.isBelow;
        const isCrossShort = holdShort && barBeforeCross && barBeforeCross.isAbove;
        
        // Control: K bars after ANY cross (even if it didn't hold)
        // A cross happened K bars ago if bar [i-K] was on one side, and [i-K+1] was on the other
        const rawCrossLong = barBeforeCross && barBeforeCross.isBelow && session5m[i - K + 1].isAbove;
        const rawCrossShort = barBeforeCross && barBeforeCross.isAbove && session5m[i - K + 1].isBelow;
        
        const crossHapLong = rawCrossLong && !isCrossLong;
        const crossHapShort = rawCrossShort && !isCrossShort;
        
        if (isCrossLong) {
          candidatesByCell[`${K}_LONG`].push({ date, session1m, session5m, i, next1mIdx, direction: 'LONG' });
        }
        if (isCrossShort) {
          candidatesByCell[`${K}_SHORT`].push({ date, session1m, session5m, i, next1mIdx, direction: 'SHORT' });
        }
        
        if (crossHapLong) {
          controlByCell[`${K}_LONG`].push({ date, session1m, session5m, i, next1mIdx, direction: 'LONG' });
        }
        if (crossHapShort) {
          controlByCell[`${K}_SHORT`].push({ date, session1m, session5m, i, next1mIdx, direction: 'SHORT' });
        }
      }
    }
  }
  
  console.log(`Processed ${totalSessions} sessions.`);
  
  function median(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }
  
  function percentiles(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return {
      p25: s[Math.floor(s.length * 0.25)] || s[0],
      p40: s[Math.floor(s.length * 0.40)] || s[0],
      p50: s[Math.floor(s.length * 0.50)] || s[0],
      p60: s[Math.floor(s.length * 0.60)] || s[0],
      p75: s[Math.floor(s.length * 0.75)] || s[0],
    };
  }

  const dpp = LIVE_INSTRUMENT.dollarsPerPoint; // $2 for MNQ
  const commission = LIVE_INSTRUMENT.commissionPerRoundTrip;

  function simulateTrades(candidates) {
    const results = [];
    
    for (const c of candidates) {
      const { session1m, session5m, i, next1mIdx, direction } = c;
      const entryPrice = session1m[next1mIdx].open;
      
      let stopHitPnl = null;
      let targetHitDist = null;
      
      // Stop is structural: closes 5-min bar back on WRONG side of VWAP
      let stopHitIdx1m = null;
      
      // Walk 5-min bars from entry to find the stop trigger
      let stopTrigger5mIdx = -1;
      for (let j = i + 1; j < session5m.length; j++) {
        const b = session5m[j];
        if (direction === 'LONG' && b.isBelow) {
          stopTrigger5mIdx = j;
          break;
        }
        if (direction === 'SHORT' && b.isAbove) {
          stopTrigger5mIdx = j;
          break;
        }
      }
      
      let walkEnd1mIdx = session1m.length - 1; // session close default
      if (stopTrigger5mIdx !== -1) {
        // Find the 1-min bar where we execute the stop (open of the NEXT 1-min bar after the 5-min close)
        const stopTriggerNext1mIdx = session5m[stopTrigger5mIdx].next1mIdx;
        if (stopTriggerNext1mIdx !== -1) {
          walkEnd1mIdx = stopTriggerNext1mIdx; // Execute on the open of this bar
        }
      }
      
      // Raw excursion up to the stop trigger (or session close)
      let mfe = 0, mae = 0;
      for (let m = next1mIdx; m < walkEnd1mIdx; m++) {
        const b = session1m[m];
        const fav = direction === 'LONG' ? b.high - entryPrice : entryPrice - b.low;
        const adv = direction === 'LONG' ? entryPrice - b.low : b.high - entryPrice;
        mfe = Math.max(mfe, fav);
        mae = Math.max(mae, adv);
      }
      
      const exitPrice = session1m[walkEnd1mIdx].open;
      const actualPnlPoints = direction === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice;
      const actualPnl = actualPnlPoints * dpp - commission;
      
      results.push({
        date: c.date,
        mae_points: mae,
        mfe_points: mfe,
        actual_pnl: actualPnl,
        direction,
        entryPrice
      });
    }
    
    return results;
  }
  
  const FINAL_RESULTS = [];
  
  for (const K of K_VALUES) {
    for (const dir of ['LONG', 'SHORT']) {
      const cell = `${K}_${dir}`;
      const cands = candidatesByCell[cell];
      const ctrls = controlByCell[cell];
      
      if (cands.length === 0) continue;
      
      const simCand = simulateTrades(cands);
      const simCtrl = simulateTrades(ctrls);
      
      // derive target from MFE distribution using sweepOptimalStopAndTarget methodology
      // MAE is purely structural (wrong side of VWAP), so we only sweep TARGET.
      // We can reuse sweepOptimalStopAndTarget by passing a dummy infinite stop, 
      // since the stop is structural and actual_pnl already reflects it if hit.
      const p75mfeCand = percentiles(simCand.map(r => r.mfe_points))?.p75 || 150;
      const sweptCand = sweepOptimalStopAndTarget(simCand, [{ value: Infinity, pct: 0 }], p75mfeCand, dpp, dpp, commission);
      let bestT_cand = sweptCand ? sweptCand.target : null;
      let bestEv_cand = sweptCand ? sweptCand.ev : -Infinity;
      
      const p75mfeCtrl = percentiles(simCtrl.map(r => r.mfe_points))?.p75 || 150;
      const sweptCtrl = sweepOptimalStopAndTarget(simCtrl, [{ value: Infinity, pct: 0 }], p75mfeCtrl, dpp, dpp, commission);
      let bestT_ctrl = sweptCtrl ? sweptCtrl.target : null;
      let bestEv_ctrl = sweptCtrl ? sweptCtrl.ev : -Infinity;
      
      // If we don't have N>=20, or sweep fails, just use actual_pnl
      const rawEvCand = simCand.reduce((sum, t) => sum + t.actual_pnl, 0) / (simCand.length || 1);
      const rawEvCtrl = simCtrl.reduce((sum, t) => sum + t.actual_pnl, 0) / (simCtrl.length || 1);
      
      const finalEvCand = bestEv_cand !== -Infinity ? bestEv_cand : rawEvCand;
      const finalEvCtrl = bestEv_ctrl !== -Infinity ? bestEv_ctrl : rawEvCtrl;
      
      // rigordiagnostics on Candidate trades
      // re-evaluate each trade using the chosen best target
      let candTrades = simCand.map(t => {
        let pnl = t.actual_pnl;
        if (bestT_cand && t.mfe_points >= bestT_cand) pnl = bestT_cand * dpp - commission;
        return { ...t, pnl };
      });
      
      const rigor = candTrades.length >= 20 ? computeRigor(candTrades, { dateField: 'date', pnlFn: t => t.pnl }) : { clean: false, thirds: null };
      const wrCand = candTrades.filter(t => t.pnl > 0).length / candTrades.length;
      // p75 MAE of the candidate population -- surfaced so a live implementation has a real,
      // data-derived fallback stop distance to use before real forward N>=20 accumulates and
      // update_optimal_stops.mjs's own generic sweep takes over, matching the "no static
      // thresholds" convention every other new setup type's bootstrap fallback follows.
      const p75MaeCand = percentiles(simCand.map(r => r.mae_points))?.p75 ?? null;

      FINAL_RESULTS.push({
        K, dir, N: candTrades.length,
        wr: wrCand,
        ev: finalEvCand,
        target: bestT_cand,
        p75Mae: p75MaeCand,
        rigorClean: rigor.clean,
        rigorThirds: rigor.thirds,
        ctrlN: simCtrl.length,
        ctrlEv: finalEvCtrl,
        ctrlTarget: bestT_ctrl
      });
      
      if (candTrades.length >= 20) {
        await recordClaim({
          slug: `vwap_reclaim_hold_k${K}_${dir.toLowerCase()}_phase1`,
          claimText: `VWAP reclaim-and-hold phase 1. K=${K} ${dir}. Target swept on MFE (max p75) with structural VWAP cross-back stop.`,
          sourceFile: 'scripts/backtest_vwap_reclaim_hold_phase1.mjs',
          sourceDate: todayDate,
          sampleSize: candTrades.length,
          winRate: wrCand,
          evPerTrade: finalEvCand,
          rigorStatus: rigor.clean ? (finalEvCand > finalEvCtrl ? 'STABLE' : 'UNSTABLE_FAILS_CONTROL') : 'UNSTABLE',
          status: 'PROVISIONAL'
        });
      }
    }
  }
  
  let mdOut = '# VWAP Reclaim and Hold Backtest Results\n\n';
  mdOut += '| K | Dir | N | WR | EV (Cand) | Target (Cand) | P75 MAE (Cand) | Rigor Clean | Rigor Thirds | Control EV | Control Target | Passes Control? |\n';
  mdOut += '|---|---|---|---|---|---|---|---|---|---|---|---|\n';

  for (const r of FINAL_RESULTS) {
    const passes = r.ev > r.ctrlEv ? 'YES' : 'NO';
    mdOut += `| ${r.K} | ${r.dir} | ${r.N} | ${(r.wr * 100).toFixed(1)}% | $${r.ev.toFixed(2)} | ${r.target ? r.target + 'pt' : 'None'} | ${r.p75Mae != null ? r.p75Mae.toFixed(1) + 'pt' : 'None'} | ${r.rigorClean} | ${JSON.stringify(r.rigorThirds)} | $${r.ctrlEv.toFixed(2)} | ${r.ctrlTarget ? r.ctrlTarget + 'pt' : 'None'} | ${passes} |\n`;
  }
  
  const fs = await import('fs');
  fs.writeFileSync('scratch/antigravity_response.md', mdOut);
  console.log('Results written to scratch/antigravity_response.md');
  process.exit(0);
}

run().catch(e => { console.error('Error:', e); process.exit(1); });
