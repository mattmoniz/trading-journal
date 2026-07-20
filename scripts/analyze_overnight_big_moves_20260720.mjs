// Direct follow-up analysis on the overnight-only 1yr backtest (backtest_overnight_only_1yr_
// 20260720.mjs): count of >400pt overnight sessions, MAE/MFE distribution of the trades that
// actually fired, whether target-hit trades left money on the table on big-move days
// specifically (post-resolution truncation, same lens as the RTH post-resolution thread),
// which levels got respected (faded successfully) vs broken during big moves, and what time
// of day big moves actually START (a different question than the already-tested "when do
// they taper" -- this is move INCEPTION time-of-day).
//
// Reuses the exact same validated 52-level exclusion list, window construction (~15.5hr
// overnight lookback), and resolution-cap fix as every other overnight script today.
//
// Run: node scripts/analyze_overnight_big_moves_20260720.mjs
import { query } from '../server/db.js';
import { resolve } from './backtest_unified.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import fs from 'fs';

const EXCLUDED = new Set(['OR_HIGH', 'OR_LOW', 'IB_HIGH', 'IB_LOW', 'IB_MID_SCALP', 'IB_MID', 'OR_MID',
  'OR_MID_AFTER_IB', 'ONH', 'ONL', '3M_VAH', '3M_VAL', '3M_POC', 'RTH_VWAP', 'WEEKLY_VWAP', 'MONTHLY_VWAP',
  'DAILY_OPEN', 'WEEKLY_OPEN', 'MONTHLY_OPEN']);
const RTH_START = 570, RTH_END = 960;
const BIG_MOVE_PTS = 400;
const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint, COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const POST_TARGET_WALK_BARS = 240; // ~4hr past resolution, matches the RTH post-resolution convention

