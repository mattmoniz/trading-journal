// =============================================================================
// PILOT — volume-confirmed candle reversal patterns (exploratory, not persisted).
//
// User's insight (2026-07-21): candle patterns are "kind of indicative of
// orderflow" -- a rejection wick represents real two-sided fighting only if real
// volume showed up there. The plain-shape pilots (pilot_candle_pattern_reversal.mjs,
// corpus-wide) found no clean entry-confirmation edge, but never checked whether a
// pattern's credibility depends on whether it was volume-backed. This tests that
// directly: within PATTERN_PRESENT touches, does the bar where the pattern
// completed show elevated volume (real participation) vs. thin/quiet volume, and
// does that distinction predict outcome better than the pattern alone?
//
// Reuses TWO already-validated modules, reimplements neither:
//   - server/services/candlePatternQuality.js (classifyReversalPattern) -- the
//     same shape classifier already piloted corpus-wide.
//   - server/services/touchQuality.js (getVolumeBaseline) -- the SAME order-flow
//     baseline (90-day trailing per-minute-of-day volume avg/std) already proven
//     to generalize corpus-wide (47/47 N>=50 setup_types, zero day-clustering,
//     2026-07-15) for classifying touch quality. This pilot asks a narrower,
//     related question: does that same volume signal, applied specifically at
//     the bar where a candle pattern completes, sharpen the pattern's signal?
//
// Same population/methodology as pilot_candle_pattern_reversal.mjs (p25 bars-to-
// resolution reaction window, N>=20 floor, no lookahead) for direct comparability.
// =============================================================================

import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { getBarShapeBaseline, classifyReversalPattern } from '../server/services/candlePatternQuality.js';
import { getVolumeBaseline } from '../server/services/touchQuality.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

const SETUP_TYPES = process.argv[2]
  ? process.argv.slice(2)
  : null;

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function replayFull(bars, entry, stop, t1, direction) {
  let resolution = 'EXPIRED', barsToResolution = 0;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    barsToResolution = i + 1;
    const stopHit = direction === 'LONG' ? bar.low <= stop : bar.high >= stop;
    const targetHit = direction === 'LONG' ? bar.high >= t1 : bar.low <= t1;
    if (stopHit) { resolution = 'STOP_HIT'; break; }
    if (targetHit) { resolution = 'TARGET_HIT'; break; }
  }
  return { resolution, barsToResolution };
}

function summarize(label, rows) {
  const n = rows.length;
  if (n === 0) return `    ${label.padEnd(20)} n=0`;
  const wins = rows.filter(r => r.resolution === 'TARGET_HIT').length;
  const wr = (wins / n * 100).toFixed(1);
  const evs = rows.map(r => Number(r.actual_pnl)).filter(v => Number.isFinite(v));
  const ev = evs.length ? (evs.reduce((a, b) => a + b, 0) / evs.length).toFixed(2) : 'n/a';
  const flag = n >= 20 ? '' : ' (N<20)';
  let rigorStr = '';
  if (n >= 20) {
    const rigor = computeRigor(rows, { dateField: 'dateStr', pnlFn: r => Number(r.actual_pnl) });
    rigorStr = `  clustered=${rigor.clustered} stable=${rigor.stable}`;
  }
  return `    ${label.padEnd(20)} n=${String(n).padEnd(5)} WR=${wr.padStart(5)}%  EV=$${ev}${flag}${rigorStr}`;
}

const _shapeBaselineCache = new Map();
const _volBaselineCache = new Map();
async function getShapeBaseline(date) {
  if (_shapeBaselineCache.has(date)) return _shapeBaselineCache.get(date);
  const b = await getBarShapeBaseline(query, date, 'NQ', 90);
  _shapeBaselineCache.set(date, b);
  return b;
}
async function getVolBaseline(date) {
  if (_volBaselineCache.has(date)) return _volBaselineCache.get(date);
  const b = await getVolumeBaseline(query, date);
  _volBaselineCache.set(date, b);
  return b;
}

