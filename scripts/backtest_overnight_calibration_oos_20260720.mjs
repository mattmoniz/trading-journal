// Out-of-sample check for backtest_overnight_calibration_20260720.mjs's headline finding
// (flat 90/40 P&L=$5,226 vs "calibrated" P&L=$36,858 across N=3730 overnight-fired touches,
// past year). That comparison derived the overnight stop/target (p75 MAE / p50 MFE) from
// the SAME touches it then tested against -- in-sample fitting, exactly the overfitting
// trap CLAUDE.md already documents for backtest_target_sweep_v2.mjs's original broken
// version. This splits the past year chronologically (first 70% = train, last 30% = test),
// derives the overnight stop/target ONLY from the training period's overnight touches, then
// evaluates flat-90/40 vs the trained-calibration against the TEST period's touches only --
// a genuine improvement must survive this or it isn't a real, generalizable finding.
//
// Run: node scripts/backtest_overnight_calibration_oos_20260720.mjs
import { query } from '../server/db.js';
import { resolve } from './backtest_unified.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';

const EXCLUDED = new Set(['OR_HIGH', 'OR_LOW', 'IB_HIGH', 'IB_LOW', 'IB_MID_SCALP', 'IB_MID', 'OR_MID',
  'OR_MID_AFTER_IB', 'ONH', 'ONL', '3M_VAH', '3M_VAL', '3M_POC', 'RTH_VWAP', 'WEEKLY_VWAP', 'MONTHLY_VWAP',
  'DAILY_OPEN', 'WEEKLY_OPEN', 'MONTHLY_OPEN']);
