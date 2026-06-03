/**
 * Day-type retrospective performance analysis + classification accuracy
 * 60-day window, all accounts (sim + live noted), intraday + EOD truth classification
 */
import { query } from '../server/db.js';

// ── Opening type (mirrors caseEngine.js) ─────────────────────────────────────
function classifyOpeningType(bars) {
  if (bars.length < 5) return 'FORMING';
  const first5  = bars.slice(0, 5);
  const open    = Number(first5[0].open);
  const close5  = Number(first5[4].close);
  const high5   = Math.max(...first5.map(b => Number(b.high)));
  const low5    = Math.min(...first5.map(b => Number(b.low)));
  const range5  = high5 - low5;
  const drift   = close5 - open;
  const driveLong  = drift >  20 && first5.every((b,i) => i===0 || Number(b.low)  >= Number(first5[i-1].low)  - 3);
  const driveShort = drift < -20 && first5.every((b,i) => i===0 || Number(b.high) <= Number(first5[i-1].high) + 3);
  if (driveLong)  return 'OPEN_DRIVE_LONG';
  if (driveShort) return 'OPEN_DRIVE_SHORT';
  if (Math.abs(drift) < 12 && range5 < 35) return 'OPEN_AUCTION';
  if (range5 > 18) {
    if (low5 < open - 8  && close5 > open + 8)  return 'OPEN_TEST_DRIVE_LONG';
    if (high5 > open + 8 && close5 < open - 8)  return 'OPEN_TEST_DRIVE_SHORT';
  }
  return 'OPEN_BALANCED';
}

// ── Intraday classifier (mirrors caseEngine.js classifyDayType) ───────────────
function classifyIntraday(openingType, nl30, orWidth) {
  const isDrive   = openingType.startsWith('OPEN_DRIVE');
  const isAuction = openingType === 'OPEN_AUCTION';
  const nlBull    = nl30 > 9;
  const nlBear    = nl30 < -9;
  const wideOR    = (orWidth || 0) > 80;
  const narrowOR  = (orWidth || 0) < 40;
  if (isDrive && (nlBull || nlBear) && wideOR) return 'TREND';
  if (isAuction || (narrowOR && !isDrive))      return 'BALANCE';
  if (wideOR && !isDrive)                       return 'TURBULENT';
  return 'BALANCE';
}

// ── EOD truth classifier ──────────────────────────────────────────────────────
// Rules (stated clearly in output):
//   TREND     = close in outer 22% of range AND range>180 AND trend_strength>0.35
//   TURBULENT = range>270 AND trend_strength<0.32 (wide, no directional resolution)
//   BALANCE   = all others
function classifyEOD(sessRange, closePct, trendStrength) {
  const bigRange  = sessRange > 270;
  const wideRange = sessRange > 180;
  const trendClose = closePct > 0.78 || closePct < 0.22;
  const directional = trendStrength > 0.35;
  if (trendClose && wideRange && directional) return 'TREND';
  if (bigRange && !directional)               return 'TURBULENT';
  return 'BALANCE';
}

// ── Main analysis ─────────────────────────────────────────────────────────────
const START = new Date(Date.now() - 63 * 86400000).toISOString().slice(0,10);
const END   = new Date(Date.now() - 86400000).toISOString().slice(0,10);

console.log(`\n${'═'.repeat(72)}`);
console.log('NQ DAY-TYPE RETROSPECTIVE ANALYSIS');
console.log(`Window: ${START} → ${END}`);
console.log(`${'═'.repeat(72)}\n`);

// ── 1. Load all bar data for the window ───────────────────────────────────────
const barsQ = await query(`
  SELECT ts::date::text as day,
    ts, open::float, high::float, low::float, close::float, volume::float,
    EXTRACT(hour FROM ts AT TIME ZONE 'America/New_York')*60 +
      EXTRACT(minute FROM ts AT TIME ZONE 'America/New_York') as et_min
  FROM price_bars
  WHERE symbol='NQ' AND ts::date >= $1 AND ts::date <= $2
    AND EXTRACT(hour FROM ts AT TIME ZONE 'America/New_York') BETWEEN 9 AND 15
  ORDER BY ts
`, [START, END]);

