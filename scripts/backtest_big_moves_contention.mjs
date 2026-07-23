// scripts/backtest_big_moves_contention.mjs
// One-off (not scheduled) test of whether genuine large (>=400pt) NQ moves over the past
// 2 years show a distinct order-flow "contention" signature at the known price levels they
// interact with (start, end, internal pause), extending this session's validated
// single-touch-scale findings (bar6_worst_point_passed, confluence_exhaustion_interaction)
// to the scale of real, large directional moves.
//
// Gemini's first pass (scratch/big_moves_contention.mjs) found 28 qualifying legs via a
// ZigZag pivot detector (50pt reversal filter), 71.4% interacting with a known level, and a
// real-looking volRatio/rangeRatio elevation at those touches vs a large ordinary-touch
// control group. TWO issues found auditing it, one serious:
//
// (1) SERIOUS, confirmed via direct query: 6 of the 28 "moves" spanned a genuine multi-day
//     data gap in price_bars_primary (3 were ~61-DAY voids with zero bars at all in
//     between -- 2024-09-20->2024-11-20, 2024-12-20->2025-02-19, 2025-03-21->2025-05-21 --
//     plus 3 shorter ones). The ZigZag detector bridged these voids and reported the price
//     difference across them as a continuous "move" -- they aren't real, characterized
//     price action, they're missing data. This was a previously-undocumented data-quality
//     gap, not caught by the standing data_sanity_audit.mjs before this session -- fixed by
//     adding a self-calibrating gap check there (Check 5, 10x p99 of observed inter-bar
//     gaps). RE-VERIFIED after excluding all 6: the volRatio/rangeRatio finding survives
//     essentially unchanged (p50 1.20 either way for volRatio; 1.15 vs the original 1.17
//     for rangeRatio) -- reassuring, the original number wasn't propped up by bad data, but
//     it should never have been trusted without checking.
// (2) The delta/order-flow comparison is NOT trustworthy as originally computed: the control
//     group's sign-adjustment used a random coin flip (no real subsequent move to derive a
//     direction from for an "ordinary" touch), while the big-move group used the REAL
//     eventual move direction -- forcing the control group's delta distribution toward zero
//     by construction, regardless of any real underlying signal. This makes the reported
//     "big moves show more delta divergence" claim an artifact, not evidence. Excluded from
//     this promoted version rather than reported as a finding.
//
// RESULT (see RESEARCH_CLAIM big_moves_show_contention_at_levels): real, modest, and
// consistent with the smaller-scale findings already validated this session -- level
// touches associated with a genuine >=400pt move show elevated volume (volRatio p50 ~1.20
// vs ~0.82 control) and range (rangeRatio p50 ~1.15-1.20 vs ~0.90 control) relative to
// ordinary touches at the same levels. N is thin at the move level (22 real moves, 167
// valid touches) -- treat as directionally real, not statistically decisive.

import { query } from '../server/db.js';
import { loadPairProximityThresholds, PROXIMITY } from './backtest_confluence.js';

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

