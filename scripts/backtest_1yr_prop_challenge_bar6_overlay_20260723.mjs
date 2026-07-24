// Answers the user's direct question (2026-07-23): "where is our walkthrough with these new
// findings" -- applies the confirmed bar-6 findings (frozen targetDistFraction<0.873 exit rule
// from recovering_exit_predictor_target_distance_confirmatory_pass) as a SIMULATED OVERLAY on top
// of the flagship 1-year Globex-inclusive prop-challenge walkthrough
// (backtest_1yr_globex_inclusive_prop_challenge_20260720.mjs)'s own CURRENT_VALIDATED_ROSTER
// scenario, Globex included, DLL=$400 -- the headline row that script calls out.
//
// CORRECTED 2026-07-23 same day: the first version of this script used a static "is setup_type in
// currentRoster" SQL filter, which OMITTED the flagship script's walk-forward DAY_TYPE_CONDITIONAL
// eligibility gate (IB_BULLISH/IB_BEARISH only count as roster-eligible on days where their
// per-day-type rolling bucket clears N>=20/EV>=-$5 AS OF THAT DAY, computed via getRthHistoryForDate
// -- not a static "in the final roster" check). That bug inflated the RTH trade population from the
// real 48 (DLL=$400, Globex included) to 187 and flipped the reported baseline from the flagship's
// own verified -$28.50/48-trade RTH leg to a fabricated -$1,457.75/187-trade number -- caught only
// because the user asked "how are we net negative $1k" and the number didn't match the flagship
// script's own last real output. Root cause: re-deriving eligibility logic instead of reusing the
// exact walk-forward mechanism (the same "reimplement instead of import" bug class CLAUDE.md's hard
// rules warn about). Fixed by porting the EXACT day-loop/eligibility logic from the flagship script
// verbatim (both legs, DLL sharing, walk-forward gate) -- verified below to reproduce the flagship's
// own known baseline numbers exactly before trusting the overlay result built on top of it.
//
// This is a BACKTEST OVERLAY, not a live-wiring decision -- the exit rule is still explicitly gated
// behind OPEN_DECISION validate_target_distance_predictor_on_live_data, waiting on real forward data
// (only 2 real bar6_checkpoint touches exist as of 2026-07-23).

import { query } from '../server/db.js';
import { resolve } from '../scripts/backtest_unified.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import fs from 'fs';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const FROZEN_CUTOFF = 0.873; // recovering_exit_predictor_target_distance_confirmatory_pass
const DLL = 400;

const EXCLUDED = new Set(['OR_HIGH', 'OR_LOW', 'IB_HIGH', 'IB_LOW', 'IB_MID_SCALP', 'IB_MID', 'OR_MID',
  'OR_MID_AFTER_IB', 'ONH', 'ONL', '3M_VAH', '3M_VAL', '3M_POC', 'RTH_VWAP', 'WEEKLY_VWAP', 'MONTHLY_VWAP',
  'DAILY_OPEN', 'WEEKLY_OPEN', 'MONTHLY_OPEN']);
const RTH_START = 570, RTH_END = 960;
const DAY_TYPE_CONDITIONAL = new Set(['IB_BULLISH', 'IB_BEARISH']);

