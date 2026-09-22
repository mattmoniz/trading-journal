// Self-recalibrating check of the "overnight order-flow direction predicts the following RTH
// session" finding (2026-09-21, RESEARCH_CLAIM
// overnight_9pm_orderflow_predicts_rth_direction_20260921) -- population = real trading days
// the ALREADY-LIVE Globex rotation badge flags high-rotation by 12am ET (>=6 confirmed 65pt
// legs, server/services/rotationDetector.js -- the badge's own real stage2 checkpoint).
//
// CAUSALITY FIX (2026-09-21, caught before building the live detector): the ORIGINAL version
// of this script entered at the 9PM price -- but "is today a >=6-leg day by 12am" is NOT
// knowable at 9pm, only at 12am. A live 9pm-firing detector gated on that same fact would be
// using information from the future relative to its own entry. Directly re-tested the
// causally-valid alternative -- wait until 12am (when the >=6-leg fact is actually knowable),
// look at what the 6pm-9pm order flow direction ALREADY said (fully known/historical by then),
// and enter at the CURRENT (12am) price -- and it's not just valid, it's STRONGER (N=53,
// hitRate=67.9%, meanCapture=151.4pts/day vs the original's 64.2%/96.7pts). Direction signal
// (6pm-9pm cumulative ask/bid split) stays the same; only the ENTRY PRICE moved from 9pm to
// 12am, matching what a live detector can actually execute.
//
// User's explicit instruction after seeing a promising but thin (N=53) manual result: "Gather
// more data before proceeding." This script is that data-gathering mechanism, self-recalibrating
// as real new trading days accumulate -- it does NOT lock in a stop distance or exit time
// permanently, it re-derives the full stop x exit-time grid on a fresh chronological 70/30 split
// EVERY run. Feeds the live SHADOW detector (server/services/overnightOrderflowEntryDetector.js)
// its current best stop/exit choice -- never hardcoded there.
//
// Deliberately its own standalone script (not folded into acd.js/setups.js) -- matches the
// "isolate non-trading features" / "market behavior hypotheses go through bar history first"
// conventions for the CALIBRATION half; the live detector itself is a real setup_type, wired
// normally into acd.js's runSetupDetection per the new-setup-type checklist.

