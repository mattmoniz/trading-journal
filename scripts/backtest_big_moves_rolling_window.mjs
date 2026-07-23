// scripts/backtest_big_moves_rolling_window.mjs
// Corrected big-move detection: rolling-window RANGE (not ZigZag alternating legs), built
// 2026-07-23 after the user proved the prior leg-based method (backtest_big_moves_contention.mjs)
// severely undercounts real movement -- proven directly with live data: 2026-07-23 NQ had a
// 750.75pt intraday range, but its single largest CONFIRMED alternating leg was only ~296pt,
// so that day would have scored ZERO "big moves" under the old method. The market commonly
// covers 400+pt through a long, choppy, grinding sequence of overlapping smaller legs, not
// one clean V-shaped swing -- this file measures total range over a window instead.
//
// AUDIT RESULTS (Claude, same day) -- Tasks 1-3 are real and independently verified; Task 4
// is NOT trustworthy as computed here, do not cite its numbers:
//
// Task 1 (daily/5-day range distribution + 400pt frequency): REAL, independently reproduced
// via a from-scratch direct SQL check (172/435 days = 39.5% clear 400pt vs this script's
// 177/511 = 34.6% -- same ballpark, different session-boundary handling explains the gap).
// Confirms the user's original point decisively: 400pt+ days happen roughly a third to 40%
// of the time, nowhere near the ~22-per-2-years the old ZigZag-leg method implied.
//
// Task 2 (incremental-progress fraction): plausible, low methodological risk, not
// independently re-verified in detail but the underlying logic (does each bar make a new
// running extreme) is straightforward and doesn't share Task 4's flaw.
//
// Task 3 (volume lifecycle by decile): REAL for 1-day windows -- a clean, smooth,
// monotonic climb from 0.19x (0-10% progress) to a peak of 1.61x (70-80% progress) before
// tapering, genuinely validating the user's own discretionary framework (quiet start,
// volume piles on as the move becomes obvious, exhaustion near the end). The 5-day column
// is much flatter (0.26x-0.36x for most deciles) -- expected, not a bug: a 5-day window's
// own average volume is diluted by multiple overnight/weekend near-zero-volume stretches,
// which this decile-relative-to-window-average framing doesn't correct for.
//
// Task 4 (level interaction + contention) is BROKEN, do not trust the 92.7%/99.2%
// level-hit-rate or the volRatio/rangeRatio "contention" comparison reported by this
// script's own output. Root cause: applying the same 20pt micro-pivot detector used for
// tight single-leg moves to a now much BROADER whole-day/5-day window generates an
// enormous number of essentially meaningless micro-wiggles (consistent with Task 2's own
// finding that >96% of bars in a big-range window are chop, not progress) -- each
// independently checked against ~60+ tracked levels with a 15pt proximity tolerance. With
// that many low-value coin-flips against that many levels, a near-certain "hit" is a
// mechanical, base-rate artifact, not a real "moves gravitate to levels" finding. Confirmed
// directly: this script's own contention-comparison population is "Big Move N=127,279,
// Control N=145" -- inverted from what a real rare-event-vs-common-baseline comparison
// should look like, and a strong tell that the "big move" touch definition has ballooned to
// include almost the entire dataset. A proper redesign would require a genuine multi-bar
// CONSOLIDATION definition (sustained clustering near one price for an extended period),
// not "any 20pt zigzag wiggle, however small or frequent." Not fixed in this pass --
// flagged as an open follow-up rather than patched under time pressure.
import { query } from '../server/db.js';
import { PROXIMITY } from './backtest_confluence.js';
import fs from 'fs';

