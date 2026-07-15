// =============================================================================
// PILOT — touch-quality classifier (not corpus-wide, not persisted).
//
// Question from docs/OPEN_THREADS.md "NEW TOP PRIORITY" thread: can we tell a
// real touch (price reacts — absorption, bounce, pause) from price just
// running through a level with no real test? Piloted on a small, high-N
// sample first per that thread's own recommendation, before any corpus-wide
// backfill or write to performance_audit.
//
// For each resolved fade, walks 1-min bars from fired_at (reusing the same
// favorable/adverse definition as maeMfeReplay.js's replayBars) and records,
// in addition to the usual final resolution:
//   - first_favorable_bar: index of the first bar where price ticks in the
//     trade's favor at all beyond entry (or null if it never does before
//     resolution — a pure blow-through)
//   - mae_before_first_favorable: adverse excursion accumulated up to that
//     bar (near-zero = clean rejection, large = slow grind-then-reverse)
//
// Bucketing avoids a hardcoded bar-count cutoff (no static thresholds, per
// CLAUDE.md): trades that never tick favorable are their own explicit
// "blow-through" bucket; trades that do are split into terciles of
// first_favorable_bar, computed from that setup_type's own distribution.
// =============================================================================

import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';

const PILOT_SETUP_TYPES = process.argv[2]
  ? process.argv.slice(2)
  : ['OR_LOW_FADE_LONG', 'CAM_S3_FADE_LONG', 'IB_HIGH_FADE_SHORT'];

function walkTouchQuality(bars, entry, stop, t1, direction) {
  let mae = 0;
  let firstFavorableBar = null;
  let maeBeforeFirstFavorable = null;
  let resolution = 'EXPIRED';
  let barsToResolution = 0;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    barsToResolution = i + 1;

    const favorable = direction === 'LONG' ? bar.high - entry : entry - bar.low;
    const adverse   = direction === 'LONG' ? entry - bar.low  : bar.high - entry;

    mae = Math.max(mae, adverse);

    if (firstFavorableBar === null && favorable > 0) {
      firstFavorableBar = i + 1;
      maeBeforeFirstFavorable = mae;
    }

    const stopHit   = direction === 'LONG' ? bar.low  <= stop : bar.high >= stop;
    const targetHit = direction === 'LONG' ? bar.high >= t1   : bar.low  <= t1;

    if (stopHit && targetHit) { resolution = 'STOP_HIT'; break; }
    if (stopHit)               { resolution = 'STOP_HIT'; break; }
    if (targetHit)              { resolution = 'TARGET_HIT'; break; }
  }

  return { resolution, barsToResolution, firstFavorableBar, maeBeforeFirstFavorable };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function summarize(label, rows) {
  const n = rows.length;
  if (n === 0) { console.log(`    ${label.padEnd(14)} n=0`); return; }
  const wins = rows.filter(r => r.resolution === 'TARGET_HIT').length;
  const wr = (wins / n * 100).toFixed(1);
  const evs = rows.map(r => Number(r.actual_pnl)).filter(v => Number.isFinite(v));
  const ev = evs.length ? (evs.reduce((a, b) => a + b, 0) / evs.length).toFixed(2) : 'n/a';
  console.log(`    ${label.padEnd(14)} n=${String(n).padEnd(5)} WR=${wr.padStart(5)}%  EV=$${ev}`);
}

async function main() {
  console.log('='.repeat(80));
  console.log('PILOT — touch-quality classifier (exploratory, not persisted)');
  console.log(`Setup types: ${PILOT_SETUP_TYPES.join(', ')}`);
  console.log('='.repeat(80));

  for (const setupType of PILOT_SETUP_TYPES) {
    const setupsRes = await query(`
      SELECT id, trade_date, fired_at, resolution, actual_pnl,
             entry_zone_low::float AS entry_low,
             COALESCE(entry_zone_high, entry_zone_low)::float AS entry_high,
             stop_level::float AS stop,
             t1_level::float AS t1
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
    const results = [];

    // Batch bars per trade_date to keep round-trips down
    const byDate = new Map();
    for (const s of setups) {
      const d = typeof s.trade_date === 'string' ? s.trade_date.slice(0, 10) : s.trade_date.toISOString().slice(0, 10);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(s);
    }

    for (const [date, dateSetups] of byDate) {
      const barsRes = await query(`
        SELECT ts, open::float, high::float, low::float, close::float
        FROM price_bars_primary
        WHERE ts::date = $1
          AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) <= 960
        ORDER BY ts
      `, [date]);
      const allBars = barsRes.rows;

      for (const s of dateSetups) {
        const bars = allBars.filter(b => b.ts >= s.fired_at);
        if (bars.length === 0) continue;
        const entry = (s.entry_low + s.entry_high) / 2;
        const walk = walkTouchQuality(bars, entry, s.stop, s.t1, direction);
        results.push({ ...s, ...walk });
      }
    }

    // Bucket 1: pure blow-through (never ticked favorable before resolution)
    const blowthrough = results.filter(r => r.firstFavorableBar === null);
    const reacted = results.filter(r => r.firstFavorableBar !== null);

    // Terciles of firstFavorableBar among reacted trades (data-derived, not a fixed bar count)
    const sortedBars = reacted.map(r => r.firstFavorableBar).sort((a, b) => a - b);
    const t1cut = percentile(sortedBars, 1 / 3);
    const t2cut = percentile(sortedBars, 2 / 3);

    const fast = reacted.filter(r => r.firstFavorableBar <= t1cut);
    const slow = reacted.filter(r => r.firstFavorableBar > t1cut && r.firstFavorableBar <= t2cut);
    const slowest = reacted.filter(r => r.firstFavorableBar > t2cut);

    console.log(`  Tercile cuts (bars to first favorable tick): fast<=${t1cut?.toFixed(1)}, mid<=${t2cut?.toFixed(1)}`);
    console.log(`  Overall:`); summarize('ALL', results);
    console.log(`  Buckets:`);
    summarize('BLOW_THROUGH', blowthrough);
    summarize('FAST_REACT', fast);
    summarize('MID_REACT', slow);
    summarize('SLOW_REACT', slowest);

    // MAE-before-turn split (clean rejection vs grind-then-reverse) among reacted trades
    const maeVals = reacted.map(r => r.maeBeforeFirstFavorable).sort((a, b) => a - b);
    const maeMedian = percentile(maeVals, 0.5);
    const cleanRejection = reacted.filter(r => r.maeBeforeFirstFavorable <= maeMedian);
    const grindReverse = reacted.filter(r => r.maeBeforeFirstFavorable > maeMedian);
    console.log(`  MAE-before-turn median (among reacted): ${maeMedian?.toFixed(2)}pt`);
    summarize('CLEAN_REJECT', cleanRejection);
    summarize('GRIND_REVERSE', grindReverse);
  }

  console.log('\n' + '='.repeat(80));
  console.log('Pilot complete. Nothing written to performance_audit or active_setups.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
