/**
 * monday_morning_texture_backtest.js
 *
 * REPORT ONLY — no writes, no live logic changed.
 *
 * Isolates the FIRST HOUR (9:30-10:30 ET) 1-min bar texture for every session
 * and compares Monday vs all other weekdays, plus Monday-morning vs
 * Monday-rest-of-day. Uses 1-min OHLC bar shape only (range, body/range,
 * direction reversals) — no sub-minute path data exists.
 */

import { query } from '../server/db.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const DOW_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function mean(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null; }
function std(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a,b)=>a+(b-m)*(b-m),0)/(arr.length-1));
}
function nFlag(n) { return n < 20 ? ` [n=${n} — THIN, n<20]` : ` [n=${n}]`; }
function tStat(a, b) {
  const ma = mean(a), mb = mean(b), sa = std(a), sb = std(b);
  if (ma == null || mb == null || sa == null || sb == null) return null;
  const se = Math.sqrt((sa*sa)/a.length + (sb*sb)/b.length);
  if (se === 0) return null;
  return (ma - mb) / se;
}
function sigLabel(t) {
  if (t == null) return 'n/a';
  const at = Math.abs(t);
  if (at >= 2.58) return `t=${t.toFixed(2)} (p<0.01, likely real)`;
  if (at >= 1.96) return `t=${t.toFixed(2)} (p<0.05, likely real)`;
  if (at >= 1.65) return `t=${t.toFixed(2)} (p<0.10, weak/marginal)`;
  return `t=${t.toFixed(2)} (not significant)`;
}

// Per-session texture metrics from a list of 1-min bars (ordered by ts)
function texture(bars) {
  if (bars.length < 2) return null;
  const ranges = bars.map(b => b.high - b.low);
  const avgRange = mean(ranges);

  const bodyRatios = [];
  for (const b of bars) {
    const r = b.high - b.low;
    if (r > 0) bodyRatios.push(Math.abs(b.close - b.open) / r);
  }
  const avgBodyRatio = mean(bodyRatios);

  // direction per bar: 1 up, -1 down, 0 flat
  const dirs = bars.map(b => b.close > b.open ? 1 : (b.close < b.open ? -1 : 0));
  let flips = 0, consideredPairs = 0;
  for (let i = 1; i < dirs.length; i++) {
    if (dirs[i] !== 0 && dirs[i-1] !== 0) {
      consideredPairs++;
      if (dirs[i] !== dirs[i-1]) flips++;
    }
  }
  const reversalRate = consideredPairs > 0 ? (flips / consideredPairs) * 100 : null;

  const totalTravel = ranges.reduce((a,b)=>a+b, 0);
  const netMove = Math.abs(bars[bars.length-1].close - bars[0].open);
  const travelToNet = netMove > 0 ? totalTravel / netMove : null;

  const hi = Math.max(...bars.map(b=>b.high));
  const lo = Math.min(...bars.map(b=>b.low));
  const hourRange = hi - lo;

  // PRIMARY CHOPPINESS METRIC: efficiency ratio (Kaufman-style)
  // efficiency = |net directional progress| / |total path traveled (sum of bar bodies)|
  // 1 = perfectly directional (every bar's body contributes to net move),
  // 0 = pure chop (bar bodies cancel out, no net progress).
  const bodySum = bars.reduce((a,b)=>a+Math.abs(b.close-b.open), 0);
  const efficiency = bodySum > 0 ? netMove / bodySum : null;

  // CROSS-CHECK: standard Choppiness Index (ATR-sum vs range, log-scaled).
  // CI = 100 * log10( sum(TrueRange) / (highestHigh - lowestLow) ) / log10(n)
  // 0 = strongly trending (TR sum ~= range), 100 = pure chop (TR sum >> range).
  // True range uses prior bar's close within the window; first bar uses high-low
  // (no pre-window close fetched).
  let trSum = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (i === 0) { trSum += b.high - b.low; }
    else {
      const pc = bars[i-1].close;
      trSum += Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    }
  }
  const choppinessIndex = (hi - lo) > 0 ? 100 * Math.log10(trSum / (hi - lo)) / Math.log10(bars.length) : null;

  return { avgRange, avgBodyRatio, reversalRate, totalTravel, netMove, travelToNet, whipsawCount: flips, hourRange, efficiency, choppinessIndex, n: bars.length };
}

