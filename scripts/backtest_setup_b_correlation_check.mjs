// Roadmap Phase 4, Setup B — correlation check vs Setup A (VALUE_FADE), per Phase 4's own
// checkpoint ("B in shadow, accumulating, correlation with A measured").
//
// Setup B was only wired live tonight (2026-08-11) -- it has ZERO real active_setups
// history yet, so a true LIVE daily-P&L correlation (the eventual Stage 3 job) cannot be
// computed. This is a PROXY: both arms are detected the same way Setup B's own Stage 1
// backtest was built (detectStopSweep()/detectLevelFades() from backtest_unified.js,
// reused not reimplemented, resolve() for every EV evaluation), over the SAME level subset
// and the SAME date range, so the comparison is apples-to-apples even though it isn't yet
// real live co-occurrence. Setup A here uses only the subset of VALUE_FADE levels Setup B
// itself tests (PD_POC/PD_VAH/PD_VAL/FLOOR_PIVOT/FLOOR_R1/FLOOR_S1/OR_HIGH/OR_LOW) -- NOT
// the full ~110-type roster -- stated plainly so this isn't mistaken for a full VALUE_FADE
// correlation. Setup A's stop/target uses the already-recorded VALUE_FADE bet_class Phase 2
// flat-default winner (39pt/43pt, RESEARCH_CLAIM value_fade_bet_class_phase2_stage1_backtest,
// SHIP_FLAT verdict) rather than inventing a new number.
//
// Run: node scripts/backtest_setup_b_correlation_check.mjs

import { resolve, loadData, detectStopSweep, detectLevelFades, floorPivots } from './backtest_unified.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { recordClaim } from './record_claim.mjs';
import { query } from '../server/db.js';

const DEFAULT_DPP = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const WALK_MAX_BARS = 240;
const B_STOP = 68, B_TARGET = 250; // Setup B Stage 1 winner
const A_STOP = 39, A_TARGET = 43;  // VALUE_FADE bet_class Phase 2 flat-default winner

function pnl(entry, exitPrice, long) {
  const signedPoints = long ? (exitPrice - entry) : (entry - exitPrice);
  return signedPoints * DEFAULT_DPP - COMMISSION;
}

function evalFires(fires, bars, stop, target) {
  let sum = 0;
  for (const f of fires) {
    const isLong = f.direction === 'LONG';
    const stopPrice = isLong ? f.entry - stop : f.entry + stop;
    const targetPrice = isLong ? f.entry + target : f.entry - target;
    const res = resolve(bars, f.entryIdx, f.direction, f.entry, stopPrice, targetPrice, WALK_MAX_BARS);
    const p = res.result === 'EXPIRED' ? pnl(f.entry, bars[Math.min(bars.length - 1, f.entryIdx + WALK_MAX_BARS)].close, isLong) : res.pnl;
    sum += p;
  }
  return sum;
}

function pearsonCorrelation(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom > 0 ? num / denom : null;
}

