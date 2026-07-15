// =============================================================================
// PILOT — order-flow touch-quality classifier (not corpus-wide, not persisted).
//
// Follow-up to scripts/pilot_touch_quality.mjs (price-action pilot, 2026-07-15),
// which found bar-count timing doesn't discriminate and the MAE-magnitude split
// gave inconsistent, setup-type-dependent results. Per docs/OPEN_THREADS.md's
// own contingency plan, next step is the order-flow signal: price_bars_primary
// has bid_volume/ask_volume/num_trades per minute, unused by any level-fade
// logic today.
//
// User's explicit correction before building this: don't treat "high volume at
// the touch" as a single distinct/absorption signal on its own — major
// structural levels draw real two-sided fighting (buyers and sellers both
// showing up in size), so heavy volume alone doesn't mean "absorbed," it can
// just as easily mean "contested and lost." The classifier below requires BOTH
// legs before calling something absorption:
//   (a) volume at the touch is genuinely elevated vs. that time-of-day's own
//       rolling baseline (reuses this codebase's existing VOLUME_SPIKE
//       convention: 90-day trailing per-minute-of-day avg/std z-score,
//       server/routes/acd.js ~line 4240 / ~7415 — not a new static cutoff), AND
//   (b) price does NOT give further adverse ground during the reaction window
//       (real absorption: heavy opposing flow, price holds) vs. DOES give
//       further ground (real fight, but the adverse side won it — not
//       absorption just because volume was heavy).
// A high-volume touch that still gives ground is bucketed separately
// (HIGH_VOL_OVERRUN) from one that holds (HIGH_VOL_ABSORBED) precisely because
// conflating them would repeat the "just a distinct interpretation" mistake
// flagged by the user.
//
// Reaction window length is data-derived per setup_type (p25 of that type's own
// bars-to-resolution from a first replay pass), not a hardcoded bar count — no
// static thresholds, per CLAUDE.md.
// =============================================================================

import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';

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

function summarize(label, rows) {
  const n = rows.length;
  if (n === 0) { console.log(`    ${label.padEnd(18)} n=0`); return; }
  const wins = rows.filter(r => r.resolution === 'TARGET_HIT').length;
  const wr = (wins / n * 100).toFixed(1);
  const evs = rows.map(r => Number(r.actual_pnl)).filter(v => Number.isFinite(v));
  const ev = evs.length ? (evs.reduce((a, b) => a + b, 0) / evs.length).toFixed(2) : 'n/a';
  const zVals = rows.map(r => r.maxVolZ).filter(Number.isFinite).sort((a,b)=>a-b);
  const medZ = percentile(zVals, 0.5);
  const deltaVals = rows.map(r => r.netAdverseDelta).filter(Number.isFinite).sort((a,b)=>a-b);
  const medDelta = percentile(deltaVals, 0.5);

  let clusterFlag = '';
  if (n >= 15) {
    const dateCounts = new Map();
    for (const r of rows) {
      const d = typeof r.trade_date === 'string' ? r.trade_date.slice(0, 10) : r.trade_date.toISOString().slice(0, 10);
      dateCounts.set(d, (dateCounts.get(d) || 0) + 1);
    }
    const distinctDates = dateCounts.size;
    const top5Sum = [...dateCounts.values()].sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0);
    const top5Pct = (top5Sum / n * 100).toFixed(0);
    clusterFlag = `  distinctDates=${distinctDates} top5%=${top5Pct}${top5Pct >= 50 ? ' ⚠CLUSTERED' : ''}`;
  }

  console.log(`    ${label.padEnd(18)} n=${String(n).padEnd(5)} WR=${wr.padStart(5)}%  EV=$${String(ev).padEnd(8)} medVolZ=${medZ?.toFixed(2).padStart(6)}  medNetAdverseDelta=${medDelta?.toFixed(0)}${clusterFlag}`);
}

