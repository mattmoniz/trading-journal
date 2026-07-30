// Rolling calibration for the cumulative-delta-confirmation live signal
// (server/services/deltaConfirmation.js). Computes the 25th-percentile-of-positive-
// cumulative-delta floor separately for each validated category (FADE, BREAKOUT) over a
// trailing window, and persists it to performance_audit so the live path never uses a
// number baked in from a one-off backtest -- matches this codebase's no-static-thresholds
// rule and the existing rolling-baseline convention (getVolumeBaseline/getPaceBaseline).
//
// Run weekly via run_weekly_backtests.sh, same cadence as every other calibration script.
//
// Reuses the exact detection/resolution functions already validated this session:
// FADE:        detectLevelFades/resolve (scripts/backtest_unified.js), getTradingDays/
//              getLevelPrices/getRTHBars (scripts/backtest_confluence.js) -- identical to
//              scratch/pilot_delta_fade_confirmation.mjs, which this mirrors.
// FADE_GLOBEX: mirrors scratch/pilot_delta_other_family_and_globex.mjs's
//              detectGlobexLevelFades/getGlobexBars (audited, no reimplementation bug --
//              it's detectLevelFades with the RTH-only gate removed, since Globex has no
//              RTH window to gate against). Genuinely different volume scale than RTH
//              fades (p25=31 vs 143 at K=10 in the validated test), hence a separate
//              category with its own calibration, not a shared threshold.
// BREAKOUT:    the same level-cluster-break detection already validated in
//              scratch/pilot_cumulative_delta_divergence.mjs (audited, bug-fixed, reused
//              3x this session) -- not yet factored into an exported function in
//              server/routes/acd.js (computeStackVolSignal() is shaped for a single live
//              poll over the last 3hrs, not a full-history backtest loop), so this script
//              replicates that exact, already-validated logic rather than inventing new
//              detection. If computeStackVolSignal() is ever refactored, extract its
//              detection core into a shared function and import it here instead.
import { query } from '../server/db.js';
import * as ss from 'simple-statistics';
import { fileURLToPath } from 'url';
import { getTradingDays, getLevelPrices, getRTHBars } from './backtest_confluence.js';
import { detectLevelFades } from './backtest_unified.js';
import { K_BARS } from '../server/services/deltaConfirmation.js';
import { computeRunningVwapSeries } from '../server/services/developingValueService.js';
import { getTrailingVwapStd, getTrailing24hrVwapStd, getGlobex24hrBars } from '../server/services/queries.js';

const TRAILING_DAYS = 200; // rolling window -- recalibrated fresh each run, not "all history forever"
const GLOBEX_EXCLUDED_LEVELS = new Set(['OR_HIGH', 'OR_LOW', 'OR_MID', 'IB_HIGH', 'IB_LOW', 'IB_MID', 'RTH_VWAP', 'ONH', 'ONL']);

async function getGlobexBars(sessionDate) {
  const r = await query(`
    SELECT ts, EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) as tod,
      open::float, high::float, low::float, close::float,
      COALESCE(bid_volume,0)::int as bid_volume, COALESCE(ask_volume,0)::int as ask_volume
    FROM price_bars_primary WHERE symbol = 'NQ'
      AND (
        (ts::date = $1::date - 1 AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) >= 1080)
        OR (ts::date = $1::date AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) < 510)
      )
    ORDER BY ts
  `, [sessionDate]);
  return r.rows;
}

function detectGlobexLevelFades(bars, levels, isMonday) {
  const STOP = isMonday ? 60 : 90, TARGET = isMonday ? 30 : 40;
  const fires = [];
  const fired = new Set();
  for (let i = 5; i < bars.length; i++) {
    const b = bars[i];
    for (const [name, price] of Object.entries(levels)) {
      if (price == null || fired.has(name)) continue;
      if (Math.abs(b.close - price) > 15) continue;
      const fromAbove = !(bars[i - 5].close < b.close);
      const dir = fromAbove ? 'LONG' : 'SHORT';
      fires.push({ direction: dir, entryIdx: i,
        stop: dir === 'LONG' ? b.close - STOP : b.close + STOP,
        target: dir === 'LONG' ? b.close + TARGET : b.close - TARGET });
      fired.add(name);
    }
  }
  return fires;
}

