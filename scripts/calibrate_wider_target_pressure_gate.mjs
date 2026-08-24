// Calibrates the wider-target mechanism's pressure-gate threshold and persists it to
// performance_audit (signal_type='WIDER_TARGET_PRESSURE_GATE') for the live code
// (server/routes/acd.js's resolveSetupsByPrice()) to read — same read-once-per-poll-then-
// cache convention already used for DELTA_CONFIRMATION_CALIB in that same function, not a
// new pattern. No-static-thresholds rule: the live code never hardcodes this number, it
// reads whatever this script last computed.
//
// Threshold = the top-tercile cutoff of buying/selling imbalance at the T1-touch bar,
// computed on ALL currently available armed trades (not held out — this script's job is to
// produce the best current live threshold, not to re-prove the mechanism; the underlying
// finding was already validated out-of-sample in scripts/backtest_wider_target_pressure_gate.mjs
// and its 2 predecessor diagnostics, all 2026-08-24). Re-run this weekly
// (run_weekly_backtests.sh) so the threshold tracks the real, growing population rather than
// freezing at whatever it was the day this shipped.
import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';

const FIRED_AT_BAR_COUNT_CUTOFF = 4;
const MAX_WALK_BARS = 500;

async function main() {
  const tradesRes = await query(`
    SELECT setup_type, trade_date::text as trade_date, fired_at,
      entry_zone_low::float as entry_zone_low, entry_zone_high::float as entry_zone_high,
      stop_level::float as stop_level, t1_level::float as t1_level, bars_to_resolution
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
      AND entry_zone_low IS NOT NULL AND entry_zone_high IS NOT NULL
      AND stop_level IS NOT NULL AND t1_level IS NOT NULL AND fired_at IS NOT NULL
    ORDER BY fired_at ASC
  `);
  // FIXED 2026-08-24 (DeepSeek design-critique finding, independently verified against
  // live data): this used to filter on the STORED resolution='TARGET_HIT' AND
  // bars_to_resolution<=4 -- but bars_to_resolution is written at the RESOLVING bar
  // (acd.js), not the T1-touch/arming bar. A trade that armed (fast T1 touch, pressure
  // confirmed) and then extended for many more bars before resolving (WIDER_TARGET_HIT/
  // WIDER_STOP_HIT/WIDER_TIME_EXPIRED) has a bars_to_resolution far above 4 and was being
  // silently excluded from its own gate's calibration sample -- while every BANKED_LOW_
  // PRESSURE/plain-bank row (which resolves AT the T1 touch, so bars_to_resolution IS the
  // touch bar count) stayed in-sample. That's a self-reinforcing loop: recalibration sees
  // an ever-more low-pressure-only sample, the top-tercile threshold drifts down, more
  // trades arm, fewer high-pressure readings survive to the next recalibration. Verified
  // live 2026-08-24: 53 rows show WIDER_*-prefixed resolution_method with
  // bars_to_resolution mostly >4 (SELECT origin_status,resolution,resolution_method,
  // COUNT(*),MIN(bars_to_resolution),MAX(bars_to_resolution) FROM active_setups WHERE
  // wider_target_mult IS NOT NULL GROUP BY 1,2,3) -- all of them would have been dropped
  // by the old filter. The downstream per-trade bar-walk below already re-derives
  // t1TouchIdx/barCount from raw bars independently of the stored resolution fields (see
  // `if (t1TouchIdx === null || barCount > FIRED_AT_BAR_COUNT_CUTOFF) continue;`), so it
  // is the correct, sole source of eligibility -- the SQL pre-filter was redundant at best
  // and silently wrong at worst. Removed both clauses; the walk below is unchanged.
  const trades = tradesRes.rows.filter(t => inferDirection(t.setup_type) !== null);

  const barsRes = await query(`
    SELECT ts, high::float as high, low::float as low,
      COALESCE(bid_volume,0)::float as bid_volume, COALESCE(ask_volume,0)::float as ask_volume
    FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC
  `);
  const allBars = barsRes.rows.map(b => ({
    ts: new Date(b.ts).getTime(), high: b.high, low: b.low,
    bid_volume: b.bid_volume, ask_volume: b.ask_volume,
  }));

  function firstIndexAfter(t) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  const imbalances = [];
  for (const trade of trades) {
    const direction = inferDirection(trade.setup_type);
    const long = direction === 'LONG';
    const entry = trade.entry_zone_high ?? trade.entry_zone_low;
    const stop = trade.stop_level;
    const t1 = trade.t1_level;
    const startIdx = firstIndexAfter(new Date(trade.fired_at).getTime());
    let barCount = 0, t1TouchIdx = null;
    for (let i = startIdx; i < Math.min(allBars.length, startIdx + MAX_WALK_BARS); i++) {
      barCount++;
      const bar = allBars[i];
      const t1Hit = long ? bar.high >= t1 : bar.low <= t1;
      const stopHit = long ? bar.low <= stop : bar.high >= stop;
      if (t1Hit && stopHit) { t1TouchIdx = null; break; }
      if (t1Hit) { t1TouchIdx = i; break; }
      if (stopHit) { t1TouchIdx = null; break; }
    }
    if (t1TouchIdx === null || barCount > FIRED_AT_BAR_COUNT_CUTOFF) continue;
    const touchBar = allBars[t1TouchIdx];
    const totalVol = touchBar.bid_volume + touchBar.ask_volume;
    if (totalVol <= 0) continue;
    const favorable = long ? touchBar.ask_volume : touchBar.bid_volume;
    const adverse = long ? touchBar.bid_volume : touchBar.ask_volume;
    imbalances.push((favorable - adverse) / totalVol);
  }

  imbalances.sort((a, b) => a - b);
  const threshold = imbalances[Math.floor(imbalances.length * 2 / 3)];
  console.log(`Calibrated on N=${imbalances.length} armed trades (all real, non-held-out). Top-tercile threshold = ${threshold.toFixed(4)}`);

  // window_days=0 marks an all-time (not rolling-window) calibration, matching
  // backtest_setup_status.mjs's own convention for the same column.
  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, notes)
    VALUES (CURRENT_DATE, 0, 'WIDER_TARGET_PRESSURE_GATE', 'THRESHOLD', $1, $2)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
      SET sample_size = EXCLUDED.sample_size, notes = EXCLUDED.notes
  `, [imbalances.length, JSON.stringify({ threshold, method: 'top_tercile_dirImbalance_at_t1_touch', calibratedOn: imbalances.length })]);

  console.log('DONE');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