async function main() {
  console.log('='.repeat(80));
  console.log('PILOT — order-flow touch-quality classifier (exploratory, not persisted)');
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

    // Batch bars per trade_date
    const byDate = new Map();
    for (const s of setups) {
      const d = typeof s.trade_date === 'string' ? s.trade_date.slice(0, 10) : s.trade_date.toISOString().slice(0, 10);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(s);
    }

    // Pass 1: replay each trade fully, keep its bars (with volume cols) for pass 2
    const enriched = [];
    for (const [date, dateSetups] of byDate) {
      const barsRes = await query(`
        SELECT ts, open::float, high::float, low::float, close::float,
               COALESCE(bid_volume,0)::int AS bid_volume, COALESCE(ask_volume,0)::int AS ask_volume,
               COALESCE(num_trades,0)::int AS num_trades,
               (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int AS mod
        FROM price_bars_primary
        WHERE ts::date = $1
          AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) <= 960
        ORDER BY ts
      `, [date]);
      const allBars = barsRes.rows;

      // Trailing 90-day per-minute-of-day volume baseline, strictly prior to this date
      // (matches acd.js's VOLUME_SPIKE convention: 90d trailing, grouped by ET minute-of-day).
      const baselineRes = await query(`
        SELECT (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int AS mod,
               AVG(COALESCE(bid_volume,0)+COALESCE(ask_volume,0))::float AS avg_vol,
               STDDEV(COALESCE(bid_volume,0)+COALESCE(ask_volume,0))::float AS std_vol
        FROM price_bars_primary
        WHERE ts::date >= $1::date - INTERVAL '90 days' AND ts::date < $1::date
        GROUP BY 1
      `, [date]);
      const baseline = new Map(baselineRes.rows.map(r => [r.mod, r]));

      for (const s of dateSetups) {
        const bars = allBars.filter(b => b.ts >= s.fired_at);
        if (bars.length === 0) continue;
        const entry = (s.entry_low + s.entry_high) / 2;
        const { resolution, barsToResolution, maeTrace } = replayFull(bars, entry, s.stop, s.t1, direction);
        enriched.push({ ...s, resolution, barsToResolution, maeTrace, bars, entry, baseline });
      }
    }

    if (enriched.length === 0) { console.log('  no bars found, skipping'); continue; }

    // Data-derived reaction window: p25 of this setup_type's own bars-to-resolution
    const barsToResList = enriched.map(r => r.barsToResolution).sort((a, b) => a - b);
    const W = Math.max(1, Math.ceil(percentile(barsToResList, 0.25)));
    console.log(`  Reaction window W=${W} bars (p25 of this type's own bars-to-resolution)`);

    // Pass 2: order-flow metrics within window
    for (const r of enriched) {
      const win = r.bars.slice(0, Math.min(W, r.barsToResolution));
      let maxZ = -Infinity;
      let adverseVol = 0, favorableVol = 0, numTrades = 0;
      for (const b of win) {
        const bl = r.baseline.get(b.mod);
        const totalVol = b.bid_volume + b.ask_volume;
        if (bl && bl.std_vol > 0) {
          const z = (totalVol - bl.avg_vol) / bl.std_vol;
          if (z > maxZ) maxZ = z;
        }
        const adverse   = direction === 'LONG' ? b.bid_volume : b.ask_volume;
        const favorable = direction === 'LONG' ? b.ask_volume : b.bid_volume;
        adverseVol += adverse;
        favorableVol += favorable;
        numTrades += b.num_trades;
      }
      r.maxVolZ = maxZ === -Infinity ? null : maxZ;
      r.netAdverseDelta = adverseVol - favorableVol;
      r.windowNumTrades = numTrades;

      const maeAtBar1 = r.maeTrace[0] ?? 0;
      const maeAtWindowEnd = r.maeTrace[Math.min(W, r.maeTrace.length) - 1] ?? maeAtBar1;
      r.gaveFurtherGround = maeAtWindowEnd > maeAtBar1 + 0.01;
    }

    const withZ = enriched.filter(r => r.maxVolZ !== null);
    const zSorted = withZ.map(r => r.maxVolZ).sort((a, b) => a - b);
    const highVolCut = percentile(zSorted, 2 / 3); // top tercile of this type's own z distribution
    console.log(`  High-vol tercile cut (max window vol z-score): >${highVolCut?.toFixed(2)}`);

    const highVol = withZ.filter(r => r.maxVolZ > highVolCut);
    const absorbed = highVol.filter(r => !r.gaveFurtherGround);
    const overrun = highVol.filter(r => r.gaveFurtherGround);
    const quiet = withZ.filter(r => r.maxVolZ <= highVolCut);

    console.log(`  Overall:`); summarize('ALL', withZ);
    console.log(`  Buckets:`);
    summarize('HIGH_VOL_ABSORBED', absorbed);
    summarize('HIGH_VOL_OVERRUN', overrun);
    summarize('QUIET (not high-vol)', quiet);
  }

  console.log('\n' + '='.repeat(80));
  console.log('Pilot complete. Nothing written to performance_audit or active_setups.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