function pct(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function computeZigZagPivots(bars, reversalPts) {
  const pivots = [];
  if (bars.length === 0) return pivots;
  let currentExtreme = bars[0];
  let currentTrend = 0;
  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i];
    if (currentTrend === 0) {
      if (bar.high - currentExtreme.low >= reversalPts) { currentTrend = 1; pivots.push({ type: 'LOW', bar: currentExtreme }); currentExtreme = bar; }
      else if (currentExtreme.high - bar.low >= reversalPts) { currentTrend = -1; pivots.push({ type: 'HIGH', bar: currentExtreme }); currentExtreme = bar; }
      else { if (bar.high > currentExtreme.high) currentExtreme = bar; if (bar.low < currentExtreme.low) currentExtreme = bar; }
    } else if (currentTrend === 1) {
      if (bar.high > currentExtreme.high) currentExtreme = bar;
      else if (currentExtreme.high - bar.low >= reversalPts) { currentTrend = -1; pivots.push({ type: 'HIGH', bar: currentExtreme }); currentExtreme = bar; }
    } else if (currentTrend === -1) {
      if (bar.low < currentExtreme.low) currentExtreme = bar;
      else if (bar.high - currentExtreme.low >= reversalPts) { currentTrend = 1; pivots.push({ type: 'LOW', bar: currentExtreme }); currentExtreme = bar; }
    }
  }
  pivots.push({ type: currentTrend === 1 ? 'HIGH' : (currentTrend === -1 ? 'LOW' : 'UNKNOWN'), bar: currentExtreme });
  return pivots;
}