const barsByDay = {};
for (const b of barsQ.rows) {
  if (!barsByDay[b.day]) barsByDay[b.day] = [];
  barsByDay[b.day].push(b);
}

// ── 2. ACD data + NL30 rolling ────────────────────────────────────────────────
const acdQ = await query(`
  SELECT trade_date::text as d, or_high::float, or_low::float, daily_score::float
  FROM acd_daily_log WHERE trade_date >= $1::date - INTERVAL '35 days' AND trade_date <= $2
  ORDER BY trade_date
`, [START, END]);
const acdByDay    = Object.fromEntries(acdQ.rows.map(r => [r.d, r]));
const scoresSorted = acdQ.rows.map(r => ({ d: r.d, score: Number(r.daily_score) || 0 }));

function getNL30(day) {
  const prior = scoresSorted.filter(r => r.d < day).slice(-30);
  return prior.reduce((s, r) => s + r.score, 0);
}

// ── 3. Correct daily P&L via CumPL diff (server SQL pattern) ──────────────────
const pnlQ = await query(`
  WITH ep_fills AS (
    SELECT log_date::text as log_date, exit_time, custom_fields->>'account' as account,
      CASE WHEN custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)?$'
      THEN (custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)')::numeric ELSE NULL END as cum_pl
    FROM trades
    WHERE custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'
      AND exit_time IS NOT NULL AND log_date >= $1 AND log_date <= $2
  ),
  last_ep_per_day AS (
    SELECT DISTINCT ON (log_date, account) log_date, account, cum_pl
    FROM ep_fills ORDER BY log_date, account, exit_time DESC
  ),
  daily_per_acct AS (
    SELECT log_date, account, cum_pl,
      cum_pl - COALESCE(LAG(cum_pl) OVER (PARTITION BY account ORDER BY log_date), cum_pl) as day_pnl
    FROM last_ep_per_day WHERE cum_pl IS NOT NULL
  )
  SELECT log_date, SUM(day_pnl) as net_pnl, COUNT(DISTINCT account) as n_accts
  FROM daily_per_acct GROUP BY log_date ORDER BY log_date
`, [START, END]);
const pnlMap = Object.fromEntries(pnlQ.rows.map(r => [r.log_date, { net: parseFloat(r.net_pnl), nAccts: parseInt(r.n_accts) }]));

// ── 4. Session-level P&L for intraday equity curve (FlatToFlat per EP fill) ───
const sessQ = await query(`
  SELECT log_date::text as day, exit_time,
    TRIM(TRAILING 'F' FROM TRIM(custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)'))::numeric as flat_pnl,
    EXTRACT(hour FROM exit_time AT TIME ZONE 'America/New_York') as exit_h_et,
    EXTRACT(minute FROM exit_time AT TIME ZONE 'America/New_York') as exit_m_et
  FROM trades
  WHERE custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'
    AND exit_time IS NOT NULL
    AND custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)' IS NOT NULL
    AND log_date >= $1 AND log_date <= $2
  ORDER BY log_date, exit_time
`, [START, END]);

const sessMap = {};
for (const r of sessQ.rows) {
  if (!sessMap[r.day]) sessMap[r.day] = [];
  sessMap[r.day].push({ time: r.exit_time, pnl: parseFloat(r.flat_pnl) || 0, hET: Number(r.exit_h_et), mET: Number(r.exit_m_et) });
}

// ── 5. Fill-level stats (fill count, contracts, timing) ──────────────────────
const fillsQ = await query(`
  SELECT log_date::text as day, COUNT(*) as fills,
    MAX(quantity) as max_qty,
    AVG(quantity::float) as avg_qty,
    MAX(EXTRACT(hour FROM exit_time AT TIME ZONE 'America/New_York')) as max_exit_h,
    MAX(EXTRACT(hour FROM exit_time AT TIME ZONE 'America/New_York')*60 +
        EXTRACT(minute FROM exit_time AT TIME ZONE 'America/New_York')) as max_exit_min_et,
    MAX(EXTRACT(hour FROM exit_time AT TIME ZONE 'America/New_York')::text || ':' ||
        LPAD(EXTRACT(minute FROM exit_time AT TIME ZONE 'America/New_York')::text, 2, '0')) as last_exit_hhmm,
    COUNT(DISTINCT custom_fields->>'account') as n_accts,
    BOOL_OR(custom_fields->>'account' LIKE '%PRO%') as has_live
  FROM trades WHERE exit_time IS NOT NULL AND log_date >= $1 AND log_date <= $2
  GROUP BY log_date ORDER BY log_date
`, [START, END]);
const fillsMap = Object.fromEntries(fillsQ.rows.map(r => [r.day, r]));

