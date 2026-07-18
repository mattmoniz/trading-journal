// Canonical daily Cumulative Volume Delta (CVD) history — order-flow signal flagged
// as a real, untested gap in docs/REGIME_DETECTION_SPEC.md §3.7 (delta/CVD divergence
// from price is a classic order-flow tell, not computed anywhere in this codebase
// before this script).
//
// delta per bar = ask_volume - bid_volume (net buyer-initiated vs seller-initiated
// volume) -- matches the EXACT existing convention in server/services/caseEngine.js's
// confirmedDeltaDir() and touchQuality.js's classifyTouch() (adverse/favorable volume
// split), reused here, not reinvented.
//
// Computes two windows per trading day:
//   - overnight CVD: sum of delta from the PRIOR day's RTH close (16:00 ET) through
//     TODAY's RTH open (09:30 ET) -- the full Globex/overnight session.
//   - RTH CVD: sum of delta during today's 09:30-16:00 ET session.
//
// symbol='NQ' filter applied throughout -- price_bars_primary has documented ES
// contamination (2023-11-15 to 2023-12-15) that has already caused two separate real
// bugs in unrelated GARCH work this session; applying the filter from the start here
// rather than discovering the same bug a third time.
//
// Persists one row/day to performance_audit, signal_type='CVD_DAILY', matching the
// VOL_REGIME_HIST/GARCH_VOL_SCALE persistence convention -- a canonical, queryable,
// reusable source per the "no dead ends" hard rule, not a one-off scratch computation.
//
// Run: node scripts/backfill_cvd_daily_history.mjs
import { query } from '../server/db.js';

async function main() {
  console.log('Loading NQ 1-min bars (bid_volume/ask_volume)...');
  const barsRes = await query(`
    SELECT ts, (date(ts AT TIME ZONE 'America/New_York'))::text as et_date,
      (EXTRACT(hour FROM ts AT TIME ZONE 'America/New_York')*60 +
       EXTRACT(minute FROM ts AT TIME ZONE 'America/New_York'))::int as et_min,
      COALESCE(bid_volume, 0) as bid_volume, COALESCE(ask_volume, 0) as ask_volume
    FROM price_bars_primary
    WHERE symbol = 'NQ'
    ORDER BY ts ASC
  `);
  console.log(`Loaded ${barsRes.rows.length} bars.`);

  // Distinct RTH trading dates (used as the day index -- overnight session for date D
  // is bounded [prior RTH close on the previous trading date, RTH open on D]).
  const rthDatesSet = new Set(barsRes.rows.filter(r => r.et_min >= 570 && r.et_min < 960).map(r => r.et_date));
  const rthDates = [...rthDatesSet].sort();
  console.log(`${rthDates.length} distinct RTH trading dates.`);

  // Bucket every bar's delta by (et_date, et_min) for windowed summation.
  const byDate = new Map();
  for (const b of barsRes.rows) {
    if (!byDate.has(b.et_date)) byDate.set(b.et_date, []);
    byDate.get(b.et_date).push({ et_min: b.et_min, delta: Number(b.ask_volume) - Number(b.bid_volume) });
  }

  const records = [];
  for (let i = 1; i < rthDates.length; i++) {
    const today = rthDates[i];
    const prior = rthDates[i - 1];

    // RTH CVD: today's 09:30-16:00 ET bars.
    const todayBars = byDate.get(today) || [];
    const rthCvd = todayBars.filter(b => b.et_min >= 570 && b.et_min < 960)
      .reduce((s, b) => s + b.delta, 0);

    // Overnight CVD: prior day's bars after its RTH close (et_min >= 960) PLUS
    // today's bars before RTH open (et_min < 570). Covers the full Globex session
    // regardless of which calendar date each bar's timestamp falls on.
    const priorBars = byDate.get(prior) || [];
    const overnightCvd =
      priorBars.filter(b => b.et_min >= 960).reduce((s, b) => s + b.delta, 0) +
      todayBars.filter(b => b.et_min < 570).reduce((s, b) => s + b.delta, 0);

    records.push({ date: today, overnightCvd, rthCvd });
  }

  console.log('Upserting into performance_audit (signal_type=CVD_DAILY)...');
  // SQL CURRENT_DATE, not JS toISOString() -- the DB runs America/New_York, JS's
  // toISOString() is UTC, and the two disagree once past 8PM ET (CLAUDE.md hard rule).
  const { rows: [{ today: today_str }] } = await query(`SELECT CURRENT_DATE::text as today`);
  for (const r of records) {
    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, notes)
      VALUES ($1, 0, 'CVD_DAILY', $2, 1, $3)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET notes = EXCLUDED.notes
    `, [today_str, r.date, JSON.stringify({ trade_date: r.date, overnight_cvd: r.overnightCvd, rth_cvd: r.rthCvd })]);
  }
  console.log(`Backfill complete: ${records.length} days.`);

  // Quick sanity print -- spot-check a few real days rather than trust the loop blindly.
  const sample = records.slice(-5);
  console.log('Most recent 5 days:', sample);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
