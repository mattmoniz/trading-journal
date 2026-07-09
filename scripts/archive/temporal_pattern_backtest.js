/**
 * temporal_pattern_backtest.js
 *
 * REPORT ONLY — no writes, no live logic changed.
 *
 * Comprehensive temporal pattern scan: day-of-week, month, quarter/season,
 * week-of-month, intra-week progression, post-weekend/holiday.
 *
 * MARKET data: derived from price_bars (NQ, RTH 9:30-16:00 ET), ~849 sessions
 *   back to 2022-12-14. Gives session range, direction, and a simple
 *   range-vs-trailing-20-day-median volatility regime (HIGH/NORMAL/LOW).
 *   NOTE: this is a SIMPLER regime classifier than the live morning-vol
 *   z-score regime in volatilityRegimeService.js — it's a range-percentile
 *   proxy, documented here for transparency, not meant to replace that.
 *
 * MY data: from daily_performance (340 sessions, 2024-11-18 onward) +
 *   daily_performance_log (333 sessions, for give-back proxy via
 *   max_favorable/session_pnl).
 *
 * acd_daily_log day_type (385 sessions, 2023-11-16 onward) joined where
 *   available for MARKET day-type distribution.
 */

import { query } from '../server/db.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const DOW_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function mean(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null; }
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a,b)=>a-b);
  const mid = Math.floor(s.length/2);
  return s.length % 2 ? s[mid] : (s[mid-1]+s[mid])/2;
}
function pct(n, d) { return d ? (n/d*100) : null; }
function fmt$(v) { return v == null ? 'n/a' : `${v>=0?'+':''}$${v.toFixed(0)}`; }
function fmtPct(v) { return v == null ? 'n/a' : `${v.toFixed(1)}%`; }
function nFlag(n) { return n < 20 ? ` [n=${n} — THIN, n<20]` : ` [n=${n}]`; }