async function main() {
  console.log('[setup_b_correlation] Loading bar/level data...');
  const { barsByDate, acdByDate, dvlByDate, dates } = await loadData();
  const lpRes = await query(`SELECT trade_date::text as d, level_name, price::float FROM level_prices`);
  const levelPricesByDate = new Map();
  for (const r of lpRes.rows) {
    if (!levelPricesByDate.has(r.d)) levelPricesByDate.set(r.d, {});
    levelPricesByDate.get(r.d)[r.level_name] = r.price;
  }

  const dailyB = new Map(); // date -> pnl
  const dailyA = new Map();

  for (let di = 5; di < dates.length; di++) {
    const date = dates[di];
    const bars = barsByDate.get(date);
    const acd = acdByDate.get(date);
    if (!bars || !acd || !bars.length) continue;

    const prevDate = dates[di - 1];
    const prevDvl = dvlByDate.get(prevDate);
    const pdVAH = prevDvl?.vah ?? null, pdVAL = prevDvl?.val ?? null, pdPOC = prevDvl?.poc ?? null;
    const orH = acd.or_high, orL = acd.or_low;
    if (!orH || !orL) continue;
    let fpLevels = {};
    if (prevDvl?.session_high && prevDvl?.session_low && prevDvl?.session_close) {
      fpLevels = floorPivots(prevDvl.session_high, prevDvl.session_low, prevDvl.session_close);
    }
    const lp = levelPricesByDate.get(date) || {};
    const sharedLevels = {
      PD_POC: lp.PD_POC ?? pdPOC, PD_VAH: lp.PD_VAH ?? pdVAH, PD_VAL: lp.PD_VAL ?? pdVAL,
      FLOOR_PIVOT: lp.FLOOR_PIVOT ?? fpLevels.FLOOR_PIVOT ?? null,
      FLOOR_R1: lp.FLOOR_R1 ?? fpLevels.FLOOR_R1 ?? null,
      FLOOR_S1: lp.FLOOR_S1 ?? fpLevels.FLOOR_S1 ?? null,
      OR_HIGH: orH, OR_LOW: orL,
    };

    const isMonday = new Date(date + 'T12:00:00').getDay() === 1;
    const bFires = detectStopSweep(bars, sharedLevels);
    const aFires = detectLevelFades(bars, sharedLevels, isMonday);

    if (bFires.length) dailyB.set(date, (dailyB.get(date) || 0) + evalFires(bFires, bars, B_STOP, B_TARGET));
    if (aFires.length) dailyA.set(date, (dailyA.get(date) || 0) + evalFires(aFires, bars, A_STOP, A_TARGET));
  }

  const overlapDates = [...dates].filter(d => dailyA.has(d) || dailyB.has(d));
  const xs = overlapDates.map(d => dailyA.get(d) || 0);
  const ys = overlapDates.map(d => dailyB.get(d) || 0);
  const correlation = pearsonCorrelation(xs, ys);
  const bothFireDays = overlapDates.filter(d => dailyA.has(d) && dailyB.has(d)).length;

  console.log(`Setup A (VALUE_FADE, shared-level subset) fired on ${dailyA.size} days. Setup B fired on ${dailyB.size} days. Both fired same day: ${bothFireDays} days.`);
  console.log(`Pearson correlation of daily P&L (zero-filled on non-firing days), N=${overlapDates.length} days: r=${correlation?.toFixed(3)}`);

  await recordClaim({
    slug: 'setup_b_vs_setup_a_correlation_proxy',
    claimText: `Proxy correlation check (Phase 4 checkpoint "correlation with A measured") between Setup B (Failed Sweep Reversal, stop=${B_STOP}/target=${B_TARGET}) and a shared-level subset of Setup A (VALUE_FADE, stop=${A_STOP}/target=${A_TARGET}, the bet_class Phase 2 flat-default winner) -- both detected via the same real detectStopSweep()/detectLevelFades() functions (backtest_unified.js) over the SAME 8-level subset (PD_POC/PD_VAH/PD_VAL/FLOOR_PIVOT/FLOOR_R1/FLOOR_S1/OR_HIGH/OR_LOW) and the same date range. NOT the full ~110-type VALUE_FADE roster -- a representative subset limited to the levels Setup B itself tests. Setup A fired on ${dailyA.size} days, Setup B on ${dailyB.size} days (both fired the same day on ${bothFireDays} days). Pearson correlation of daily P&L, N=${overlapDates.length} days: r=${correlation?.toFixed(3)}. Read against the roadmap's own <0.6 threshold: ${correlation != null && Math.abs(correlation) < 0.6 ? 'well under the 0.6 correlation ceiling -- consistent with genuine diversification, not a restatement of the same bet' : 'at or above the 0.6 correlation ceiling -- worth a closer look before treating B as diversifying'}. This is explicitly a PROXY (both arms bar-history-derived, not real live co-occurrence) pending Setup B accumulating real active_setups history -- the genuine live-data correlation is Stage 3's job (roadmap Part 5), not this check's. Re-run once Setup B has real SHADOW fires to compare against Setup A's real (origin_status-filtered) daily P&L directly.`,
    sourceFile: 'scripts/backtest_setup_b_correlation_check.mjs',
    sourceDate: '2026-08-11',
    sampleSize: overlapDates.length,
    evPerTrade: correlation,
    rigorStatus: `proxy_correlation_r${correlation?.toFixed(3)}_bothfire${bothFireDays}days`,
    status: 'PROVISIONAL',
  });
  console.log('RESEARCH_CLAIM setup_b_vs_setup_a_correlation_proxy recorded.');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