// ── 6. Classify and analyze each day ─────────────────────────────────────────
const days = [];
for (const [day, bars] of Object.entries(barsByDay)) {
  if (bars.length < 200) continue;

  const rthBars = bars.filter(b => b.et_min >= 570 && b.et_min <= 960);
  const orBars  = bars.filter(b => b.et_min >= 570 && b.et_min < 600);
  const ibBars  = bars.filter(b => b.et_min >= 570 && b.et_min < 630);
  if (orBars.length < 5) continue;

  const openingType = classifyOpeningType(orBars);
  const acd   = acdByDay[day];
  const orHigh = acd?.or_high || Math.max(...orBars.map(b => b.high));
  const orLow  = acd?.or_low  || Math.min(...orBars.map(b => b.low));
  const orWidth = orHigh - orLow;
  const nl30  = getNL30(day);

  // Intraday classification (engine logic, ~10:30-11 AM context)
  const intradayType = classifyIntraday(openingType, nl30, orWidth);

  // Full session EOD stats
  const sessHigh  = Math.max(...rthBars.map(b => b.high));
  const sessLow   = Math.min(...rthBars.map(b => b.low));
  const sessRange = sessHigh - sessLow;
  const sessOpen  = rthBars[0]?.open || rthBars[0]?.close;
  const sessClose = rthBars[rthBars.length - 1]?.close;
  const closePct  = sessRange > 0 ? (sessClose - sessLow) / sessRange : 0.5;
  const trendStr  = sessRange > 0 ? Math.abs(sessClose - sessOpen) / sessRange : 0;
  const eodType   = classifyEOD(sessRange, closePct, trendStr);

  // P&L
  const pnlRow = pnlMap[day];
  const netPnL = pnlRow?.net || 0;

  // Intraday equity curve from session-level flat P&L
  const sessions = sessMap[day] || [];
  let running = 0, peakEquity = 0, peakSessionIdx = -1;
  for (let i = 0; i < sessions.length; i++) {
    running += sessions[i].pnl;
    if (running > peakEquity) { peakEquity = running; peakSessionIdx = i; }
  }
  const giveBack = Math.max(0, peakEquity - netPnL);
  const peakSess = peakSessionIdx >= 0 ? sessions[peakSessionIdx] : null;
  const peakHET  = peakSess ? `${peakSess.hET}:${String(peakSess.mET).padStart(2,'0')}` : null;
  const peakBeforeNoon = peakSess ? peakSess.hET < 12 : false;

  // Fill stats
  const fillRow = fillsMap[day];
  const fills    = fillRow ? parseInt(fillRow.fills) : 0;
  const maxContracts = fillRow ? parseInt(fillRow.max_qty) : 0;
  const avgContracts = fillRow ? Math.round(parseFloat(fillRow.avg_qty) * 10) / 10 : 0;
  const lastExitHHMM = fillRow?.last_exit_hhmm || null;
  const tradedPastWindow = fillRow ? parseInt(fillRow.max_exit_min_et) > 780 : false; // after 1 PM = min > 780
  const hasLive = fillRow?.has_live || false;

  // Session win rate
  const winSessions    = sessions.filter(s => s.pnl > 0).length;
  const totalSessions  = sessions.length;
  const winRate = totalSessions > 0 ? winSessions / totalSessions : null;

  days.push({
    day, fills, netPnL, peakEquity, giveBack,
    winRate, winSessions, totalSessions,
    maxContracts, avgContracts,
    intradayType, eodType, match: intradayType === eodType,
    openingType, orWidth: Math.round(orWidth), nl30,
    sessRange: Math.round(sessRange), closePct: Math.round(closePct * 100),
    trendStr: Math.round(trendStr * 100),
    lastExitHHMM, tradedPastWindow, peakHET, peakBeforeNoon, hasLive,
  });
}