// ISO-week key (year + week number) for grouping trading days into weeks
// regardless of holidays.
function isoWeekKey(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2,'0')}`;
}

async function main() {
  console.log('[temporal_pattern_backtest] REPORT ONLY — no writes, no live logic changed.\n');

  // ── MARKET data: RTH session summary per day from price_bars ──────────
  const marketQ = await query(`
    WITH rth AS (
      SELECT ts::date as d, ts, open::float, high::float, low::float, close::float, volume::float
      FROM price_bars
      WHERE symbol='NQ' AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
    )
    SELECT d::text as date,
      (array_agg(open ORDER BY ts ASC))[1] as open,
      (array_agg(close ORDER BY ts DESC))[1] as close,
      MAX(high) as high, MIN(low) as low, SUM(volume) as volume, COUNT(*) as n
    FROM rth GROUP BY d ORDER BY d
  `);
  let marketDays = marketQ.rows
    .filter(r => Number(r.n) >= 200) // require a reasonably complete RTH session
    .map(r => ({
      date: r.date,
      open: Number(r.open), close: Number(r.close),
      high: Number(r.high), low: Number(r.low),
      range: Number(r.high) - Number(r.low),
      dir: Number(r.close) - Number(r.open),
      volume: Number(r.volume),
    }));
  console.log(`MARKET sessions (RTH, >=200 1-min bars): ${marketDays.length}  (${marketDays[0]?.date} → ${marketDays[marketDays.length-1]?.date})\n`);

  // Simple volatility regime: range vs trailing 20-session median range
  for (let i = 0; i < marketDays.length; i++) {
    if (i < 20) { marketDays[i].regime = null; continue; }
    const baseline = median(marketDays.slice(i-20, i).map(d => d.range));
    const ratio = marketDays[i].range / baseline;
    marketDays[i].rangeRatio = ratio;
    marketDays[i].regime = ratio >= 1.3 ? 'HIGH' : ratio <= 0.7 ? 'LOW' : 'NORMAL';
  }

  // Join acd_daily_log day_type
  const dayTypeQ = await query(`SELECT trade_date::text as date, day_type FROM acd_daily_log WHERE day_type IS NOT NULL`);
  const dayTypeByDate = Object.fromEntries(dayTypeQ.rows.map(r => [r.date, r.day_type]));
  for (const d of marketDays) d.dayType = dayTypeByDate[d.date] || null;

  // ── MY data: corrected CumPL-diff daily P&L (per project convention —
  // daily_performance.daily_pnl uses an older/looser formula and disagrees
  // with the verified CumPL-diff total by ~$55k over the full history) ──
  const myQ = await query(`
    WITH ep_fills AS (
      SELECT log_date, custom_fields->>'account' as account, exit_time,
        CASE WHEN custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)?$'
        THEN (custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)')::numeric ELSE NULL END as cum_pl
      FROM trades WHERE custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP' AND exit_time IS NOT NULL
    ),
    last_ep_per_day AS (SELECT DISTINCT ON (log_date, account) log_date, account, cum_pl FROM ep_fills ORDER BY log_date, account, exit_time DESC),
    daily_pnl_per_account AS (SELECT log_date, cum_pl - COALESCE(LAG(cum_pl) OVER (PARTITION BY account ORDER BY log_date), 0) as session_pnl FROM last_ep_per_day WHERE cum_pl IS NOT NULL),
    daily_cuml AS (SELECT log_date, SUM(session_pnl)::float as cum_daily_pnl FROM daily_pnl_per_account GROUP BY log_date),
    trade_agg AS (
      SELECT log_date, COUNT(*) as total_trades,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as winning_trades,
        SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losing_trades,
        SUM(pnl)::float as sum_pnl
      FROM trades WHERE exit_time IS NOT NULL GROUP BY log_date
    )
    SELECT ta.log_date::text as date,
      COALESCE(dc.cum_daily_pnl, ta.sum_pnl) as pnl,
      ta.total_trades::int as total_trades,
      ta.winning_trades::int as winning_trades,
      ta.losing_trades::int as losing_trades,
      dpl.max_favorable::float as mfe, dpl.max_adverse::float as mae
    FROM trade_agg ta
    LEFT JOIN daily_cuml dc ON dc.log_date = ta.log_date
    LEFT JOIN daily_performance_log dpl ON dpl.trade_date = ta.log_date
    ORDER BY ta.log_date
  `);
  let myDays = myQ.rows.map(r => ({
    date: r.date,
    pnl: Number(r.pnl), trades: Number(r.total_trades),
    win: Number(r.winning_trades), loss: Number(r.losing_trades),
    mfe: r.mfe, mae: r.mae,
  }));
  console.log(`MY sessions (daily_performance): ${myDays.length}  (${myDays[0]?.date} → ${myDays[myDays.length-1]?.date})\n`);

  // Give-back proxy: gave back >=50% of peak open profit, and ended red or
  // gave back more than half of MFE.
  for (const d of myDays) {
    d.giveback = (d.mfe != null && d.mfe > 0) ? (d.mfe - d.pnl) / d.mfe : null;
    d.givebackSpiral = d.giveback != null && d.giveback >= 0.5;
    d.red = d.pnl < 0;
  }

  // Attach DOW + month + quarter + week-of-month + ISO week to both sets
  function annotate(days) {
    for (const d of days) {
      const dt = new Date(d.date + 'T12:00:00Z');
      d.dow = dt.getUTCDay(); // 0=Sun..6=Sat
      d.dowName = DOW_NAMES[d.dow];
      d.month = dt.getUTCMonth() + 1; // 1-12
      d.year = dt.getUTCFullYear();
      d.quarter = Math.ceil(d.month / 3);
      d.dom = dt.getUTCDate();
      d.weekOfMonth = Math.ceil(d.dom / 7); // 1-5, rough
      d.isoWeek = isoWeekKey(d.date);
    }
  }
  annotate(marketDays);
  annotate(myDays);

  // Mark "first trading day of week" (regardless of weekday) for both sets
  function markFirstOfWeek(days) {
    const byWeek = {};
    for (const d of days) (byWeek[d.isoWeek] ??= []).push(d);
    for (const wk of Object.values(byWeek)) {
      wk.sort((a,b) => a.date < b.date ? -1 : 1);
      wk.forEach((d, idx) => { d.weekPos = idx; d.isFirstOfWeek = idx === 0; d.isLastOfWeek = idx === wk.length-1; });
    }
  }
  markFirstOfWeek(marketDays);
  markFirstOfWeek(myDays);

  // Mark "day after gap" (prior calendar date is >1 day back = post-weekend/holiday)
  function markPostGap(days) {
    for (let i = 1; i < days.length; i++) {
      const prev = new Date(days[i-1].date + 'T12:00:00Z');
      const cur = new Date(days[i].date + 'T12:00:00Z');
      const gapDays = (cur - prev) / 86400000;
      days[i].gapDays = gapDays;
      days[i].postGap = gapDays > 1;
    }
  }
  markPostGap(marketDays);
  markPostGap(myDays);

  const recentCutoff = '2025-06-15'; // last ~12 months for confound check on MY data
  const myRecent = myDays.filter(d => d.date >= recentCutoff);
  const marketRecent = marketDays.filter(d => d.date >= recentCutoff);
  console.log(`Recent-12mo subset for confound checks: MY n=${myRecent.length}, MARKET n=${marketRecent.length} (>= ${recentCutoff})\n`);

  console.log('='.repeat(78));
  console.log('DIMENSION 1 — DAY OF WEEK');
  console.log('='.repeat(78));

  console.log('\n-- MARKET: avg range, % up days, regime distribution by weekday --');
  for (let dow = 1; dow <= 5; dow++) {
    const ds = marketDays.filter(d => d.dow === dow);
    const ranges = ds.map(d => d.range);
    const upPct = pct(ds.filter(d => d.dir > 0).length, ds.length);
    const regimeCounts = {};
    for (const d of ds) if (d.regime) regimeCounts[d.regime] = (regimeCounts[d.regime]||0)+1;
    console.log(`  ${DOW_NAMES[dow]}: n=${ds.length}  avgRange=${mean(ranges)?.toFixed(1)}  medRange=${median(ranges)?.toFixed(1)}  %up=${fmtPct(upPct)}  regimes=${JSON.stringify(regimeCounts)}`);
  }

  console.log('\n-- MARKET: day_type distribution by weekday (acd_daily_log, n=385) --');
  for (let dow = 1; dow <= 5; dow++) {
    const ds = marketDays.filter(d => d.dow === dow && d.dayType);
    const counts = {};
    for (const d of ds) counts[d.dayType] = (counts[d.dayType]||0)+1;
    console.log(`  ${DOW_NAMES[dow]}: n=${ds.length}  ${JSON.stringify(counts)}`);
  }

  console.log('\n-- MY: pnl, win rate, trade count, %red, giveback by weekday --');
  const dowSummary = [];
  for (let dow = 1; dow <= 5; dow++) {
    const ds = myDays.filter(d => d.dow === dow);
    const pnls = ds.map(d => d.pnl);
    const gbDays = ds.filter(d => d.giveback != null);
    const summary = {
      dow: DOW_NAMES[dow], n: ds.length,
      totalPnl: pnls.reduce((a,b)=>a+b,0), avgPnl: mean(pnls), medPnl: median(pnls),
      winRate: pct(ds.filter(d=>d.pnl>0).length, ds.length),
      avgTrades: mean(ds.map(d=>d.trades)),
      pctRed: pct(ds.filter(d=>d.red).length, ds.length),
      givebackRate: pct(gbDays.filter(d=>d.givebackSpiral).length, gbDays.length),
    };
    dowSummary.push(summary);
    console.log(`  ${summary.dow}: n=${summary.n}${nFlag(summary.n)}  totalP&L=${fmt$(summary.totalPnl)}  avg=${fmt$(summary.avgPnl)}  median=${fmt$(summary.medPnl)}  winRate=${fmtPct(summary.winRate)}  avgTrades=${summary.avgTrades?.toFixed(1)}  %red=${fmtPct(summary.pctRed)}  giveback-spiral%=${fmtPct(summary.givebackRate)} (of n=${gbDays.length})`);
  }

  console.log('\n-- MY (recent 12mo only): pnl, win rate by weekday --');
  for (let dow = 1; dow <= 5; dow++) {
    const ds = myRecent.filter(d => d.dow === dow);
    const pnls = ds.map(d => d.pnl);
    console.log(`  ${DOW_NAMES[dow]}: n=${ds.length}${nFlag(ds.length)}  totalP&L=${fmt$(pnls.reduce((a,b)=>a+b,0))}  avg=${fmt$(mean(pnls))}  winRate=${fmtPct(pct(ds.filter(d=>d.pnl>0).length, ds.length))}`);
  }

  // Rank by |avgPnl|
  const ranked = [...dowSummary].sort((a,b) => Math.abs(b.avgPnl) - Math.abs(a.avgPnl));
  console.log('\n-- Ranked by |avg P&L| --');
  ranked.forEach((s,i) => console.log(`  ${i+1}. ${s.dow}: avg=${fmt$(s.avgPnl)}  (n=${s.n})`));

  console.log('\n-- MY: "first trading day of week" (holiday-adjusted Monday-effect) vs rest --');
  {
    const firstDays = myDays.filter(d => d.isFirstOfWeek);
    const restDays = myDays.filter(d => !d.isFirstOfWeek);
    const mondaysOnly = myDays.filter(d => d.dow === 1);
    const trueMondays = firstDays.filter(d => d.dow === 1);
    const nonMondayFirsts = firstDays.filter(d => d.dow !== 1);
    console.log(`  First-of-week (any weekday): n=${firstDays.length}${nFlag(firstDays.length)}  avg=${fmt$(mean(firstDays.map(d=>d.pnl)))}  winRate=${fmtPct(pct(firstDays.filter(d=>d.pnl>0).length, firstDays.length))}`);
    console.log(`  Rest of week: n=${restDays.length}  avg=${fmt$(mean(restDays.map(d=>d.pnl)))}  winRate=${fmtPct(pct(restDays.filter(d=>d.pnl>0).length, restDays.length))}`);
    console.log(`  Calendar Monday (any week position): n=${mondaysOnly.length}${nFlag(mondaysOnly.length)}  avg=${fmt$(mean(mondaysOnly.map(d=>d.pnl)))}`);
    console.log(`  True first-of-week AND calendar Monday: n=${trueMondays.length}`);
    console.log(`  First-of-week but NOT Monday (post-holiday Tue start etc): n=${nonMondayFirsts.length}${nFlag(nonMondayFirsts.length)}  avg=${fmt$(mean(nonMondayFirsts.map(d=>d.pnl)))}`);
  }

  console.log('\n' + '='.repeat(78));
  console.log('DIMENSION 2 — MONTH OF YEAR');
  console.log('='.repeat(78));

  console.log('\n-- MARKET: avg range, %up by month (across all years) --');
  for (let m = 1; m <= 12; m++) {
    const ds = marketDays.filter(d => d.month === m);
    console.log(`  ${String(m).padStart(2,'0')}: n=${ds.length}${nFlag(ds.length)}  avgRange=${mean(ds.map(d=>d.range))?.toFixed(1)}  %up=${fmtPct(pct(ds.filter(d=>d.dir>0).length, ds.length))}`);
  }

  console.log('\n-- MY: pnl, win rate by month (across all years, n likely thin for most) --');
  for (let m = 1; m <= 12; m++) {
    const ds = myDays.filter(d => d.month === m);
    if (!ds.length) { console.log(`  ${String(m).padStart(2,'0')}: n=0`); continue; }
    console.log(`  ${String(m).padStart(2,'0')}: n=${ds.length}${nFlag(ds.length)}  totalP&L=${fmt$(ds.map(d=>d.pnl).reduce((a,b)=>a+b,0))}  avg=${fmt$(mean(ds.map(d=>d.pnl)))}  winRate=${fmtPct(pct(ds.filter(d=>d.pnl>0).length, ds.length))}`);
  }

  console.log('\n' + '='.repeat(78));
  console.log('DIMENSION 3 — SEASON / QUARTER');
  console.log('='.repeat(78));

  console.log('\n-- MARKET: avg range, %up by quarter --');
  for (let q = 1; q <= 4; q++) {
    const ds = marketDays.filter(d => d.quarter === q);
    console.log(`  Q${q}: n=${ds.length}  avgRange=${mean(ds.map(d=>d.range))?.toFixed(1)}  %up=${fmtPct(pct(ds.filter(d=>d.dir>0).length, ds.length))}`);
  }
  console.log('\n-- MY: pnl, win rate by quarter --');
  for (let q = 1; q <= 4; q++) {
    const ds = myDays.filter(d => d.quarter === q);
    console.log(`  Q${q}: n=${ds.length}${nFlag(ds.length)}  totalP&L=${fmt$(ds.map(d=>d.pnl).reduce((a,b)=>a+b,0))}  avg=${fmt$(mean(ds.map(d=>d.pnl)))}  winRate=${fmtPct(pct(ds.filter(d=>d.pnl>0).length, ds.length))}`);
  }

  // Summer (Jun-Aug) low-volume check
  console.log('\n-- MARKET: summer (Jun-Aug) vs rest — volume & range --');
  {
    const summer = marketDays.filter(d => [6,7,8].includes(d.month));
    const rest = marketDays.filter(d => ![6,7,8].includes(d.month));
    console.log(`  Summer: n=${summer.length}  avgVolume=${mean(summer.map(d=>d.volume))?.toFixed(0)}  avgRange=${mean(summer.map(d=>d.range))?.toFixed(1)}`);
    console.log(`  Rest:   n=${rest.length}  avgVolume=${mean(rest.map(d=>d.volume))?.toFixed(0)}  avgRange=${mean(rest.map(d=>d.range))?.toFixed(1)}`);
  }

  console.log('\n' + '='.repeat(78));
  console.log('DIMENSION 4 — WEEK OF MONTH (1st-5th, by day-of-month/7)');
  console.log('='.repeat(78));

  console.log('\n-- MARKET: avg range, %up by week-of-month --');
  for (let w = 1; w <= 5; w++) {
    const ds = marketDays.filter(d => d.weekOfMonth === w);
    console.log(`  Week ${w}: n=${ds.length}${nFlag(ds.length)}  avgRange=${mean(ds.map(d=>d.range))?.toFixed(1)}  %up=${fmtPct(pct(ds.filter(d=>d.dir>0).length, ds.length))}`);
  }
  console.log('\n-- MY: pnl, win rate by week-of-month --');
  for (let w = 1; w <= 5; w++) {
    const ds = myDays.filter(d => d.weekOfMonth === w);
    console.log(`  Week ${w}: n=${ds.length}${nFlag(ds.length)}  totalP&L=${fmt$(ds.map(d=>d.pnl).reduce((a,b)=>a+b,0))}  avg=${fmt$(mean(ds.map(d=>d.pnl)))}  winRate=${fmtPct(pct(ds.filter(d=>d.pnl>0).length, ds.length))}`);
  }

  // Month-end / month-start (last 2 trading days of month vs first 2)
  console.log('\n-- MARKET & MY: month-end (last 2 trading days) vs month-start (first 2) vs mid-month --');
  {
    function tagMonthPos(days) {
      const byMonth = {};
      for (const d of days) {
        const ym = d.date.slice(0,7);
        (byMonth[ym] ??= []).push(d);
      }
      for (const grp of Object.values(byMonth)) {
        grp.sort((a,b)=>a.date<b.date?-1:1);
        grp.forEach((d,i) => {
          if (i < 2) d.monthPos = 'start';
          else if (i >= grp.length-2) d.monthPos = 'end';
          else d.monthPos = 'mid';
        });
      }
    }
    tagMonthPos(marketDays);
    tagMonthPos(myDays);
    for (const pos of ['start','mid','end']) {
      const md = marketDays.filter(d=>d.monthPos===pos);
      const myd = myDays.filter(d=>d.monthPos===pos);
      console.log(`  ${pos.toUpperCase()}: MARKET n=${md.length} avgRange=${mean(md.map(d=>d.range))?.toFixed(1)} %up=${fmtPct(pct(md.filter(d=>d.dir>0).length,md.length))}  |  MY n=${myd.length}${nFlag(myd.length)} avg=${fmt$(mean(myd.map(d=>d.pnl)))} winRate=${fmtPct(pct(myd.filter(d=>d.pnl>0).length,myd.length))}`);
    }
  }

  console.log('\n' + '='.repeat(78));
  console.log('DIMENSION 5 — OPEX / TRIPLE-WITCHING WEEKS (3rd Friday of Mar/Jun/Sep/Dec)');
  console.log('  (Using THE WEEK CONTAINING the 3rd Friday of quarter-end months —');
  console.log('   a verifiable calendar fact, not an invented event date.)');
  console.log('='.repeat(78));
  {
    // Find 3rd-Friday week for each quarter-end month present in data
    function thirdFridayWeek(year, month) {
      const fridays = [];
      for (let day = 1; day <= 31; day++) {
        const d = new Date(Date.UTC(year, month-1, day));
        if (d.getUTCMonth() !== month-1) break;
        if (d.getUTCDay() === 5) fridays.push(d);
      }
      if (fridays.length < 3) return null;
      return isoWeekKey(fridays[2].toISOString().slice(0,10));
    }
    const opexWeeks = new Set();
    const years = new Set(myDays.map(d=>d.year).concat(marketDays.map(d=>d.year)));
    for (const y of years) for (const m of [3,6,9,12]) {
      const wk = thirdFridayWeek(y, m);
      if (wk) opexWeeks.add(wk);
    }
    const mdOpex = marketDays.filter(d=>opexWeeks.has(d.isoWeek));
    const mdOther = marketDays.filter(d=>!opexWeeks.has(d.isoWeek));
    const myOpex = myDays.filter(d=>opexWeeks.has(d.isoWeek));
    const myOther = myDays.filter(d=>!opexWeeks.has(d.isoWeek));
    console.log(`  OPEX weeks: MARKET n=${mdOpex.length}${nFlag(mdOpex.length)} avgRange=${mean(mdOpex.map(d=>d.range))?.toFixed(1)} avgVol=${mean(mdOpex.map(d=>d.volume))?.toFixed(0)}  |  MY n=${myOpex.length}${nFlag(myOpex.length)} avg=${fmt$(mean(myOpex.map(d=>d.pnl)))} winRate=${fmtPct(pct(myOpex.filter(d=>d.pnl>0).length,myOpex.length))}`);
    console.log(`  Other weeks: MARKET n=${mdOther.length} avgRange=${mean(mdOther.map(d=>d.range))?.toFixed(1)} avgVol=${mean(mdOther.map(d=>d.volume))?.toFixed(0)}  |  MY n=${myOther.length} avg=${fmt$(mean(myOther.map(d=>d.pnl)))} winRate=${fmtPct(pct(myOther.filter(d=>d.pnl>0).length,myOther.length))}`);
  }

  console.log('\n' + '='.repeat(78));
  console.log('DIMENSION 6 — INTRA-WEEK PROGRESSION (cumulative P&L by position in week)');
  console.log('='.repeat(78));
  {
    const byPos = {};
    for (const d of myDays) (byPos[d.weekPos] ??= []).push(d);
    console.log('\n-- MY: avg P&L by position-in-week (0=first trading day, up to 4) --');
    for (let p = 0; p <= 4; p++) {
      const ds = byPos[p] || [];
      if (!ds.length) continue;
      console.log(`  Pos ${p}: n=${ds.length}${nFlag(ds.length)}  avg=${fmt$(mean(ds.map(d=>d.pnl)))}  winRate=${fmtPct(pct(ds.filter(d=>d.pnl>0).length,ds.length))}  %red=${fmtPct(pct(ds.filter(d=>d.red).length,ds.length))}`);
    }
    // Within-week running cumulative: for weeks with exactly 5 sessions, average cumulative P&L curve
    const byWeek = {};
    for (const d of myDays) (byWeek[d.isoWeek] ??= []).push(d);
    const fullWeeks = Object.values(byWeek).filter(w => w.length === 5).map(w => [...w].sort((a,b)=>a.date<b.date?-1:1));
    console.log(`\n-- MY: avg cumulative P&L curve across Mon-Fri full weeks (n=${fullWeeks.length} weeks)${nFlag(fullWeeks.length)} --`);
    if (fullWeeks.length) {
      for (let p = 0; p < 5; p++) {
        const cumAtP = fullWeeks.map(w => w.slice(0,p+1).reduce((a,d)=>a+d.pnl,0));
        console.log(`  Through day ${p+1}: avg cumulative=${fmt$(mean(cumAtP))}`);
      }
    }
  }

  console.log('\n' + '='.repeat(78));
  console.log('DIMENSION 7 — POST-WEEKEND / POST-HOLIDAY (gap > 1 calendar day before session)');
  console.log('='.repeat(78));
  {
    const mdGap = marketDays.filter(d=>d.postGap);
    const mdNoGap = marketDays.filter(d=>!d.postGap);
    const myGap = myDays.filter(d=>d.postGap);
    const myNoGap = myDays.filter(d=>!d.postGap);
    console.log(`\n-- MARKET: post-gap vs normal --`);
    console.log(`  Post-gap: n=${mdGap.length}  avgRange=${mean(mdGap.map(d=>d.range))?.toFixed(1)}  %up=${fmtPct(pct(mdGap.filter(d=>d.dir>0).length,mdGap.length))}`);
    console.log(`  Normal:   n=${mdNoGap.length}  avgRange=${mean(mdNoGap.map(d=>d.range))?.toFixed(1)}  %up=${fmtPct(pct(mdNoGap.filter(d=>d.dir>0).length,mdNoGap.length))}`);
    console.log(`\n-- MY: post-gap vs normal --`);
    console.log(`  Post-gap: n=${myGap.length}${nFlag(myGap.length)}  avg=${fmt$(mean(myGap.map(d=>d.pnl)))}  winRate=${fmtPct(pct(myGap.filter(d=>d.pnl>0).length,myGap.length))}  avgTrades=${mean(myGap.map(d=>d.trades))?.toFixed(1)}`);
    console.log(`  Normal:   n=${myNoGap.length}  avg=${fmt$(mean(myNoGap.map(d=>d.pnl)))}  winRate=${fmtPct(pct(myNoGap.filter(d=>d.pnl>0).length,myNoGap.length))}  avgTrades=${mean(myNoGap.map(d=>d.trades))?.toFixed(1)}`);

    // Break out 2-day gaps (weekend) vs 3+ day gaps (long weekend/holiday)
    const weekendOnly = myDays.filter(d=>d.gapDays===2);
    const longGap = myDays.filter(d=>d.gapDays>2);
    console.log(`\n  MY weekend-gap (2 days) only: n=${weekendOnly.length}${nFlag(weekendOnly.length)}  avg=${fmt$(mean(weekendOnly.map(d=>d.pnl)))}  winRate=${fmtPct(pct(weekendOnly.filter(d=>d.pnl>0).length,weekendOnly.length))}`);
    console.log(`  MY long-gap (3+ days, e.g. holiday): n=${longGap.length}${nFlag(longGap.length)}  avg=${fmt$(mean(longGap.map(d=>d.pnl)))}  winRate=${fmtPct(pct(longGap.filter(d=>d.pnl>0).length,longGap.length))}`);
  }

  console.log('\n[temporal_pattern_backtest] Done. No writes performed.\n');
}

main().then(()=>process.exit(0)).catch(err=>{console.error(err); process.exit(1);});