async function main() {
  const maxDateRow = await query(`SELECT MAX(trade_date)::text as max_date FROM active_setups`);
  const maxDate = maxDateRow.rows[0].max_date;

  const daysQ = await query(`
    SELECT DISTINCT s.trade_date::text as trade_date, dl.day_type
    FROM active_setups s
    LEFT JOIN acd_daily_log dl ON dl.trade_date = s.trade_date
    WHERE s.trade_date >= $1::date - interval '365 days' AND s.trade_date <= $1::date
    ORDER BY trade_date ASC
  `, [maxDate]);
  const tradingDays = daysQ.rows;
  const startDateStr = tradingDays[0].trade_date;
  console.log(`Window: ${startDateStr} to ${maxDate} (${tradingDays.length} days)`);

  console.log('Loading CURRENT_VALIDATED_ROSTER...');
  const rosterQ = await query(`
    SELECT DISTINCT ON (signal_name) signal_name as setup_type, recommendation
    FROM performance_audit WHERE signal_type = 'SETUP_STATUS'
    ORDER BY signal_name, run_date DESC
  `);
  const currentRoster = new Set();
  for (const r of rosterQ.rows) {
    if (r.recommendation !== 'SUPPRESS' && r.recommendation !== 'THIN_N') currentRoster.add(r.setup_type);
  }

  console.log('Loading ALL RTH trades (full history, for walk-forward eligibility) with bar-level fields...');
  const rthTradesQ = await query(`
    SELECT s.trade_date::text as trade_date, fired_at, setup_type, actual_pnl::float as actual_pnl,
           size_multiplier::float as size_multiplier, resolution, dl.day_type,
           entry_zone_low::float, entry_zone_high::float, stop_level::float, t1_level::float,
           mae_points::float as mae_points, mfe_points::float as mfe_points
    FROM active_setups s
    LEFT JOIN acd_daily_log dl ON s.trade_date = dl.trade_date
    WHERE actual_pnl IS NOT NULL AND resolution IN ('TARGET_HIT', 'STOP_HIT', 'TIME_EXPIRED')
      AND (mae_points IS NULL OR mae_points <= 300) AND (mfe_points IS NULL OR mfe_points <= 300)
    ORDER BY trade_date ASC, fired_at ASC
  `);
  const allRthTrades = rthTradesQ.rows;

  const rthTradesByDate = {};
  for (const t of allRthTrades) {
    if (!rthTradesByDate[t.trade_date]) rthTradesByDate[t.trade_date] = [];
    rthTradesByDate[t.trade_date].push(t);
  }
  const rthHistoryByDate = {};
  let currentRthHistory = [];
  const uniqueRthDates = [...new Set(allRthTrades.map(t => t.trade_date))].sort();
  for (const d of uniqueRthDates) {
    rthHistoryByDate[d] = [...currentRthHistory];
    currentRthHistory.push(...rthTradesByDate[d]);
  }
  const getRthHistoryForDate = (date) => {
    let latestBefore = null;
    for (const d of uniqueRthDates) { if (d < date) latestBefore = d; else break; }
    if (!latestBefore) return [];
    return rthHistoryByDate[latestBefore].concat(rthTradesByDate[latestBefore] || []);
  };

  // --- Globex leg: identical simulation to the flagship script (flat stops, per fresh-holdout resolution) ---
  console.log('Loading level and bar data for Globex simulation...');
  const lvlRes = await query(`
    SELECT trade_date::text as d, level_name, price::float as price FROM level_prices
    WHERE trade_date >= $1::date - interval '365 days' AND trade_date <= $1::date
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
    FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date - interval '367 days'
    ORDER BY ts ASC
  `, [maxDate]);
  const allBars = barsRes.rows.map(b => ({ ...b, ts: new Date(b.ts).getTime() }));
  const barsByDate = new Map();
  for (const b of allBars) {
    if (!barsByDate.has(b.d)) barsByDate.set(b.d, []);
    barsByDate.get(b.d).push(b);
  }

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
    dayInfo.push({ d, startIdx, rthEndIdx, wideStartIdx });
  }

  console.log('Simulating overnight trades...');
  const allGlobexTrades = [];
  for (const x of dayInfo) {
    const lv = levelsByDate.get(x.d);
    if (!lv) continue;
    const isMonday = new Date(x.d + 'T12:00:00').getDay() === 1;
    const defaultStop = isMonday ? 60 : 90, defaultTarget = isMonday ? 30 : 40;
    for (const name of levelNames) {
      const lvl = lv[name];
      if (lvl == null) continue;
      for (let i = x.wideStartIdx + 1; i < x.startIdx; i++) {
        const b = allBars[i], prev = allBars[i - 1];
        if (Math.abs(b.close - lvl) > 15) continue;
        const dir = prev.close > lvl ? 'SHORT' : 'LONG';
        const long = dir === 'LONG';
        const entry = b.close;
        const stopPrice = long ? entry - defaultStop : entry + defaultStop;
        const targetPrice = long ? entry + defaultTarget : entry - defaultTarget;
        const r = resolve(allBars, i, dir, entry, stopPrice, targetPrice, x.rthEndIdx - i);
        const pnl = r.result === 'TARGET_HIT' ? defaultTarget * PNL_PER_POINT - COMMISSION
          : r.result === 'STOP_HIT' ? -(defaultStop * PNL_PER_POINT + COMMISSION) : r.pnl;
        allGlobexTrades.push({ trade_date: x.d, fired_at: new Date(b.ts), setup_type: `${name}_${dir}`, actual_pnl: pnl, gatedPnl: pnl, is_globex: true });
        break;
      }
    }
  }
  const globexTradesByDate = {};
  for (const t of allGlobexTrades) {
    if (!globexTradesByDate[t.trade_date]) globexTradesByDate[t.trade_date] = [];
    globexTradesByDate[t.trade_date].push(t);
  }
  const globexHistoryByDate = {};
  let currentGlobexHistory = [];
  const uniqueGlobexDates = [...new Set(allGlobexTrades.map(t => t.trade_date))].sort();
  for (const d of uniqueGlobexDates) {
    globexHistoryByDate[d] = [...currentGlobexHistory];
    currentGlobexHistory.push(...globexTradesByDate[d]);
  }
  const getGlobexHistoryForDate = (date) => {
    let latestBefore = null;
    for (const d of uniqueGlobexDates) { if (d < date) latestBefore = d; else break; }
    if (!latestBefore) return [];
    return globexHistoryByDate[latestBefore].concat(globexTradesByDate[latestBefore] || []);
  };

  // --- Bar-6 rule: recompute gatedPnl for every RTH trade in the window (used only in the overlay run) ---
  console.log('Recomputing bar-6 exit rule for RTH trades in window...');
  let recomputed = 0;
  for (const t of allRthTrades) {
    t.gatedPnl = t.actual_pnl;
    if (t.trade_date < startDateStr) continue; // only need this for the reporting window
    if (t.entry_zone_low == null || t.stop_level == null || t.t1_level == null) continue;
    const direction = directionFromType(t.setup_type);
    if (!direction) continue;
    const dayBars = barsByDate.get(t.trade_date);
    if (!dayBars || dayBars.length < 25) continue;
    const firedAtMs = new Date(t.fired_at).getTime();
    let entryIdx = -1;
    for (let i = dayBars.length - 1; i >= 0; i--) { if (dayBars[i].ts <= firedAtMs) { entryIdx = i; break; } }
    if (entryIdx < 0) continue;
    const forwardBars = dayBars.slice(entryIdx);
    let resolutionBarIdx = -1;
    for (let i = 0; i < forwardBars.length; i++) {
      const bar = forwardBars[i];
      const stopHit = direction === 'LONG' ? bar.low <= t.stop_level : bar.high >= t.stop_level;
      const targetHit = direction === 'LONG' ? bar.high >= t.t1_level : bar.low <= t.t1_level;
      if (stopHit || targetHit) { resolutionBarIdx = i; break; }
    }
    if (resolutionBarIdx === -1) resolutionBarIdx = forwardBars.length - 1;
    if (resolutionBarIdx < 6 || forwardBars.length < 7) continue;
    const b0_6 = forwardBars.slice(0, 7);
    let worstPrice = direction === 'LONG' ? b0_6[0].low : b0_6[0].high;
    let worstBarIdx = 0;
    for (let i = 0; i <= 6; i++) {
      if (direction === 'LONG' && b0_6[i].low < worstPrice) { worstPrice = b0_6[i].low; worstBarIdx = i; }
      if (direction === 'SHORT' && b0_6[i].high > worstPrice) { worstPrice = b0_6[i].high; worstBarIdx = i; }
    }
    if (worstBarIdx > 2) continue; // DETERIORATING -- rule doesn't apply
    const hi = t.entry_zone_high != null ? t.entry_zone_high : t.entry_zone_low;
    const entry = (t.entry_zone_low + hi) / 2;
    const bar6Close = b0_6[6].close;
    const pointsAtBar6 = direction === 'LONG' ? (bar6Close - entry) : (entry - bar6Close);
    const pnlAtBar6 = pointsAtBar6 * PNL_PER_POINT - COMMISSION;
    const distToTarget = direction === 'LONG' ? (t.t1_level - bar6Close) : (bar6Close - t.t1_level);
    const distEntryToTarget = direction === 'LONG' ? (t.t1_level - entry) : (entry - t.t1_level);
    const targetDistFraction = distEntryToTarget !== 0 ? (distToTarget / distEntryToTarget) : 0;
    if (targetDistFraction < FROZEN_CUTOFF) { t.gatedPnl = pnlAtBar6; recomputed++; }
  }
  console.log(`Bar-6 rule changed the outcome of ${recomputed} RTH trades in the window.`);

  const combinedTradesByDate = {};
  for (const dRow of tradingDays) {
    const d = dRow.trade_date;
    const rth = (rthTradesByDate[d] || []).filter(t => t.trade_date >= startDateStr);
    const globex = globexTradesByDate[d] || [];
    const combined = [...rth, ...globex];
    combined.sort((a, b) => new Date(a.fired_at).getTime() - new Date(b.fired_at).getTime());
    combinedTradesByDate[d] = combined;
  }

  // --- Day-loop simulation, run twice (baseline actual_pnl vs overlay gatedPnl), IDENTICAL eligibility logic ---
  function simulate(pnlField) {
    const stats = { totalPnl: 0, rthPnl: 0, globexPnl: 0, totalTrades: 0, rthTrades: 0, globexTrades: 0,
      lockoutDays: 0, maxDrawdown: 0, peakPnl: 0, wins: 0 };

    for (const dRow of tradingDays) {
      const todayStr = dRow.trade_date;
      const todayType = dRow.day_type;
      const rthHist = getRthHistoryForDate(todayStr);
      const globexHist = getGlobexHistoryForDate(todayStr);

      const rthStats = {}, rthDtStats = {};
      for (const t of rthHist) {
        if (!rthStats[t.setup_type]) rthStats[t.setup_type] = { n: 0, pnl: 0 };
        rthStats[t.setup_type].n++;
        rthStats[t.setup_type].pnl += t.actual_pnl;
        if (DAY_TYPE_CONDITIONAL.has(t.setup_type)) {
          if (!rthDtStats[t.setup_type]) rthDtStats[t.setup_type] = {};
          if (!rthDtStats[t.setup_type][t.day_type]) rthDtStats[t.setup_type][t.day_type] = { n: 0, pnl: 0 };
          rthDtStats[t.setup_type][t.day_type].n++;
          rthDtStats[t.setup_type][t.day_type].pnl += t.actual_pnl;
        }
      }
      const legacyEligibleSetups = new Set();
      for (const setup in rthStats) {
        if (DAY_TYPE_CONDITIONAL.has(setup)) {
          const buckets = rthDtStats[setup] || {};
          const validBuckets = Object.values(buckets).filter(b => b.n >= 20);
          const anyGoodBucket = validBuckets.some(b => (b.pnl / b.n) >= -5);
          if (validBuckets.length > 0 && !anyGoodBucket) continue;
          const tBucket = buckets[todayType];
          if (tBucket && tBucket.n >= 20 && (tBucket.pnl / tBucket.n) >= -5) legacyEligibleSetups.add(setup);
        } else {
          const n = rthStats[setup].n;
          const ev = rthStats[setup].pnl / n;
          if (n >= 20 && ev >= -5) legacyEligibleSetups.add(setup);
        }
      }
      const rosterEligibleSetups = new Set();
      for (const setup of currentRoster) {
        if (DAY_TYPE_CONDITIONAL.has(setup)) {
          if (legacyEligibleSetups.has(setup)) rosterEligibleSetups.add(setup);
        } else {
          rosterEligibleSetups.add(setup);
        }
      }

      const globexStats = {};
      for (const t of globexHist) {
        if (!globexStats[t.setup_type]) globexStats[t.setup_type] = { n: 0, pnl: 0 };
        globexStats[t.setup_type].n++;
        globexStats[t.setup_type].pnl += t.actual_pnl;
      }
      const globexEligibleSetups = new Set();
      for (const setup in globexStats) {
        const n = globexStats[setup].n;
        const ev = globexStats[setup].pnl / n;
        if (n >= 20 && ev >= -5) globexEligibleSetups.add(setup);
      }

      const todaysTrades = combinedTradesByDate[todayStr] || [];
      let dayPnl = 0, isLocked = false;
      for (const t of todaysTrades) {
        if (isLocked) continue;
        let eligible = false;
        if (t.is_globex) { if (globexEligibleSetups.has(t.setup_type)) eligible = true; }
        else { if (rosterEligibleSetups.has(t.setup_type)) eligible = true; }
        if (!eligible) continue;

        const sizedPnl = t[pnlField] * (t.is_globex ? 1.0 : (t.size_multiplier || 1.0));
        dayPnl += sizedPnl;
        stats.totalPnl += sizedPnl;
        stats.totalTrades++;
        if (sizedPnl > 0) stats.wins++;
        if (t.is_globex) { stats.globexPnl += sizedPnl; stats.globexTrades++; }
        else { stats.rthPnl += sizedPnl; stats.rthTrades++; }
        if (stats.totalPnl > stats.peakPnl) stats.peakPnl = stats.totalPnl;
        const dd = stats.peakPnl - stats.totalPnl;
        if (dd > stats.maxDrawdown) stats.maxDrawdown = dd;
        if (dayPnl <= -DLL) { isLocked = true; stats.lockoutDays++; }
      }
    }
    return stats;
  }

  const baseline = simulate('actual_pnl');
  const overlay = simulate('gatedPnl');

  let report = `# 1-Year Prop Challenge -- Bar-6 Exit Rule Overlay (CORRECTED)\n`;
  report += `**Window:** ${startDateStr} to ${maxDate} (${tradingDays.length} trading days) | CURRENT_VALIDATED_ROSTER | Globex Included | DLL=$${DLL} | walk-forward eligibility identical to flagship script\n\n`;
  report += `Sanity check -- baseline should reproduce the flagship script's own known numbers (RTH P&L=-$28.50/48 trades, Globex P&L=$4495/1271 trades, Total=$4466.50/1319 trades):\n`;
  report += `- Baseline: Total=$${baseline.totalPnl.toFixed(2)}, RTH=$${baseline.rthPnl.toFixed(2)}/${baseline.rthTrades}, Globex=$${baseline.globexPnl.toFixed(2)}/${baseline.globexTrades}, Trades=${baseline.totalTrades}\n\n`;
  report += `Bar-6 rule changed the outcome of **${recomputed}** RTH trades in the reporting window.\n\n`;
  report += `| Run | Total P&L | Trades | Win Rate | Max Drawdown | Lockout Days |\n|---|---|---|---|---|---|\n`;
  report += `| Baseline (actual outcomes) | $${baseline.totalPnl.toFixed(2)} | ${baseline.totalTrades} | ${(baseline.wins / baseline.totalTrades * 100).toFixed(1)}% | $${baseline.maxDrawdown.toFixed(2)} | ${baseline.lockoutDays} |\n`;
  report += `| + Bar-6 exit rule overlay | $${overlay.totalPnl.toFixed(2)} | ${overlay.totalTrades} | ${(overlay.wins / overlay.totalTrades * 100).toFixed(1)}% | $${overlay.maxDrawdown.toFixed(2)} | ${overlay.lockoutDays} |\n`;
  report += `\n**Net effect: $${(overlay.totalPnl - baseline.totalPnl).toFixed(2)} over the window` + (recomputed > 0 ? ` ($${((overlay.totalPnl - baseline.totalPnl) / recomputed).toFixed(2)}/affected trade).` : '.') + `**\n`;

  fs.writeFileSync('scratch/bar6_overlay_prop_challenge_RESULTS.md', report);
  console.log(report);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
