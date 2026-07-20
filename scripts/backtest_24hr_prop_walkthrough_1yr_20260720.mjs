// Past-year prop-account walkthrough for the "24hr trading cycle" idea (user request,
// 2026-07-20 follow-up to the wider-window level-fade backtest). Simulates what firing the
// PRIOR-PERIOD level-fade family across the overnight Globex session + RTH (not RTH-only)
// would have produced over the last year, wrapped in the same chronological DLL/lockout
// prop-account mechanic used elsewhere in this codebase's walk-forwards.
//
// Scope decisions, made after re-verifying the underlying wider-window backtest today:
// - EXCLUDES the 6 same-day-forming levels (OR_HIGH/LOW, IB_HIGH/LOW/MID_SCALP,
//   OR_MID_AFTER_IB) -- confirmed unstable/unreliable via two independent reimplementations
//   disagreeing by 3x on N and flipping EV sign (see docs/WIDER_WINDOW_BACKTEST_20260720.md's
//   2026-07-20 update). Not safe to build on.
// - EXCLUDES ONH/ONL (documented lookahead artifact) and 3M_VAH/VAL/POC (separate
//   documented same-day lookahead-risk caveat, OPEN_DECISION 3m_val_poc_same_day_lookahead_risk).
// - Everything else is a genuine prior-period level (value fixed before the day begins) --
//   uses the corrected wider-window methodology validated earlier today on a 3-level/6-row
//   spot-check (5/6 rows reproduced the original report closely once two bugs were fixed):
//   (1) the wide window extends BACKWARD into the overnight session (~15.5hrs before RTH
//   open), not forward past close -- confirmed via the doc's own ONH/ONL caveat language;
//   (2) resolution runs to the window's own natural end (session close), not a flat 240-bar
//   (4hr) cap -- a fixed cap was starving overnight-fired trades of the time they need,
//   since overnight NQ moves slower than RTH.
// - This is a SIMULATION, not real trade history -- nothing has ever fired live this way
//   except the 4 dedicated Globex setup_types (checked earlier today, N=4-6 each, too thin
//   to compare against). No live sizeMultiplier exists for this hypothetical scenario --
//   flat 1x sizing throughout. Eligibility is a rolling n>=20/ev>=-5 filter computed fresh
//   from THIS simulation's own population (can't reuse live SETUP_STATUS -- that reflects
//   RTH-only reality, not this scenario).
//
// Run: node scripts/backtest_24hr_prop_walkthrough_1yr_20260720.mjs
import { query } from '../server/db.js';
import { resolve } from './backtest_unified.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import fs from 'fs';

// Found 2026-07-20 (2nd pass) via a fresh DISTINCT level_name query against level_prices --
// this list is now more conservative than the original wider-window doc's, on purpose:
// IB_MID/OR_MID (distinct from 10D_IB_MID/5D_OR_MID -- these are TODAY's own same-day
// IB-mid/OR-mid, not the rolling composites) and RTH_VWAP (today's own developing session
// VWAP) are unambiguously same-day-forming and were simply missing from the first pass.
// WEEKLY_VWAP/MONTHLY_VWAP are excluded too, even though the original wider-window doc
// treated WEEKLY_VWAP as "prior-period safe" -- CLAUDE.md's own documented caveat (from the
// 2026-07-13 minute-bar-scanner conditioning work) already established WEEKLY_VWAP "spans
// the current week including today's own bars" and is same-day-forming; MONTHLY_VWAP is the
// same live-accumulating convention. Not safe to extend backward into an overnight window
// when the level's own value is still being formed by bars inside that very window.
// Found 2026-07-20 (3rd pass): DAILY_OPEN/WEEKLY_OPEN/MONTHLY_OPEN are NOT prior-period --
// a day's/week's/month's own open isn't known until that period's own RTH session begins,
// so testing a touch of "today's open" during the overnight hours BEFORE that open is a
// lookahead violation, structurally identical to the IB_MID/OR_MID problem just caught.
// These were the #1/#2 P&L contributors in the pass before this fix ($2,619/$2,511 of the
// reported total) -- a real, meaningful contamination, not a rounding-error-sized one.
const EXCLUDED = new Set(['OR_HIGH', 'OR_LOW', 'IB_HIGH', 'IB_LOW', 'IB_MID_SCALP', 'IB_MID', 'OR_MID',
  'OR_MID_AFTER_IB', 'ONH', 'ONL', '3M_VAH', '3M_VAL', '3M_POC', 'RTH_VWAP', 'WEEKLY_VWAP', 'MONTHLY_VWAP',
  'DAILY_OPEN', 'WEEKLY_OPEN', 'MONTHLY_OPEN']);