async function main() {
  let setupTypes = SETUP_TYPES;
  if (!setupTypes) {
    const r = await query(`
      SELECT setup_type FROM active_setups
      WHERE resolution_method = 'BACKFILL' AND resolution IN ('STOP_HIT', 'TARGET_HIT')
        AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL AND actual_pnl IS NOT NULL
      GROUP BY setup_type HAVING COUNT(*) >= 50
    `);
    setupTypes = r.rows.map(x => x.setup_type);
  }

  const pooledHigh = [], pooledLow = [], pooledNoPattern = [];

  for (const setupType of setupTypes) {
    const direction = directionFromType(setupType);
    const setupsRes = await query(`
      SELECT id, trade_date, fired_at, resolution, actual_pnl,
             entry_zone_low::float AS entry_low, COALESCE(entry_zone_high, entry_zone_low)::float AS entry_high,
             stop_level::float AS stop, t1_level::float AS t1
      FROM active_setups
      WHERE setup_type = $1 AND resolution_method = 'BACKFILL' AND resolution IN ('STOP_HIT', 'TARGET_HIT')
        AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL AND actual_pnl IS NOT NULL
      ORDER BY trade_date, fired_at
    `, [setupType]);
    const setups = setupsRes.rows;
    if (setups.length < 50) continue;

    const byDate = new Map();
    for (const s of setups) {
      const d = typeof s.trade_date === 'string' ? s.trade_date.slice(0, 10) : s.trade_date.toISOString().slice(0, 10);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(s);
    }

    const enriched = [];
    for (const [date, dateSetups] of byDate) {
      const barsRes = await query(`
        SELECT ts, open::float, high::float, low::float, close::float,
               COALESCE(bid_volume,0)::int AS bid_volume, COALESCE(ask_volume,0)::int AS ask_volume,
               (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int AS mod
        FROM price_bars_primary WHERE symbol='NQ' AND ts::date = $1 ORDER BY ts
      `, [date]);
      const allBars = barsRes.rows;
      const shapeBaseline = await getShapeBaseline(date);
      const volBaseline = await getVolBaseline(date);
      for (const s of dateSetups) {
        const bars = allBars.filter(b => b.ts > s.fired_at);
        if (bars.length === 0) continue;
        const entry = (s.entry_low + s.entry_high) / 2;
        const { resolution, barsToResolution } = replayFull(bars, entry, s.stop, s.t1, direction);
        enriched.push({ ...s, dateStr: date, resolution, barsToResolution, bars, shapeBaseline, volBaseline });
      }
    }
    if (enriched.length === 0) continue;

    const barsToResList = enriched.map(r => r.barsToResolution).sort((a, b) => a - b);
    const windowBars = Math.max(1, Math.ceil(percentile(barsToResList, 0.25)));

    // Pass 1: find pattern matches and their volume z-score at the decisive bar
    const patternHits = [];
    const noPattern = [];
    for (const r of enriched) {
      const win = r.bars.slice(0, Math.min(windowBars, r.barsToResolution));
      const match = r.shapeBaseline ? classifyReversalPattern({ windowBars: win, direction, baseline: r.shapeBaseline }) : null;
      if (!match) { noPattern.push(r); continue; }
      const decisiveBar = win[match.barIndex];
      const bl = r.volBaseline.get(decisiveBar.mod);
      if (!bl || !(bl.std_vol > 0)) continue; // no volume baseline coverage, can't classify
      const totalVol = decisiveBar.bid_volume + decisiveBar.ask_volume;
      const z = (totalVol - bl.avg_vol) / bl.std_vol;
      patternHits.push({ ...r, volZ: z });
    }
    if (patternHits.length < 10) continue; // not enough pattern hits to split into HIGH/LOW meaningfully

    // Per-setup_type cutoff: same 2/3 tercile convention as calibrate_touch_quality.mjs
    const zSorted = patternHits.map(x => x.volZ).sort((a, b) => a - b);
    const cutoff = percentile(zSorted, 2 / 3);

    const high = patternHits.filter(x => x.volZ > cutoff);
    const low = patternHits.filter(x => x.volZ <= cutoff);

    console.log(`\n### ${setupType}  (pattern hits N=${patternHits.length}, cutoff z=${cutoff.toFixed(2)})`);
    console.log(summarize('HIGH_VOL_PATTERN', high));
    console.log(summarize('LOW_VOL_PATTERN', low));
    console.log(summarize('NO_PATTERN', noPattern));

    pooledHigh.push(...high); pooledLow.push(...low); pooledNoPattern.push(...noPattern);
  }

  console.log('\n' + '='.repeat(90));
  console.log('POOLED');
  console.log('='.repeat(90));
  console.log(summarize('HIGH_VOL_PATTERN', pooledHigh));
  console.log(summarize('LOW_VOL_PATTERN', pooledLow));
  console.log(summarize('NO_PATTERN', pooledNoPattern));
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
