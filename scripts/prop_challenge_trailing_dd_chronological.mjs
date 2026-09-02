/**
 * Chronological (single-path, no resampling) walk of the SAME CURRENT_VALIDATED_ROSTER +
 * Globex-included trade population as scripts/backtest_1yr_globex_inclusive_prop_challenge_
 * 20260720.mjs, answering two follow-up questions that script's own aggregate table can't:
 *
 *   1. "How long did it take to get to those profits?" -- the flagship script only reports
 *      END-OF-WINDOW totals per DLL tier, no day-by-day trajectory. This walks the exact same
 *      real trade sequence in true chronological order (not Monte Carlo resampled) and prints
 *      the running equity curve plus the trading-day/trade-count it took to first cross $3,000
 *      and to reach the final balance.
 *   2. "No DLL, but a trailing EOD drawdown until $3k profit" -- replaces the flagship script's
 *      per-day loss-limit-with-lockout (which resets every day) with a genuine account-level
 *      trailing drawdown, tracked from the account's own peak balance, that stops trailing
 *      (freezes) once open profit reaches $3,000 -- matching server/services/monteCarloService.js's
 *      own established default (`trailingDrawdown: 1500, drawdownFreezeProfit: 3000`, already
 *      used by scripts/prop_test_2k_no_dll.mjs), not a new invented convention. Unlike a DLL,
 *      this can permanently END the account (blown) if the running balance ever drops
 *      trailingDrawdown dollars below its own peak, at any point in the whole year, not just
 *      within a single day.
 *
 * Deliberately reuses the SAME sizing convention as the flagship script (t.actual_pnl *
 * size_multiplier -- a fixed, already-recorded per-trade dollar value, no separate contracts-
 * based position sizing) rather than switching to monteCarloService.js's dynamic-risk-%
 * engine, so this is a genuine apples-to-apples comparison against "those profits" and not a
 * different simulation with different assumptions layered in.
 *
 * Trade-loading/eligibility logic (CURRENT_VALIDATED_ROSTER rolling N>=20/EV>=-$5 gate, Globex
 * touch-simulation with flat 90/40 (60/30 Monday) stops) intentionally mirrors the flagship
 * script's own logic line-for-line rather than reimplementing a different population --
 * see that script's header for the full provenance of each piece (fresh-holdout resolution
 * for the flat Globex stops, EXCLUDED level set, etc).
 *
 * ALSO APPLIES TODAY'S TWO LIVE CHANGES retroactively, using already-computed re-simulation
 * data rather than waiting for enough new real trades to accumulate (both shipped only hours
 * before this script was written, so barely any real trades reflect them yet):
 *   - Sibling-reversal gate (isPostWinOppositeFamilyBlocked): reuses
 *     computeFlaggedReversalIds() (exported from backtest_post_win_opposite_family_reversal.mjs,
 *     the exact real identification logic, not reimplemented) to find every historical real
 *     trade that WOULD have been forced to SHADOW under this gate -- those trades are excluded
 *     from the account balance here (they still existed and resolved, they just wouldn't have
 *     been real capital), while still contributing to the rolling eligibility stats the same
 *     way a real SHADOW trade always does in this codebase's convention.
 *   - IB_HIGH/IB_LOW/PD_IB_HIGH/PD_IB_LOW invalidation-boundary fix: reads the persisted
 *     changed_trades list from performance_audit (signal_type='IB_INVALIDATION_BOUNDARY_FIX',
 *     the walk-forward re-simulation already run and DeepSeek-reviewed for that fix) and
 *     substitutes each affected trade's CORRECTED pnl in place of the stored (pre-fix)
 *     actual_pnl, rather than re-deriving the re-simulation by hand.
 *
 * Run: node scripts/prop_challenge_trailing_dd_chronological.mjs
 */

import { query } from '../server/db.js';
import pool from '../server/db.js';
import { resolve } from '../scripts/backtest_unified.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeFlaggedReversalIds } from './backtest_post_win_opposite_family_reversal.mjs';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;

// Matches monteCarloService.js's own default account config -- not a new invented figure.
const TRAILING_DRAWDOWN = 1500;
const DRAWDOWN_FREEZE_PROFIT = 3000;
const STARTING_BALANCE = 0; // report in pure P&L terms, matching the flagship script's own framing

const EXCLUDED = new Set(['OR5_HIGH', 'OR5_LOW', 'IB_HIGH', 'IB_LOW', 'IB_MID_SCALP', 'IB_MID', 'OR5_MID',
  'ONH', 'ONL', '3M_VAH', '3M_VAL', '3M_POC', 'RTH_VWAP', 'WEEKLY_VWAP', 'MONTHLY_VWAP',
  'DAILY_OPEN', 'WEEKLY_OPEN', 'MONTHLY_OPEN']);
const RTH_START = 570, RTH_END = 960;
const DAY_TYPE_CONDITIONAL = new Set(['IB_BULLISH', 'IB_BEARISH']);