function landmark(et_min) {
  if (et_min >= 960) return et_min < 1080 ? '1_Pre_Globex(16-18h)' : '2_Evening(18-24h)';
  if (et_min < 180) return '3_Asia(00-03h)';
  if (et_min < 510) return '4_London(03-08:30h)';
  return '5_Pre_Market(08:30-09:30h)';
}

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

  const barsRes = await query(`
    SELECT ts, ts::date::text as d, EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)::int as tod,
      high::float as high, low::float as low, close::float as close
    FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date - interval '370 days' ORDER BY ts ASC
  `, [maxDate]);
  const allBars = barsRes.rows.map(b => ({ ...b, ts: new Date(b.ts).getTime() }));
  console.log(`${levelNames.length} levels, ${dates.length} days, ${allBars.length} bars, window ending ${maxDate}.`);

  function firstIdxAtOrAfter(dateStr, todMin) {
    for (let i = 0; i < allBars.length; i++) {
      if (allBars[i].d > dateStr) return i;
      if (allBars[i].d === dateStr && allBars[i].tod >= todMin) return i;
    }
    return -1;
  }

  // ── Build per-day overnight window + range + inception (rolling-extremum walk) ──────────
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

    let hi_ = -Infinity, lo_ = Infinity;
    for (let i = wideStartIdx; i < startIdx; i++) { if (allBars[i].high > hi_) hi_ = allBars[i].high; if (allBars[i].low < lo_) lo_ = allBars[i].low; }
    const range = hi_ - lo_;

    // Rolling-extremum walk for inception (same method as the pattern-discovery script):
    // find the first bar where close deviates >= BIG_MOVE_PTS from the rolling extreme.
    let rollingHigh = -Infinity, rollingLow = Infinity, inceptionIdx = null, moveType = null;
    for (let i = wideStartIdx; i < startIdx; i++) {
      const b = allBars[i];
      if (b.high > rollingHigh) rollingHigh = b.high;
      if (b.low < rollingLow) rollingLow = b.low;
      if (b.close - rollingLow >= BIG_MOVE_PTS) { inceptionIdx = i; moveType = 'UP'; break; }
      if (rollingHigh - b.close >= BIG_MOVE_PTS) { inceptionIdx = i; moveType = 'DOWN'; break; }
    }
    dayInfo.push({ d, startIdx, rthEndIdx, wideStartIdx, range, inceptionIdx, moveType });
  }

  // ── Q1: how many overnights with range > 400pt? ──────────────────────────────────────
  const bigDays = dayInfo.filter(x => x.range > BIG_MOVE_PTS);
  console.log(`\n=== Q1: Overnights with range > ${BIG_MOVE_PTS}pt ===`);
  console.log(`${bigDays.length} of ${dayInfo.length} trading days (${(100 * bigDays.length / dayInfo.length).toFixed(1)}%).`);

  // ── Q5: what time do big moves (>400pt) actually START? ──────────────────────────────
  const inceptionMoves = bigDays.filter(x => x.inceptionIdx != null);
  const landmarkCounts = {};
  for (const x of inceptionMoves) {
    const lm = landmark(allBars[x.inceptionIdx].tod);
    landmarkCounts[lm] = (landmarkCounts[lm] || 0) + 1;
  }
  console.log(`\n=== Q5: When do >${BIG_MOVE_PTS}pt moves START? (N=${inceptionMoves.length} with a detectable inception) ===`);
  for (const lm of ['1_Pre_Globex(16-18h)', '2_Evening(18-24h)', '3_Asia(00-03h)', '4_London(03-08:30h)', '5_Pre_Market(08:30-09:30h)']) {
    const n = landmarkCounts[lm] || 0;
    console.log(`  ${lm}: ${n} (${(100 * n / inceptionMoves.length).toFixed(1)}%)`);
  }
  const upCount = inceptionMoves.filter(x => x.moveType === 'UP').length;
  console.log(`  Direction split: UP=${upCount} (${(100*upCount/inceptionMoves.length).toFixed(1)}%) DOWN=${inceptionMoves.length-upCount}`);

  // ── Scan touches (same method as backtest_overnight_only_1yr), tracking full MAE/MFE
  // AND post-target continuation, tagged by whether that day was a >400pt big-move day ──
  console.log('\nScanning overnight touches with MAE/MFE tracking...');
  const allTouches = [];
  const dayInfoByDate = new Map(dayInfo.map(x => [x.d, x]));
  for (const x of dayInfo) {
    const lv = levelsByDate.get(x.d);
    const isMonday = new Date(x.d + 'T12:00:00').getDay() === 1;
    const STOP = isMonday ? 60 : 90, TARGET = isMonday ? 30 : 40;
    const isBigDay = x.range > BIG_MOVE_PTS;

    for (const name of levelNames) {
      const lvl = lv[name];
      if (lvl == null) continue;
      for (let i = x.wideStartIdx + 1; i < x.startIdx; i++) {
        const b = allBars[i], prev = allBars[i - 1];
        if (Math.abs(b.close - lvl) > 15) continue;
        const dir = prev.close > lvl ? 'SHORT' : 'LONG';
        const long = dir === 'LONG';
        const entry = b.close;
        const r = resolve(allBars, i, dir,
          entry, long ? entry - STOP : entry + STOP, long ? entry + TARGET : entry - TARGET,
          x.rthEndIdx - i);
        const pnl = r.result === 'TARGET_HIT' ? TARGET * PNL_PER_POINT - COMMISSION
          : r.result === 'STOP_HIT' ? -(STOP * PNL_PER_POINT + COMMISSION) : 0;

        // Post-target continuation check: if TARGET_HIT, walk further to see the TRUE
        // favorable extreme reached vs. what the target actually captured.
        let postTargetExtra = null;
        if (r.result === 'TARGET_HIT') {
          const resolveIdx = i + r.barsHeld;
          const endWalk = Math.min(allBars.length, resolveIdx + POST_TARGET_WALK_BARS);
          let trueFav = TARGET;
          for (let j = resolveIdx; j < endWalk; j++) {
            const bar = allBars[j];
            const fav = long ? bar.high - entry : entry - bar.low;
            if (fav > trueFav) trueFav = fav;
          }
          postTargetExtra = trueFav - TARGET;
        }

        allTouches.push({
          date: x.d, name, dir, mae: r.mae, mfe: r.mfe, result: r.result, pnl, isBigDay, postTargetExtra,
        });
        break;
      }
    }
  }
  console.log(`${allTouches.length} total overnight touches (${allTouches.filter(t=>t.isBigDay).length} on >${BIG_MOVE_PTS}pt days).`);

  // ── Q2: MAE/MFE distribution of trades taken ─────────────────────────────────────────
  function pct(arr, p) { const s = [...arr].sort((a,b)=>a-b); return s.length ? s[Math.min(s.length-1, Math.floor(p*s.length))] : null; }
  const allMae = allTouches.map(t=>t.mae), allMfe = allTouches.map(t=>t.mfe);
  const bigMae = allTouches.filter(t=>t.isBigDay).map(t=>t.mae), bigMfe = allTouches.filter(t=>t.isBigDay).map(t=>t.mfe);
  console.log(`\n=== Q2: MAE/MFE of all overnight trades taken (N=${allTouches.length}) ===`);
  console.log(`  ALL DAYS   -- MAE p50=${pct(allMae,0.5).toFixed(1)} p75=${pct(allMae,0.75).toFixed(1)} p90=${pct(allMae,0.9).toFixed(1)}  MFE p50=${pct(allMfe,0.5).toFixed(1)} p75=${pct(allMfe,0.75).toFixed(1)} p90=${pct(allMfe,0.9).toFixed(1)}`);
  console.log(`  BIG DAYS   -- MAE p50=${pct(bigMae,0.5).toFixed(1)} p75=${pct(bigMae,0.75).toFixed(1)} p90=${pct(bigMae,0.9).toFixed(1)}  MFE p50=${pct(bigMfe,0.5).toFixed(1)} p75=${pct(bigMfe,0.75).toFixed(1)} p90=${pct(bigMfe,0.9).toFixed(1)} (N=${bigMae.length})`);

  // ── Q3: did we leave money on the table on big-move days specifically? ───────────────
  const bigTargetHits = allTouches.filter(t => t.isBigDay && t.result === 'TARGET_HIT');
  const avgExtra = bigTargetHits.length ? bigTargetHits.reduce((s,t)=>s+t.postTargetExtra,0)/bigTargetHits.length : 0;
  const medExtra = bigTargetHits.length ? [...bigTargetHits].sort((a,b)=>a.postTargetExtra-b.postTargetExtra)[Math.floor(bigTargetHits.length/2)].postTargetExtra : 0;
  const pctWithBigExtra = bigTargetHits.length ? 100*bigTargetHits.filter(t=>t.postTargetExtra >= 30).length/bigTargetHits.length : 0;
  console.log(`\n=== Q3: Money left on the table -- TARGET_HIT trades on >${BIG_MOVE_PTS}pt days (N=${bigTargetHits.length}) ===`);
  console.log(`  Avg extra favorable move AFTER target: ${avgExtra.toFixed(1)}pt. Median: ${medExtra.toFixed(1)}pt.`);
  console.log(`  ${pctWithBigExtra.toFixed(1)}% of these ran >=30pt further past target within ${POST_TARGET_WALK_BARS} bars.`);
  // Compare to non-big-day target hits as a baseline
  const normalTargetHits = allTouches.filter(t => !t.isBigDay && t.result === 'TARGET_HIT');
  const avgExtraNormal = normalTargetHits.length ? normalTargetHits.reduce((s,t)=>s+t.postTargetExtra,0)/normalTargetHits.length : 0;
  console.log(`  (Baseline, non-big-move days, N=${normalTargetHits.length}): avg extra = ${avgExtraNormal.toFixed(1)}pt.`);

  // ── Q4: which levels were "respected" (faded successfully) during big moves? ──────────
  const byLevelBig = {};
  for (const t of allTouches.filter(t=>t.isBigDay)) {
    (byLevelBig[t.name] ||= { n: 0, targetHit: 0, stopHit: 0 });
    byLevelBig[t.name].n++;
    if (t.result === 'TARGET_HIT') byLevelBig[t.name].targetHit++;
    if (t.result === 'STOP_HIT') byLevelBig[t.name].stopHit++;
  }
  const levelRows = Object.entries(byLevelBig).filter(([,s]) => s.n >= 5).sort((a,b) => (b[1].targetHit/b[1].n) - (a[1].targetHit/a[1].n));
  console.log(`\n=== Q4: Levels touched on >${BIG_MOVE_PTS}pt days (N>=5 touches), sorted by fade-success rate ===`);
  for (const [name, s] of levelRows) {
    console.log(`  ${name}: N=${s.n} respected(target)=${s.targetHit} (${(100*s.targetHit/s.n).toFixed(0)}%) broken(stop)=${s.stopHit} (${(100*s.stopHit/s.n).toFixed(0)}%)`);
  }

  // Write full report
  let report = `# Overnight Big-Move Analysis (>${BIG_MOVE_PTS}pt) -- Past Year\n\n`;
  report += `## Q1: Overnights with range > ${BIG_MOVE_PTS}pt\n${bigDays.length} of ${dayInfo.length} trading days (${(100*bigDays.length/dayInfo.length).toFixed(1)}%).\n\n`;
  report += `## Q5: When do these moves START?\nN=${inceptionMoves.length} with detectable inception.\n\n| Landmark | N | % |\n|---|---|---|\n`;
  for (const lm of ['1_Pre_Globex(16-18h)', '2_Evening(18-24h)', '3_Asia(00-03h)', '4_London(03-08:30h)', '5_Pre_Market(08:30-09:30h)']) {
    const n = landmarkCounts[lm] || 0;
    report += `| ${lm} | ${n} | ${(100*n/inceptionMoves.length).toFixed(1)}% |\n`;
  }
  report += `\nDirection: UP=${upCount} (${(100*upCount/inceptionMoves.length).toFixed(1)}%), DOWN=${inceptionMoves.length-upCount}.\n\n`;
  report += `## Q2: MAE/MFE of trades taken\n\n| Population | N | MAE p50 | MAE p75 | MAE p90 | MFE p50 | MFE p75 | MFE p90 |\n|---|---|---|---|---|---|---|---|\n`;
  report += `| All days | ${allTouches.length} | ${pct(allMae,0.5).toFixed(1)} | ${pct(allMae,0.75).toFixed(1)} | ${pct(allMae,0.9).toFixed(1)} | ${pct(allMfe,0.5).toFixed(1)} | ${pct(allMfe,0.75).toFixed(1)} | ${pct(allMfe,0.9).toFixed(1)} |\n`;
  report += `| Big (>${BIG_MOVE_PTS}pt) days | ${bigMae.length} | ${pct(bigMae,0.5).toFixed(1)} | ${pct(bigMae,0.75).toFixed(1)} | ${pct(bigMae,0.9).toFixed(1)} | ${pct(bigMfe,0.5).toFixed(1)} | ${pct(bigMfe,0.75).toFixed(1)} | ${pct(bigMfe,0.9).toFixed(1)} |\n`;
  report += `\n## Q3: Money left on the table (TARGET_HIT trades on big-move days)\nN=${bigTargetHits.length}. Avg extra favorable move past target: ${avgExtra.toFixed(1)}pt (median ${medExtra.toFixed(1)}pt). ${pctWithBigExtra.toFixed(1)}% ran >=30pt further. Baseline (non-big-day target hits, N=${normalTargetHits.length}): avg extra=${avgExtraNormal.toFixed(1)}pt.\n\n`;
  report += `## Q4: Levels touched on big-move days (N>=5), sorted by fade-success rate\n\n| Level+Dir | N | Target-hit (respected) | Stop-hit (broken) |\n|---|---|---|---|\n`;
  for (const [name, s] of levelRows) {
    report += `| ${name} | ${s.n} | ${s.targetHit} (${(100*s.targetHit/s.n).toFixed(0)}%) | ${s.stopHit} (${(100*s.stopHit/s.n).toFixed(0)}%) |\n`;
  }
  fs.writeFileSync('scratch/analyze_overnight_big_moves_RESULTS.md', report);
  console.log('\nWrote scratch/analyze_overnight_big_moves_RESULTS.md');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
