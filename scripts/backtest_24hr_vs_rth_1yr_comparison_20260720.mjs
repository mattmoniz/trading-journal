// True apples-to-apples comparison: SAME 52 prior-period levels, SAME past-year window,
// SAME simulated stop/target methodology, SAME chronological DLL/lockout prop-account
// wrapper -- RTH-only vs the wider (~15.5hr overnight + RTH) window, side by side. Answers
// the actual question ("does 24hr help or hurt") that scripts/
// backtest_24hr_prop_walkthrough_1yr_20260720.mjs (WIDE-only, no RTH-only baseline computed
// in the same run) couldn't -- that script's number should never be compared directly
// against the older 2yr/full-roster LEGACY_ROLLING walkthrough (different window length,
// different setup universe, different data source: real actual_pnl vs this fresh sim).
//
// Reuses the exact same level exclusion list, window construction, and resolution-cap fix
// validated in backtest_24hr_prop_walkthrough_1yr_20260720.mjs -- see that file's comments
// for the full history of bugs found and fixed to get here.
//
// Run: node scripts/backtest_24hr_vs_rth_1yr_comparison_20260720.mjs
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
    FROM level_prices
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

  console.log('Scanning RTH-only and WIDE windows for the same levels/dates...');
  const tradesByScenario = { RTH_ONLY: [], WIDE_24HR: [] };
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

    const isMonday = new Date(d + 'T12:00:00').getDay() === 1;
    const STOP = isMonday ? 60 : 90, TARGET = isMonday ? 30 : 40;

    for (const name of levelNames) {
      const lvl = lv[name];
      if (lvl == null) continue;
      for (const [scenario, scanStart] of [['RTH_ONLY', startIdx], ['WIDE_24HR', wideStartIdx]]) {
        for (let i = scanStart + 1; i < rthEndIdx; i++) {
          const b = allBars[i], prev = allBars[i - 1];
          if (Math.abs(b.close - lvl) > 15) continue;
          const dir = prev.close > lvl ? 'SHORT' : 'LONG';
          const entry = b.close;
          const r = resolve(allBars, i, dir,
            entry, dir === 'LONG' ? entry - STOP : entry + STOP,
            dir === 'LONG' ? entry + TARGET : entry - TARGET, rthEndIdx - i);
          const pnl = r.result === 'TARGET_HIT' ? TARGET * PNL_PER_POINT - COMMISSION
            : r.result === 'STOP_HIT' ? -(STOP * PNL_PER_POINT + COMMISSION) : 0;
          tradesByScenario[scenario].push({ date: d, setup_type: `${name}_${dir}`, pnl });
          break;
        }
      }
    }
  }
  console.log(`RTH_ONLY: ${tradesByScenario.RTH_ONLY.length} trades. WIDE_24HR: ${tradesByScenario.WIDE_24HR.length} trades.`);

  function runPropAccount(trades) {
    const tradesByDate = {};
    for (const t of trades) { (tradesByDate[t.date] ||= []).push(t); }
    const results = {};
    for (const dll of DLL_LEVELS) results[dll] = { pnl: 0, trades: 0, wins: 0, grossProfit: 0, grossLoss: 0, lockoutDays: 0, peakPnl: 0, maxDrawdown: 0, blownOn: null };
    const setupCumStats = {};
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
          if (dayPnl <= -dll) { locked = true; stats.lockoutDays++; }
        }
        if (dayPnl <= -MAX_DRAWDOWN) stats.blownOn = d;
      }
      for (const t of todaysTrades) {
        (setupCumStats[t.setup_type] ||= { n: 0, pnl: 0 });
        setupCumStats[t.setup_type].n++; setupCumStats[t.setup_type].pnl += t.pnl;
      }
    }
    return results;
  }

  const rthResults = runPropAccount(tradesByScenario.RTH_ONLY);
  const wideResults = runPropAccount(tradesByScenario.WIDE_24HR);

  console.log('\n=== RTH-only vs WIDE_24HR, same 52 levels, same past year ===');
  let report = `# RTH-only vs 24hr-window, SAME levels, SAME past year -- apples-to-apples\n\n${levelNames.length} prior-period level names, ${dates.length} trading days, window ending ${maxDate}. Simulated stop/target (90/40, 60/30 Monday), not each setup's real calibrated stop -- same methodology both sides.\n\n| Scenario | DLL | Total P&L | Trades | Win Rate | Profit Factor | Expectancy/Trade | Max DD | Lockout Days |\n|---|---|---|---|---|---|---|---|---|\n`;
  for (const [label, results] of [['RTH_ONLY', rthResults], ['WIDE_24HR', wideResults]]) {
    for (const dll of DLL_LEVELS) {
      const s = results[dll];
      const wr = s.trades > 0 ? (100 * s.wins / s.trades).toFixed(1) : '0.0';
      const pf = s.grossLoss > 0 ? (s.grossProfit / s.grossLoss).toFixed(2) : 'N/A';
      const exp = s.trades > 0 ? (s.pnl / s.trades).toFixed(2) : '0.00';
      const line = `| ${label} | $${dll} | $${s.pnl.toFixed(2)} | ${s.trades} | ${wr}% | ${pf} | $${exp} | $${s.maxDrawdown.toFixed(2)} | ${s.lockoutDays} |`;
      console.log(line);
      report += line + '\n';
    }
  }
  report += `\n## Delta (WIDE_24HR minus RTH_ONLY)\n\n| DLL | ΔP&L | ΔTrades |\n|---|---|---|\n`;
  for (const dll of DLL_LEVELS) {
    const dPnl = wideResults[dll].pnl - rthResults[dll].pnl;
    const dTrades = wideResults[dll].trades - rthResults[dll].trades;
    const line = `| $${dll} | $${dPnl.toFixed(2)} | ${dTrades} |`;
    console.log(line);
    report += line + '\n';
  }
  fs.writeFileSync('scratch/backtest_24hr_vs_rth_1yr_comparison_RESULTS.md', report);
  console.log('\nWrote scratch/backtest_24hr_vs_rth_1yr_comparison_RESULTS.md');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