const RTH_START = 570, RTH_END = 960;
const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint, COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
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
  const splitIdx = Math.floor(dates.length * 0.7);
  const trainDates = new Set(dates.slice(0, splitIdx));
  const testDates = new Set(dates.slice(splitIdx));
  console.log(`${dates.length} days total. Train: ${dates[0]} to ${dates[splitIdx - 1]} (${trainDates.size}d). Test: ${dates[splitIdx]} to ${dates[dates.length - 1]} (${testDates.size}d).`);

  const barsRes = await query(`
    SELECT ts, ts::date::text as d, EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)::int as tod,
      high::float as high, low::float as low, close::float as close
    FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date - interval '370 days' ORDER BY ts ASC
  `, [maxDate]);
  const allBars = barsRes.rows.map(b => ({ ...b, ts: new Date(b.ts).getTime() }));

  function firstIdxAtOrAfter(dateStr, todMin) {
    for (let i = 0; i < allBars.length; i++) {
      if (allBars[i].d > dateStr) return i;
      if (allBars[i].d === dateStr && allBars[i].tod >= todMin) return i;
    }
    return -1;
  }

  console.log('Scanning overnight-fired touches, tagging train vs test...');
  const touches = []; // { date, dir, mae, mfe, fireIdx, rthEndIdx, isTrain }
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

    for (const name of levelNames) {
      const lvl = lv[name];
      if (lvl == null) continue;
      for (let i = wideStartIdx + 1; i < startIdx; i++) { // OVERNIGHT portion only (before RTH open)
        const b = allBars[i], prev = allBars[i - 1];
        if (Math.abs(b.close - lvl) > 15) continue;
        const dir = prev.close > lvl ? 'SHORT' : 'LONG';
        const long = dir === 'LONG';
        const entry = b.close;
        let mae = 0, mfe = 0;
        const maeMfeEnd = Math.min(rthEndIdx, i + 240);
        for (let j = i + 1; j < maeMfeEnd; j++) {
          const bar = allBars[j];
          const adv = long ? entry - bar.low : bar.high - entry;
          const fav = long ? bar.high - entry : entry - bar.low;
          if (adv > mae) mae = adv;
          if (fav > mfe) mfe = fav;
        }
        touches.push({ date: d, name, dir, mae, mfe, fireIdx: i, rthEndIdx, isTrain: trainDates.has(d) });
        break;
      }
    }
  }
  const trainTouches = touches.filter(t => t.isTrain);
  const testTouches = touches.filter(t => !t.isTrain);
  console.log(`${trainTouches.length} train touches, ${testTouches.length} test touches.`);

  const trainMae = trainTouches.map(t => t.mae).sort((a, b) => a - b);
  const trainMfe = trainTouches.map(t => t.mfe).sort((a, b) => a - b);
  const trainedStop = percentile(trainMae, 0.75), trainedTarget = percentile(trainMfe, 0.50);
  console.log(`Trained on first 70%: stop=${trainedStop.toFixed(1)}pt target=${trainedTarget.toFixed(1)}pt`);

  function simTotal(subset, stop, target) {
    let n = 0, wins = 0, pnl = 0;
    for (const t of subset) {
      const long = t.dir === 'LONG';
      const entry = allBars[t.fireIdx].close;
      const isMonday = new Date(t.date + 'T12:00:00').getDay() === 1;
      const r = resolve(allBars, t.fireIdx, t.dir, entry,
        long ? entry - stop : entry + stop, long ? entry + target : entry - target,
        t.rthEndIdx - t.fireIdx);
      const p = r.result === 'TARGET_HIT' ? target * PNL_PER_POINT - COMMISSION
        : r.result === 'STOP_HIT' ? -(stop * PNL_PER_POINT + COMMISSION) : 0;
      n++; if (r.result === 'TARGET_HIT') wins++; pnl += p;
    }
    return { n, wins, pnl };
  }

  const flatStopFn = (d) => new Date(d + 'T12:00:00').getDay() === 1 ? 60 : 90;
  const flatTargetFn = (d) => new Date(d + 'T12:00:00').getDay() === 1 ? 30 : 40;
  // simTotal needs per-touch flat params since Monday differs -- handle separately
  function simTotalFlat(subset) {
    let n = 0, wins = 0, pnl = 0;
    for (const t of subset) {
      const long = t.dir === 'LONG';
      const entry = allBars[t.fireIdx].close;
      const stop = flatStopFn(t.date), target = flatTargetFn(t.date);
      const r = resolve(allBars, t.fireIdx, t.dir, entry,
        long ? entry - stop : entry + stop, long ? entry + target : entry - target,
        t.rthEndIdx - t.fireIdx);
      const p = r.result === 'TARGET_HIT' ? target * PNL_PER_POINT - COMMISSION
        : r.result === 'STOP_HIT' ? -(stop * PNL_PER_POINT + COMMISSION) : 0;
      n++; if (r.result === 'TARGET_HIT') wins++; pnl += p;
    }
    return { n, wins, pnl };
  }

  console.log('\n=== OUT-OF-SAMPLE CHECK: trained calibration vs flat default, on TEST period only ===');
  const testFlat = simTotalFlat(testTouches);
  const testCal = simTotal(testTouches, trainedStop, trainedTarget);
  console.log(`TEST period flat 90/40: N=${testFlat.n} WR=${(100*testFlat.wins/testFlat.n).toFixed(1)}% P&L=$${testFlat.pnl.toFixed(2)}`);
  console.log(`TEST period trained-calibration (stop=${trainedStop.toFixed(1)}/target=${trainedTarget.toFixed(1)}): N=${testCal.n} WR=${(100*testCal.wins/testCal.n).toFixed(1)}% P&L=$${testCal.pnl.toFixed(2)}`);
  console.log(`Delta (test, OOS): $${(testCal.pnl - testFlat.pnl).toFixed(2)}`);

  // For comparison: what the ORIGINAL (in-sample, whole-year) script reported
  console.log('\n=== For reference: in-sample (whole year, same data used to derive AND test) ===');
  const allFlat = simTotalFlat(touches);
  const wholeYearMae = touches.map(t => t.mae).sort((a, b) => a - b);
  const wholeYearMfe = touches.map(t => t.mfe).sort((a, b) => a - b);
  const inSampleStop = percentile(wholeYearMae, 0.75), inSampleTarget = percentile(wholeYearMfe, 0.50);
  const allCal = simTotal(touches, inSampleStop, inSampleTarget);
  console.log(`Whole-year flat: N=${allFlat.n} P&L=$${allFlat.pnl.toFixed(2)}`);
  console.log(`Whole-year in-sample-calibrated (stop=${inSampleStop.toFixed(1)}/target=${inSampleTarget.toFixed(1)}): N=${allCal.n} P&L=$${allCal.pnl.toFixed(2)}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
