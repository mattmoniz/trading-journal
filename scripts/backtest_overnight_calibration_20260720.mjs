// Follow-up to backtest_24hr_vs_rth_1yr_comparison_20260720.mjs: that comparison used the
// SAME flat 90pt/40pt (60/30 Monday) stop/target for both RTH-only and the wider overnight
// window -- borrowed from the RTH-calibrated default, never actually checked against
// overnight-specific price behavior. User's hypothesis: overnight NQ moves slower, so this
// flat target is miscalibrated for the overnight-fired subset specifically (consistent with
// the resolution-cap bug found earlier today, where a fixed 4hr window was starving
// overnight trades of time to resolve -- a related but distinct question: not "how long
// does it take" but "how FAR does it typically move").
//
// Three-part script:
// 1. Per-level breakdown of the existing 90/40 RTH-only vs 24hr comparison (which specific
//    levels actually do better overnight vs which drag the pool down).
// 2. MAE/MFE excursion distributions for overnight-fired vs RTH-fired touches on the SAME
//    levels -- tests whether overnight genuinely moves differently, with real percentiles,
//    not a guess.
// 3. If a real difference exists, derive an overnight-specific stop (p75 MAE) / target (p50
//    MFE) the same way update_optimal_stops.mjs already does for RTH, and re-run the
//    per-level ranking using those instead of the flat 90/40 -- this is the real "which
//    levels are good overnight" answer, since ranking with RTH-shaped parameters is exactly
//    the confound being tested here.
//
// Run: node scripts/backtest_overnight_calibration_20260720.mjs
import { query } from '../server/db.js';
import { resolve } from './backtest_unified.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import fs from 'fs';

const EXCLUDED = new Set(['OR_HIGH', 'OR_LOW', 'IB_HIGH', 'IB_LOW', 'IB_MID_SCALP', 'IB_MID', 'OR_MID',
  'OR_MID_AFTER_IB', 'ONH', 'ONL', '3M_VAH', '3M_VAL', '3M_POC', 'RTH_VWAP', 'WEEKLY_VWAP', 'MONTHLY_VWAP',
  'DAILY_OPEN', 'WEEKLY_OPEN', 'MONTHLY_OPEN']);
