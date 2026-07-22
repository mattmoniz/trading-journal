// =============================================================================
// PILOT — candlestick reversal-pattern classifier near a level touch (not
// corpus-wide, not persisted to performance_audit).
//
// Question (user, 2026-07-21): do known reversal candle patterns (engulfing,
// hammer/shooting star, doji, piercing/dark cloud, morning/evening star,
// tweezer) near a tested MGI level improve confirmation of a level-fade entry?
//
// Same 3 pilot setup_types as the 2026-07-15 price-action touch-quality pilot
// (docs/OPEN_THREADS.md), for direct comparability against that prior result
// (which did NOT generalize corpus-wide). Same methodology: p25 bars-to-
// resolution reaction window per setup_type (matches calibrate_touch_quality.mjs's
// windowBars), no lookahead (window bars are strictly after fired_at), N>=20
// hard floor before treating any bucket as decisive, computeRigor() day-
// clustering + 3-way chronological stability check on both buckets.
//
// Uses server/services/candlePatternQuality.js -- the same module a future live
// classifier would import -- so this pilot and any later production wiring can
// never drift apart (per CLAUDE.md's "share modules" convention).
// =============================================================================

import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { getBarShapeBaseline, classifyReversalPattern } from '../server/services/candlePatternQuality.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

const PILOT_SETUP_TYPES = process.argv[2]
  ? process.argv.slice(2)
  : ['OR_LOW_FADE_LONG', 'CAM_S3_FADE_LONG', 'IB_HIGH_FADE_SHORT'];

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
    const stopHit   = direction === 'LONG' ? bar.low  <= stop : bar.high >= stop;
    const targetHit = direction === 'LONG' ? bar.high >= t1   : bar.low  <= t1;
    if (stopHit)   { resolution = 'STOP_HIT'; break; }
    if (targetHit) { resolution = 'TARGET_HIT'; break; }
  }
  return { resolution, barsToResolution };
}

function summarize(label, rows) {
  const n = rows.length;
  if (n === 0) { console.log(`    ${label.padEnd(20)} n=0`); return; }
  const wins = rows.filter(r => r.resolution === 'TARGET_HIT').length;
  const wr = (wins / n * 100).toFixed(1);
  const evs = rows.map(r => Number(r.actual_pnl)).filter(v => Number.isFinite(v));
  const ev = evs.length ? (evs.reduce((a, b) => a + b, 0) / evs.length).toFixed(2) : 'n/a';
  const rigor = computeRigor(rows, { dateField: 'dateStr', pnlFn: r => Number(r.actual_pnl) });
  const flag = n >= 20 ? '' : '  (below N>=20 floor)';
  console.log(`    ${label.padEnd(20)} n=${String(n).padEnd(5)} WR=${wr.padStart(5)}%  EV=$${ev}  clustered=${rigor.clustered}  stable=${rigor.stable}${flag}`);
}

const _baselineCache = new Map();
async function getBaseline(date) {
  if (_baselineCache.has(date)) return _baselineCache.get(date);
  const b = await getBarShapeBaseline(query, date, 'NQ', 90);
  _baselineCache.set(date, b);
  return b;
}

async function main() {
  console.log('='.repeat(80));
  console.log('PILOT — candle reversal pattern classifier (exploratory, not persisted)');
  console.log(`Setup types: ${PILOT_SETUP_TYPES.join(', ')}`);
  console.log('='.repeat(80));

  for (const setupType of PILOT_SETUP_TYPES) {
    const setupsRes = await query(`
      SELECT id, trade_date, fired_at, resolution, actual_pnl,
             entry_zone_low::float AS entry_low,
             COALESCE(entry_zone_high, entry_zone_low)::float AS entry_high,
             stop_level::float AS stop, t1_level::float AS t1
      FROM active_setups
      WHERE setup_type = $1
        AND resolution_method = 'BACKFILL'
        AND resolution IN ('STOP_HIT', 'TARGET_HIT')
        AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL
        AND actual_pnl IS NOT NULL
      ORDER BY trade_date, fired_at
    `, [setupType]);

    const setups = setupsRes.rows;
    console.log(`\n### ${setupType}  (N=${setups.length})`);
    if (setups.length === 0) { console.log('  no rows, skipping'); continue; }

    const direction = directionFromType(setupType);

    const byDate = new Map();
    for (const s of setups) {
      const d = typeof s.trade_date === 'string' ? s.trade_date.slice(0, 10) : s.trade_date.toISOString().slice(0, 10);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(s);
    }

    const enriched = [];
    for (const [date, dateSetups] of byDate) {
      const barsRes = await query(`
        SELECT ts, open::float, high::float, low::float, close::float
        FROM price_bars_primary
        WHERE symbol='NQ' AND ts::date = $1
        ORDER BY ts
      `, [date]);
      const allBars = barsRes.rows;
      const baseline = await getBaseline(date);

      for (const s of dateSetups) {
        const bars = allBars.filter(b => b.ts > s.fired_at);
        if (bars.length === 0) continue;
        const entry = (s.entry_low + s.entry_high) / 2;
        const { resolution, barsToResolution } = replayFull(bars, entry, s.stop, s.t1, direction);
        enriched.push({ ...s, dateStr: date, resolution, barsToResolution, bars, baseline });
      }
    }
    if (enriched.length === 0) { console.log('  no enriched rows, skipping'); continue; }

    const barsToResList = enriched.map(r => r.barsToResolution).sort((a, b) => a - b);
    const windowBars = Math.max(1, Math.ceil(percentile(barsToResList, 0.25)));
    console.log(`  reaction window (p25 bars-to-resolution): ${windowBars} bars`);

    const withPattern = [], noPattern = [];
    const byPatternName = new Map();
    for (const r of enriched) {
      const win = r.bars.slice(0, Math.min(windowBars, r.barsToResolution));
      const match = r.baseline ? classifyReversalPattern({ windowBars: win, direction, baseline: r.baseline }) : null;
      if (match) {
        withPattern.push(r);
        if (!byPatternName.has(match.pattern)) byPatternName.set(match.pattern, []);
        byPatternName.get(match.pattern).push(r);
      } else {
        noPattern.push(r);
      }
    }

    summarize('PATTERN_PRESENT', withPattern);
    summarize('NO_PATTERN', noPattern);
    console.log('  --- by individual pattern ---');
    for (const [name, rows] of [...byPatternName.entries()].sort((a, b) => b[1].length - a[1].length)) {
      summarize(name, rows);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('Done. Exploratory only -- nothing written to performance_audit.');
  console.log('='.repeat(80));
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