function pct(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

async function main() {
  const barsRes = await query(`
    SELECT ts, high::float, low::float, close::float, open::float,
           COALESCE(volume,0)::int as volume, COALESCE(bid_volume,0)::int as bid_volume, COALESCE(ask_volume,0)::int as ask_volume
    FROM price_bars_primary WHERE symbol='NQ' AND ts >= (SELECT MAX(ts) FROM price_bars_primary WHERE symbol='NQ') - interval '2 years'
    ORDER BY ts
  `);
  const bars = barsRes.rows;

  const REVERSAL = 50, BIG_MOVE_THRESHOLD = 400, GAP_HOURS_CUTOFF = 60;
  const pivots = computeZigZagPivots(bars, REVERSAL);

  const bigMoves = [];
  for (let i = 0; i < pivots.length - 1; i++) {
    const p1 = pivots[i], p2 = pivots[i + 1];
    if (p1.type === p2.type || p1.type === 'UNKNOWN') continue;
    const startPrice = p1.type === 'LOW' ? p1.bar.low : p1.bar.high;
    const endPrice = p2.type === 'HIGH' ? p2.bar.high : p2.bar.low;
    const amplitude = Math.abs(endPrice - startPrice);
    if (amplitude < BIG_MOVE_THRESHOLD) continue;
    const startIndex = bars.findIndex(b => b.ts === p1.bar.ts);
    const endIndex = bars.findIndex(b => b.ts === p2.bar.ts);
    let maxGapHours = 0;
    for (let j = startIndex; j < endIndex; j++) maxGapHours = Math.max(maxGapHours, (bars[j + 1].ts - bars[j].ts) / 3600000);
    bigMoves.push({ start: p1.bar, end: p2.bar, startPrice, endPrice, amplitude, direction: p1.type === 'LOW' ? 'UP' : 'DOWN', startIndex, endIndex, maxGapHours });
  }

  const realMoves = bigMoves.filter(m => m.maxGapHours < GAP_HOURS_CUTOFF);
  console.log(`Total qualifying legs: ${bigMoves.length}, excluded as gap artifacts: ${bigMoves.length - realMoves.length}, real moves: ${realMoves.length}`);

  const levelPricesRes = await query(`SELECT trade_date::text as trade_date, level_name, price::float as price FROM level_prices WHERE price IS NOT NULL`);
  const lpByDate = new Map();
  for (const r of levelPricesRes.rows) {
    const d = r.trade_date.slice(0, 10);
    if (!lpByDate.has(d)) lpByDate.set(d, new Map());
    lpByDate.get(d).set(r.level_name, r.price);
  }
  const pairThresholds = await loadPairProximityThresholds();
  function getNearbyLevels(price, dateStr) {
    const lp = lpByDate.get(dateStr);
    if (!lp) return [];
    const nearby = [];
    for (const [name, levelPrice] of lp) if (Math.abs(price - levelPrice) <= PROXIMITY) nearby.push({ name, dist: Math.abs(price - levelPrice) });
    return nearby;
  }

  let movesWithLevels = 0;
  const bigMoveTouches = [];
  for (const move of realMoves) {
    const startDate = move.start.ts.toISOString().slice(0, 10);
    const endDate = move.end.ts.toISOString().slice(0, 10);
    const startLevels = getNearbyLevels(move.startPrice, startDate);
    const endLevels = getNearbyLevels(move.endPrice, endDate);
    if (startLevels.length) bigMoveTouches.push({ type: 'START', barIndex: move.startIndex, moveDirection: move.direction });
    if (endLevels.length) bigMoveTouches.push({ type: 'END', barIndex: move.endIndex, moveDirection: move.direction });

    const moveBars = bars.slice(move.startIndex, move.endIndex + 1);
    const microPivots = computeZigZagPivots(moveBars, 20);
    let hasPauseTouch = false;
    for (const mp of microPivots) {
      if (mp.bar.ts.getTime() === move.start.ts.getTime() || mp.bar.ts.getTime() === move.end.ts.getTime()) continue;
      const mpDate = mp.bar.ts.toISOString().slice(0, 10);
      const mpPrice = mp.type === 'HIGH' ? mp.bar.high : mp.bar.low;
      const mpLevels = getNearbyLevels(mpPrice, mpDate);
      if (mpLevels.length) {
        const idx = bars.findIndex(b => b.ts === mp.bar.ts);
        bigMoveTouches.push({ type: 'PAUSE', barIndex: idx, moveDirection: move.direction });
        hasPauseTouch = true;
      }
    }
    if (startLevels.length || endLevels.length || hasPauseTouch) movesWithLevels++;
  }
  console.log(`Level hit rate: ${movesWithLevels}/${realMoves.length} (${(movesWithLevels / realMoves.length * 100).toFixed(1)}%), total touches: ${bigMoveTouches.length}`);

  function computeFeatures(touch) {
    if (touch.barIndex < 20) return null;
    const priorBars = bars.slice(touch.barIndex - 20, touch.barIndex);
    for (let j = 0; j < priorBars.length - 1; j++) if ((priorBars[j + 1].ts - priorBars[j].ts) / 3600000 > GAP_HOURS_CUTOFF) return null;
    const meanVol = priorBars.reduce((a, b) => a + b.volume, 0) / 20;
    const meanRange = priorBars.reduce((a, b) => a + (b.high - b.low), 0) / 20;
    if (meanVol === 0 || meanRange === 0) return null;
    const entryBar = bars[touch.barIndex];
    return { volRatio: entryBar.volume / meanVol, rangeRatio: (entryBar.high - entryBar.low) / meanRange };
  }

  const bigMoveFeatures = bigMoveTouches.map(computeFeatures).filter(Boolean);

  // Control group: ordinary touches at the same level universe, sampled broadly, excluding
  // anything inside a big-move's own bar range.
  const inBigMove = new Array(bars.length).fill(false);
  for (const m of realMoves) for (let i = m.startIndex; i <= m.endIndex; i++) inBigMove[i] = true;
  const validLevels = new Set(bigMoveTouches.length ? [...lpByDate.values()].flatMap(m => [...m.keys()]) : []);
  const controlFeatures = [];
  for (let i = 20; i < bars.length; i += 10) {
    if (inBigMove[i]) continue;
    const bar = bars[i];
    const barDate = bar.ts.toISOString().slice(0, 10);
    const lp = lpByDate.get(barDate);
    if (!lp) continue;
    let touched = false;
    for (const [name, levelPrice] of lp) {
      if (validLevels.has(name) && (Math.abs(bar.high - levelPrice) <= PROXIMITY || Math.abs(bar.low - levelPrice) <= PROXIMITY)) { touched = true; break; }
    }
    if (touched) {
      const feats = computeFeatures({ barIndex: i });
      if (feats) controlFeatures.push(feats);
    }
  }

  const bmVol = bigMoveFeatures.map(f => f.volRatio), ctVol = controlFeatures.map(f => f.volRatio);
  const bmRng = bigMoveFeatures.map(f => f.rangeRatio), ctRng = controlFeatures.map(f => f.rangeRatio);
  console.log(`\nBig-move touches N=${bigMoveFeatures.length}, control N=${controlFeatures.length}`);
  console.log(`volRatio   big-move: p25=${pct(bmVol,0.25).toFixed(2)} p50=${pct(bmVol,0.5).toFixed(2)} p75=${pct(bmVol,0.75).toFixed(2)}  |  control: p25=${pct(ctVol,0.25).toFixed(2)} p50=${pct(ctVol,0.5).toFixed(2)} p75=${pct(ctVol,0.75).toFixed(2)}`);
  console.log(`rangeRatio big-move: p25=${pct(bmRng,0.25).toFixed(2)} p50=${pct(bmRng,0.5).toFixed(2)} p75=${pct(bmRng,0.75).toFixed(2)}  |  control: p25=${pct(ctRng,0.25).toFixed(2)} p50=${pct(ctRng,0.5).toFixed(2)} p75=${pct(ctRng,0.75).toFixed(2)}`);

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
