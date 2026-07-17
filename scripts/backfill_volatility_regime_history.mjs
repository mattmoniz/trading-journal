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
//
// Ongoing table, not a one-shot snapshot (decided 2026-07-17, see OPEN_DECISION
// vol_regime_history_cron_undecided): the whole point of persisting this canonical
// history was so future comparisons never have to reimplement classifyRegime() by hand
// again — that guarantee only holds if the table keeps growing past the original backfill
// cutoff. Wired into server/index.js's nightly Mon-Fri cron. Default mode is incremental
// (skips trading days already present in performance_audit) so the nightly run only does
// ~1 day of work (a full-history rerun takes ~3.5min, too slow to repeat every night as
// history grows); pass --full to force a complete rebuild (e.g. after a classifyRegime()
// logic change that should retroactively reclassify every historical day).
//
// Staleness detection (added 2026-07-17): incremental mode alone has a real blind spot —
// once a day has a row, it's never revisited, so a retroactive correction to
// price_bars_primary (this codebase has a documented history of exactly that: duplicate-
// bar repairs, timezone fixes) would leave that day's regime silently wrong forever. Fixed
// by storing a content fingerprint (hash of the exact 9:30-10:30 ET bars the classification
// actually used) in each row's notes, and re-checking it for the most recent
// RECHECK_WINDOW_DAYS trading days on every incremental run — cheap (one lightweight query
// per recent day) and catches the common case (a fix landing soon after the bad data was
// ingested). Deliberately NOT extended to check fingerprints across ALL of history every
// night — that cost grows with history size for a benefit that's rare past the recent
// window (older/broader corrections are exactly what this codebase's existing
// DB_MIGRATION_PROTOCOL.md already calls for re-verifying downstream data after). If a
// repair script touches price_bars_primary outside the recheck window, run --full.
import crypto from 'crypto';
import { query } from '../server/db.js';
import {
  fiveMinBars, stdevLogReturns, getPercentile, classifyRegime, getMorningVolBaseline,
} from '../server/services/volatilityRegimeService.js';

const RTH_START_MIN = 570;
const MORNING_END_MIN = 630;
const N_BASELINE = 60;
const RECHECK_WINDOW_DAYS = 15;
const FULL = process.argv.includes('--full');

function fingerprintBars(oneMin) {
  const s = oneMin.map(b => `${b.et_min}:${b.open}:${b.high}:${b.low}:${b.close}`).join(',');
  return crypto.createHash('md5').update(s).digest('hex');
}

async function getMorningBars(d) {
  const { rows: barRows } = await query(`
    SELECT DISTINCT ON (ts) (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min,
      open::float, high::float, low::float, close::float
    FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN ${RTH_START_MIN} AND ${MORNING_END_MIN}
    ORDER BY ts, id DESC
  `, [d]);
  return barRows.sort((a, b) => a.et_min - b.et_min);
}

async function run() {
  const { rows: today } = await query(`SELECT CURRENT_DATE::text as d`);
  console.log(`Running as of ${today[0].d}${FULL ? ' (--full rebuild)' : ' (incremental)'}`);

  const { rows: dateRows } = await query(`
    SELECT DISTINCT ts::date::text as d FROM price_bars_primary
    WHERE symbol='NQ' AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN ${RTH_START_MIN} AND 959
    ORDER BY d
  `);
  const allTradingDates = dateRows.map(r => r.d);
  let allDates = allTradingDates;

  // signal_name -> stored bars_fingerprint (from notes), for staleness comparison
  let storedFingerprints = new Map();
  if (!FULL) {
    const { rows: doneRows } = await query(`SELECT DISTINCT ON (signal_name) signal_name as d, notes FROM performance_audit WHERE signal_type='VOL_REGIME_HIST' ORDER BY signal_name, run_date DESC`);
    const done = new Set(doneRows.map(r => r.d));
    for (const r of doneRows) {
      try { storedFingerprints.set(r.d, JSON.parse(r.notes).bars_fingerprint); } catch (_) {}
    }
    // Recheck window: the most recent RECHECK_WINDOW_DAYS trading days get their
    // fingerprint re-verified even if already classified, so a retroactive data
    // correction gets picked up automatically instead of sitting stale forever.
    const recheckSet = new Set(allTradingDates.slice(-RECHECK_WINDOW_DAYS));
    allDates = allTradingDates.filter(d => !done.has(d) || recheckSet.has(d));
  }
  console.log(`Found ${allDates.length} candidate trading days${FULL ? '' : ` (new + last ${RECHECK_WINDOW_DAYS} rechecked for staleness)`}.`);

  const results = [];
  let skippedThinBaseline = 0, skippedThinMorning = 0, skippedUnchanged = 0;

  for (const d of allDates) {
    const oneMin = await getMorningBars(d);
    if (oneMin.length < 15) { skippedThinMorning++; continue; }

    const fp = fingerprintBars(oneMin);
    if (!FULL && storedFingerprints.has(d) && storedFingerprints.get(d) === fp) {
      skippedUnchanged++;
      continue; // already classified and the underlying bars haven't changed
    }

    const baseline = await getMorningVolBaseline(d);
    if (!baseline || baseline.n < N_BASELINE) { skippedThinBaseline++; continue; }

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

    const wasStale = storedFingerprints.has(d);
    results.push({ trade_date: d, regime, morning_vol: morningVol, trend_str: trendStr, baseline_n: baseline.n, bars_fingerprint: fp, wasStale });
  }

  const staleCount = results.filter(r => r.wasStale).length;
  console.log(`Classified ${results.length} days (${staleCount} were re-classified due to changed underlying bars). Skipped ${skippedThinBaseline} (thin baseline), ${skippedThinMorning} (thin morning bars), ${skippedUnchanged} (already classified, unchanged).`);
  if (staleCount > 0) {
    console.log(`STALE DAYS CORRECTED: ${results.filter(r => r.wasStale).map(r => r.trade_date).join(', ')}`);
  }

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
      JSON.stringify({ trade_date: r.trade_date, regime: r.regime, morning_vol: r.morning_vol, trend_str: r.trend_str, baseline_n: r.baseline_n, bars_fingerprint: r.bars_fingerprint }),
    ]);
  }
  console.log(`Persisted ${results.length} rows to performance_audit (signal_type='VOL_REGIME_HIST', run_date=${today[0].d}).`);
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
