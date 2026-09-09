// Rolling stop/target width calibration for the momentum-chase (PDH/PDL breakout) setup,
// 2026-09-09. Backing research: RESEARCH_CLAIM setup6_momentum_chase_medium_regime_positive_20260909
// (scratch/backtest_script_round5.py) -- found a real, chronologically stable edge (N=128,
// win rate 58.6%, mean +$13.23/trade) in MEDIUM GARCH-regime days ONLY, using a stop/target
// width equal to the 75th percentile of 5-min bar range -- but that backtest derived the width
// ONCE from the full ~1.5-year history (LOW=34pt/MEDIUM=46pt/HIGH=58pt), not walk-forward.
//
// This script closes that gap for LIVE use: recomputes the SAME 75th-percentile-of-bar-range
// statistic from only a TRAILING window of real, regime-tagged bars, on every run (this
// codebase's own no-static-thresholds rule -- a threshold that never gets recomputed against
// current data is exactly the kind of thing found stale/inverted before, see CLAUDE.md's
// sizeMultiplier incident). The live detector (server/services/momentumChaseDetector.js) reads
// this script's freshest row rather than a hardcoded number.
//
// Trailing window: 90 calendar days of regime-tagged trading days (not 90 bars) -- matches the
// scale of window this exact research thread already uses for a similar rolling-deviation
// stat (the EMA-band-reversion scripts' "30-session rolling sigma"), widened here since a
// bar-range PERCENTILE needs more samples to stabilize than a mean/stdev does. Recomputes
// LOW/MEDIUM/HIGH all three (MEDIUM is the only one the live detector actually fires on, but
// LOW/HIGH are cheap to compute alongside and useful for display/monitoring context).
//
// Scheduled: added to run_daily_calibration.sh (nightly, 8:20pm ET) -- recalibrates every
// trading day as new bars and new GARCH regime tags accumulate.

import { query } from '../server/db.js';

const TRAILING_DAYS = 90;

async function main() {
  console.log('Fetching GARCH regime series...');
  const garchRes = await query(`
    SELECT run_date::text as trade_date, (notes::jsonb->>'scale')::float as scale
    FROM performance_audit
    WHERE signal_type = 'GARCH_VOL_SCALE' AND signal_name != 'LATEST'
    ORDER BY run_date ASC
  `);
  if (garchRes.rows.length === 0) {
    console.log('No GARCH_VOL_SCALE history yet -- nothing to calibrate.');
    process.exit(0);
  }
  const scales = garchRes.rows.map((r) => r.scale).slice().sort((a, b) => a - b);
  const percentile = (arr, p) => {
    const pos = p * (arr.length - 1);
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return arr[lo];
    return arr[lo] + (arr[hi] - arr[lo]) * (pos - lo);
  };
  const p30 = percentile(scales, 0.30);
  const p80 = percentile(scales, 0.80);

  const regimeByDate = new Map();
  for (const row of garchRes.rows) {
    const r = row.scale < p30 ? 'LOW' : row.scale <= p80 ? 'MEDIUM' : 'HIGH';
    regimeByDate.set(row.trade_date, r);
  }

  const cutoffDateRes = await query(`SELECT (CURRENT_DATE - INTERVAL '${TRAILING_DAYS} days')::date::text as cutoff`);
  const cutoff = cutoffDateRes.rows[0].cutoff;

  console.log(`Fetching 5-min RTH bar ranges since ${cutoff}...`);
  const barsRes = await query(`
    SELECT ts::date::text as trade_date, floor(EXTRACT(epoch FROM ts) / 300) as bucket,
      MAX(high) as bar_hi, MIN(low) as bar_lo
    FROM price_bars_primary
    WHERE symbol = 'NQ' AND ts::date >= $1 AND ts::date < CURRENT_DATE
      AND EXTRACT(hour FROM ts) * 60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    GROUP BY ts::date, floor(EXTRACT(epoch FROM ts) / 300)
  `, [cutoff]);
  const rangesByRegime = { LOW: [], MEDIUM: [], HIGH: [] };
  for (const row of barsRes.rows) {
    const regime = regimeByDate.get(row.trade_date);
    if (!regime) continue;
    const range = row.bar_hi - row.bar_lo;
    if (range > 0) rangesByRegime[regime].push(range);
  }

  const widths = {};
  for (const regime of ['LOW', 'MEDIUM', 'HIGH']) {
    const arr = rangesByRegime[regime].slice().sort((a, b) => a - b);
    widths[regime] = arr.length >= 20 ? Math.round(percentile(arr, 0.75)) : null;
    console.log(`${regime}: N=${arr.length} bars, 75th-pctile width=${widths[regime]}`);
  }

  if (Object.values(widths).some((w) => w === null)) {
    console.log('At least one regime has <20 bars in the trailing window -- not overwriting a stale/thin calibration silently. Aborting write.');
    process.exit(1);
  }

  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, notes)
    VALUES (CURRENT_DATE, $1, 'MOMENTUM_CHASE_WIDTH_CALIB', 'LATEST', $2, $3)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET notes = EXCLUDED.notes, sample_size = EXCLUDED.sample_size
  `, [TRAILING_DAYS, rangesByRegime.MEDIUM.length, JSON.stringify({
    widths, trailing_days: TRAILING_DAYS, p30, p80,
    n_bars: { LOW: rangesByRegime.LOW.length, MEDIUM: rangesByRegime.MEDIUM.length, HIGH: rangesByRegime.HIGH.length },
  })]);
  console.log('Calibration written:', widths);
}

main().catch((e) => { console.error(e); process.exit(1); });
