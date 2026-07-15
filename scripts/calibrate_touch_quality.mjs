// =============================================================================
// Calibrate per-setup_type touch-quality (order-flow) parameters and persist to
// performance_audit (signal_type='TOUCH_QUALITY'). Read live by acd.js's
// resolveSetupsByPrice() to classify open setups in real time.
//
// Origin: docs/OPEN_THREADS.md "Touch-quality" thread. Supersedes the exploratory
// scripts/pilot_touch_quality_orderflow.mjs for production use — that script's
// findings (validated on all 47 N>=50 setup_types, cross-checked against Gemini,
// zero day-clustering) are what this script turns into a live-readable calibration.
//
// Uses server/services/touchQuality.js — the SAME module the live resolution path
// imports — so calibration and live classification can never drift apart.
//
// Safe to re-run: idempotent upsert on (run_date, window_days, signal_type, signal_name).
// =============================================================================

import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { getVolumeBaseline, classifyTouch } from '../server/services/touchQuality.js';
import { computeRigor, rigorContext } from '../server/services/rigorDiagnostics.js';

const MIN_N = 20; // hard floor, per CLAUDE.md — matches SUPPRESS_MIN_N convention elsewhere

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function replayFull(bars, entry, stop, t1, direction) {
  let mae = 0;
  let resolution = 'EXPIRED';
  let barsToResolution = 0;
  const maeTrace = [];
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    barsToResolution = i + 1;
    const adverse = direction === 'LONG' ? entry - bar.low : bar.high - entry;
    mae = Math.max(mae, adverse);
    maeTrace.push(mae);
    const stopHit   = direction === 'LONG' ? bar.low  <= stop : bar.high >= stop;
    const targetHit = direction === 'LONG' ? bar.high >= t1   : bar.low  <= t1;
    if (stopHit)   { resolution = 'STOP_HIT'; break; }
    if (targetHit) { resolution = 'TARGET_HIT'; break; }
  }
  return { resolution, barsToResolution, maeTrace };
}

function bucketStats(rows) {
  const n = rows.length;
  if (n === 0) return { n: 0, wr: null, ev: null };
  const wins = rows.filter(r => r.resolution === 'TARGET_HIT').length;
  const evs = rows.map(r => Number(r.actual_pnl)).filter(Number.isFinite);
  const ev = evs.length ? evs.reduce((a, b) => a + b, 0) / evs.length : null;
  return { n, wr: wins / n, ev };
}

// Same margin-based rule used to independently re-derive Gemini's tags during the
// 2026-07-15 audit (which caught 2 of Gemini's own mislabeled types) — a bucket
// needs both N>=15 (non-thin) and a >=$3 EV margin over the next-best bucket to
// be called out as the winner/loser, matching the margin Gemini itself used.
function classifyPattern(absorbed, overrun, quiet) {
  const buckets = [
    { name: 'ABSORBED', ...absorbed },
    { name: 'OVERRUN', ...overrun },
    { name: 'QUIET', ...quiet },
  ].filter(b => b.n >= 15 && b.ev !== null);
  if (buckets.length < 2) return 'NO_CLEAR_PATTERN';
  const sorted = [...buckets].sort((a, b) => b.ev - a.ev);
  const best = sorted[0], worst = sorted[sorted.length - 1];
  if (worst.name === 'OVERRUN' && (sorted[sorted.length - 2].ev - worst.ev) >= 3) return 'OVERRUN_BAD';
  if (best.name === 'ABSORBED' && (best.ev - sorted[1].ev) >= 3) return 'ABSORBED_BEST';
  if (best.name === 'QUIET' && (best.ev - sorted[1].ev) >= 3) return 'QUIET_BEST';
  return 'NO_CLEAR_PATTERN';
}

// Bars-of-day and the 90-day volume baseline depend only on `date`, not on setup_type —
// trading dates overlap heavily across the 47 setup_types this script calibrates, so
// without caching, both queries were being re-run once per (setup_type, date) pair
// instead of once per date. This was the direct cause of the calibration run taking
// ~50 minutes under concurrent DB load in production (vs. under 2 minutes when it ran
// idle). Found in code review 2026-07-15.
const _barsCache = new Map();
const _baselineCache = new Map();

async function getBarsForDate(date) {
  if (_barsCache.has(date)) return _barsCache.get(date);
  const barsRes = await query(`
    SELECT ts, open::float, high::float, low::float, close::float,
           COALESCE(bid_volume,0)::int AS bid_volume, COALESCE(ask_volume,0)::int AS ask_volume,
           (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int AS mod
    FROM price_bars_primary
    WHERE ts::date = $1 AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) <= 960
    ORDER BY ts
  `, [date]);
  _barsCache.set(date, barsRes.rows);
  return barsRes.rows;
}

