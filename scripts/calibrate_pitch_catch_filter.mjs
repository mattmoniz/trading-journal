// Calibrates the Pitch and Catch mechanism's qualification filter (RVol band, minimum
// settle-bars, ADX threshold) and persists it to performance_audit
// (signal_type='PITCH_CATCH_FILTER') for the live shadow logger (server/routes/acd.js) to
// read. Same read-once-per-poll-then-cache convention as STEP_TRAIL_FRACTION/
// WIDER_TARGET_PRESSURE_GATE. No-static-thresholds rule: bounds are percentiles of the real
// population's own distribution, never hardcoded literals.
//
// STATUS: this mechanism is UNVALIDATED (see server/services/pitchCatchWalker.js's header for
// the full negative evidence trail) -- this script exists to derive the CURRENT best filter
// definition for observation-only shadow logging, not to re-prove the mechanism works. Re-run
// weekly so the calibration tracks the real, growing population.
import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { computeADXSeries } from '../server/services/adxService.js';

const MAX_WALK_BARS = 2000, PULLBACK_MIN_FRAC = 0.15, CONFIRM_BARS = 3;

async function main() {
  const dailyBarsRes = await query(`
    SELECT ts::date::text as d, high::float as high, low::float as low, close::float as close
    FROM price_bars_primary WHERE symbol='NQ'
      AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int BETWEEN 570 AND 959
    ORDER BY ts ASC
  `);
  const byDate = new Map();
  for (const b of dailyBarsRes.rows) {
    if (!byDate.has(b.d)) byDate.set(b.d, { high: b.high, low: b.low, close: b.close });
    else { const c = byDate.get(b.d); c.high = Math.max(c.high, b.high); c.low = Math.min(c.low, b.low); c.close = b.close; }
  }
  const dailyDates = [...byDate.keys()].sort();
  const dailyBars = dailyDates.map(d => ({ d, ...byDate.get(d) }));
  const dailyAdx = computeADXSeries(dailyBars, 14, 14);
  const adxByDate = new Map();
  for (let i = 1; i < dailyBars.length; i++) adxByDate.set(dailyBars[i].d, dailyAdx[i - 1]);

  const setupsRes = await query(`
    SELECT setup_type, trade_date::text as trade_date, fired_at,
      entry_zone_low::float as entry_zone_low, entry_zone_high::float as entry_zone_high,
      stop_level::float as stop_level, t1_level::float as t1_level
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
      AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL AND fired_at IS NOT NULL
    ORDER BY fired_at ASC
  `);
  const barsRes = await query(`
    SELECT ts, ts::date::text as d, high::float as high, low::float as low, close::float as close,
      bid_volume::float as bid_volume, ask_volume::float as ask_volume
    FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC
  `);
  const allBars = barsRes.rows.map(b => ({
    ts: new Date(b.ts).getTime(), d: b.d, high: b.high, low: b.low, close: b.close,
    bid_volume: b.bid_volume || 0, ask_volume: b.ask_volume || 0,
  }));
  function firstIndexAfter(t) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function barVol(b) { return b.bid_volume + b.ask_volume; }

  let armed = [];
  for (const t of setupsRes.rows) {
    const dir = inferDirection(t.setup_type);
    if (dir === null) continue;
    const long = dir === 'LONG';
    const entry = t.entry_zone_high ?? t.entry_zone_low;
    const stop = t.stop_level, t1 = t.t1_level;
    const startIdx = firstIndexAfter(new Date(t.fired_at).getTime());
    if (startIdx >= allBars.length) continue;
    let t1Idx = null, barCount = 1, stopHitFirst = false;
    for (let i = startIdx; i < Math.min(allBars.length, startIdx + MAX_WALK_BARS); i++) {
      const bar = allBars[i];
      const t1Hit = long ? bar.high >= t1 : bar.low <= t1;
      const stopHit = long ? bar.low <= stop : bar.high >= stop;
      if (stopHit) { stopHitFirst = true; break; }
      if (t1Hit) { t1Idx = i; break; }
      barCount++;
    }
    if (stopHitFirst || t1Idx === null || barCount > 4) continue;
    const origDist = Math.abs(t1 - entry);
    const widerTarget = entry + (long ? 1 : -1) * 1.5 * origDist;
    let widerIdx = null;
    for (let i = t1Idx; i < Math.min(allBars.length, startIdx + MAX_WALK_BARS); i++) {
      const bar = allBars[i];
      const stopHit = long ? bar.low <= stop : bar.high >= stop;
      if (stopHit) break;
      const wHit = long ? bar.high >= widerTarget : bar.low <= widerTarget;
      if (wHit) { widerIdx = i; break; }
    }
    if (widerIdx === null) continue;
    armed.push({ trade_date: t.trade_date, long, entry, origDist, widerTarget, widerIdx, startIdx, adx: adxByDate.get(t.trade_date) });
  }

  function findConfirmedPullback(long, sessionDate, startIdx, origDist, startPrice) {
    let runningPeak = startPrice, belowCount = 0, confirmBar = null;
    for (let i = startIdx; i < allBars.length && allBars[i].d === sessionDate; i++) {
      const bar = allBars[i];
      if (long) {
        runningPeak = Math.max(runningPeak, bar.close);
        if ((runningPeak - bar.close) / origDist >= PULLBACK_MIN_FRAC) { belowCount++; if (belowCount >= CONFIRM_BARS) { confirmBar = i; break; } }
        else belowCount = 0;
      } else {
        runningPeak = Math.min(runningPeak, bar.close);
        if ((bar.close - runningPeak) / origDist >= PULLBACK_MIN_FRAC) { belowCount++; if (belowCount >= CONFIRM_BARS) { confirmBar = i; break; } }
        else belowCount = 0;
      }
    }
    return confirmBar == null ? null : { confirmBar };
  }

  const samples = [];
  for (const t of armed) {
    const pb = findConfirmedPullback(t.long, t.trade_date, t.widerIdx, t.origDist, t.widerTarget);
    if (!pb) continue;
    const firstLegBars = allBars.slice(t.startIdx, t.widerIdx + 1);
    const settleBars = allBars.slice(t.widerIdx + 1, pb.confirmBar + 1);
    const firstLegAvgVol = firstLegBars.reduce((s, b) => s + barVol(b), 0) / firstLegBars.length;
    const settleAvgVol = settleBars.reduce((s, b) => s + barVol(b), 0) / Math.max(1, settleBars.length);
    const rvol = firstLegAvgVol > 0 ? settleAvgVol / firstLegAvgVol : null;
    const barsToConfirm = pb.confirmBar - t.widerIdx;
    if (rvol != null && t.adx != null) samples.push({ rvol, barsToConfirm, adx: t.adx });
  }

  if (samples.length < 20) {
    console.log(`Only N=${samples.length} confirmed-pullback samples -- below N>=20, not calibrating yet.`);
    process.exit(0);
  }

  // Percentile-derived bounds, not hardcoded literals -- 25th/75th percentile of the real
  // RVol distribution defines "moderate" (per the 2026-09-04 diagnostic: both extremes,
  // very-quiet and very-heavy, underperformed the middle band).
  const rvols = [...samples.map(s => s.rvol)].sort((a, b) => a - b);
  const rvolLo = rvols[Math.floor(rvols.length * 0.25)];
  const rvolHi = rvols[Math.floor(rvols.length * 0.75)];
  const bcSorted = [...samples.map(s => s.barsToConfirm)].sort((a, b) => a - b);
  const minBarsToConfirm = bcSorted[Math.floor(bcSorted.length * 0.5)]; // population median
  const adxSorted = [...samples.map(s => s.adx)].sort((a, b) => a - b);
  const adxThreshold = adxSorted[Math.floor(adxSorted.length * 0.75)]; // top-quartile cutoff, matches the diagnostic's own regime split

  console.log(`Calibrated on N=${samples.length} confirmed-pullback samples: rvolLo=${rvolLo.toFixed(3)}, rvolHi=${rvolHi.toFixed(3)}, minBarsToConfirm=${minBarsToConfirm}, adxThreshold=${adxThreshold.toFixed(1)}`);

  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, notes)
    VALUES (CURRENT_DATE, 0, 'PITCH_CATCH_FILTER', 'FILTER', $1, $2)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
      SET sample_size = EXCLUDED.sample_size, notes = EXCLUDED.notes
  `, [samples.length, JSON.stringify({
    rvolLo, rvolHi, minBarsToConfirm, adxThreshold,
    method: 'percentile_25_75_rvol_median_bars_p75_adx',
  })]);

  console.log('DONE');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