const RTH_START = 570, RTH_END = 960;
const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint, COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
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

  // Walk every touch once, recording MAE/MFE for BOTH a flat 240-bar cap (for distribution
  // purposes -- this is exactly what update_optimal_stops.mjs's real MAE/MFE columns
  // represent: excursion up to a resolution, not an unbounded walk) AND which scenario
  // (RTH_ONLY vs the overnight-inclusive part of WIDE_24HR) it belongs to. A touch is
  // "overnight-fired" if its own fire index is before that day's own RTH_START.
  console.log('Scanning touches, recording MAE/MFE by fired-session...');
  const touchesByLevel = {}; // name -> { RTH: [...], OVERNIGHT: [...] } each { mae, mfe, dir }
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
      // Find the single first touch in the FULL wide window (matches the real live
      // "fired.add(name)" one-fire-per-day behavior) -- classify it as RTH or OVERNIGHT
      // by whether its own index is before startIdx.
      for (let i = wideStartIdx + 1; i < rthEndIdx; i++) {
        const b = allBars[i], prev = allBars[i - 1];
        if (Math.abs(b.close - lvl) > 15) continue;
        const dir = prev.close > lvl ? 'SHORT' : 'LONG';
        const long = dir === 'LONG';
        const entry = b.close;
        let mae = 0, mfe = 0;
        const endIdx = Math.min(rthEndIdx, i + 240);
        for (let j = i + 1; j < endIdx; j++) {
          const bar = allBars[j];
          const adv = long ? entry - bar.low : bar.high - entry;
          const fav = long ? bar.high - entry : entry - bar.low;
          if (adv > mae) mae = adv;
          if (fav > mfe) mfe = fav;
        }
        const session = i < startIdx ? 'OVERNIGHT' : 'RTH';
        (touchesByLevel[name] ||= { RTH: [], OVERNIGHT: [] });
        touchesByLevel[name][session].push({ date: d, dir, mae, mfe, fireIdx: i, rthEndIdx });
        break;
      }
    }
  }

  // ── Part 2: pooled MAE/MFE distributions, RTH-fired vs overnight-fired ──────────────
  const pooledMae = { RTH: [], OVERNIGHT: [] }, pooledMfe = { RTH: [], OVERNIGHT: [] };
  for (const name of levelNames) {
    for (const session of ['RTH', 'OVERNIGHT']) {
      for (const t of (touchesByLevel[name]?.[session] || [])) {
        pooledMae[session].push(t.mae); pooledMfe[session].push(t.mfe);
      }
    }
  }
  for (const session of ['RTH', 'OVERNIGHT']) { pooledMae[session].sort((a, b) => a - b); pooledMfe[session].sort((a, b) => a - b); }

  console.log('\n=== Pooled MAE/MFE distribution: RTH-fired vs overnight-fired touches (same levels) ===');
  console.log(`RTH-fired:       N=${pooledMae.RTH.length}  MAE p50=${percentile(pooledMae.RTH, 0.5)?.toFixed(1)} p75=${percentile(pooledMae.RTH, 0.75)?.toFixed(1)}  MFE p50=${percentile(pooledMfe.RTH, 0.5)?.toFixed(1)} p75=${percentile(pooledMfe.RTH, 0.75)?.toFixed(1)}`);
  console.log(`Overnight-fired: N=${pooledMae.OVERNIGHT.length}  MAE p50=${percentile(pooledMae.OVERNIGHT, 0.5)?.toFixed(1)} p75=${percentile(pooledMae.OVERNIGHT, 0.75)?.toFixed(1)}  MFE p50=${percentile(pooledMfe.OVERNIGHT, 0.5)?.toFixed(1)} p75=${percentile(pooledMfe.OVERNIGHT, 0.75)?.toFixed(1)}`);

  // ── Part 3: derive overnight-specific stop/target (p75 MAE / p50 MFE, same convention
  // as update_optimal_stops.mjs) and re-simulate PnL for overnight-fired touches using
  // BOTH the flat 90/40 default AND the derived overnight-calibrated values, per level.
  const overnightStop = percentile(pooledMae.OVERNIGHT, 0.75);
  const overnightTarget = percentile(pooledMfe.OVERNIGHT, 0.50);
  const rthStop = percentile(pooledMae.RTH, 0.75);
  const rthTarget = percentile(pooledMfe.RTH, 0.50);
  console.log(`\nDerived (p75 MAE / p50 MFE): RTH stop=${rthStop?.toFixed(1)} target=${rthTarget?.toFixed(1)}  |  Overnight stop=${overnightStop?.toFixed(1)} target=${overnightTarget?.toFixed(1)}`);

  console.log('\nRe-simulating overnight-fired touches with flat 90/40 vs overnight-calibrated stop/target...');
  const perLevelResults = {};
  for (const name of levelNames) {
    const onTouches = touchesByLevel[name]?.OVERNIGHT || [];
    if (!onTouches.length) continue;
    let flatN = 0, flatWins = 0, flatPnl = 0, calN = 0, calWins = 0, calPnl = 0;
    for (const t of onTouches) {
      const long = t.dir === 'LONG';
      // entry price: need the bar's close at fireIdx -- recover from allBars
      const entry = allBars[t.fireIdx].close;
      const isMonday = new Date(t.date + 'T12:00:00').getDay() === 1;
      const flatStop = isMonday ? 60 : 90, flatTarget = isMonday ? 30 : 40;
      const rFlat = resolve(allBars, t.fireIdx, t.dir, entry,
        long ? entry - flatStop : entry + flatStop, long ? entry + flatTarget : entry - flatTarget,
        t.rthEndIdx - t.fireIdx);
      const pnlFlat = rFlat.result === 'TARGET_HIT' ? flatTarget * PNL_PER_POINT - COMMISSION
        : rFlat.result === 'STOP_HIT' ? -(flatStop * PNL_PER_POINT + COMMISSION) : 0;
      flatN++; if (rFlat.result === 'TARGET_HIT') flatWins++; flatPnl += pnlFlat;

      const rCal = resolve(allBars, t.fireIdx, t.dir, entry,
        long ? entry - overnightStop : entry + overnightStop, long ? entry + overnightTarget : entry - overnightTarget,
        t.rthEndIdx - t.fireIdx);
      const pnlCal = rCal.result === 'TARGET_HIT' ? overnightTarget * PNL_PER_POINT - COMMISSION
        : rCal.result === 'STOP_HIT' ? -(overnightStop * PNL_PER_POINT + COMMISSION) : 0;
      calN++; if (rCal.result === 'TARGET_HIT') calWins++; calPnl += pnlCal;
    }
    perLevelResults[name] = { flatN, flatWins, flatPnl, calN, calWins, calPnl };
  }

  const sorted = Object.entries(perLevelResults).sort((a, b) => b[1].calPnl - a[1].calPnl);
  console.log('\n=== Overnight-fired touches per level: flat 90/40 vs overnight-calibrated stop/target ===');
  let report = `# Overnight Calibration Check -- Past Year\n\nDerived from overnight-fired touch MAE/MFE distributions: RTH stop=${rthStop?.toFixed(1)}pt/target=${rthTarget?.toFixed(1)}pt (p75 MAE/p50 MFE) vs Overnight stop=${overnightStop?.toFixed(1)}pt/target=${overnightTarget?.toFixed(1)}pt. Pooled N: RTH-fired=${pooledMae.RTH.length}, Overnight-fired=${pooledMae.OVERNIGHT.length}.\n\n## Per-level overnight-fired P&L: flat (90/40 or 60/30 Monday) vs overnight-calibrated stop/target\n\n| Level+Dir touches | N | Flat P&L | Flat WR | Calibrated P&L | Calibrated WR |\n|---|---|---|---|---|---|\n`;
  for (const [name, r] of sorted) {
    const line = `| ${name} | ${r.flatN} | $${r.flatPnl.toFixed(2)} | ${(100 * r.flatWins / r.flatN).toFixed(1)}% | $${r.calPnl.toFixed(2)} | ${(100 * r.calWins / r.calN).toFixed(1)}% |`;
    console.log(line);
    report += line + '\n';
  }
  const totalFlat = Object.values(perLevelResults).reduce((s, r) => s + r.flatPnl, 0);
  const totalCal = Object.values(perLevelResults).reduce((s, r) => s + r.calPnl, 0);
  const totalNFlat = Object.values(perLevelResults).reduce((s, r) => s + r.flatN, 0);
  console.log(`\nTOTAL overnight-fired: N=${totalNFlat}  Flat P&L=$${totalFlat.toFixed(2)}  Calibrated P&L=$${totalCal.toFixed(2)}`);
  report = `## TOTAL overnight-fired (N=${totalNFlat}): Flat P&L=$${totalFlat.toFixed(2)} vs Calibrated P&L=$${totalCal.toFixed(2)}\n\n` + report;

  fs.writeFileSync('scratch/backtest_overnight_calibration_RESULTS.md', report);
  console.log('\nWrote scratch/backtest_overnight_calibration_RESULTS.md');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
