// =============================================================================
// recalibrate_level_fade_stops.mjs
//
// Recalibrates stop/target for the 9 "KEEP" level-fade setups in
// server/routes/acd.js (the `keepLevels` array, ~line 3619). Today those
// setups all share a flat 90pt stop / 40pt target regardless of each level's
// actual historical MAE distribution (per performance_audit: PD_IB_MID has a
// P75 MAE of only 38pt vs PD_POC/PD_VAH/FLOOR_PIVOT/FLOOR_R1/PD_OR_MID at 65pt).
//
// This script walks the FULL price history (2022-12-14 -> present, 861 days)
// and for each level:
//   1. Computes the level price for every trade day (definitions copied
//      verbatim from the live detection code in acd.js so results transfer).
//   2. Finds the first AM (before 12:00 ET) touch (price within 10pt of level).
//   3. Replays bar-by-bar from the touch bar, fading toward the level
//      (price approaching from above => SHORT; from below => LONG), exactly
//      mirroring the live setup's directional logic.
//   4. Sweeps a stop grid (P75 MAE -10/-0/+10/+20, plus 90pt baseline) x a
//      target grid (25/30/35/40/45pt), conservative same-bar rule: if both
//      stop and target are hit on the same bar, STOP wins.
//   5. Picks the EV-per-trade maximizing stop/target combo with N >= 15.
//
// Levels: PD_POC, 5D_OR_MID, PD_VAL, PD_VAH, PD_IB_MID, FLOOR_PIVOT, OR_HIGH,
//         FLOOR_R1, PD_OR_MID
//
// FLOOR_PIVOT / FLOOR_R1 use the *standard monthly* floor pivot formula
// (prior calendar month H/L/C), as explicitly requested by the task — this
// differs from the live code's daily-reset floor pivot (a known simplification
// in acd.js); the monthly version is the textbook-correct "floor pivot".
//
// PNL_PER_POINT = 2, COMMISSION = 1 (round trip, flat $1 deducted per trade).
// =============================================================================

import { query } from '../server/db.js';

const PNL_PER_POINT = 2;
const COMMISSION = 1;
const TOUCH_TOL = 10;       // pts, "first touch" proximity
const AM_CUTOFF_MIN = 720;  // 12:00 ET in minutes-from-midnight
const RTH_START_MIN = 570;  // 9:30 ET
const RTH_END_MIN = 959;    // 15:59 ET
const MIN_N = 15;

const STOP_GRID_DELTAS = [-10, 0, 10, 20]; // applied to each level's P75 MAE
const BASELINE_STOP = 90;
const TARGET_GRID = [25, 30, 35, 40, 45];