days.sort((a, b) => a.day.localeCompare(b.day));
const tradingDays = days.filter(d => d.fills > 0);

// ── STEP 1+2: Per-day table ────────────────────────────────────────────────────
console.log('STEP 1+2: DAY-BY-DAY CLASSIFICATION & STATS');
console.log('─'.repeat(128));
console.log('Date       OR    NL30  Opening Type          Intraday  EOD      M?  Acct  Fills  Net P&L   Peak$  GiveBack  PastWin  Last');
console.log('─'.repeat(128));
for (const d of days) {
  const m     = d.match ? '✓' : '✗';
  const pnl   = d.fills > 0 ? `$${d.netPnL >= 0 ? '+' : ''}${d.netPnL.toFixed(0)}` : 'no trade';
  const peak  = d.fills > 0 ? `$${d.peakEquity.toFixed(0)}` : '';
  const gb    = d.fills > 0 ? `$${d.giveBack.toFixed(0)}` : '';
  const pw    = d.tradedPastWindow ? '⚠ YES' : '     ';
  const acct  = d.hasLive ? 'LIVE' : 'sim ';
  console.log(
    `${d.day} ${String(d.orWidth).padStart(4)}  ${String(d.nl30).padStart(4)}  ${d.openingType.padEnd(21)} ${d.intradayType.padEnd(9)} ${d.eodType.padEnd(8)} ${m}   ${acct}  ${String(d.fills).padStart(5)}  ${pnl.padStart(9)}  ${peak.padStart(6)}  ${gb.padStart(8)}  ${pw}    ${d.lastExitHHMM||''}`
  );
}

// ── STEP 3: Aggregate by day type ─────────────────────────────────────────────
console.log('\n\nSTEP 3: AGGREGATE BY DAY TYPE (intraday classification)');
const byType = {};
for (const d of tradingDays) {
  const t = d.intradayType;
  if (!byType[t]) byType[t] = [];
  byType[t].push(d);
}

for (const [typ, ds] of Object.entries(byType)) {
  const n          = ds.length;
  const totalPnL   = ds.reduce((s,d)=>s+d.netPnL,0);
  const avgPnL     = totalPnL / n;
  const winDays    = ds.filter(d=>d.netPnL>0).length;
  const winDayRate = winDays/n*100;
  const avgGB      = ds.reduce((s,d)=>s+d.giveBack,0)/n;
  const avgFills   = ds.reduce((s,d)=>s+d.fills,0)/n;
  const avgMaxC    = ds.reduce((s,d)=>s+d.maxContracts,0)/n;
  const pastWin    = ds.filter(d=>d.tradedPastWindow).length;
  const gbDays     = ds.filter(d=>d.giveBack>200).length;
  const top3W      = [...ds].sort((a,b)=>b.netPnL-a.netPnL).slice(0,3).map(d=>`${d.day}($${d.netPnL.toFixed(0)})`).join(', ');
  const top3L      = [...ds].sort((a,b)=>a.netPnL-b.netPnL).slice(0,3).map(d=>`${d.day}($${d.netPnL.toFixed(0)})`).join(', ');
  const gbWorst    = ds.filter(d=>d.giveBack>200).sort((a,b)=>b.giveBack-a.giveBack).slice(0,2).map(d=>`${d.day}(peak+$${d.peakEquity.toFixed(0)}→$${d.netPnL.toFixed(0)})`).join(', ');

  console.log(`\n── ${typ} (n=${n} trading days) ──`);
  console.log(`  Total P&L:      $${totalPnL.toFixed(0)} | Avg/day: $${avgPnL.toFixed(0)} | Win-day rate: ${winDayRate.toFixed(0)}% (${winDays}/${n})`);
  console.log(`  Avg give-back:  $${avgGB.toFixed(0)} | Days with $200+ give-back: ${gbDays}`);
  if (gbWorst) console.log(`    Worst GB days: ${gbWorst}`);
  console.log(`  Avg fills/day:  ${avgFills.toFixed(1)} | Avg max contracts: ${avgMaxC.toFixed(1)}`);
  console.log(`  Traded past 1PM:${pastWin}/${n} days (${(pastWin/n*100).toFixed(0)}%)`);
  console.log(`  Top 3 winners:  ${top3W}`);
  console.log(`  Top 3 losers:   ${top3L}`);
}