async function getBaselineForDate(date) {
  if (_baselineCache.has(date)) return _baselineCache.get(date);
  const baseline = await getVolumeBaseline(query, date);
  _baselineCache.set(date, baseline);
  return baseline;
}

async function main() {
  console.log('='.repeat(80));
  console.log('CALIBRATE TOUCH QUALITY (order-flow) — persists to performance_audit');
  console.log('='.repeat(80));

  const today = (await query(`SELECT CURRENT_DATE::text as today`)).rows[0].today;

  const typesRes = await query(`
    SELECT setup_type, COUNT(*) as n
    FROM active_setups
    WHERE resolution_method = 'BACKFILL' AND resolution IN ('STOP_HIT', 'TARGET_HIT')
      AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL
      AND actual_pnl IS NOT NULL
    GROUP BY setup_type HAVING COUNT(*) >= 50
    ORDER BY n DESC
  `);
  const setupTypes = typesRes.rows.map(r => r.setup_type);
  console.log(`Setup types qualifying (N>=50): ${setupTypes.length}`);

  let upserted = 0;
  for (const setupType of setupTypes) {
    const setupsRes = await query(`
      SELECT id, trade_date, fired_at, resolution, actual_pnl,
             entry_zone_low::float AS entry_low,
             COALESCE(entry_zone_high, entry_zone_low)::float AS entry_high,
             stop_level::float AS stop, t1_level::float AS t1
      FROM active_setups
      WHERE setup_type = $1 AND resolution_method = 'BACKFILL' AND resolution IN ('STOP_HIT', 'TARGET_HIT')
        AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL AND actual_pnl IS NOT NULL
      ORDER BY trade_date, fired_at
    `, [setupType]);
    const setups = setupsRes.rows;
    const direction = directionFromType(setupType);

    const byDate = new Map();
    for (const s of setups) {
      const d = typeof s.trade_date === 'string' ? s.trade_date.slice(0, 10) : s.trade_date.toISOString().slice(0, 10);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(s);
    }

    const enriched = [];
    for (const [date, dateSetups] of byDate) {
      const allBars = await getBarsForDate(date);
      const baseline = await getBaselineForDate(date);

      for (const s of dateSetups) {
        // Strictly AFTER fired_at, matching acd.js's live bars query
        // (`WHERE ... ts > $1`, resolveSetupsByPrice) exactly — using `>=` here
        // included the touch bar itself as "bar 1" of the calibrated window while
        // live excludes it, a systematic 1-bar misalignment between what the
        // cutoff was fit on and what it's applied to. Found in code review 2026-07-15.
        const bars = allBars.filter(b => b.ts > s.fired_at);
        if (bars.length === 0) continue;
        const entry = (s.entry_low + s.entry_high) / 2;
        // Only barsToResolution/maeTrace come from this same-day, RTH-truncated (<=960min)
        // replay — `s.resolution` (the real, already-validated DB column, included via the
        // spread below) is kept as the win/loss source of truth. Previously this replay's own
        // `resolution` field overwrote s.resolution, so a trade whose real resolving bar fell
        // outside this truncated same-day bar set would replay as EXPIRED and get excluded
        // from bucketStats()'s win count while its real actual_pnl still counted toward EV —
        // an internally inconsistent WR%/EV$ pair. Found in code review 2026-07-15.
        const { barsToResolution, maeTrace } = replayFull(bars, entry, s.stop, s.t1, direction);
        enriched.push({ ...s, dateStr: date, barsToResolution, maeTrace, bars, baseline });
      }
    }
    if (enriched.length === 0) continue;

    const barsToResList = enriched.map(r => r.barsToResolution).sort((a, b) => a - b);
    const windowBars = Math.max(1, Math.ceil(percentile(barsToResList, 0.25)));

    for (const r of enriched) {
      const win = r.bars.slice(0, Math.min(windowBars, r.barsToResolution));
      const maeAtBar1 = r.maeTrace[0] ?? 0;
      const maeAtWindowEnd = r.maeTrace[Math.min(windowBars, r.maeTrace.length) - 1] ?? maeAtBar1;
      r.gaveFurtherGround = maeAtWindowEnd > maeAtBar1 + 0.01;
      // First pass just to get maxVolZ distribution — cutoff computed below, so
      // classify with cutoff=Infinity (always QUIET) here, we only need maxVolZ.
      const probe = classifyTouch({ windowBars: win, direction, baseline: r.baseline, highVolZCutoff: Infinity, gaveFurtherGround: r.gaveFurtherGround });
      r.maxVolZ = probe?.maxVolZ ?? null;
    }

    const withZ = enriched.filter(r => r.maxVolZ !== null);
    if (withZ.length === 0) continue;
    const zSorted = withZ.map(r => r.maxVolZ).sort((a, b) => a - b);
    const highVolZCutoff = percentile(zSorted, 2 / 3);

    for (const r of withZ) {
      r.bucket = r.maxVolZ > highVolZCutoff ? (r.gaveFurtherGround ? 'HIGH_VOL_OVERRUN' : 'HIGH_VOL_ABSORBED') : 'QUIET';
    }

    const absorbedRows = withZ.filter(r => r.bucket === 'HIGH_VOL_ABSORBED');
    const overrunRows  = withZ.filter(r => r.bucket === 'HIGH_VOL_OVERRUN');
    const quietRows    = withZ.filter(r => r.bucket === 'QUIET');
    const absorbed = bucketStats(absorbedRows);
    const overrun  = bucketStats(overrunRows);
    const quiet    = bucketStats(quietRows);
    const pattern = classifyPattern(absorbed, overrun, quiet);

    // Standing rigor diagnostic (day-clustering + 3-way chronological stability) — per
    // CLAUDE.md's "Rigor diagnostics are standing, not one-off" rule. Informational only,
    // does not feed `pattern`/classifyPattern above — a bucket flagged unstable/clustered
    // still gets its computed WR/EV, just with a flag attached so it isn't trusted blindly.
    // Missing from the first version of this script; added in code review 2026-07-15.
    const pnlFn = r => Number(r.actual_pnl) || 0;
    const absorbedRigor = computeRigor(absorbedRows, { dateField: 'dateStr', pnlFn });
    const overrunRigor  = computeRigor(overrunRows,  { dateField: 'dateStr', pnlFn });
    const quietRigor    = computeRigor(quietRows,    { dateField: 'dateStr', pnlFn });

    const overallEvs = withZ.map(r => Number(r.actual_pnl)).filter(Number.isFinite);
    const overallEv = overallEvs.length ? overallEvs.reduce((a,b)=>a+b,0) / overallEvs.length : null;
    const overallWins = withZ.filter(r => r.resolution === 'TARGET_HIT').length;

    const notes = JSON.stringify({
      window_bars: windowBars,
      high_vol_z_cutoff: Math.round(highVolZCutoff * 100) / 100,
      pattern,
      absorbed: { n: absorbed.n, wr: absorbed.wr !== null ? Math.round(absorbed.wr*1000)/10 : null, ev: absorbed.ev !== null ? Math.round(absorbed.ev*100)/100 : null, thin: absorbed.n < MIN_N, rigor: rigorContext(absorbedRigor) },
      overrun:  { n: overrun.n,  wr: overrun.wr  !== null ? Math.round(overrun.wr*1000)/10  : null, ev: overrun.ev  !== null ? Math.round(overrun.ev*100)/100  : null, thin: overrun.n  < MIN_N, rigor: rigorContext(overrunRigor) },
      quiet:    { n: quiet.n,    wr: quiet.wr    !== null ? Math.round(quiet.wr*1000)/10    : null, ev: quiet.ev    !== null ? Math.round(quiet.ev*100)/100    : null, thin: quiet.n    < MIN_N, rigor: rigorContext(quietRigor) },
    });

    await query(`
      INSERT INTO performance_audit (
        run_date, window_days, signal_type, signal_name,
        sample_size, win_rate, ev_per_trade, recommendation, notes
      ) VALUES (
        $1::date, 0, 'TOUCH_QUALITY', $2,
        $3, $4, $5, $6, $7
      )
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
        sample_size = EXCLUDED.sample_size, win_rate = EXCLUDED.win_rate,
        ev_per_trade = EXCLUDED.ev_per_trade, recommendation = EXCLUDED.recommendation,
        notes = EXCLUDED.notes
    `, [today, setupType, withZ.length, overallWins / withZ.length, overallEv, pattern, notes]);
    upserted++;
    console.log(`  ${setupType.padEnd(28)} W=${windowBars} cutoff=${highVolZCutoff.toFixed(2).padStart(5)}  ${pattern.padEnd(20)} ABS(n=${absorbed.n},ev=${absorbed.ev?.toFixed(0)}) OVR(n=${overrun.n},ev=${overrun.ev?.toFixed(0)}) QUI(n=${quiet.n},ev=${quiet.ev?.toFixed(0)})`);
  }

  console.log(`\nUpserted ${upserted} TOUCH_QUALITY rows.`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