async function calibrateFadeGlobex(days) {
  const events = [];
  for (const d of days) {
    const levelsRes = await query(`
      SELECT DISTINCT ON (level_name) level_name, price::float
      FROM level_prices WHERE trade_date < $1 AND price IS NOT NULL
      ORDER BY level_name, trade_date DESC
    `, [d]);
    const levels = {};
    for (const row of levelsRes.rows) if (!GLOBEX_EXCLUDED_LEVELS.has(row.level_name)) levels[row.level_name] = row.price;

    const bars = await getGlobexBars(d);
    if (bars.length < 60) continue;
    const isMonday = new Date(d).getUTCDay() === 1;
    const fires = detectGlobexLevelFades(bars, levels, isMonday);
    for (const fire of fires) {
      if (bars.length - 1 - fire.entryIdx < K_BARS) continue;
      const window = bars.slice(fire.entryIdx + 1, fire.entryIdx + 1 + K_BARS);
      let cumDelta = 0;
      for (const b of window) {
        const delta = (b.ask_volume || 0) - (b.bid_volume || 0);
        cumDelta += (fire.direction === 'LONG' ? delta : -delta);
      }
      events.push(cumDelta);
    }
  }
  return events;
}

async function calibrateFade(days) {
  const events = [];
  for (const d of days) {
    const levels = await getLevelPrices(d);
    const rthBars = await getRTHBars(d);
    if (rthBars.length < 60) continue;
    const isMonday = new Date(d).getUTCDay() === 1;
    const fires = detectLevelFades(rthBars, levels, isMonday);
    for (const fire of fires) {
      if (rthBars.length - 1 - fire.entryIdx < K_BARS) continue;
      const window = rthBars.slice(fire.entryIdx + 1, fire.entryIdx + 1 + K_BARS);
      let cumDelta = 0;
      for (const b of window) {
        const delta = (b.ask_volume || 0) - (b.bid_volume || 0);
        cumDelta += (fire.direction === 'LONG' ? delta : -delta);
      }
      events.push(cumDelta);
    }
  }
  return events;
}

async function calibrateBreakout(days) {
  const events = [];
  for (const d of days) {
    const levels = await getLevelPrices(d);
    const rthBars = await getRTHBars(d);
    if (rthBars.length < 40) continue;

    for (let i = 0; i < rthBars.length; i++) {
      rthBars[i].gap = i > 0 ? (rthBars[i].ts.getTime() - rthBars[i - 1].ts.getTime()) / 60000 : null;
    }

    const levelsArr = Object.entries(levels).filter(([, p]) => p != null && isFinite(p))
      .map(([name, price]) => ({ name, price })).sort((a, b) => a.price - b.price);
    const clusters = [];
    let cur = levelsArr.length ? [levelsArr[0]] : [];
    for (let j = 1; j < levelsArr.length; j++) {
      if (levelsArr[j].price - levelsArr[j - 1].price <= 15) cur.push(levelsArr[j]);
      else { clusters.push(cur); cur = [levelsArr[j]]; }
    }
    if (cur.length) clusters.push(cur);

    const firedBars = new Set();
    for (let i = 30; i < rthBars.length; i++) {
      if (firedBars.has(i)) continue;
      const bar = rthBars[i];
      for (const cluster of clusters) {
        const clusterMin = cluster[0].price, clusterMax = cluster[cluster.length - 1].price;
        let direction = null;
        if (bar.close < clusterMin) {
          let foundAbove = false, validBreak = true;
          for (let k = 1; k <= 30; k++) {
            const pb = rthBars[i - k]; if (!pb) break;
            if (pb.gap == null || pb.gap > 5) { validBreak = false; break; }
            if (pb.close >= clusterMax) { foundAbove = true; break; }
            if (pb.close < clusterMin) { validBreak = false; break; }
          }
          if (foundAbove && validBreak) direction = 'SHORT';
        } else if (bar.close > clusterMax) {
          let foundBelow = false, validBreak = true;
          for (let k = 1; k <= 30; k++) {
            const pb = rthBars[i - k]; if (!pb) break;
            if (pb.gap == null || pb.gap > 5) { validBreak = false; break; }
            if (pb.close <= clusterMin) { foundBelow = true; break; }
            if (pb.close > clusterMax) { validBreak = false; break; }
          }
          if (foundBelow && validBreak) direction = 'LONG';
        }
        if (direction) {
          if (i + K_BARS < rthBars.length) {
            const window = rthBars.slice(i + 1, i + 1 + K_BARS);
            let cumDelta = 0;
            for (const b of window) {
              const delta = (b.ask_volume || 0) - (b.bid_volume || 0);
              cumDelta += (direction === 'LONG' ? delta : -delta);
            }
            events.push(cumDelta);
          }
          firedBars.add(i);
          break;
        }
      }
    }
  }
  return events;
}