// P75 MAE figures supplied by the task (performance_audit). OR_HIGH unknown -> computed.
const P75_MAE = {
  PD_POC: 65,
  '5D_OR_MID': 55,
  PD_VAL: 60,
  PD_VAH: 65,
  PD_IB_MID: 38,
  FLOOR_PIVOT: 65,
  OR_HIGH: null, // computed from data below
  FLOOR_R1: 65,
  PD_OR_MID: 65,
};

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function minutesOfDay(ts) {
  const d = new Date(ts);
  // ts already stored/interpreted as ET wall-clock (see server/db.js comment)
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// -----------------------------------------------------------------------------
// 1. Pull raw data needed to compute level prices per day
// -----------------------------------------------------------------------------
async function loadLevelInputs() {
  const dv = await query(`
    SELECT trade_date, poc::float as poc, vah::float as vah, val::float as val,
           session_high::float as session_high, session_low::float as session_low,
           session_close::float as session_close
    FROM developing_value_log ORDER BY trade_date
  `);
  const acd = await query(`
    SELECT trade_date, or_high::float as or_high, or_low::float as or_low
    FROM acd_daily_log ORDER BY trade_date
  `);
  // IB (9:30-10:30) high/low per day, computed directly from bars (matches live code's window 570-630)
  const ib = await query(`
    SELECT ts::date as trade_date, MAX(high)::float as ib_high, MIN(low)::float as ib_low
    FROM price_bars_primary
    WHERE symbol='NQ' AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 630
    GROUP BY ts::date ORDER BY ts::date
  `);
  // Trading days list (RTH present) -- the universe we iterate over
  const days = await query(`
    SELECT DISTINCT ts::date as trade_date FROM price_bars_primary
    WHERE symbol='NQ' AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN ${RTH_START_MIN} AND ${RTH_END_MIN}
    ORDER BY ts::date
  `);
  // Monthly H/L/C from price_bars_primary RTH session bars, by calendar month
  const monthly = await query(`
    SELECT date_trunc('month', ts::date)::date as month_start,
           MAX(high)::float as month_high, MIN(low)::float as month_low,
           (ARRAY_AGG(close::float ORDER BY ts DESC))[1] as month_close
    FROM price_bars_primary
    WHERE symbol='NQ' AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN ${RTH_START_MIN} AND ${RTH_END_MIN}
    GROUP BY date_trunc('month', ts::date)
    ORDER BY month_start
  `);

  return {
    dvByDate: new Map(dv.rows.map(r => [r.trade_date, r])),
    acdByDate: new Map(acd.rows.map(r => [r.trade_date, r])),
    ibByDate: new Map(ib.rows.map(r => [r.trade_date, r])),
    tradeDays: days.rows.map(r => r.trade_date),
    monthly: monthly.rows, // [{month_start, month_high, month_low, month_close}]
  };
}

// Map a trade_date -> the calendar month string 'YYYY-MM' it falls in, and find prior month's row
function priorMonthKey(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function monthKeyOf(dateStr) {
  return dateStr.slice(0, 7);
}

// -----------------------------------------------------------------------------
// 2. Build per-day level price map for each of the 9 levels
// -----------------------------------------------------------------------------
function buildLevelSeries(inputs) {
  const { dvByDate, acdByDate, ibByDate, tradeDays, monthly } = inputs;

  const monthlyByKey = new Map(
    monthly.map(m => [
      `${new Date(m.month_start).getUTCFullYear()}-${String(new Date(m.month_start).getUTCMonth() + 1).padStart(2, '0')}`,
      m,
    ])
  );

  // sorted trade_date list for prior-day lookups
  const dvDates = [...dvByDate.keys()].sort();
  const acdDates = [...acdByDate.keys()].sort();

  function priorDvRow(tradeDate) {
    // last dv row strictly before tradeDate
    let lo = 0, hi = dvDates.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (dvDates[mid] < tradeDate) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans >= 0 ? dvByDate.get(dvDates[ans]) : null;
  }
  function priorAcdRow(tradeDate) {
    let lo = 0, hi = acdDates.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (acdDates[mid] < tradeDate) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans >= 0 ? acdByDate.get(acdDates[ans]) : null;
  }
  function priorNAcdRows(tradeDate, n) {
    // last n acd rows strictly before tradeDate, most recent first
    let lo = 0, hi = acdDates.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (acdDates[mid] < tradeDate) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (ans < 0) return [];
    const out = [];
    for (let i = ans; i >= 0 && out.length < n; i--) out.push(acdByDate.get(acdDates[i]));
    return out;
  }
  // prior trading day with IB data, strictly before tradeDate
  const ibDates = [...ibByDate.keys()].sort();
  function priorIbRow(tradeDate) {
    let lo = 0, hi = ibDates.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ibDates[mid] < tradeDate) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans >= 0 ? ibByDate.get(ibDates[ans]) : null;
  }

  // levels[tradeDate] = { PD_POC, '5D_OR_MID', PD_VAL, PD_VAH, PD_IB_MID, FLOOR_PIVOT, OR_HIGH, FLOOR_R1, PD_OR_MID }
  const levels = new Map();

  for (const tradeDate of tradeDays) {
    const out = {};

    // PD_POC / PD_VAL / PD_VAH -- prior day's developing value log
    const pdDv = priorDvRow(tradeDate);
    out.PD_POC = pdDv ? pdDv.poc : null;
    out.PD_VAL = pdDv ? pdDv.val : null;
    out.PD_VAH = pdDv ? pdDv.vah : null;

    // FLOOR_PIVOT / FLOOR_R1 -- standard MONTHLY floor pivot using PRIOR calendar month's H/L/C
    const pmKey = priorMonthKey(tradeDate);
    const pm = monthlyByKey.get(pmKey);
    if (pm && pm.month_high != null && pm.month_low != null && pm.month_close != null) {
      const p = (pm.month_high + pm.month_low + pm.month_close) / 3;
      out.FLOOR_PIVOT = p;
      out.FLOOR_R1 = 2 * p - pm.month_low;
    } else {
      out.FLOOR_PIVOT = null;
      out.FLOOR_R1 = null;
    }

    // OR_HIGH -- today's own opening range high (acd_daily_log row for tradeDate itself)
    const todayAcd = acdByDate.get(tradeDate);
    out.OR_HIGH = todayAcd ? todayAcd.or_high : null;

    // PD_OR_MID -- prior day's OR mid
    const pdAcd = priorAcdRow(tradeDate);
    out.PD_OR_MID = pdAcd && pdAcd.or_high != null && pdAcd.or_low != null
      ? (pdAcd.or_high + pdAcd.or_low) / 2 : null;

    // 5D_OR_MID -- rolling composite: max(OR highs of last 5 days) / min(OR lows of last 5 days), midpoint
    const last5 = priorNAcdRows(tradeDate, 5).filter(r => r.or_high != null && r.or_low != null);
    if (last5.length > 0) {
      const hi = Math.max(...last5.map(r => r.or_high));
      const lo = Math.min(...last5.map(r => r.or_low));
      out['5D_OR_MID'] = (hi + lo) / 2;
    } else {
      out['5D_OR_MID'] = null;
    }

    // PD_IB_MID -- prior trading day's IB (9:30-10:30) midpoint
    const pdIb = priorIbRow(tradeDate);
    out.PD_IB_MID = pdIb && pdIb.ib_high != null && pdIb.ib_low != null
      ? (pdIb.ib_high + pdIb.ib_low) / 2 : null;

    levels.set(tradeDate, out);
  }

  return levels;
}

// -----------------------------------------------------------------------------
// 3. For each level, find first AM touch per day, then resolve bar-by-bar
//    for EVERY (stop,target) combo in the grid simultaneously.
// -----------------------------------------------------------------------------
async function loadBarsByDate(tradeDays) {
  // Load all RTH bars for all trade days in one shot (861 days x ~390 bars ~= 335K rows -- fine)
  const res = await query(`
    SELECT ts, ts::date as trade_date, open::float as open, high::float as high,
           low::float as low, close::float as close
    FROM price_bars_primary
    WHERE symbol='NQ' AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN ${RTH_START_MIN} AND ${RTH_END_MIN}
    ORDER BY ts
  `);
  const byDate = new Map();
  for (const r of res.rows) {
    if (!byDate.has(r.trade_date)) byDate.set(r.trade_date, []);
    byDate.get(r.trade_date).push(r);
  }
  return byDate;
}

// Find first AM touch (within TOUCH_TOL of level) for a given day's bars.
// Returns { touchIdx, dir } where dir = 'LONG' (approaching from below -> fade up)
// or 'SHORT' (approaching from above -> fade down), matching live code's
// approachDir logic (compare close 5 bars back vs current touch price).
function findFirstTouch(bars, level) {
  if (level == null || !bars.length) return null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const mins = minutesOfDay(b.ts);
    if (mins >= AM_CUTOFF_MIN) break; // AM session only
    // touch if level is within [low-TOL, high+TOL] i.e. bar range comes within TOUCH_TOL of level
    const dist = Math.min(Math.abs(b.high - level), Math.abs(b.low - level));
    const within = (b.low - TOUCH_TOL <= level) && (b.high + TOUCH_TOL >= level);
    if (within) {
      const refIdx = Math.max(0, i - 5);
      const approachDir = bars[refIdx].close < b.close ? 'FROM_BELOW' : 'FROM_ABOVE';
      const isLong = approachDir === 'FROM_ABOVE'; // mirrors live code: FROM_ABOVE => LONG (fade back up)
      return { touchIdx: i, dir: isLong ? 'LONG' : 'SHORT', entry: b.close, bar: b };
    }
  }
  return null;
}