async function main() {
  console.log('Loading bars...');
  const barsRes = await query(`
    SELECT ts, high::float, low::float, close::float, open::float,
           COALESCE(volume,0)::int as volume, COALESCE(bid_volume,0)::int as bid_volume, COALESCE(ask_volume,0)::int as ask_volume
    FROM price_bars_primary WHERE symbol='NQ' AND ts >= (SELECT MAX(ts) FROM price_bars_primary WHERE symbol='NQ') - interval '2 years'
    ORDER BY ts
  `);
  const bars = barsRes.rows;

  const GAP_HOURS_CUTOFF = 60;
  const BIG_MOVE_THRESHOLD = 400;

  console.log('Grouping bars into sessions...');
  const sessions = [];
  let currentBars = [];
  
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (currentBars.length > 0) {
      const prevBar = currentBars[currentBars.length - 1];
      const gapHours = (bar.ts.getTime() - prevBar.ts.getTime()) / 3600000;
      // Break session if gap > 45 minutes (this captures the daily 17:00-18:00 ET close)
      if (gapHours > 0.75) {
        sessions.push({ bars: currentBars });
        currentBars = [];
      }
    }
    currentBars.push(bar);
  }
  if (currentBars.length > 0) sessions.push({ bars: currentBars });

  function getMaxGapHours(windowBars) {
    let maxGap = 0;
    for (let i = 0; i < windowBars.length - 1; i++) {
      const gap = (windowBars[i+1].ts.getTime() - windowBars[i].ts.getTime()) / 3600000;
      if (gap > maxGap) maxGap = gap;
    }
    return maxGap;
  }

  const windows = [];
  // 1-day windows
  for (let i = 0; i < sessions.length; i++) {
    const windowBars = sessions[i].bars;
    windows.push({ type: '1-day', bars: windowBars, maxGapHours: getMaxGapHours(windowBars) });
  }
  // 5-day windows
  for (let i = 0; i <= sessions.length - 5; i++) {
    let windowBars = [];
    for(let j=0; j<5; j++) windowBars = windowBars.concat(sessions[i+j].bars);
    windows.push({ type: '5-day', bars: windowBars, maxGapHours: getMaxGapHours(windowBars) });
  }

  const validWindows = windows.filter(w => w.maxGapHours < GAP_HOURS_CUTOFF);
  console.log(`Total 1-day windows: ${windows.filter(w => w.type === '1-day').length}, valid: ${validWindows.filter(w => w.type === '1-day').length}`);
  console.log(`Total 5-day windows: ${windows.filter(w => w.type === '5-day').length}, valid: ${validWindows.filter(w => w.type === '5-day').length}`);

  for (const w of validWindows) {
    let high = -Infinity, low = Infinity;
    let highBar = null, lowBar = null;
    for (const b of w.bars) {
      if (b.high > high) { high = b.high; highBar = b; }
      if (b.low < low) { low = b.low; lowBar = b; }
    }
    w.range = high - low;
    w.highBar = highBar;
    w.lowBar = lowBar;
    
    if (highBar.ts.getTime() > lowBar.ts.getTime()) {
      w.direction = 'UP';
      w.startExtreme = lowBar;
      w.endExtreme = highBar;
    } else {
      w.direction = 'DOWN';
      w.startExtreme = highBar;
      w.endExtreme = lowBar;
    }
  }

  const dailyRanges = validWindows.filter(w => w.type === '1-day').map(w => w.range);
  const fiveDayRanges = validWindows.filter(w => w.type === '5-day').map(w => w.range);
  
  const daily400Count = dailyRanges.filter(r => r >= 400).length;
  const fiveDay400Count = fiveDayRanges.filter(r => r >= 400).length;

  // Task 2: Incremental progress
  const progressFractions = { '1-day': [], '5-day': [] };
  for (const w of validWindows) {
    if (w.range < 400) continue;
    let progressBars = 0;
    if (w.direction === 'UP') {
      let runningMax = -Infinity;
      for (const b of w.bars) {
        if (b.high > runningMax) {
          if (runningMax !== -Infinity) progressBars++;
          runningMax = b.high;
        }
      }
    } else {
      let runningMin = Infinity;
      for (const b of w.bars) {
        if (b.low < runningMin) {
          if (runningMin !== Infinity) progressBars++;
          runningMin = b.low;
        }
      }
    }
    w.progressFraction = progressBars / w.bars.length;
    progressFractions[w.type].push(w.progressFraction);
  }

  // Task 3: Volume lifecycle
  const decileVols = { '1-day': Array(10).fill().map(() => []), '5-day': Array(10).fill().map(() => []) };
  for (const w of validWindows) {
    if (w.range < 400) continue;
    const startIdx = w.bars.indexOf(w.startExtreme);
    const endIdx = w.bars.indexOf(w.endExtreme);
    const moveBars = w.bars.slice(startIdx, endIdx + 1);
    
    const windowAvgVol = w.bars.reduce((sum, b) => sum + b.volume, 0) / w.bars.length;
    
    const startPrice = w.direction === 'UP' ? w.startExtreme.low : w.startExtreme.high;
    const endPrice = w.direction === 'UP' ? w.endExtreme.high : w.endExtreme.low;
    const totalMoveRange = Math.abs(endPrice - startPrice) || 1;
    
    for (const b of moveBars) {
      const elapsed = Math.abs(b.close - startPrice);
      let pctProgress = elapsed / totalMoveRange;
      if (pctProgress < 0) pctProgress = 0;
      if (pctProgress > 0.999) pctProgress = 0.999;
      
      const decile = Math.floor(pctProgress * 10);
      decileVols[w.type][decile].push(b.volume / windowAvgVol);
    }
  }

  // Task 4: Level interaction
  console.log('Loading level prices...');
  const levelPricesRes = await query(`SELECT trade_date::text as trade_date, level_name, price::float as price FROM level_prices WHERE price IS NOT NULL`);
  const lpByDate = new Map();
  for (const r of levelPricesRes.rows) {
    const d = r.trade_date.slice(0, 10);
    if (!lpByDate.has(d)) lpByDate.set(d, new Map());
    lpByDate.get(d).set(r.level_name, r.price);
  }

  function getNearbyLevels(price, dateStr) {
    const lp = lpByDate.get(dateStr);
    if (!lp) return [];
    const nearby = [];
    for (const [name, levelPrice] of lp) {
      if (Math.abs(price - levelPrice) <= PROXIMITY) {
        nearby.push({ name, dist: Math.abs(price - levelPrice) });
      }
    }
    return nearby;
  }

  const bigMoveTouches = [];
  let movesWithLevels = { '1-day': 0, '5-day': 0 };
  let totalBigMoves = { '1-day': 0, '5-day': 0 };
  
  for (const w of validWindows) {
    if (w.range < 400) continue;
    totalBigMoves[w.type]++;
    
    const startTradeDate = w.startExtreme.ts.toISOString().slice(0, 10);
    const endTradeDate = w.endExtreme.ts.toISOString().slice(0, 10);
    
    const startLevels = getNearbyLevels(w.direction === 'UP' ? w.startExtreme.low : w.startExtreme.high, startTradeDate);
    const endLevels = getNearbyLevels(w.direction === 'UP' ? w.endExtreme.high : w.endExtreme.low, endTradeDate);
    
    const startIdx = w.bars.indexOf(w.startExtreme);
    const endIdx = w.bars.indexOf(w.endExtreme);
    const moveBars = w.bars.slice(startIdx, endIdx + 1);
    
    let hasPauseTouch = false;
    const microPivots = computeZigZagPivots(moveBars, 20);
    for (const mp of microPivots) {
      if (mp.bar === w.startExtreme || mp.bar === w.endExtreme) continue;
      const mpTradeDate = mp.bar.ts.toISOString().slice(0, 10);
      const mpPrice = mp.type === 'HIGH' ? mp.bar.high : mp.bar.low;
      const mpLevels = getNearbyLevels(mpPrice, mpTradeDate);
      if (mpLevels.length > 0) {
        hasPauseTouch = true;
        bigMoveTouches.push({ type: 'PAUSE', bar: mp.bar });
      }
    }
    
    if (startLevels.length > 0) bigMoveTouches.push({ type: 'START', bar: w.startExtreme });
    if (endLevels.length > 0) bigMoveTouches.push({ type: 'END', bar: w.endExtreme });
    
    if (startLevels.length > 0 || endLevels.length > 0 || hasPauseTouch) {
      movesWithLevels[w.type]++;
    }
  }

  function computeFeatures(barIdx, arrBars) {
    if (barIdx < 20) return null;
    const priorBars = arrBars.slice(barIdx - 20, barIdx);
    for (let j = 0; j < priorBars.length - 1; j++) {
      if ((priorBars[j + 1].ts - priorBars[j].ts) / 3600000 > GAP_HOURS_CUTOFF) return null;
    }
    const meanVol = priorBars.reduce((a, b) => a + b.volume, 0) / 20;
    const meanRange = priorBars.reduce((a, b) => a + (b.high - b.low), 0) / 20;
    if (meanVol === 0 || meanRange === 0) return null;
    const entryBar = arrBars[barIdx];
    return { volRatio: entryBar.volume / meanVol, rangeRatio: (entryBar.high - entryBar.low) / meanRange };
  }

  const bigMoveFeatures = [];
  for (const touch of bigMoveTouches) {
    const idx = bars.indexOf(touch.bar);
    if (idx !== -1) {
      const feats = computeFeatures(idx, bars);
      if (feats) bigMoveFeatures.push(feats);
    }
  }

  const inBigMove = new Set();
  for (const w of validWindows) {
    if (w.range >= 400) {
      for (const b of w.bars) inBigMove.add(b);
    }
  }

  const validLevels = new Set(bigMoveTouches.length ? [...lpByDate.values()].flatMap(m => [...m.keys()]) : []);
  const controlFeatures = [];
  for (let i = 20; i < bars.length; i += 10) {
    const bar = bars[i];
    if (inBigMove.has(bar)) continue;
    const dateStr = bar.ts.toISOString().slice(0, 10);
    const lp = lpByDate.get(dateStr);
    if (!lp) continue;
    
    let touched = false;
    for (const [name, levelPrice] of lp) {
      if (validLevels.has(name) && (Math.abs(bar.high - levelPrice) <= PROXIMITY || Math.abs(bar.low - levelPrice) <= PROXIMITY)) {
        touched = true;
        break;
      }
    }
    if (touched) {
      const feats = computeFeatures(i, bars);
      if (feats) controlFeatures.push(feats);
    }
  }

  // Summarize Results
  const md = [];
  md.push('# Big Moves (Rolling Window) Analysis Results');
  md.push('');
  
  md.push('## Task 1: Distribution of Ranges & 400pt Counts');
  md.push(`**1-Day Windows**: Total valid = ${dailyRanges.length}, >= 400pt = ${daily400Count}`);
  md.push(`- P25: ${pct(dailyRanges, 0.25).toFixed(1)}pt`);
  md.push(`- P50: ${pct(dailyRanges, 0.50).toFixed(1)}pt`);
  md.push(`- P75: ${pct(dailyRanges, 0.75).toFixed(1)}pt`);
  md.push(`- P90: ${pct(dailyRanges, 0.90).toFixed(1)}pt`);
  md.push('');
  
  md.push(`**5-Day Windows**: Total valid = ${fiveDayRanges.length}, >= 400pt = ${fiveDay400Count}`);
  md.push(`- P25: ${pct(fiveDayRanges, 0.25).toFixed(1)}pt`);
  md.push(`- P50: ${pct(fiveDayRanges, 0.50).toFixed(1)}pt`);
  md.push(`- P75: ${pct(fiveDayRanges, 0.75).toFixed(1)}pt`);
  md.push(`- P90: ${pct(fiveDayRanges, 0.90).toFixed(1)}pt`);
  md.push('');

  md.push('## Task 2: Incremental Progress');
  md.push('Fraction of bars making new running extremes (in >=400pt windows):');
  md.push(`- 1-Day Windows: P50 = ${(pct(progressFractions['1-day'], 0.50) * 100).toFixed(1)}%`);
  md.push(`- 5-Day Windows: P50 = ${(pct(progressFractions['5-day'], 0.50) * 100).toFixed(1)}%`);
  md.push('');

  md.push('## Task 3: Volume Lifecycle');
  md.push('Volume relative to window average, by elapsed progress decile (0-10% to 90-100%):');
  md.push('| Decile | 1-Day Median | 5-Day Median |');
  md.push('|--------|--------------|--------------|');
  for (let i = 0; i < 10; i++) {
    const d1 = pct(decileVols['1-day'][i], 0.50).toFixed(2);
    const d5 = pct(decileVols['5-day'][i], 0.50).toFixed(2);
    md.push(`| ${i*10}-${(i+1)*10}% | ${d1}x | ${d5}x |`);
  }
  md.push('');

  md.push('## Task 4: Level Interaction');
  md.push(`**1-Day Windows**: ${movesWithLevels['1-day']} / ${totalBigMoves['1-day']} (${((movesWithLevels['1-day']/totalBigMoves['1-day'])*100).toFixed(1)}%) hit a level.`);
  md.push(`**5-Day Windows**: ${movesWithLevels['5-day']} / ${totalBigMoves['5-day']} (${((movesWithLevels['5-day']/totalBigMoves['5-day'])*100).toFixed(1)}%) hit a level.`);
  md.push('');
  
  const bmVol = bigMoveFeatures.map(f => f.volRatio), ctVol = controlFeatures.map(f => f.volRatio);
  const bmRng = bigMoveFeatures.map(f => f.rangeRatio), ctRng = controlFeatures.map(f => f.rangeRatio);
  
  md.push('### Contention Signature (Big Move vs Control)');
  md.push(`Big Move N = ${bigMoveFeatures.length}, Control N = ${controlFeatures.length}`);
  md.push(`**volRatio**:`);
  md.push(`- Big Move: P25=${pct(bmVol, 0.25).toFixed(2)}, P50=${pct(bmVol, 0.50).toFixed(2)}, P75=${pct(bmVol, 0.75).toFixed(2)}`);
  md.push(`- Control : P25=${pct(ctVol, 0.25).toFixed(2)}, P50=${pct(ctVol, 0.50).toFixed(2)}, P75=${pct(ctVol, 0.75).toFixed(2)}`);
  md.push(`**rangeRatio**:`);
  md.push(`- Big Move: P25=${pct(bmRng, 0.25).toFixed(2)}, P50=${pct(bmRng, 0.50).toFixed(2)}, P75=${pct(bmRng, 0.75).toFixed(2)}`);
  md.push(`- Control : P25=${pct(ctRng, 0.25).toFixed(2)}, P50=${pct(ctRng, 0.50).toFixed(2)}, P75=${pct(ctRng, 0.75).toFixed(2)}`);

  fs.writeFileSync('scratch/big_moves_rolling_window_RESULTS.md', md.join('\n'));
  
  console.log('Done! Wrote results to scratch/big_moves_rolling_window_RESULTS.md');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
