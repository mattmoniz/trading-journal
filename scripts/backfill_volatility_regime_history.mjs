// Canonical historical backfill of the live volatility-regime classification, one row
// per trading day, persisted to performance_audit (signal_type='VOL_REGIME_HIST').
//
// Built 2026-07-16 after two independent Gemini attempts at a Markov-vs-existing-regime
// comparison produced inconsistent results — root cause: volatilityRegimeService.js has
// no persisted history, so any historical backtest had to REIMPLEMENT classifyRegime()'s
// logic by hand, and neither reimplementation was verified to match the live tool exactly.
// This script eliminates that risk by importing the real, live functions directly
// (fiveMinBars, stdevLogReturns, getPercentile, classifyRegime, getMorningVolBaseline —
// all exported from volatilityRegimeService.js specifically for this reuse) instead of
// reimplementing any of the math. Same trendStr formula as computeLiveVolatilityRegime()
// (see that function for the live version this mirrors line-for-line).
//
// No lookahead: getMorningVolBaseline(d) is strictly `ts::date < d` by construction, and
// this script only uses each day's own 9:30-10:30 ET bars for that day's own classification —
// exactly what would have been available live at 10:30 ET that morning.
import { query } from '../server/db.js';
import {
  fiveMinBars, stdevLogReturns, getPercentile, classifyRegime, getMorningVolBaseline,
} from '../server/services/volatilityRegimeService.js';

const RTH_START_MIN = 570;
const MORNING_END_MIN = 630;
const N_BASELINE = 60;

async function run() {
  const { rows: today } = await query(`SELECT CURRENT_DATE::text as d`);
  console.log(`Running as of ${today[0].d}`);

  const { rows: dateRows } = await query(`
    SELECT DISTINCT ts::date::text as d FROM price_bars_primary
    WHERE symbol='NQ' AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN ${RTH_START_MIN} AND 959
    ORDER BY d
  `);
  const allDates = dateRows.map(r => r.d);
  console.log(`Found ${allDates.length} candidate trading days.`);

  const results = [];
  let skippedThinBaseline = 0, skippedThinMorning = 0;

  for (const d of allDates) {
    const baseline = await getMorningVolBaseline(d);
    if (!baseline || baseline.n < N_BASELINE) { skippedThinBaseline++; continue; }

    const { rows: barRows } = await query(`
      SELECT DISTINCT ON (ts) (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min,
        open::float, high::float, low::float, close::float
      FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
        AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN ${RTH_START_MIN} AND ${MORNING_END_MIN}
      ORDER BY ts, id DESC
    `, [d]);
    const oneMin = barRows.sort((a, b) => a.et_min - b.et_min);
    if (oneMin.length < 15) { skippedThinMorning++; continue; }

    const five = fiveMinBars(oneMin);
    const morningVol = stdevLogReturns(five);
    if (morningVol == null) { skippedThinMorning++; continue; }

    const sessOpen = oneMin[0].open;
    const sessHigh = Math.max(...oneMin.map(b => b.high));
    const sessLow = Math.min(...oneMin.map(b => b.low));
    const sessClose = oneMin[oneMin.length - 1].close;
    const range = sessHigh - sessLow;
    const trendStr = range > 0 ? Math.abs(sessClose - sessOpen) / range : 0;

    const regime = classifyRegime(morningVol, baseline, trendStr, true);
    if (!regime) continue;

    results.push({ trade_date: d, regime, morning_vol: morningVol, trend_str: trendStr, baseline_n: baseline.n });
  }

  console.log(`Classified ${results.length} days. Skipped ${skippedThinBaseline} (thin baseline), ${skippedThinMorning} (thin morning bars).`);

  const counts = {};
  for (const r of results) counts[r.regime] = (counts[r.regime] || 0) + 1;
  console.log('Regime distribution:', counts);

  // Persist one row per day into performance_audit for durable reuse.
  for (const r of results) {
    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, notes)
      VALUES ($1, 0, 'VOL_REGIME_HIST', $2, 1, $3)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET notes = EXCLUDED.notes
    `, [
      today[0].d, r.trade_date,
      JSON.stringify({ trade_date: r.trade_date, regime: r.regime, morning_vol: r.morning_vol, trend_str: r.trend_str, baseline_n: r.baseline_n }),
    ]);
  }
  console.log(`Persisted ${results.length} rows to performance_audit (signal_type='VOL_REGIME_HIST', run_date=${today[0].d}).`);
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