// ── STEP 4: THE STORY ─────────────────────────────────────────────────────────
console.log('\n\nSTEP 4: THE STORY');
console.log('─'.repeat(72));

// 4a
const typeStats = {};
for (const [typ, ds] of Object.entries(byType)) {
  const total = ds.reduce((s,d)=>s+d.netPnL,0);
  const avg   = total/ds.length;
  const wr    = ds.filter(d=>d.netPnL>0).length/ds.length*100;
  typeStats[typ] = { total, avg, wr, n: ds.length, days: ds };
}
const sorted = Object.entries(typeStats).sort((a,b)=>b[1].avg-a[1].avg);
console.log('\na) MOST PROFITABLE DAY TYPE (avg $/day):');
sorted.forEach(([t,s]) => console.log(`   ${t.padEnd(12)}: avg $${s.avg.toFixed(0)}/day | total $${s.total.toFixed(0)} | ${s.wr.toFixed(0)}% win-days | n=${s.n}`));

// 4b
console.log('\nb) GIVE-BACK BLEEDING (which type gives it back?):');
for (const [t,s] of sorted) {
  const avgGB = s.days.reduce((x,d)=>x+d.giveBack,0)/s.n;
  const highGB = s.days.filter(d=>d.giveBack>300).length;
  const pct    = (highGB/s.n*100).toFixed(0);
  const gbUp   = s.days.filter(d=>d.netPnL<0 && d.peakEquity>100);
  console.log(`   ${t.padEnd(12)}: avg give-back=$${avgGB.toFixed(0)} | ${pct}% of days gave back $300+`);
  if (gbUp.length) {
    gbUp.sort((a,b)=>b.giveBack-a.giveBack).slice(0,3).forEach(d =>
      console.log(`     ↳ ${d.day}: was up +$${d.peakEquity.toFixed(0)}, closed $${d.netPnL.toFixed(0)} → gave back $${d.giveBack.toFixed(0)}`));
  }
}

// 4c
const winDays = tradingDays.filter(d=>d.netPnL>300).sort((a,b)=>b.netPnL-a.netPnL);
console.log(`\nc) WINNING DAYS (P&L>$300, n=${winDays.length}):`);
console.log('   Date        P&L     Type       OR   Fills MaxC  GiveBack  Late? PeakHour');
for (const d of winDays.slice(0,15)) {
  const late = d.tradedPastWindow ? '⚠' : ' ';
  console.log(`   ${d.day}  $${String(d.netPnL.toFixed(0)).padStart(5)}  ${d.intradayType.padEnd(10)} ${String(d.orWidth).padStart(4)} ${String(d.fills).padStart(5)}  ${d.maxContracts}  $${d.giveBack.toFixed(0).padStart(6)}  ${late}     ${d.peakHET||'--'}`);
}
const winTypes = {}; winDays.forEach(d=>{ winTypes[d.intradayType]=(winTypes[d.intradayType]||0)+1; });
const wAvgFills = winDays.length ? winDays.reduce((s,d)=>s+d.fills,0)/winDays.length : 0;
const wAvgGB    = winDays.length ? winDays.reduce((s,d)=>s+d.giveBack,0)/winDays.length : 0;
const wPastWin  = winDays.filter(d=>d.tradedPastWindow).length;
console.log(`   Type mix: ${Object.entries(winTypes).map(([k,v])=>`${k}(${v})`).join(' ')}`);
console.log(`   Avg fills: ${wAvgFills.toFixed(1)} | Avg give-back: $${wAvgGB.toFixed(0)} | Past 1PM: ${wPastWin}/${winDays.length}`);