// Replay from the bar AFTER touch (entry assumed at touch bar's close) through
// remainder of RTH session, for a single stop/target pair. Conservative same-bar: STOP wins.
function resolveTrade(bars, touchIdx, dir, entry, stopPts, targetPts) {
  const stopPx = dir === 'LONG' ? entry - stopPts : entry + stopPts;
  const targetPx = dir === 'LONG' ? entry + targetPts : entry - targetPts;

  let mfe = 0, mae = 0;
  for (let i = touchIdx + 1; i < bars.length; i++) {
    const bar = bars[i];
    let favorable, adverse;
    if (dir === 'LONG') {
      favorable = bar.high - entry;
      adverse = entry - bar.low;
    } else {
      favorable = entry - bar.low;
      adverse = bar.high - entry;
    }
    mfe = Math.max(mfe, favorable);
    mae = Math.max(mae, adverse);

    let stopHit, targetHit;
    if (dir === 'LONG') {
      stopHit = bar.low <= stopPx;
      targetHit = bar.high >= targetPx;
    } else {
      stopHit = bar.high >= stopPx;
      targetHit = bar.low <= targetPx;
    }

    if (stopHit) {
      // same-bar conflict resolved conservatively: STOP wins regardless of targetHit
      return { win: false, pnlPts: -stopPts, mfe, mae };
    }
    if (targetHit) {
      return { win: true, pnlPts: targetPts, mfe, mae };
    }
  }
  // Unresolved by end of RTH session -> close at last bar's close (flat exit)
  const last = bars[bars.length - 1];
  const pnlPts = dir === 'LONG' ? last.close - entry : entry - last.close;
  return { win: pnlPts > 0, pnlPts, mfe, mae, expired: true };
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------
async function main() {
  console.log('='.repeat(130));
  console.log('LEVEL FADE STOP/TARGET RECALIBRATION -- FULL HISTORY (2022-12-14 -> present)');
  console.log('Conservative same-bar rule: STOP wins. PNL_PER_POINT=2, COMMISSION=1 (round trip).');
  console.log('='.repeat(130));

  const inputs = await loadLevelInputs();
  console.log(`Trading days in price_bars_primary: ${inputs.tradeDays.length}`);
  console.log(`developing_value_log rows: ${inputs.dvByDate.size}, acd_daily_log rows: ${inputs.acdByDate.size}, IB days: ${inputs.ibByDate.size}`);

  const levelSeries = buildLevelSeries(inputs);
  const barsByDate = await loadBarsByDate(inputs.tradeDays);
  console.log(`Bars loaded across ${barsByDate.size} days.`);
  console.log('');

  const LEVEL_NAMES = ['PD_POC', '5D_OR_MID', 'PD_VAL', 'PD_VAH', 'PD_IB_MID', 'FLOOR_PIVOT', 'OR_HIGH', 'FLOOR_R1', 'PD_OR_MID'];

  // For each level: gather all (touch) trades -> raw MAE list (for OR_HIGH P75 computation)
  // and for each stop/target combo, simulate the trade.
  const levelTouches = {}; // levelName -> [{dir, entry, bars, touchIdx, tradeDate}]
  for (const name of LEVEL_NAMES) {
    levelTouches[name] = [];
  }

  for (const tradeDate of inputs.tradeDays) {
    const bars = barsByDate.get(tradeDate);
    if (!bars || bars.length < 3) continue;
    const lv = levelSeries.get(tradeDate);
    if (!lv) continue;
    for (const name of LEVEL_NAMES) {
      const levelPx = lv[name];
      if (levelPx == null || !Number.isFinite(levelPx)) continue;
      const touch = findFirstTouch(bars, levelPx);
      if (touch) {
        levelTouches[name].push({ ...touch, bars, tradeDate });
      }
    }
  }

  console.log('First-AM-touch counts per level:');
  for (const name of LEVEL_NAMES) {
    console.log(`  ${name}: ${levelTouches[name].length} touches`);
  }
  console.log('');

  // Compute OR_HIGH's own P75 MAE using a baseline 90pt-stop/40pt-target resolution's MAE samples
  // (same methodology basis as the supplied figures, which are "P75 MAE" of the historical trade MAE distribution)
  function computeP75Mae(touches) {
    const maes = [];
    for (const t of touches) {
      const r = resolveTrade(t.bars, t.touchIdx, t.dir, t.entry, BASELINE_STOP, 40);
      maes.push(r.mae);
    }
    return percentile(maes, 75);
  }
  P75_MAE.OR_HIGH = computeP75Mae(levelTouches.OR_HIGH);
  console.log(`Computed OR_HIGH P75 MAE (baseline 90/40 resolution): ${P75_MAE.OR_HIGH.toFixed(1)}pt`);
  console.log('');

  // ---------------------------------------------------------------------------
  // Sweep stop x target grid per level
  // ---------------------------------------------------------------------------
  function evalCombo(touches, stopPts, targetPts) {
    let wins = 0, n = 0, totalPnl = 0;
    const maes = [], mfes = [];
    for (const t of touches) {
      const r = resolveTrade(t.bars, t.touchIdx, t.dir, t.entry, stopPts, targetPts);
      n++;
      if (r.win) wins++;
      const pnlDollars = r.pnlPts * PNL_PER_POINT - COMMISSION;
      totalPnl += pnlDollars;
      maes.push(r.mae);
      mfes.push(r.mfe);
    }
    const wr = n ? wins / n : 0;
    const ev = n ? totalPnl / n : 0;
    return {
      stop: stopPts, target: targetPts, n, wr, ev, totalPnl,
      mae50: percentile(maes, 50), mae75: percentile(maes, 75),
      mfe50: percentile(mfes, 50), mfe75: percentile(mfes, 75),
    };
  }

  const report = {}; // levelName -> { baseline, grid: [...], best }

  for (const name of LEVEL_NAMES) {
    const touches = levelTouches[name];
    const p75 = P75_MAE[name];
    const stopCandidates = [...new Set([...STOP_GRID_DELTAS.map(d => Math.max(5, Math.round(p75 + d))), BASELINE_STOP])];

    const baseline = evalCombo(touches, BASELINE_STOP, 40);

    const grid = [];
    for (const stopPts of stopCandidates) {
      for (const targetPts of TARGET_GRID) {
        grid.push(evalCombo(touches, stopPts, targetPts));
      }
    }

    // Pick best EV among combos with N >= MIN_N; fall back to highest-N combo if none qualify
    const qualifying = grid.filter(g => g.n >= MIN_N);
    let best;
    if (qualifying.length > 0) {
      best = qualifying.reduce((a, b) => (b.ev > a.ev ? b : a));
    } else {
      best = grid.reduce((a, b) => (b.n > a.n ? b : a));
    }

    report[name] = { p75, baseline, grid, best, totalTouches: touches.length };
  }

  // ---------------------------------------------------------------------------
  // Output: comparison table
  // ---------------------------------------------------------------------------
  console.log('='.repeat(130));
  console.log('COMPARISON TABLE');
  console.log('='.repeat(130));
  const header = `| Level | OLD (90/40) WR / EV | NEW Stop | NEW Target | NEW WR / EV | N | Improvement |`;
  const sep = `|---|---|---|---|---|---|---|`;
  console.log(header);
  console.log(sep);
  for (const name of LEVEL_NAMES) {
    const r = report[name];
    const oldStr = `${(r.baseline.wr * 100).toFixed(1)}% / $${r.baseline.ev.toFixed(2)} (N=${r.baseline.n})`;
    const newStr = `${(r.best.wr * 100).toFixed(1)}% / $${r.best.ev.toFixed(2)} (N=${r.best.n})`;
    const improvement = r.baseline.ev !== 0
      ? `${r.best.ev >= r.baseline.ev ? '+' : ''}${(r.best.ev - r.baseline.ev).toFixed(2)} (${(((r.best.ev - r.baseline.ev) / Math.abs(r.baseline.ev)) * 100).toFixed(0)}%)`
      : `${(r.best.ev - r.baseline.ev).toFixed(2)}`;
    console.log(`| ${name} | ${oldStr} | ${r.best.stop}pt | ${r.best.target}pt | ${newStr} | ${r.best.n} | ${improvement} |`);
  }
  console.log('');

  // ---------------------------------------------------------------------------
  // Full grid dump per level (for transparency)
  // ---------------------------------------------------------------------------
  console.log('='.repeat(130));
  console.log('FULL GRID DETAIL PER LEVEL (stop x target sweep)');
  console.log('='.repeat(130));
  for (const name of LEVEL_NAMES) {
    const r = report[name];
    console.log(`\n--- ${name} (P75 MAE input: ${r.p75.toFixed(1)}pt, total AM touches: ${r.totalTouches}) ---`);
    console.log('Stop | Target |   N  |   WR   |    EV    |  TotalPnl |  MAE p50/p75 | MFE p50/p75');
    for (const g of r.grid) {
      const mark = (g.stop === r.best.stop && g.target === r.best.target) ? '  <== BEST' : '';
      console.log(
        `${String(g.stop).padStart(4)} | ${String(g.target).padStart(6)} | ${String(g.n).padStart(4)} | ${(g.wr * 100).toFixed(1).padStart(5)}% | $${g.ev.toFixed(2).padStart(7)} | $${g.totalPnl.toFixed(0).padStart(8)} | ${g.mae50.toFixed(0)}/${g.mae75.toFixed(0)} | ${g.mfe50.toFixed(0)}/${g.mfe75.toFixed(0)}${mark}`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Final JS array for keepLevels
  // ---------------------------------------------------------------------------
  const nameMap = {
    PD_POC: 'PD_POC_FADE',
    '5D_OR_MID': '5D_OR_MID_FADE',
    PD_VAL: 'PD_VAL_FADE',
    PD_VAH: 'PD_VAH_FADE',
    PD_IB_MID: 'PD_IB_MID_FADE',
    FLOOR_PIVOT: 'FLOOR_PIVOT_FADE',
    OR_HIGH: 'OR_HIGH_FADE',
    FLOOR_R1: 'FLOOR_R1_FADE',
    PD_OR_MID: 'PD_OR_MID_FADE',
  };

  console.log('');
  console.log('='.repeat(130));
  console.log('RECOMMENDED keepLevels ARRAY (paste into server/routes/acd.js)');
  console.log('='.repeat(130));
  console.log('const keepLevels = [');
  for (const name of LEVEL_NAMES) {
    const r = report[name];
    const b = r.best;
    console.log(
      `  { name: '${nameMap[name]}', stop: ${b.stop}, target: ${b.target}, wr: ${b.wr.toFixed(3)}, ev: ${b.ev.toFixed(2)}, n: ${b.n}, mfe: ${Math.round(b.mfe50)}, mae: ${Math.round(b.mae50)} },`
    );
  }
  console.log('];');
  console.log('');

  process.exit(0);
}

main().catch(err => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
