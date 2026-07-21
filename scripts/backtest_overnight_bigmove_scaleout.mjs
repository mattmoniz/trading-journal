import { query } from '../server/db.js';
import { resolve } from './backtest_unified.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import fs from 'fs';

const EXCLUDED = new Set(['OR_HIGH', 'OR_LOW', 'IB_HIGH', 'IB_LOW', 'IB_MID_SCALP', 'IB_MID', 'OR_MID',
  'OR_MID_AFTER_IB', 'ONH', 'ONL', '3M_VAH', '3M_VAL', '3M_POC', 'RTH_VWAP', 'WEEKLY_VWAP', 'MONTHLY_VWAP',
  'DAILY_OPEN', 'WEEKLY_OPEN', 'MONTHLY_OPEN']);
const RTH_START = 570, RTH_END = 960;
const BIG_MOVE_PTS = 400;
const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const POST_TARGET_WALK_BARS = 390;
const TRAIL_PERCENTILES = [0.25, 0.35, 0.50, 0.65, 0.75, 0.85, 0.90, 0.95];

function exactPnl(entry, exitPrice, long) {
  const signedPoints = long ? (exitPrice - entry) : (entry - exitPrice);
  return signedPoints * PNL_PER_POINT - COMMISSION;
}

function percentile(sortedArr, p) {
  if (!sortedArr.length) return null;
  const idx = Math.min(sortedArr.length - 1, Math.floor(sortedArr.length * p));
  return sortedArr[idx];
}