// 4d
const lossDays = tradingDays.filter(d=>d.netPnL<-300).sort((a,b)=>a.netPnL-b.netPnL);
console.log(`\nd) WORST DAYS (P&L<-$300, n=${lossDays.length}):`);
console.log('   Date        P&L     Type       OR   Fills MaxC  GiveBack  Late? PeakHour');
for (const d of lossDays.slice(0,15)) {
  const late = d.tradedPastWindow ? '⚠' : ' ';
  console.log(`   ${d.day}  $${String(d.netPnL.toFixed(0)).padStart(6)}  ${d.intradayType.padEnd(10)} ${String(d.orWidth).padStart(4)} ${String(d.fills).padStart(5)}  ${d.maxContracts}  $${d.giveBack.toFixed(0).padStart(6)}  ${late}     ${d.peakHET||'--'}`);
}
const lossTypes = {}; lossDays.forEach(d=>{ lossTypes[d.intradayType]=(lossTypes[d.intradayType]||0)+1; });
const lAvgFills = lossDays.length ? lossDays.reduce((s,d)=>s+d.fills,0)/lossDays.length : 0;
const lAvgGB    = lossDays.length ? lossDays.reduce((s,d)=>s+d.giveBack,0)/lossDays.length : 0;
const lPastWin  = lossDays.filter(d=>d.tradedPastWindow).length;
console.log(`   Type mix: ${Object.entries(lossTypes).map(([k,v])=>`${k}(${v})`).join(' ')}`);
console.log(`   Avg fills: ${lAvgFills.toFixed(1)} | Avg give-back: $${lAvgGB.toFixed(0)} | Past 1PM: ${lPastWin}/${lossDays.length}`);

// 4e
console.log('\ne) "UP EARLY, GAVE IT BACK" (peak before noon, give-back ≥ $200):');
const earlyGiveBack = tradingDays.filter(d=>d.peakBeforeNoon && d.giveBack>=200 && d.peakEquity>0);
if (!earlyGiveBack.length) {
  console.log('   None detected in session-level resolution.');
  const gbTrade = tradingDays.filter(d=>d.giveBack>=200).sort((a,b)=>b.giveBack-a.giveBack);
  if (gbTrade.length) {
    console.log(`   Days with $200+ give-back (all times, n=${gbTrade.length}):`);
    gbTrade.slice(0,8).forEach(d=>
      console.log(`   ${d.day}: peak +$${d.peakEquity.toFixed(0)} at ${d.peakHET}, closed $${d.netPnL.toFixed(0)}, GB=$${d.giveBack.toFixed(0)} [${d.intradayType}]`));
  }
} else {
  earlyGiveBack.sort((a,b)=>b.giveBack-a.giveBack).forEach(d=>
    console.log(`   ${d.day}: was +$${d.peakEquity.toFixed(0)} before noon at ${d.peakHET}, closed $${d.netPnL.toFixed(0)}, GB=$${d.giveBack.toFixed(0)} [${d.intradayType}]`));
}