async function main() {
  // First-hour bars: 9:30-10:30 ET (minute-of-day 570-629 inclusive = 60 bars)
  const firstHourQ = await query(`
    SELECT ts::date as date, ts, open::float, high::float, low::float, close::float
    FROM price_bars
    WHERE symbol='NQ' AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 629
    ORDER BY ts
  `);
  // Rest-of-day bars: 10:30-16:00 ET (minute-of-day 630-959)
  const restOfDayQ = await query(`
    SELECT ts::date as date, ts, open::float, high::float, low::float, close::float
    FROM price_bars
    WHERE symbol='NQ' AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 630 AND 959
    ORDER BY ts
  `);
  // Full RTH bars for full-day-range comparison (9:30-16:00, minute 570-959)
  const fullDayQ = await query(`
    SELECT ts::date as date, MAX(high::float) as hi, MIN(low::float) as lo, COUNT(*) as n
    FROM price_bars
    WHERE symbol='NQ' AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
    GROUP BY ts::date
  `);

  const dstr = (v) => typeof v === 'string' ? v.slice(0,10) : v.toISOString().slice(0,10);
  const byDateFirstHour = {};
  for (const r of firstHourQ.rows) {
    const d = dstr(r.date);
    (byDateFirstHour[d] ||= []).push(r);
  }
  const byDateRest = {};
  for (const r of restOfDayQ.rows) {
    const d = dstr(r.date);
    (byDateRest[d] ||= []).push(r);
  }
  const fullDayRange = {};
  for (const r of fullDayQ.rows) {
    const d = dstr(r.date);
    if (Number(r.n) >= 200) fullDayRange[d] = Number(r.hi) - Number(r.lo);
  }

  // Build per-session records, requiring >=50 of 60 first-hour bars
  const sessions = [];
  for (const [date, bars] of Object.entries(byDateFirstHour)) {
    if (bars.length < 50) continue;
    const tex = texture(bars);
    if (!tex) continue;
    const dow = new Date(date + 'T12:00:00Z').getUTCDay();
    const restBars = byDateRest[date] || [];
    const restTex = restBars.length >= 250 ? texture(restBars) : null;
    sessions.push({
      date, dow, dowName: DOW_NAMES[dow],
      ...tex,
      fullDayRange: fullDayRange[date] ?? null,
      restTex,
    });
  }
  sessions.sort((a,b) => a.date < b.date ? -1 : 1);

  console.log(`Sessions with usable first-hour data (>=50/60 1-min bars): ${sessions.length}  (${sessions[0]?.date} → ${sessions[sessions.length-1]?.date})\n`);

  const recentCutoff = '2025-06-15';
  const recent = sessions.filter(s => s.date >= recentCutoff);
  console.log(`Recent-12mo subset: n=${recent.length} (>= ${recentCutoff})\n`);

  // ─── A. Monday vs all other days, first hour ─────────────────────────────
  console.log('═══ A. MONDAY FIRST HOUR vs ALL OTHER DAYS FIRST HOUR ═══\n');

  function reportAvB(label, monArr, othArr, fmt = (v)=>v.toFixed(2)) {
    const mm = mean(monArr), mo = mean(othArr);
    console.log(`${label}:`);
    console.log(`  Monday:     mean=${mm!=null?fmt(mm):'n/a'}  ${nFlag(monArr.length)}`);
    console.log(`  Other days: mean=${mo!=null?fmt(mo):'n/a'}  ${nFlag(othArr.length)}`);
    console.log(`  diff: ${(mm-mo)>=0?'+':''}${(mm-mo).toFixed(3)}  ${sigLabel(tStat(monArr, othArr))}\n`);
  }

  const monday = sessions.filter(s => s.dow === 1);
  const otherDays = sessions.filter(s => s.dow !== 1);

  reportAvB('0a. EFFICIENCY RATIO [PRIMARY] (|net move| / sum|body|; 1=clean trend, 0=pure chop)', monday.map(s=>s.efficiency).filter(v=>v!=null), otherDays.map(s=>s.efficiency).filter(v=>v!=null), v=>v.toFixed(3));
  reportAvB('0b. CHOPPINESS INDEX [CROSS-CHECK] (100*log10(sum(TR)/range)/log10(n); 0=trend, 100=chop)', monday.map(s=>s.choppinessIndex).filter(v=>v!=null), otherDays.map(s=>s.choppinessIndex).filter(v=>v!=null), v=>v.toFixed(1));
  reportAvB('1. Avg bar range per minute (pts) [supporting]', monday.map(s=>s.avgRange), otherDays.map(s=>s.avgRange));
  reportAvB('2. Avg body/range ratio (0=whippy, 1=decisive) [supporting]', monday.map(s=>s.avgBodyRatio), otherDays.map(s=>s.avgBodyRatio));
  reportAvB('3. Reversal rate (% consecutive bars flipping dir) [supporting]', monday.map(s=>s.reversalRate).filter(v=>v!=null), otherDays.map(s=>s.reversalRate).filter(v=>v!=null), v=>v.toFixed(1)+'%');
  reportAvB('4. Travel/Net ratio (total bar-range travel ÷ |net move|) [supporting]', monday.map(s=>s.travelToNet).filter(v=>v!=null), otherDays.map(s=>s.travelToNet).filter(v=>v!=null));
  reportAvB('5. Whipsaw count (direction flips in 60 bars) [supporting]', monday.map(s=>s.whipsawCount), otherDays.map(s=>s.whipsawCount), v=>v.toFixed(1));

  // #6 first-hour range as share of full-day range
  const monShare = monday.filter(s=>s.fullDayRange).map(s=>s.hourRange/s.fullDayRange*100);
  const othShare = otherDays.filter(s=>s.fullDayRange).map(s=>s.hourRange/s.fullDayRange*100);
  reportAvB('6. First-hour range as % of full-day range', monShare, othShare, v=>v.toFixed(1)+'%');

  // ─── A (recent 12mo) ─────────────────────────────────────────────────────
  console.log('═══ A (RECENT 12mo). Same comparison, >= ' + recentCutoff + ' ═══\n');
  const mondayR = recent.filter(s => s.dow === 1);
  const otherR = recent.filter(s => s.dow !== 1);
  reportAvB('0a. EFFICIENCY RATIO [PRIMARY]', mondayR.map(s=>s.efficiency).filter(v=>v!=null), otherR.map(s=>s.efficiency).filter(v=>v!=null), v=>v.toFixed(3));
  reportAvB('0b. CHOPPINESS INDEX [CROSS-CHECK]', mondayR.map(s=>s.choppinessIndex).filter(v=>v!=null), otherR.map(s=>s.choppinessIndex).filter(v=>v!=null), v=>v.toFixed(1));
  reportAvB('1. Avg bar range per minute (pts)', mondayR.map(s=>s.avgRange), otherR.map(s=>s.avgRange));
  reportAvB('2. Avg body/range ratio', mondayR.map(s=>s.avgBodyRatio), otherR.map(s=>s.avgBodyRatio));
  reportAvB('3. Reversal rate (%)', mondayR.map(s=>s.reversalRate).filter(v=>v!=null), otherR.map(s=>s.reversalRate).filter(v=>v!=null), v=>v.toFixed(1)+'%');
  reportAvB('4. Travel/Net ratio', mondayR.map(s=>s.travelToNet).filter(v=>v!=null), otherR.map(s=>s.travelToNet).filter(v=>v!=null));
  reportAvB('5. Whipsaw count', mondayR.map(s=>s.whipsawCount), otherR.map(s=>s.whipsawCount), v=>v.toFixed(1));
  const monShareR = mondayR.filter(s=>s.fullDayRange).map(s=>s.hourRange/s.fullDayRange*100);
  const othShareR = otherR.filter(s=>s.fullDayRange).map(s=>s.hourRange/s.fullDayRange*100);
  reportAvB('6. First-hour range as % of full-day range', monShareR, othShareR, v=>v.toFixed(1)+'%');

  // ─── B. Monday first hour vs Monday rest-of-day ──────────────────────────
  console.log('═══ B. MONDAY FIRST HOUR vs MONDAY REST-OF-DAY (10:30-16:00) ═══\n');
  const mondayWithRest = monday.filter(s => s.restTex);
  console.log(`Mondays with usable rest-of-day data: n=${mondayWithRest.length}\n`);

  function reportFirstVRest(label, key, fmt=(v)=>v.toFixed(2), restKey=key) {
    const first = mondayWithRest.map(s=>s[key]).filter(v=>v!=null);
    const rest = mondayWithRest.map(s=>s.restTex[restKey]).filter(v=>v!=null);
    console.log(`${label}:`);
    console.log(`  First hour (9:30-10:30):  mean=${fmt(mean(first))}  ${nFlag(first.length)}`);
    console.log(`  Rest of day (10:30-16:00): mean=${fmt(mean(rest))}  ${nFlag(rest.length)}`);
    console.log(`  diff: ${sigLabel(tStat(first, rest))}\n`);
  }
  reportFirstVRest('0a. EFFICIENCY RATIO [PRIMARY]', 'efficiency', v=>v.toFixed(3));
  reportFirstVRest('0b. CHOPPINESS INDEX [CROSS-CHECK]', 'choppinessIndex', v=>v.toFixed(1));
  reportFirstVRest('1. Avg bar range per minute (pts)', 'avgRange');
  reportFirstVRest('2. Avg body/range ratio', 'avgBodyRatio');
  reportFirstVRest('3. Reversal rate (%)', 'reversalRate', v=>v.toFixed(1)+'%');
  reportFirstVRest('4. Travel/Net ratio', 'travelToNet');

  // ─── C. Rank all weekdays by first-hour choppiness ───────────────────────
  console.log('═══ C. ALL WEEKDAYS RANKED — FIRST HOUR TEXTURE ═══\n');
  const byDow = {};
  for (const s of sessions) (byDow[s.dow] ||= []).push(s);

  const rows = [1,2,3,4,5].map(dow => {
    const arr = byDow[dow] || [];
    return {
      dow: DOW_NAMES[dow],
      n: arr.length,
      efficiency: mean(arr.map(s=>s.efficiency).filter(v=>v!=null)),
      choppinessIndex: mean(arr.map(s=>s.choppinessIndex).filter(v=>v!=null)),
      avgRange: mean(arr.map(s=>s.avgRange)),
      bodyRatio: mean(arr.map(s=>s.avgBodyRatio)),
      reversalRate: mean(arr.map(s=>s.reversalRate).filter(v=>v!=null)),
      travelToNet: mean(arr.map(s=>s.travelToNet).filter(v=>v!=null)),
      whipsaw: mean(arr.map(s=>s.whipsawCount)),
    };
  });
  console.log('Day    n     EfficRatio  ChopIndex  AvgRange/min  BodyRatio  ReversalRate  Travel/Net  Whipsaw#');
  for (const r of rows) {
    console.log(`${r.dow.padEnd(6)} ${String(r.n).padEnd(5)} ${r.efficiency.toFixed(3).padEnd(11)} ${r.choppinessIndex.toFixed(1).padEnd(10)} ${r.avgRange.toFixed(2).padEnd(13)} ${r.bodyRatio.toFixed(3).padEnd(10)} ${r.reversalRate.toFixed(1)+'%'.padEnd(12)} ${r.travelToNet.toFixed(2).padEnd(11)} ${r.whipsaw.toFixed(1)}`);
  }
  console.log('\nRanked by EFFICIENCY RATIO [PRIMARY] (lower = choppier, no net progress):');
  [...rows].sort((a,b)=>a.efficiency-b.efficiency).forEach((r,i)=>console.log(`  ${i+1}. ${r.dow}: ${r.efficiency.toFixed(3)} (n=${r.n})`));
  console.log('\nRanked by CHOPPINESS INDEX [CROSS-CHECK] (higher = choppier):');
  [...rows].sort((a,b)=>b.choppinessIndex-a.choppinessIndex).forEach((r,i)=>console.log(`  ${i+1}. ${r.dow}: ${r.choppinessIndex.toFixed(1)} (n=${r.n})`));
  console.log('\nRanked by REVERSAL RATE [supporting] (higher = choppier):');
  [...rows].sort((a,b)=>b.reversalRate-a.reversalRate).forEach((r,i)=>console.log(`  ${i+1}. ${r.dow}: ${r.reversalRate.toFixed(1)}% (n=${r.n})`));
  console.log('\nRanked by BODY/RANGE RATIO [supporting] (lower = whippier):');
  [...rows].sort((a,b)=>a.bodyRatio-b.bodyRatio).forEach((r,i)=>console.log(`  ${i+1}. ${r.dow}: ${r.bodyRatio.toFixed(3)} (n=${r.n})`));
  console.log('\nRanked by TRAVEL/NET RATIO [supporting] (higher = more chop-for-distance):');
  [...rows].sort((a,b)=>b.travelToNet-a.travelToNet).forEach((r,i)=>console.log(`  ${i+1}. ${r.dow}: ${r.travelToNet.toFixed(2)} (n=${r.n})`));

  // ─── D confound: per-year breakdown for Monday reversal rate & body ratio ─
  console.log('\n═══ D. CONFOUND CHECK — Monday first-hour metrics by year ═══\n');
  const byYear = {};
  for (const s of monday) {
    const y = s.date.slice(0,4);
    (byYear[y] ||= []).push(s);
  }
  for (const [y, arr] of Object.entries(byYear).sort()) {
    console.log(`  ${y}: n=${arr.length}  efficiency=${mean(arr.map(s=>s.efficiency).filter(v=>v!=null)).toFixed(3)}  choppinessIndex=${mean(arr.map(s=>s.choppinessIndex).filter(v=>v!=null)).toFixed(1)}  reversalRate=${mean(arr.map(s=>s.reversalRate).filter(v=>v!=null)).toFixed(1)}%  bodyRatio=${mean(arr.map(s=>s.avgBodyRatio)).toFixed(3)}`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