async function run() {
  console.log('Loading trade population (mirrors backtest_1yr_globex_inclusive_prop_challenge_20260720.mjs)...');

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

  const rosterQ = await query(`
    SELECT DISTINCT ON (signal_name) signal_name as setup_type, recommendation
    FROM performance_audit WHERE signal_type = 'SETUP_STATUS'
    ORDER BY signal_name, run_date DESC
  `);
  const currentRoster = new Set();
  for (const r of rosterQ.rows) {
    if (r.recommendation !== 'SUPPRESS' && r.recommendation !== 'THIN_N') currentRoster.add(r.setup_type);
  }

  const rthTradesQ = await query(`
    SELECT s.id, s.trade_date::text as trade_date, s.setup_type, s.actual_pnl::float as actual_pnl,
           s.size_multiplier::float as size_multiplier, s.fired_at, dl.day_type
    FROM active_setups s
    LEFT JOIN acd_daily_log dl ON s.trade_date = dl.trade_date
    WHERE s.actual_pnl IS NOT NULL AND s.resolution IN ('TARGET_HIT', 'STOP_HIT', 'TIME_EXPIRED')
      AND (s.mae_points IS NULL OR s.mae_points <= 300) AND (s.mfe_points IS NULL OR s.mfe_points <= 300)
    ORDER BY s.trade_date ASC, s.fired_at ASC
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
    dayInfo.push({ d, startIdx, rthEndIdx, wideStartIdx: Math.max(lo, 1) });
  }

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
        allGlobexTrades.push({ trade_date: x.d, fired_at: new Date(b.ts), setup_type: `${name}_${dir}`, actual_pnl: pnl, is_globex: true });
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

  console.log(`RTH trades: ${allRthTrades.length}, Globex trades: ${allGlobexTrades.length}`);

  // ── Apply today's 2 live changes retroactively ──
  console.log('Loading sibling-reversal gate + IB invalidation-boundary fix data...');
  const { rows: allDecisiveTrades } = await query(`
    SELECT id, trade_date::text as trade_date, setup_type, fired_at::text as fired_at,
           resolved_at::text as resolved_at, resolution, actual_pnl::float as actual_pnl,
           origin_status
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
      AND resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED','TRAIL_EXIT')
      AND actual_pnl IS NOT NULL AND fired_at IS NOT NULL
    ORDER BY fired_at
  `);
  const siblingReversalFlaggedIds = computeFlaggedReversalIds(allDecisiveTrades);
  console.log(`  Sibling-reversal gate: ${siblingReversalFlaggedIds.size} historical real trades would have been forced to SHADOW`);

  const ibFixRow = await query(`
    SELECT notes::jsonb->'changed_trades' as ct FROM performance_audit
    WHERE signal_type='IB_INVALIDATION_BOUNDARY_FIX' ORDER BY run_date DESC LIMIT 1
  `);
  const ibFixMap = new Map();
  for (const t of (ibFixRow.rows[0]?.ct || [])) ibFixMap.set(t.id, t.new_pnl);
  console.log(`  IB invalidation-boundary fix: ${ibFixMap.size} historical real trades have a corrected pnl`);

  // ── Single chronological pass: CURRENT_VALIDATED_ROSTER, Globex included, no DLL,
  //    account-level trailing drawdown that freezes once profit hits $3,000. ──
  let balance = STARTING_BALANCE, peak = STARTING_BALANCE, ddFloor = STARTING_BALANCE - TRAILING_DRAWDOWN;
  let ddFrozen = false, blown = false, blownAt = null;
  let tradesExec = 0, tradingDaysElapsed = 0;
  let firstCross3k = null; // { date, tradesExec, tradingDaysElapsed }
  const milestones = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 7500];
  const milestonesHit = {};

  for (const dRow of tradingDays) {
    const todayStr = dRow.trade_date;
    const todayType = dRow.day_type;
    tradingDaysElapsed++;
    if (blown) break;

    const rthHist = getRthHistoryForDate(todayStr);
    const globexHist = getGlobexHistoryForDate(todayStr);
    const rthStats = {}, rthDtStats = {};
    for (const t of rthHist) {
      if (!rthStats[t.setup_type]) rthStats[t.setup_type] = { n: 0, pnl: 0 };
      rthStats[t.setup_type].n++; rthStats[t.setup_type].pnl += t.actual_pnl;
      if (DAY_TYPE_CONDITIONAL.has(t.setup_type)) {
        if (!rthDtStats[t.setup_type]) rthDtStats[t.setup_type] = {};
        if (!rthDtStats[t.setup_type][t.day_type]) rthDtStats[t.setup_type][t.day_type] = { n: 0, pnl: 0 };
        rthDtStats[t.setup_type][t.day_type].n++; rthDtStats[t.setup_type][t.day_type].pnl += t.actual_pnl;
      }
    }
    const rosterEligibleSetups = new Set();
    for (const setup of currentRoster) {
      if (DAY_TYPE_CONDITIONAL.has(setup)) {
        const buckets = rthDtStats[setup] || {};
        const tBucket = buckets[todayType];
        if (tBucket && tBucket.n >= 20 && (tBucket.pnl / tBucket.n) >= -5) rosterEligibleSetups.add(setup);
      } else {
        rosterEligibleSetups.add(setup);
      }
    }
    const globexStats = {};
    for (const t of globexHist) {
      if (!globexStats[t.setup_type]) globexStats[t.setup_type] = { n: 0, pnl: 0 };
      globexStats[t.setup_type].n++; globexStats[t.setup_type].pnl += t.actual_pnl;
    }
    const globexEligibleSetups = new Set();
    for (const setup in globexStats) {
      const n = globexStats[setup].n, ev = globexStats[setup].pnl / n;
      if (n >= 20 && ev >= -5) globexEligibleSetups.add(setup);
    }

    const rth = (rthTradesByDate[todayStr] || []).filter(t => t.trade_date >= startDateStr);
    const globex = globexTradesByDate[todayStr] || [];
    const todaysTrades = [...rth, ...globex].sort((a, b) => new Date(a.fired_at).getTime() - new Date(b.fired_at).getTime());

    for (const t of todaysTrades) {
      if (blown) break;
      const eligible = t.is_globex ? globexEligibleSetups.has(t.setup_type) : rosterEligibleSetups.has(t.setup_type);
      if (!eligible) continue;
      // Sibling-reversal gate: this specific real trade would have been forced to SHADOW
      // today, so it wouldn't have contributed to real account balance -- excluded here, but
      // still counted in rthStats/rthHistory above for rolling-eligibility purposes, matching
      // how a real SHADOW trade already counts toward a setup_type's forward track record.
      if (!t.is_globex && t.id != null && siblingReversalFlaggedIds.has(t.id)) continue;

      // IB invalidation-boundary fix: substitute the corrected pnl for the 154 historical
      // trades that fix's own walk-forward re-simulation found would have resolved
      // differently, instead of the stored (pre-fix) actual_pnl.
      const effectivePnl = (!t.is_globex && t.id != null && ibFixMap.has(t.id)) ? ibFixMap.get(t.id) : t.actual_pnl;
      const sizedPnl = effectivePnl * (t.is_globex ? 1.0 : (t.size_multiplier || 1.0));
      balance += sizedPnl;
      tradesExec++;

      if (balance > peak) peak = balance;
      if (!ddFrozen) {
        ddFloor = peak - TRAILING_DRAWDOWN;
        if (peak - STARTING_BALANCE >= DRAWDOWN_FREEZE_PROFIT) { ddFrozen = true; ddFloor = peak - TRAILING_DRAWDOWN; }
      }
      if (balance <= ddFloor) {
        blown = true; blownAt = { date: todayStr, tradesExec, balance: Math.round(balance) };
        break;
      }
      if (firstCross3k === null && balance >= 3000) {
        firstCross3k = { date: todayStr, tradesExec, tradingDaysElapsed };
      }
      for (const m of milestones) {
        if (!milestonesHit[m] && balance >= m) {
          milestonesHit[m] = { date: todayStr, tradesExec, tradingDaysElapsed };
        }
      }
    }
  }

  console.log(`\n=== CHRONOLOGICAL WALK -- CURRENT_VALIDATED_ROSTER, Globex included, NO DLL, trailing $${TRAILING_DRAWDOWN} drawdown freezing at +$${DRAWDOWN_FREEZE_PROFIT} profit, WITH today's sibling-reversal gate + IB fix applied retroactively ===`);
  console.log(`Window: ${startDateStr} to ${maxDate} (${tradingDays.length} trading days)`);
  console.log(`Total trades executed: ${tradesExec}`);
  console.log(`Final balance: $${Math.round(balance)}  |  Peak: $${Math.round(peak)}  |  Blown: ${blown}`);
  if (blown) {
    console.log(`  BLOWN on ${blownAt.date} after ${blownAt.tradesExec} trades, balance $${blownAt.balance} (trailing floor breached)`);
  }
  console.log(`\n--- Milestones (first time balance crossed each level) ---`);
  for (const m of milestones) {
    const h = milestonesHit[m];
    console.log(`  $${m}: ${h ? `${h.date} (trade #${h.tradesExec}, trading day #${h.tradingDaysElapsed} of ${tradingDays.length})` : 'never reached'}`);
  }
  if (firstCross3k) {
    console.log(`\nDrawdown freeze condition (+$${DRAWDOWN_FREEZE_PROFIT} profit) first met: ${firstCross3k.date} (trade #${firstCross3k.tradesExec}, trading day #${firstCross3k.tradingDaysElapsed} of ${tradingDays.length})`);
  } else {
    console.log(`\nDrawdown freeze condition (+$${DRAWDOWN_FREEZE_PROFIT} profit) never met.`);
  }

  await pool.end();
}

run().catch(e => { console.error('[prop_challenge_trailing_dd_chronological] ERROR:', e.message, e.stack); process.exit(1); });