// ── STEP 5: Cross-check vs engine edge ────────────────────────────────────────
console.log('\n\nSTEP 5: CROSS-CHECK vs ENGINE EDGE THESIS');
console.log('Engine: TURBULENT/TREND = +1 impact edge, BALANCE = -3 anti-edge (0% T1, n=7 INTERIM)');
const edgeDays    = tradingDays.filter(d=>d.intradayType==='TURBULENT'||d.intradayType==='TREND');
const antiDays    = tradingDays.filter(d=>d.intradayType==='BALANCE');
const edgeAvg     = edgeDays.length ? edgeDays.reduce((s,d)=>s+d.netPnL,0)/edgeDays.length : null;
const antiAvg     = antiDays.length ? antiDays.reduce((s,d)=>s+d.netPnL,0)/antiDays.length : null;
const edgeWR      = edgeDays.length ? edgeDays.filter(d=>d.netPnL>0).length/edgeDays.length*100 : null;
const antiWR      = antiDays.length ? antiDays.filter(d=>d.netPnL>0).length/antiDays.length*100 : null;
const edgeTotal   = edgeDays.reduce((s,d)=>s+d.netPnL,0);
const antiTotal   = antiDays.reduce((s,d)=>s+d.netPnL,0);
console.log(`\n  TREND+TURBULENT (edge)  : n=${edgeDays.length}, total=$${edgeTotal.toFixed(0)}, avg=$${(edgeAvg||0).toFixed(0)}/day, WD=${(edgeWR||0).toFixed(0)}%`);
console.log(`  BALANCE (anti-edge)     : n=${antiDays.length}, total=$${antiTotal.toFixed(0)}, avg=$${(antiAvg||0).toFixed(0)}/day, WD=${(antiWR||0).toFixed(0)}%`);
if (edgeAvg != null && antiAvg != null) {
  const edgeBetter  = edgeAvg > antiAvg;
  const antiNegative = antiAvg < 0;
  if (edgeBetter && antiNegative)
    console.log('  VERDICT: ✓ CONFIRMED — Edge days outperform. Balance days negative. Thesis holds.');
  else if (edgeBetter)
    console.log('  VERDICT: ✓ PARTIALLY CONFIRMED — Edge days outperform, but Balance not negative (small sample?)');
  else
    console.log('  VERDICT: ✗ CONTRADICTED — Balance days actually outperform edge days in this window.');
}

// ── CLASSIFICATION ACCURACY ────────────────────────────────────────────────────
console.log(`\n\n${'═'.repeat(72)}`);
console.log('CLASSIFICATION ACCURACY: INTRADAY CALL vs EOD TRUTH');
console.log(`${'═'.repeat(72)}`);
console.log('\nINTRADAY RULES (engine logic, ~10:30 AM perspective):');
console.log('  TREND     = Open Drive + NL30 > ±9 + OR > 80pts');
console.log('  BALANCE   = Open Auction | OR < 40 and no Drive | default');
console.log('  TURBULENT = OR > 80pts and no Open Drive');
console.log('\nEOD TRUTH RULES (full-session outcome):');
console.log('  TREND     = close in outer 22% of range AND range>180pts AND |close-open|/range>0.35');
console.log('  TURBULENT = range>270pts AND |close-open|/range<0.32 (wide, no clean direction)');
console.log('  BALANCE   = all others (moderate range, close near middle, weak direction)');

const totalDays = days.length;
const matches   = days.filter(d=>d.match).length;
console.log(`\nOVERALL ACCURACY: ${matches}/${totalDays} = ${(matches/totalDays*100).toFixed(0)}%`);

console.log('\nACCURACY BY INTRADAY CALL:');
for (const called of ['TREND','TURBULENT','BALANCE']) {
  const sub = days.filter(d=>d.intradayType===called);
  if (!sub.length) continue;
  const correct = sub.filter(d=>d.eodType===called).length;
  const pct = (correct/sub.length*100).toFixed(0);
  console.log(`  Called ${called.padEnd(10)}: ${correct}/${sub.length} correct (${pct}%)`);
  const misses = {};
  sub.filter(d=>d.eodType!==called).forEach(d=>{ misses[d.eodType]=(misses[d.eodType]||0)+1; });
  Object.entries(misses).forEach(([t,n])=>console.log(`    ↳ became ${t}: ${n} times`));
}

console.log('\nACCURACY BY EOD TRUTH:');
for (const truth of ['TREND','TURBULENT','BALANCE']) {
  const sub = days.filter(d=>d.eodType===truth);
  if (!sub.length) continue;
  const correct = sub.filter(d=>d.intradayType===truth).length;
  const pct = (correct/sub.length*100).toFixed(0);
  console.log(`  Truth ${truth.padEnd(10)}: correctly called ${correct}/${sub.length} (${pct}%)`);
  const misses = {};
  sub.filter(d=>d.intradayType!==truth).forEach(d=>{ misses[d.intradayType]=(misses[d.intradayType]||0)+1; });
  Object.entries(misses).forEach(([t,n])=>console.log(`    ↳ was called ${t}: ${n} times`));
}