async function main() {
  const maxDateRow = await query(`SELECT MAX(trade_date)::text as d FROM level_prices`);
  const maxDate = maxDateRow.rows[0].d;

  const lvlRes = await query(`
    SELECT trade_date::text as d, level_name, price::float as price
    FROM level_prices WHERE trade_date >= $1::date - interval '365 days' AND trade_date <= $1::date
  `, [maxDate]);
  
  const levelsByDate = new Map();
  for (const r of lvlRes.rows) {
    if (EXCLUDED.has(r.level_name)) continue;
    if (!levelsByDate.has(r.d)) levelsByDate.set(r.d, {});
    levelsByDate.get(r.d)[r.level_name] = r.price;
  }
  const levelNames = [...new Set(lvlRes.rows.map(r => r.level_name).filter(n => !EXCLUDED.has(n)))];
  const dates = [...levelsByDate.keys()].sort();

  const barsRes = await query(`
    SELECT ts, ts::date::text as d, EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)::int as tod,
      high::float as high, low::float as low, close::float as close
    FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date - interval '370 days' ORDER BY ts ASC
  `, [maxDate]);
  const allBars = barsRes.rows.map(b => ({ ...b, ts: new Date(b.ts).getTime() }));

  const overnightBarsRanges = [];
  for (const b of allBars) {
    if (b.tod < RTH_START || b.tod >= RTH_END) {
      overnightBarsRanges.push(b.high - b.low);
    }
  }
  overnightBarsRanges.sort((a,b) => a - b);
  const MIN_TRAIL_WIDTH = parseFloat(overnightBarsRanges[Math.floor(overnightBarsRanges.length / 2)].toFixed(2));
  console.log(`Minimum trail width floor (overnight median 1-min NQ bar range): ${MIN_TRAIL_WIDTH}pt`);

  function firstIdxAtOrAfter(dateStr, todMin) {
    for (let i = 0; i < allBars.length; i++) {
      if (allBars[i].d > dateStr) return i;
      if (allBars[i].d === dateStr && allBars[i].tod >= todMin) return i;
    }
    return -1;
  }

  const dayInfo = [];
  for (const d of dates) {
    const startIdx = firstIdxAtOrAfter(d, RTH_START);
    if (startIdx <= 0) continue;
    let rthEndIdx = allBars.length;
    for (let i = startIdx; i < allBars.length; i++) {
      if (allBars[i].d > d || (allBars[i].d === d && allBars[i].tod >= RTH_END)) { rthEndIdx = i; break; }
    }
    const wideStartTs = allBars[startIdx].ts - 15.5 * 3600 * 1000;
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts < wideStartTs) lo = mid + 1; else hi = mid; }
    const wideStartIdx = Math.max(lo, 1);

    let hi_ = -Infinity, lo_ = Infinity;
    for (let i = wideStartIdx; i < startIdx; i++) { if (allBars[i].high > hi_) hi_ = allBars[i].high; if (allBars[i].low < lo_) lo_ = allBars[i].low; }
    const range = hi_ - lo_;
    dayInfo.push({ d, startIdx, rthEndIdx, wideStartIdx, range });
  }

  const allTouches = [];
  for (const x of dayInfo) {
    const lv = levelsByDate.get(x.d);
    if (!lv) continue;
    const isMonday = new Date(x.d + 'T12:00:00').getDay() === 1;
    const STOP = isMonday ? 60 : 90, TARGET = isMonday ? 30 : 40;
    const isBigDay = x.range > BIG_MOVE_PTS;
    if (!isBigDay) continue;

    for (const name of levelNames) {
      const lvl = lv[name];
      if (lvl == null) continue;
      for (let i = x.wideStartIdx + 1; i < x.startIdx; i++) {
        const b = allBars[i], prev = allBars[i - 1];
        if (Math.abs(b.close - lvl) > 15) continue;
        const dir = prev.close > lvl ? 'SHORT' : 'LONG';
        const long = dir === 'LONG';
        const entry = b.close;
        const targetPrice = long ? entry + TARGET : entry - TARGET;
        const stopPrice = long ? entry - STOP : entry + STOP;
        const r = resolve(allBars, i, dir, entry, stopPrice, targetPrice, x.rthEndIdx - i);

        allTouches.push({
          date: x.d, name, dir, isBigDay, result: r.result, entry, long, originalTarget: TARGET, originalStop: STOP, startIdx: i, endIdx: i + r.barsHeld + POST_TARGET_WALK_BARS
        });
        break;
      }
    }
  }

  // Expect a single pooled test since population is thin
  const trades = allTouches;
  
  const pullbacks = [];
  for (const w of trades) {
    if (w.result !== 'TARGET_HIT') continue;
    let maxFav = -Infinity;
    let currentPullback = 0;
    let maxPullbackSinceNewFav = 0;
    const endIdx = Math.min(allBars.length, w.endIdx);
    
    for (let i = w.startIdx; i < endIdx; i++) {
      const bar = allBars[i];
      const fav = w.long ? bar.high - w.entry : w.entry - bar.low;
      const adv = w.long ? w.entry - bar.low : bar.high - w.entry;
      
      if (fav > maxFav) {
        if (maxPullbackSinceNewFav > 0) pullbacks.push(maxPullbackSinceNewFav);
        maxFav = fav;
        maxPullbackSinceNewFav = 0;
      } else {
        const currentAdvFromMax = maxFav - fav;
        if (currentAdvFromMax > maxPullbackSinceNewFav) maxPullbackSinceNewFav = currentAdvFromMax;
      }
    }
  }
  
  pullbacks.sort((a, b) => a - b);
  if (pullbacks.length === 0) { console.log("No pullback data"); process.exit(0); }
  
  const trailCandidates = [...new Set(TRAIL_PERCENTILES.map(p => +percentile(pullbacks, p).toFixed(1)))].filter(c => c >= MIN_TRAIL_WIDTH);
  console.log('Trail Candidates:', trailCandidates);
  
  if (trailCandidates.length === 0) {
     console.log("No trail candidates survived the MIN_TRAIL_WIDTH floor.");
  }
  
  const baselineEvents = [];
  let t1ReachedTotal = 0;
  
  for (const w of trades) {
    const entry = w.entry;
    const long = w.long;
    const targetPrice = w.long ? entry + w.originalTarget : entry - w.originalTarget;
    const stopPrice = w.long ? entry - w.originalStop : entry + w.originalStop;
    
    let pnlA = null;
    let outcomeA = null;
    let t1Reached = false;
    const endIdx = Math.min(allBars.length, w.endIdx);
    
    for (let i = w.startIdx; i < endIdx; i++) {
      const bar = allBars[i];
      if (outcomeA === null) {
        const tHit = long ? bar.high >= targetPrice : bar.low <= targetPrice;
        const sHit = long ? bar.low <= stopPrice : bar.high >= stopPrice;
        
        if (tHit && sHit) outcomeA = 'STOP';
        else if (tHit) outcomeA = 'TARGET';
        else if (sHit) outcomeA = 'STOP';
        
        if (outcomeA === 'TARGET') { pnlA = exactPnl(entry, targetPrice, long); t1Reached = true; }
        else if (outcomeA === 'STOP') { pnlA = exactPnl(entry, stopPrice, long); }
      }
    }
    
    if (outcomeA === null) pnlA = 0;
    if (t1Reached) t1ReachedTotal++;
    baselineEvents.push({ date: w.date, pnl: pnlA, tradeEv: pnlA });
  }

  const baselineSplitIdx = Math.floor(baselineEvents.length * (2 / 3));
  const baselineEv = baselineEvents.reduce((s, e) => s + e.pnl, 0) / baselineEvents.length;
  const baselineOosEv = baselineEvents.slice(baselineSplitIdx).reduce((s, e) => s + e.pnl, 0) / (baselineEvents.length - baselineSplitIdx);

  const results = {};
  let responseMd = '# Overnight Big-Move Trailing Mechanism Test Results\n\n';
  let detailedMd = '# Overnight Big-Move Trailing Mechanism - Grid Search & Diagnostics\n\n';
  
  if (t1ReachedTotal < 15) {
     responseMd += `Failed thin-tail gate: Only ${t1ReachedTotal} TARGET_HIT trades on big-move days. No test possible.\\n`;
     fs.writeFileSync('scratch/antigravity_response.md', responseMd);
     return;
  }
  
  const simResults = [];
  
  for (const trail of trailCandidates) {
    let totalEv = 0;
    const events = [];

    for (const w of trades) {
      const entry = w.entry;
      const long = w.long;
      const targetPrice = long ? entry + w.originalTarget : entry - w.originalTarget;
      const stopPrice = long ? entry - w.originalStop : entry + w.originalStop;
      
      let outcomeA = null, outcomeB = null;
      let pnlB = null;
      let runningExtreme = -Infinity;
      
      const endIdx = Math.min(allBars.length, w.endIdx);
      
      for (let i = w.startIdx; i < endIdx; i++) {
        const bar = allBars[i];
        
        if (outcomeA === null) {
          const tHit = long ? bar.high >= targetPrice : bar.low <= targetPrice;
          const sHit = long ? bar.low <= stopPrice : bar.high >= stopPrice;
          
          if (tHit && sHit) outcomeA = 'STOP';
          else if (tHit) outcomeA = 'TARGET';
          else if (sHit) outcomeA = 'STOP';
          
          if (outcomeA === 'STOP') { pnlB = exactPnl(entry, stopPrice, long); outcomeB = 'STOP'; }
        }

        if (outcomeA === 'TARGET' && outcomeB === null) {
           const high = bar.high, low = bar.low;
           if (runningExtreme === -Infinity) {
              runningExtreme = long ? high : low;
           } else {
              if (long && high > runningExtreme) runningExtreme = high;
              if (!long && low < runningExtreme) runningExtreme = low;
           }
           // Breakeven floor for the trailing stop:
           let trailingStopPx = long ? runningExtreme - trail : runningExtreme + trail;
           if (long) { trailingStopPx = Math.max(trailingStopPx, entry); }
           else { trailingStopPx = Math.min(trailingStopPx, entry); }

           const trHit = long ? low <= trailingStopPx : high >= trailingStopPx;
           if (trHit) {
              outcomeB = 'TRAIL_STOP';
              pnlB = exactPnl(entry, trailingStopPx, long);
           }
        }
      }
      
      if (outcomeA === 'TARGET' && outcomeB === null) {
          // If it didn't hit the trail stop by the end of the walk, exit at market
          const lastBar = allBars[endIdx - 1];
          pnlB = exactPnl(entry, lastBar.close, long);
      }
      if (pnlB === null) pnlB = 0; // EXPIRED before TARGET or STOP

      totalEv += pnlB;
      events.push({ date: w.date, pnl: pnlB, tradeEv: pnlB });
    }
    
    const ev = totalEv / trades.length;
    simResults.push({ trail, ev, events });
  }

  detailedMd += `## Trail Width Floor\n`;
  detailedMd += `Overnight median 1-min NQ bar range: **${MIN_TRAIL_WIDTH}pt**\n\n`;

  detailedMd += `## Grid Search Results\n`;
  detailedMd += `| Trail Width | Full EV | IS EV | OOS EV |\n|---|---|---|---|\n`;

  const splitIdx = Math.floor(trades.length * (2/3));
  
  let bestInSample = null;
  for (const res of simResults) {
    const isEv = res.events.slice(0, splitIdx).reduce((acc, e) => acc + e.tradeEv, 0) / splitIdx;
    const oosEv = res.events.slice(splitIdx).reduce((acc, e) => acc + e.tradeEv, 0) / (trades.length - splitIdx);
    detailedMd += `| ${res.trail} | $${res.ev.toFixed(2)} | $${isEv.toFixed(2)} | $${oosEv.toFixed(2)} |\n`;

    if (!bestInSample || isEv > bestInSample.isEv) {
      bestInSample = { ...res, isEv };
    }
  }

  let plateauPassed = false;
  if (bestInSample) {
     const b_t = bestInSample.trail;
     let tIdx = trailCandidates.indexOf(b_t);
     
     const neighbors = [];
     if (tIdx > 0) neighbors.push(simResults.find(r => r.trail === trailCandidates[tIdx-1]));
     if (tIdx < trailCandidates.length - 1) neighbors.push(simResults.find(r => r.trail === trailCandidates[tIdx+1]));
     
     plateauPassed = neighbors.every(n => n && n.events.slice(0, splitIdx).reduce((acc, e) => acc + e.tradeEv, 0)/splitIdx > 0);
  }

  let survivors = 0;
  if (bestInSample && plateauPassed) {
     const oosEv = bestInSample.events.slice(splitIdx).reduce((acc, e) => acc + e.tradeEv, 0) / (trades.length - splitIdx);
     const fullEv = bestInSample.ev;

     if (oosEv > 0 && fullEv > baselineEv && oosEv > baselineOosEv) {
         const rigor = computeRigor(bestInSample.events, { dateField: 'date', pnlFn: e => e.pnl });
         detailedMd += `\n## Guardrails for Best IS (${bestInSample.trail}pt)\n`;
         detailedMd += `- Plateau Check: PASSED\n`;
         detailedMd += `- OOS > 0 and OOS > Baseline OOS: PASSED\n`;
         detailedMd += `- Full EV > Baseline Full EV: PASSED\n`;
         detailedMd += `- Rigor / Day-Clustering Clean: ${rigor.clean ? 'PASSED' : 'FAILED'}\n`;

         if (rigor.clean) {
           responseMd += `### Pooled Overnight Big-Move Population\n- **Target Hits**: ${t1ReachedTotal}\n- **Best Trail Width**: ${bestInSample.trail}pt\n- **Baseline EV (100% T1, full)**: $${baselineEv.toFixed(2)}\n- **Baseline EV (100% T1, OOS)**: $${baselineOosEv.toFixed(2)}\n- **In-Sample EV (first 2/3)**: $${bestInSample.isEv.toFixed(2)}\n- **OOS EV (last 1/3)**: $${oosEv.toFixed(2)}\n- **Full Blended EV**: $${fullEv.toFixed(2)}\n- **Status**: SURVIVED all guardrails (Thin-tail, Plateau, OOS split, Rigor)\n\n`;
           survivors++;
         }
     } else {
         detailedMd += `\n## Guardrails for Best IS (${bestInSample.trail}pt)\n`;
         detailedMd += `- Plateau Check: PASSED\n`;
         detailedMd += `- OOS/Baseline Check: FAILED (oosEv=$${oosEv.toFixed(2)}, baselineOos=$${baselineOosEv.toFixed(2)})\n`;
     }
  } else if (bestInSample) {
      detailedMd += `\n## Guardrails for Best IS (${bestInSample.trail}pt)\n`;
      detailedMd += `- Plateau Check: FAILED\n`;
  }

  if (survivors === 0) {
      responseMd += "No trailing mechanism config survived the overfitting guardrails (thin-tail gate, plateau check, OOS check, rigor clean). **0 survivors.**\n\n";
      responseMd += "This is a legitimate honest outcome. The raw 'extra runup' finding likely didn't survive real bar-by-bar sequence simulation with a trailing stop floored to normal market noise.\n";
  }

  fs.writeFileSync('scratch/antigravity_response.md', responseMd);
  fs.writeFileSync('scratch/overnight_bigmove_trailing_mechanism_RESULTS.md', detailedMd);

  console.log('Done, wrote results to scratch/antigravity_response.md and scratch/overnight_bigmove_trailing_mechanism_RESULTS.md');
}

main().catch(e => { console.error(e); process.exit(1); });
