// =============================================================================
// First-5-min adverse-excursion gate (2026-07-13, confirmed by user via OPEN_THREADS
// item: "if a first-5-min setup absorbs high MAE before the 9:35 bar closes, exit
// immediately"). Original finding (2026-07-09 backtest) used a hardcoded 38pt cutoff —
// that violates the "no static thresholds" rule, so this script derives the cutoff as
// mean + Kσ of the historical MAE-at-9:35 distribution instead, and sweeps K by EV
// (same pattern as update_optimal_stops.mjs's stop/target sweep) rather than assuming
// a fixed sigma multiplier.
//
// Cross-setup (session-timing effect, not setup-specific — matches the original
// finding's combined N across setup types), so this writes a single row, not one per
// setup_type.
//
// Writes signal_type='FIRST5MIN_MAE_GATE', signal_name='ALL_SETUPS' to performance_audit.
// The live path reads it in server/routes/acd.js's resolveSetupsByPrice().
// Run weekly (Sunday), same cadence as update_optimal_stops.mjs.
// =============================================================================

import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';

const MIN_N = 20;
const PNL_PER_POINT = 2; // MNQ = $2/point — matches resolveSetupsByPrice in acd.js
const COMMISSION = 1;
const K_CANDIDATES = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];

function mean(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }
function stddev(arr, mu) { return Math.sqrt(arr.reduce((s, v) => s + (v - mu) ** 2, 0) / arr.length); }