// VWAP_MAGNET (RTH) — added 2026-07-28 after RESEARCH_CLAIM
// delta_confirmation_validated_for_vwap_magnet_rth_and_globex confirmed a real, rigor-clean
// descriptive gap using its OWN threshold (not the unrelated RTH FADE threshold). Reuses the
// exact same sigma-distance detection as scripts/backtest_vwap_magnet.mjs and the live
// vwapMagnetSetup in server/routes/acd.js -- computeRunningVwapSeries + getTrailingVwapStd.
async function calibrateVwapMagnet(days) {
  const events = [];
  for (const d of days) {
    const rthBars = await getRTHBars(d);
    if (rthBars.length < 30) continue;
    const vwapSeries = computeRunningVwapSeries(rthBars);
    const std = await getTrailingVwapStd(d, 30);
    let i = 2;
    while (i < rthBars.length) {
      const vwap = vwapSeries[i];
      if (vwap != null) {
        const dist = rthBars[i].close - vwap;
        if (Math.abs(dist) >= std.threshold) {
          const direction = dist < 0 ? 'LONG' : 'SHORT';
          if (rthBars.length - 1 - i >= K_BARS) {
            const window = rthBars.slice(i + 1, i + 1 + K_BARS);
            let cumDelta = 0;
            for (const b of window) {
              const delta = (b.ask_volume || 0) - (b.bid_volume || 0);
              cumDelta += (direction === 'LONG' ? delta : -delta);
            }
            events.push(cumDelta);
          }
          i += K_BARS; // same "one touch, then skip ahead" convention as the backfill script
        }
      }
      i++;
    }
  }
  return events;
}

// GLOBEX_VWAP_MAGNET — same idea for the 24hr VWAP, own threshold source
// (getTrailing24hrVwapStd/getGlobex24hrBars, genuinely different volume scale than RTH).
async function calibrateGlobexVwapMagnet(days) {
  const events = [];
  for (const d of days) {
    const globexBars = await getGlobex24hrBars(d);
    if (globexBars.length < 60) continue;
    const vwapSeries = computeRunningVwapSeries(globexBars);
    const std = await getTrailing24hrVwapStd(d, 30);
    let i = 4;
    while (i < globexBars.length) {
      const vwap = vwapSeries[i];
      if (vwap != null) {
        const dist = globexBars[i].close - vwap;
        if (Math.abs(dist) >= std.threshold) {
          const direction = dist < 0 ? 'LONG' : 'SHORT';
          if (globexBars.length - 1 - i >= K_BARS) {
            const window = globexBars.slice(i + 1, i + 1 + K_BARS);
            let cumDelta = 0;
            for (const b of window) {
              const delta = (b.ask_volume || 0) - (b.bid_volume || 0);
              cumDelta += (direction === 'LONG' ? delta : -delta);
            }
            events.push(cumDelta);
          }
          i += K_BARS;
        }
      }
      i++;
    }
  }
  return events;
}

async function run() {
  const allDays = await getTradingDays();
  const days = allDays.slice(-TRAILING_DAYS);
  console.log(`Calibrating over trailing ${days.length} days (of ${allDays.length} available)`);

  const { rows } = await query(`SELECT CURRENT_DATE::text as today`);
  const today = rows[0].today;

  for (const [category, fn] of [
    ['FADE', calibrateFade], ['FADE_GLOBEX', calibrateFadeGlobex], ['BREAKOUT', calibrateBreakout],
    ['VWAP_MAGNET', calibrateVwapMagnet], ['GLOBEX_VWAP_MAGNET', calibrateGlobexVwapMagnet],
  ]) {
    const cumDeltas = await fn(days);
    const positive = cumDeltas.filter(v => v > 0);
    const threshold = positive.length > 0 ? ss.quantile(positive, 0.25) : 0;
    console.log(`${category}: N=${cumDeltas.length}, positive=${positive.length}, p25 threshold=${threshold.toFixed(1)}`);

    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, notes)
      VALUES ($1, $2, 'DELTA_CONFIRMATION_CALIB', $3, $4, $5)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
        SET sample_size = EXCLUDED.sample_size, notes = EXCLUDED.notes
    `, [today, TRAILING_DAYS, category, cumDeltas.length, JSON.stringify({ threshold, k: K_BARS, computed_at: today })]);
  }

  console.log('Done.');
  process.exit(0);
}

// Exported (2026-07-28) so a later script (the bar-10 early-exit-on-bad-signal test) can
// reuse the exact validated Globex/breakout detection logic rather than reimplementing it
// per the "export the real function" rule -- guarded below so importing this module never
// triggers the weekly calibration run() as a side effect.
export { detectGlobexLevelFades, getGlobexBars, calibrateFadeGlobex, calibrateFade, calibrateBreakout, calibrateVwapMagnet, calibrateGlobexVwapMagnet };

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch(e => { console.error(e); process.exit(1); });
}