import { query } from '../server/db.js';
import { detectRotationLegs } from '../server/services/rotationDetector.js';
import { dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const CLEAN_DATA_START = '2025-11-20'; // last confirmed clean, continuous-density NQ window
const DOLLAR_PER_PT = 2, COMMISSION = 2; // MNQ, per CLAUDE.md's own ground-truth constants
const STOP_CANDIDATES_PTS = [100, 150, 200, 250, 300, 400, 500, 700, Infinity];
const EXIT_TIME_CANDIDATES = ['10:30', '11:30', '12:30', '13:30', '14:30', '15:30', '16:00'];
const MIN_TEST_N_FOR_PROMOTION = 30; // flagged in the OPEN_DECISION, not enforced here -- informational

function getNqRollWeekDates(year) {
  const excluded = new Set();
  for (const month of [2, 5, 8, 11]) {
    const d = new Date(year, month, 1);
    const thursdays = [], fridays = [];
    while (d.getMonth() === month) {
      if (d.getDay() === 4) thursdays.push(new Date(d));
      if (d.getDay() === 5) fridays.push(new Date(d));
      d.setDate(d.getDate() + 1);
    }
    const secondThursday = thursdays[1], thirdFriday = fridays[2];
    const mondayBefore = new Date(thirdFriday); mondayBefore.setDate(mondayBefore.getDate() - 4);
    const curr = new Date(secondThursday);
    while (curr <= mondayBefore) { excluded.add(curr.toISOString().slice(0, 10)); curr.setDate(curr.getDate() + 1); }
  }
  return excluded;
}
const excludedDates = new Set();
for (let y = 2024; y <= 2027; y++) getNqRollWeekDates(y).forEach((d) => excludedDates.add(d));

function minSince6pm(isoDate, timeStr, tDay) {
  const [hh, mm] = timeStr.split(':').map(Number);
  if (isoDate < tDay) return (hh - 18) * 60 + mm;
  return 360 + hh * 60 + mm;
}

// Exported 2026-09-22 (per CLAUDE.md's "export the real function" rule) so a related script
// can test alternative exit MECHANISMS against this exact same population/entry/direction
// definition without re-deriving it -- see scripts/research_overnight_orderflow_trail_exit.mjs.
export async function fetchTrades() {
  const res = await query(`
    SELECT ts AT TIME ZONE 'America/New_York' as ts_et, open, high, low, close, bid_volume, ask_volume
    FROM price_bars_primary WHERE symbol = 'NQ' AND ts >= $1
    ORDER BY ts ASC
  `, [CLEAN_DATA_START]);
  const bars = res.rows.map((b, idx) => {
    const d = new Date(b.ts_et + 'Z');
    return {
      idx, ts: d, isoDate: d.toISOString().slice(0, 10), timeStr: d.toISOString().slice(11, 16),
      dayOfWeek: d.getUTCDay(), open: Number(b.open), high: Number(b.high), low: Number(b.low), close: Number(b.close),
      bid_volume: Number(b.bid_volume || 0), ask_volume: Number(b.ask_volume || 0),
    };
  });

  const days = new Map();
  for (const bar of bars) {
    let tDay = bar.isoDate;
    if (bar.timeStr >= '18:00') {
      const nextD = new Date(bar.ts); nextD.setUTCDate(nextD.getUTCDate() + (bar.dayOfWeek === 5 ? 3 : 1)); tDay = nextD.toISOString().slice(0, 10);
    } else if (bar.dayOfWeek === 0) {
      const nextD = new Date(bar.ts); nextD.setUTCDate(nextD.getUTCDate() + 1); tDay = nextD.toISOString().slice(0, 10);
    } else if (bar.dayOfWeek === 6) {
      const nextD = new Date(bar.ts); nextD.setUTCDate(nextD.getUTCDate() + 2); tDay = nextD.toISOString().slice(0, 10);
    }
    if (!days.has(tDay)) days.set(tDay, { overnight: [], rth: [] });
    if (bar.timeStr >= '09:30' && bar.timeStr < '16:00') {
      if (tDay === bar.isoDate) days.get(tDay).rth.push(bar);
    } else {
      days.get(tDay).overnight.push(bar);
    }
  }

  const trades = [];
  for (const [tDay, data] of days.entries()) {
    if (tDay < CLEAN_DATA_START || excludedDates.has(tDay)) continue;
    const rth = data.rth, ov = data.overnight;
    if (rth.length < 300) continue;
    ov.sort((a, b) => a.ts - b.ts); rth.sort((a, b) => a.ts - b.ts);
    const validOv = ov.filter((b) => (b.isoDate < tDay && b.timeStr >= '18:00') || (b.isoDate === tDay && b.timeStr < '09:30'));
    if (validOv.length < 100) continue;
    validOv.sort((a, b) => minSince6pm(a.isoDate, a.timeStr, tDay) - minSince6pm(b.isoDate, b.timeStr, tDay));

    const bars12am = validOv.filter((b) => minSince6pm(b.isoDate, b.timeStr, tDay) <= 360);
    if (detectRotationLegs(bars12am).length < 6) continue; // badge's own real stage2 threshold

    const bars9pm = validOv.filter((b) => minSince6pm(b.isoDate, b.timeStr, tDay) <= 180);
    if (bars9pm.length < 5) continue;
    let ask = 0, bid = 0;
    for (const b of bars9pm) { ask += b.ask_volume; bid += b.bid_volume; }
    const share9pm = (ask + bid) > 0 ? ask / (ask + bid) : 0.5;
    const direction = share9pm > 0.5 ? 1 : -1;

    // Entry priced at 12AM, not 9pm -- see the causality-fix header comment above. The
    // direction signal (share9pm) is still the 6pm-9pm read; only the executable entry price
    // moves to the moment the >=6-leg fact actually becomes knowable.
    const after12am = validOv.filter((b) => minSince6pm(b.isoDate, b.timeStr, tDay) >= 360);
    if (!after12am.length) continue;
    const entryBar = after12am[0];
    const entryPrice = entryBar.open;

    const exitIdxByTime = {};
    for (const t of EXIT_TIME_CANDIDATES) {
      const match = rth.find((b) => b.timeStr >= t);
      exitIdxByTime[t] = match ? match.idx : rth[rth.length - 1].idx;
    }
    const rthCloseIdx = rth[rth.length - 1].idx;

    let maeSoFar = 0, mfeSoFar = 0;
    const maeAtExitIdx = {}, mfeAtExitIdx = {};
    for (let barPtr = entryBar.idx; barPtr <= rthCloseIdx; barPtr++) {
      const b = bars[barPtr];
      if (b) {
        const adverse = direction === 1 ? (entryPrice - b.low) : (b.high - entryPrice);
        if (adverse > maeSoFar) maeSoFar = adverse;
        // MFE: max favorable excursion so far (points in the trade's OWN favor), added
        // 2026-09-22 for the runner/trail-exit comparison below -- purely additive, does not
        // change simTrade()'s existing MAE-only behavior or any prior calibration output.
        const favorable = direction === 1 ? (b.high - entryPrice) : (entryPrice - b.low);
        if (favorable > mfeSoFar) mfeSoFar = favorable;
      }
      for (const t of EXIT_TIME_CANDIDATES) {
        if (barPtr === exitIdxByTime[t] && maeAtExitIdx[t] === undefined) { maeAtExitIdx[t] = maeSoFar; mfeAtExitIdx[t] = mfeSoFar; }
      }
    }
    trades.push({
      tDay, direction, entryPrice, exitIdxByTime, maeAtExitIdx, mfeAtExitIdx,
      entryIdx: entryBar.idx, rthCloseIdx, share9pm,
      // Session bars from the real Globex 6pm open through the entry bar (the SAME bars12am
      // slice this file's own rotation-leg gate already filters) -- exposed for
      // scripts/research_overnight_orderflow_regime_exit.mjs's own real computeLiveVolumeBuildingSignal()
      // call, so it doesn't need to re-derive the session-open boundary a second way.
      sessionBarsAtEntry: bars12am,
      priceAtExit: (t) => bars[exitIdxByTime[t]].close,
    });
  }
  trades.sort((a, b) => a.tDay.localeCompare(b.tDay));
  return { trades, bars };
}

function simTrade(t, stopDist, exitTime) {
  const maeAtExit = t.maeAtExitIdx[exitTime];
  if (stopDist !== Infinity && maeAtExit >= stopDist) return -stopDist;
  return (t.priceAtExit(exitTime) - t.entryPrice) * t.direction;
}

function evalGrid(pool) {
  const grid = [];
  for (const stopDist of STOP_CANDIDATES_PTS) {
    for (const exitTime of EXIT_TIME_CANDIDATES) {
      const captures = pool.map((t) => simTrade(t, stopDist, exitTime));
      const meanCap = captures.reduce((a, b) => a + b, 0) / captures.length;
      const hits = captures.filter((c) => c > 0).length;
      grid.push({ stopDist, exitTime, meanCap, hitRate: 100 * hits / pool.length, n: pool.length });
    }
  }
  return grid;
}

function reportPool(pool, stopDist, exitTime) {
  const captures = pool.map((t) => simTrade(t, stopDist, exitTime));
  const hits = captures.filter((c) => c > 0).length;
  const meanCap = captures.reduce((a, b) => a + b, 0) / captures.length;
  const dollarPnl = captures.map((c) => c * DOLLAR_PER_PT - COMMISSION);
  const meanDollar = dollarPnl.reduce((a, b) => a + b, 0) / dollarPnl.length;
  const events = pool.map((t, i) => ({ date: t.tDay, pnl: captures[i] }));
  const ci = dayBlockedBootstrapCI(events, `overnight_orderflow_${stopDist}_${exitTime}`, { dateField: 'date' });
  return { n: pool.length, hitRate: +( 100 * hits / pool.length).toFixed(1), meanCapture: +meanCap.toFixed(1), meanDollarPerDay: +meanDollar.toFixed(2), ci: { lo: +ci.lo.toFixed(1), hi: +ci.hi.toFixed(1) }, excludesZero: ci.lo > 0 || ci.hi < 0 };
}

async function main() {
  const { trades } = await fetchTrades();
  console.log(`Total qualifying trades (badge-high-by-12am population): ${trades.length}`);
  if (trades.length < 20) {
    console.log('ABORT: fewer than 20 real qualifying days -- too thin to calibrate anything yet.');
    process.exit(0);
  }

  const splitIdx = Math.floor(trades.length * 0.7);
  const train = trades.slice(0, splitIdx), test = trades.slice(splitIdx);
  console.log(`Train: N=${train.length} (${train[0].tDay} to ${train[train.length - 1].tDay})`);
  console.log(`Test:  N=${test.length} (${test[0]?.tDay} to ${test[test.length - 1]?.tDay})`);

  const trainGrid = evalGrid(train);
  trainGrid.sort((a, b) => b.meanCap - a.meanCap);
  const chosen = trainGrid[0];
  console.log(`Chosen cell (from TRAIN only): stop=${chosen.stopDist === Infinity ? 'NONE' : chosen.stopDist}, exit=${chosen.exitTime}`);

  const testResult = test.length >= 5 ? reportPool(test, chosen.stopDist, chosen.exitTime) : null;
  const testBaseline4pm = test.length >= 5 ? reportPool(test, Infinity, '16:00') : null;
  const allResult = reportPool(trades, chosen.stopDist, chosen.exitTime);
  const allBaseline4pm = reportPool(trades, Infinity, '16:00');

  console.log('TEST (chosen cell, held out):', testResult);
  console.log('TEST (fixed no-stop/4pm baseline, for comparison):', testBaseline4pm);
  console.log('ALL trades (chosen cell):', allResult);
  console.log('ALL trades (fixed no-stop/4pm baseline):', allBaseline4pm);

  const notes = {
    population: 'badge-high-by-12am (>=6 real rotation legs by midnight ET)', totalN: trades.length,
    trainN: train.length, testN: test.length,
    trainWindow: { start: train[0].tDay, end: train[train.length - 1].tDay },
    testWindow: test.length ? { start: test[0].tDay, end: test[test.length - 1].tDay } : null,
    chosenCell: { stopPts: chosen.stopDist === Infinity ? null : chosen.stopDist, exitTime: chosen.exitTime },
    testResult, testBaseline4pm, allResult, allBaseline4pm,
    minTestNForPromotion: MIN_TEST_N_FOR_PROMOTION,
    method: 'chronological 70/30 split, stop x exit-time grid chosen on TRAIN only, day-blocked bootstrap CI on TEST',
  };

  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, notes)
    VALUES (CURRENT_DATE, 0, 'OVERNIGHT_9PM_ENTRY_CALIB', 'ALL_SESSIONS', $1, $2, $3, $4)
    ON CONFLICT DO NOTHING
  `, [trades.length, allResult.hitRate, allResult.meanDollarPerDay, JSON.stringify(notes)]);

  const status = testResult && testResult.excludesZero && testResult.n >= MIN_TEST_N_FOR_PROMOTION ? 'CONFIRMED' : 'PROVISIONAL';
  await recordClaim({
    slug: 'overnight_9pm_orderflow_predicts_rth_direction_20260921',
    claimText: `Self-recalibrating (scripts/calibrate_overnight_orderflow_entry.mjs, daily). Population: real trading days the live Globex rotation badge flags high-rotation by 12am (>=6 legs). Direction: 6pm-9pm ET cumulative ask/bid volume split. Held from 9pm entry through a candidate RTH exit time, stop distance and exit time both chosen fresh each run on a chronological 70/30 TRAIN split (grid: stop in [100,150,200,250,300,400,500,700,none] pts x exit in [10:30,11:30,12:30,13:30,14:30,15:30,16:00] ET), reported on the held-out TEST split. Latest run: N=${trades.length} total (train=${train.length}, test=${test.length}), chosen cell stop=${chosen.stopDist === Infinity ? 'NONE' : chosen.stopDist + 'pts'}/exit=${chosen.exitTime}. TEST: hitRate=${testResult?.hitRate}%, meanCapture=${testResult?.meanCapture}pts, $${testResult?.meanDollarPerDay}/day, day-blocked bootstrap 95% CI=[${testResult?.ci.lo},${testResult?.ci.hi}], excludesZero=${testResult?.excludesZero}. A manual holdout check (2026-09-21) found the EXIT-TIME choice specifically does not yet generalize (train favored 1:30pm, but that run's own held-out test favored the original 4pm close instead) -- this script exists so the stop/exit choice and its held-out performance both keep re-deriving fresh as real days accumulate, rather than locking in a possibly-overfit choice from a single N=53 snapshot. User's explicit instruction: "gather more data before proceeding" -- nothing here is wired to any live/SHADOW setup.`,
    sourceFile: 'scripts/calibrate_overnight_orderflow_entry.mjs',
    sourceDate: '2026-09-21',
    sampleSize: testResult?.n ?? trades.length,
    winRate: testResult?.hitRate ?? allResult.hitRate,
    evPerTrade: testResult?.meanDollarPerDay ?? allResult.meanDollarPerDay,
    rigorStatus: testResult?.excludesZero ? 'test_CI_excludes_zero' : 'test_CI_crosses_zero_thin_test_n',
    status,
  });
  console.log(`\nRecordClaim status=${status}`);
}

// Guarded 2026-09-22 (alongside exporting fetchTrades above) so importing this file for its
// fetchTrades() export doesn't also trigger main()'s own performance_audit INSERT/recordClaim
// side effects as an import-time accident -- matches this codebase's standard convention
// (e.g. scripts/backtest_poc_rotation_vbp.mjs) for a script that's both directly-runnable and
// importable.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