const RTH_START = 570, RTH_END = 960;
const STARTING_BALANCE = 100000, MAX_DRAWDOWN = 100000;
const DLL_LEVELS = [200, 400, 600];
const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint, COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;

async function main() {
  const maxDateRow = await query(`SELECT MAX(trade_date)::text as d FROM level_prices`);
  const maxDate = maxDateRow.rows[0].d;
  console.log(`Past-year window ending ${maxDate}.`);

  const lvlRes = await query(`
    SELECT trade_date::text as d, level_name, price::float as price
    FROM level_prices
    WHERE trade_date >= $1::date - interval '365 days' AND trade_date <= $1::date
  `, [maxDate]);
  const levelNamesPresent = new Set(lvlRes.rows.map(r => r.level_name));
  const levelNames = [...levelNamesPresent].filter(n => !EXCLUDED.has(n));
  console.log(`${levelNames.length} prior-period level names in scope (excluded ${EXCLUDED.size} same-day-forming/lookahead-risk names).`);

  const levelsByDate = new Map();
  for (const r of lvlRes.rows) {
    if (EXCLUDED.has(r.level_name)) continue;
    if (!levelsByDate.has(r.d)) levelsByDate.set(r.d, {});
    levelsByDate.get(r.d)[r.level_name] = r.price;
  }
  const dates = [...levelsByDate.keys()].sort();
  console.log(`${dates.length} trading days.`);

  console.log('Loading NQ bars (24hr, buffered start)...');
  const barsRes = await query(`
    SELECT ts, ts::date::text as d, EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)::int as tod,
      high::float as high, low::float as low, close::float as close
    FROM price_bars_primary
    WHERE symbol='NQ' AND ts >= $1::date - interval '370 days'
    ORDER BY ts ASC
  `, [maxDate]);
  const allBars = barsRes.rows.map(b => ({ ...b, ts: new Date(b.ts).getTime() }));
  console.log(`${allBars.length} bars loaded.`);

  function firstIdxAtOrAfter(dateStr, todMin) {
    let lo = 0, hi = allBars.length;
    // bars are date-then-tod ordered chronologically; linear scan bounded by date is fine
    // for a ~370-day slice (one-off script)
    for (let i = 0; i < allBars.length; i++) {
      if (allBars[i].d > dateStr) return i;
      if (allBars[i].d === dateStr && allBars[i].tod >= todMin) return i;
    }
    return -1;
  }

  // Direction convention: level names ending in a natural "resistance-like" concept
  // (VAH/HIGH/R1-R4) fade SHORT on approach from below... actually simplest and most
  // faithful to backtest_unified.js: direction is determined per-touch by approach side
  // (fromAbove -> SHORT, fromBelow -> LONG), exactly matching detectLevelFades()'s own logic
  // -- no need to hardcode per-level-name direction semantics.
  console.log('Scanning for touches (wide window: ~15.5hr pre-RTH-open through RTH close)...');
  const trades = []; // { date, setup_type, pnl }
  for (const d of dates) {
    const lv = levelsByDate.get(d);
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
    const wideEndIdx = rthEndIdx;

    const isMonday = new Date(d + 'T12:00:00').getDay() === 1;
    const STOP = isMonday ? 60 : 90, TARGET = isMonday ? 30 : 40;

    for (const name of levelNames) {
      const lvl = lv[name];
      if (lvl == null) continue;
      for (let i = wideStartIdx + 1; i < wideEndIdx; i++) {
        const b = allBars[i], prev = allBars[i - 1];
        if (Math.abs(b.close - lvl) > 15) continue;
        const dir = prev.close > lvl ? 'SHORT' : 'LONG';
        const entry = b.close;
        const r = resolve(allBars, i, dir,
          entry, dir === 'LONG' ? entry - STOP : entry + STOP,
          dir === 'LONG' ? entry + TARGET : entry - TARGET, wideEndIdx - i);
        const pnl = r.result === 'TARGET_HIT' ? TARGET * PNL_PER_POINT - COMMISSION
          : r.result === 'STOP_HIT' ? -(STOP * PNL_PER_POINT + COMMISSION) : 0;
        trades.push({ date: d, setup_type: `${name}_${dir}`, pnl });
        break; // one fire per level per day, matches detectLevelFades()
      }
    }
  }
  console.log(`${trades.length} simulated trades across ${levelNames.length} level names.`);

  // Chronological prop-account wrapper, same mechanic as scratch/backtest_prop_2yr_walkforward_*.mjs
  const tradesByDate = {};
  for (const t of trades) { (tradesByDate[t.date] ||= []).push(t); }
  const results = {};
  for (const dll of DLL_LEVELS) results[dll] = { pnl: 0, trades: 0, wins: 0, grossProfit: 0, grossLoss: 0, lockoutDays: 0, peakPnl: 0, maxDrawdown: 0, blownOn: null };
  const setupCumStats = {}; // setup_type -> {n, pnl} rolling, for eligibility
  const setupBreakdown = {}; // for $400 report

  for (const d of dates) {
    const todaysTrades = tradesByDate[d] || [];
    const eligible = new Set();
    for (const st in setupCumStats) {
      const s = setupCumStats[st];
      if (s.n >= 20 && (s.pnl / s.n) >= -5) eligible.add(st);
    }
    for (const dll of DLL_LEVELS) {
      const stats = results[dll];
      if (stats.blownOn) continue;
      let dayPnl = 0, locked = false;
      for (const t of todaysTrades) {
        if (!eligible.has(t.setup_type) || locked) continue;
        dayPnl += t.pnl;
        stats.trades++; stats.pnl += t.pnl;
        if (t.pnl > 0) { stats.wins++; stats.grossProfit += t.pnl; }
        else if (t.pnl < 0) stats.grossLoss += Math.abs(t.pnl);
        if (stats.pnl > stats.peakPnl) stats.peakPnl = stats.pnl;
        const dd = stats.peakPnl - stats.pnl;
        if (dd > stats.maxDrawdown) stats.maxDrawdown = dd;
        if (dll === 400) {
          (setupBreakdown[t.setup_type] ||= { n: 0, pnl: 0, wins: 0 });
          setupBreakdown[t.setup_type].n++; setupBreakdown[t.setup_type].pnl += t.pnl;
          if (t.pnl > 0) setupBreakdown[t.setup_type].wins++;
        }
        if (dayPnl <= -dll) { locked = true; stats.lockoutDays++; }
      }
      if (dayPnl <= -MAX_DRAWDOWN) stats.blownOn = d; // per-day check only, matches base script convention loosely
    }
    // Update rolling eligibility stats AFTER today's trading decision (point-in-time, no lookahead)
    for (const t of todaysTrades) {
      (setupCumStats[t.setup_type] ||= { n: 0, pnl: 0 });
      setupCumStats[t.setup_type].n++; setupCumStats[t.setup_type].pnl += t.pnl;
    }
  }

  console.log('\n=== 24hr trading cycle, prior-period levels only, past year, prop-account walkthrough ===');
  let report = `# 24hr Trading Cycle -- Past-Year Prop-Account Walkthrough (prior-period levels only)\n\nSIMULATED, not real trade history. Excludes same-day-forming levels (OR/IB) -- confirmed unreliable today -- and ONH/ONL/3M_* (documented lookahead risk). ${levelNames.length} level names, ${dates.length} trading days, window ending ${maxDate}.\n\n| DLL | Total P&L | Trades | Win Rate | Profit Factor | Expectancy/Trade | Max Drawdown | Lockout Days |\n|---|---|---|---|---|---|---|---|\n`;
  for (const dll of DLL_LEVELS) {
    const s = results[dll];
    const wr = s.trades > 0 ? (100 * s.wins / s.trades).toFixed(1) : '0.0';
    const pf = s.grossLoss > 0 ? (s.grossProfit / s.grossLoss).toFixed(2) : 'N/A';
    const exp = s.trades > 0 ? (s.pnl / s.trades).toFixed(2) : '0.00';
    const line = `| $${dll} | $${s.pnl.toFixed(2)} | ${s.trades} | ${wr}% | ${pf} | $${exp} | $${s.maxDrawdown.toFixed(2)} | ${s.lockoutDays} |`;
    console.log(line);
    report += line + '\n';
  }
  report += `\n## Per-setup breakdown ($400 DLL), top 15 by P&L, bottom 15 by P&L\n\n| Setup Type | Trades | Total P&L | Win Rate |\n|---|---|---|---|\n`;
  const sorted = Object.entries(setupBreakdown).sort((a, b) => b[1].pnl - a[1].pnl);
  const top15 = sorted.slice(0, 15), bottom15 = sorted.slice(-15).reverse();
  for (const [st, s] of [...top15, ...bottom15]) {
    report += `| ${st} | ${s.n} | $${s.pnl.toFixed(2)} | ${(100 * s.wins / s.n).toFixed(1)}% |\n`;
  }
  fs.writeFileSync('scratch/backtest_24hr_prop_walkthrough_1yr_RESULTS.md', report);
  console.log('\nWrote scratch/backtest_24hr_prop_walkthrough_1yr_RESULTS.md');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