async function main() {
  console.log('Computing first-5-min MAE gate threshold from active_setups + price_bars_primary...');

  // Setups that fired in the first 5 minutes of RTH (9:30:00-9:34:59 ET = minute 570-574).
  const firedRes = await query(`
    SELECT id, setup_type, fired_at::text AS fired_at, trade_date::text AS trade_date,
           entry_zone_low::float, entry_zone_high::float, actual_pnl::float,
           stop_level::float, replay_resolution, resolution_bar_time::text AS resolution_bar_time
    FROM active_setups
    WHERE status = 'RESOLVED'
      AND replay_resolution IN ('TARGET_HIT', 'STOP_HIT')
      AND actual_pnl IS NOT NULL
      AND (EXTRACT(hour FROM fired_at) * 60 + EXTRACT(minute FROM fired_at))::int >= 570
      AND (EXTRACT(hour FROM fired_at) * 60 + EXTRACT(minute FROM fired_at))::int < 575
  `);
  console.log(`Found ${firedRes.rows.length} first-5-min-fired resolved trades (pre-direction-filter).`);

  const trades = [];
  for (const row of firedRes.rows) {
    const direction = inferDirection(row.setup_type);
    if (!direction) continue; // unknown direction (e.g. ZONE_EDGE_FADE) — skip, can't compute MAE side
    const entry = row.entry_zone_high ?? row.entry_zone_low;
    if (entry == null) continue;

    const barsRes = await query(`
      SELECT high::float, low::float, ts::text AS ts
      FROM price_bars_primary
      WHERE symbol = 'NQ' AND ts::date = $2::date AND ts > $1::timestamp
        AND (EXTRACT(hour FROM ts) * 60 + EXTRACT(minute FROM ts))::int <= 575
      ORDER BY ts
    `, [row.fired_at, row.trade_date]);
    if (barsRes.rows.length === 0) continue;

    // Stop the walk at the earlier of (a) the 9:35 bar close, or (b) the bar where the
    // trade's REAL stop already hit — otherwise MAE keeps accruing past the point where
    // the position was actually already flat, inflating drawdown for early-stopped trades
    // (found 2026-07-13: this initially made the gate look worse than it really is).
    let maeAt935 = 0;
    for (const bar of barsRes.rows) {
      const adverse = direction === 'LONG' ? entry - bar.low : bar.high - entry;
      maeAt935 = Math.max(maeAt935, adverse);
      if (row.replay_resolution === 'STOP_HIT' && row.stop_level != null) {
        const stopHitThisBar = direction === 'LONG' ? bar.low <= row.stop_level : bar.high >= row.stop_level;
        if (stopHitThisBar) break; // position already flat after this — stop accruing MAE
      }
    }
    trades.push({ maeAt935, actualPnl: row.actual_pnl });
  }

  console.log(`${trades.length} trades with valid direction + bar data through the 9:35 bar.`);
  if (trades.length < MIN_N) {
    console.log(`N=${trades.length} < MIN_N=${MIN_N} — insufficient sample, not persisting a gate (directional only).`);
    process.exit(0);
  }

  const maeValues = trades.map(t => t.maeAt935);
  const mu = mean(maeValues);
  const sigma = stddev(maeValues, mu);
  const evBaseline = mean(trades.map(t => t.actualPnl));

  let bestK = null, bestEV = evBaseline, bestThreshold = null;
  const sweepLog = [];
  for (const K of K_CANDIDATES) {
    const threshold = mu + K * sigma;
    const gatedPnls = trades.map(t =>
      t.maeAt935 > threshold ? (-t.maeAt935 * PNL_PER_POINT - COMMISSION) : t.actualPnl
    );
    const ev = mean(gatedPnls);
    sweepLog.push({ K, threshold, ev });
    if (ev > bestEV) { bestEV = ev; bestK = K; bestThreshold = threshold; }
  }

  console.log(`\nBaseline (no gate) EV: $${evBaseline.toFixed(2)}  N=${trades.length}  mu=${mu.toFixed(1)}pt  sigma=${sigma.toFixed(1)}pt`);
  sweepLog.forEach(({ K, threshold, ev }) => {
    const marker = K === bestK ? ' ← OPTIMAL' : '';
    console.log(`  K=${K}  threshold=${threshold.toFixed(1)}pt  EV=$${ev.toFixed(2)}${marker}`);
  });

  const active = bestK !== null;
  const wr = 100 * trades.filter(t => t.actualPnl > 0).length / trades.length;

  if (!active) {
    console.log(`\nNo K improves on baseline EV — gate not activated. Persisting HOLD row for tracking.`);
  } else {
    const gatedCount = trades.filter(t => t.maeAt935 > bestThreshold).length;
    console.log(`\nBest gate: K=${bestK}σ → threshold=${bestThreshold.toFixed(1)}pt. ${gatedCount}/${trades.length} trades would be gated. EV improves $${evBaseline.toFixed(2)} → $${bestEV.toFixed(2)}.`);
  }

  await query(`
    INSERT INTO performance_audit (
      run_date, window_days, signal_type, signal_name,
      sample_size, win_rate, ev_per_trade, avg_mae, p50_mae, p75_mae,
      optimal_stop, optimal_ev, recommendation, notes
    ) VALUES (
      CURRENT_DATE, 9999, 'FIRST5MIN_MAE_GATE', 'ALL_SETUPS',
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10
    )
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
      sample_size = EXCLUDED.sample_size, win_rate = EXCLUDED.win_rate,
      ev_per_trade = EXCLUDED.ev_per_trade, avg_mae = EXCLUDED.avg_mae,
      p50_mae = EXCLUDED.p50_mae, p75_mae = EXCLUDED.p75_mae,
      optimal_stop = EXCLUDED.optimal_stop, optimal_ev = EXCLUDED.optimal_ev,
      recommendation = EXCLUDED.recommendation, notes = EXCLUDED.notes
  `, [
    trades.length, wr / 100, evBaseline, mu, mu, mu + sigma,
    active ? bestThreshold : null, active ? bestEV : null,
    active ? 'ACTIVE' : 'HOLD',
    active
      ? `K=${bestK}sigma mu=${mu.toFixed(1)} sigma=${sigma.toFixed(1)} threshold=${bestThreshold.toFixed(1)}pt delta=$${(bestEV - evBaseline).toFixed(2)}`
      : `mu=${mu.toFixed(1)} sigma=${sigma.toFixed(1)} — no K improved EV, gate inactive`,
  ]);

  console.log(`\nPersisted FIRST5MIN_MAE_GATE row (recommendation=${active ? 'ACTIVE' : 'HOLD'}).`);
  process.exit(0);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