console.log('\nMISCLASSIFICATION DETAIL:');
console.log('Date        Called      EOD-Truth  OR   NL30  Range ClsPct TrStr  P&L        Fills');
const mismatches = days.filter(d=>!d.match);
for (const d of mismatches) {
  const pnl = d.fills > 0 ? `$${d.netPnL>=0?'+':''}${d.netPnL.toFixed(0)}` : 'no trades';
  console.log(`${d.day}  ${d.intradayType.padEnd(11)} ${d.eodType.padEnd(10)} ${String(d.orWidth).padStart(4)} ${String(d.nl30).padStart(4)}  ${String(d.sessRange).padStart(4)} ${String(d.closePct).padStart(5)}%  ${String(d.trendStr).padStart(3)}%  ${pnl.padStart(9)}   ${d.fills}`);
}

console.log('\nTHE COST QUESTION: P&L on mismatch vs match TRADING days:');
const matchT    = tradingDays.filter(d=>d.match);
const mismatchT = tradingDays.filter(d=>!d.match);
if (matchT.length && mismatchT.length) {
  const mAvg  = matchT.reduce((s,d)=>s+d.netPnL,0)/matchT.length;
  const mmAvg = mismatchT.reduce((s,d)=>s+d.netPnL,0)/mismatchT.length;
  const mWR   = matchT.filter(d=>d.netPnL>0).length/matchT.length*100;
  const mmWR  = mismatchT.filter(d=>d.netPnL>0).length/mismatchT.length*100;
  console.log(`  Correctly classified: n=${matchT.length}, avg=$${mAvg.toFixed(0)}/day, WD=${mWR.toFixed(0)}%`);
  console.log(`  Misclassified:        n=${mismatchT.length}, avg=$${mmAvg.toFixed(0)}/day, WD=${mmWR.toFixed(0)}%`);
  const gap = mmAvg - mAvg;
  console.log(`  Gap: $${gap.toFixed(0)}/day ${gap < -50 ? '← WORSE on mismatch days ✗' : gap > 50 ? '← BETTER on mismatch days (surprising)' : '← negligible'}`);
}

console.log('\n  By mismatch type (trading days):');
const mPairs = {};
mismatchT.forEach(d=>{ const k=`${d.intradayType}→${d.eodType}`; if(!mPairs[k])mPairs[k]={n:0,pnl:0}; mPairs[k].n++; mPairs[k].pnl+=d.netPnL; });
for (const [pair, v] of Object.entries(mPairs)) {
  const avg = v.pnl/v.n;
  const days_ = mismatchT.filter(d=>`${d.intradayType}→${d.eodType}`===pair).slice(0,3).map(d=>`${d.day}($${d.netPnL.toFixed(0)})`).join(', ');
  console.log(`  ${pair.padEnd(26)}: n=${v.n}, avg=$${avg.toFixed(0)}/day | ${days_}`);
  if (pair==='TURBULENT→BALANCE')  console.log(`    ↳ Called turbulent, settled into balance — likely held for big moves that never came`);
  if (pair==='BALANCE→TREND')      console.log(`    ↳ Called balance, actually trended — likely faded extremes & got run over`);
  if (pair==='TURBULENT→TREND')    console.log(`    ↳ Called turbulent, actually trended — had the right volatility read, but no-drive OR lowered conviction`);
}

console.log('\n\n' + '═'.repeat(72));
console.log('METHODOLOGY NOTES');
console.log('─'.repeat(72));
console.log('P&L:        CumPL diff per account (last EP fill CumPL - prior day) summed.');
console.log('            March 31 shows $0 — first day of window, no prior baseline.');
console.log('Intraday equity: FlatToFlat P&L on each EP fill (session-level snapshots).');
console.log('  Peak/give-back = max of running session-sum vs close. Intra-session peaks');
console.log('  (e.g. stopped out mid-session) are not captured — give-back is a lower bound.');
console.log('Accounts:   All accounts included (sim + live). [LIVE] = PRO prefix account.');
console.log('  P&L is prop firm sim dollars on sim days, real on LIVE days.');
console.log('Sample:     ~60 trading days. Directional patterns only — small n per type.');
console.log('Day labels: Retroactively classified from bar data. Not what showed live.');
console.log('═'.repeat(72) + '\n');

process.exit(0);
