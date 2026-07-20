// Isolates OVERNIGHT-fired touches only (excludes RTH-fired touches entirely) from the same
// 52-level population, past year, and validated window/resolution-cap methodology used in
// backtest_24hr_vs_rth_1yr_comparison_20260720.mjs -- that script reported RTH_ONLY and
// WIDE_24HR (overnight+RTH pooled together); this isolates the overnight portion on its own
// so it can be judged independently, per user request.
//
// Run: node scripts/backtest_overnight_only_1yr_20260720.mjs
import { query } from '../server/db.js';
import { resolve } from './backtest_unified.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import fs from 'fs';

const EXCLUDED = new Set(['OR_HIGH', 'OR_LOW', 'IB_HIGH', 'IB_LOW', 'IB_MID_SCALP', 'IB_MID', 'OR_MID',
  'OR_MID_AFTER_IB', 'ONH', 'ONL', '3M_VAH', '3M_VAL', '3M_POC', 'RTH_VWAP', 'WEEKLY_VWAP', 'MONTHLY_VWAP',
  'DAILY_OPEN', 'WEEKLY_OPEN', 'MONTHLY_OPEN']);
const RTH_START = 570, RTH_END = 960;
const MAX_DRAWDOWN = 100000;
const DLL_LEVELS = [200, 400, 600];
const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint, COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;

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
  console.log(`${levelNames.length} level names, ${dates.length} trading days, window ending ${maxDate}.`);

  const barsRes = await query(`
    SELECT ts, ts::date::text as d, EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)::int as tod,
      high::float as high, low::float as low, close::float as close
    FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date - interval '370 days' ORDER BY ts ASC
  `, [maxDate]);
  const allBars = barsRes.rows.map(b => ({ ...b, ts: new Date(b.ts).getTime() }));
  console.log(`${allBars.length} bars loaded.`);

  function firstIdxAtOrAfter(dateStr, todMin) {
    for (let i = 0; i < allBars.length; i++) {
      if (allBars[i].d > dateStr) return i;
      if (allBars[i].d === dateStr && allBars[i].tod >= todMin) return i;
    }
    return -1;
  }

  console.log('Scanning OVERNIGHT-only portion (before RTH open) for the same 52 levels...');
  const trades = [];
  for (const d of dates) {
    const lv = levelsByDate.get(d);
    const startIdx = firstIdxAtOrAfter(d, RTH_START); // RTH open -- overnight scan ends here
    if (startIdx <= 0) continue;
    let rthEndIdx = allBars.length;
    for (let i = startIdx; i < allBars.length; i++) {
      if (allBars[i].d > d || (allBars[i].d === d && allBars[i].tod >= RTH_END)) { rthEndIdx = i; break; }
    }
    const wideStartTs = allBars[startIdx].ts - 15.5 * 3600 * 1000;
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts < wideStartTs) lo = mid + 1; else hi = mid; }
    const wideStartIdx = Math.max(lo, 1);

    const isMonday = new Date(d + 'T12:00:00').getDay() === 1;
    const STOP = isMonday ? 60 : 90, TARGET = isMonday ? 30 : 40;

    for (const name of levelNames) {
      const lvl = lv[name];
      if (lvl == null) continue;
      // OVERNIGHT-only window: wideStartIdx through startIdx (RTH open) -- NOT into RTH itself
      for (let i = wideStartIdx + 1; i < startIdx; i++) {
        const b = allBars[i], prev = allBars[i - 1];
        if (Math.abs(b.close - lvl) > 15) continue;
        const dir = prev.close > lvl ? 'SHORT' : 'LONG';
        const entry = b.close;
        // Resolve to the window's own end (RTH open) -- a touch that fires overnight and
        // resolves into the beginning of RTH is fine (same convention as the wide-window
        // scripts); a touch is NOT allowed to fire from within RTH itself here.
        const r = resolve(allBars, i, dir,
          entry, dir === 'LONG' ? entry - STOP : entry + STOP,
          dir === 'LONG' ? entry + TARGET : entry - TARGET, rthEndIdx - i);
        const pnl = r.result === 'TARGET_HIT' ? TARGET * PNL_PER_POINT - COMMISSION
          : r.result === 'STOP_HIT' ? -(STOP * PNL_PER_POINT + COMMISSION) : 0;
        trades.push({ date: d, setup_type: `${name}_${dir}`, pnl });
        break;
      }
    }
  }
  console.log(`${trades.length} overnight-only simulated trades.`);

  const tradesByDate = {};
  for (const t of trades) { (tradesByDate[t.date] ||= []).push(t); }
  const results = {};
  for (const dll of DLL_LEVELS) results[dll] = { pnl: 0, trades: 0, wins: 0, grossProfit: 0, grossLoss: 0, lockoutDays: 0, peakPnl: 0, maxDrawdown: 0, blownOn: null };
  const setupCumStats = {};
  const setupBreakdown = {};

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
      if (dayPnl <= -MAX_DRAWDOWN) stats.blownOn = d;
    }
    for (const t of todaysTrades) {
      (setupCumStats[t.setup_type] ||= { n: 0, pnl: 0 });
      setupCumStats[t.setup_type].n++; setupCumStats[t.setup_type].pnl += t.pnl;
    }
  }

  console.log('\n=== OVERNIGHT-ONLY (excludes RTH entirely), past year, prop-account walkthrough ===');
  let report = `# Overnight-ONLY (excludes RTH) -- Past-Year Prop-Account Walkthrough\n\nSIMULATED. Same 52 prior-period levels, same exclusions, same past year as the RTH-vs-24hr comparison -- but this isolates ONLY touches that fire during the overnight portion (before RTH open), excluding all RTH-fired touches entirely.\n\n| DLL | Total P&L | Trades | Win Rate | Profit Factor | Expectancy/Trade | Max Drawdown | Lockout Days |\n|---|---|---|---|---|---|---|---|\n`;
  for (const dll of DLL_LEVELS) {
    const s = results[dll];
    const wr = s.trades > 0 ? (100 * s.wins / s.trades).toFixed(1) : '0.0';
    const pf = s.grossLoss > 0 ? (s.grossProfit / s.grossLoss).toFixed(2) : 'N/A';
    const exp = s.trades > 0 ? (s.pnl / s.trades).toFixed(2) : '0.00';
    const line = `| $${dll} | $${s.pnl.toFixed(2)} | ${s.trades} | ${wr}% | ${pf} | $${exp} | $${s.maxDrawdown.toFixed(2)} | ${s.lockoutDays} |`;
    console.log(line);
    report += line + '\n';
  }
  report += `\n## Per-setup breakdown ($400 DLL), top 15 / bottom 15\n\n| Setup Type | Trades | Total P&L | Win Rate |\n|---|---|---|---|\n`;
  const sorted = Object.entries(setupBreakdown).sort((a, b) => b[1].pnl - a[1].pnl);
  for (const [st, s] of [...sorted.slice(0, 15), ...sorted.slice(-15).reverse()]) {
    report += `| ${st} | ${s.n} | $${s.pnl.toFixed(2)} | ${(100 * s.wins / s.n).toFixed(1)}% |\n`;
  }
  fs.writeFileSync('scratch/backtest_overnight_only_1yr_RESULTS.md', report);
  console.log('\nWrote scratch/backtest_overnight_only_1yr_RESULTS.md');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
