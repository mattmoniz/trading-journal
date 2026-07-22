// =============================================================================
// PILOT — volume-climax (LLT proxy) and absorption at the entry bar of a real,
// resolved level-fade setup (exploratory, not persisted to performance_audit).
//
// Idea (user, 2026-07-22, from a Bookmap feature comparison): Bookmap's Large Lot
// Tracker and Absorption indicators need per-trade tick data / L2 order-book depth
// this codebase does not have. Both have a bar-level proxy buildable from data
// already captured (price_bars_primary's volume/bid_volume/ask_volume per 1-min
// bar) -- this is also verbatim Opus Audit 2's untapped-data recommendation
// (scratch/opus_audit_2_results.md §6A: "Volume climax... exhaustion
// confirmation for fades" and "Absorption... the single most useful real-time
// confirm for a fade entry, and the data supports it"), never built until now.
//
// Definitions (percentile-based against the pooled distribution, not a hardcoded
// magnitude -- matches the no-static-thresholds rule):
//   volRatio   = entry bar's volume / mean volume of the 20 bars strictly BEFORE it
//                (no lookahead -- baseline never includes the entry bar itself)
//   rangeRatio = entry bar's (high-low) / mean range of the same 20 prior bars
//   delta      = entry bar's ask_volume - bid_volume (positive = net aggressive buying)
//
//   VOLUME_CLIMAX  = volRatio in the top quartile (p75+) of the pooled distribution
//   ABSORPTION     = ALL of: volRatio top quartile AND rangeRatio BOTTOM quartile
//                    (unusually tight for that much volume) AND delta sign opposite
//                    the fade direction (LONG: delta<0 net selling absorbed without
//                    breaking down; SHORT: delta>0 net buying absorbed without
//                    breaking up)
//
// Population: real resolved BACKFILL setups (active_setups), same source and
// enrichment pattern as pilot_cvd_divergence.mjs -- reuses the setup's own
// already-calibrated stop_level/t1_level rather than reimplementing detection or
// re-deriving stops. SIGNAL vs SAME_SELECTION_NO_SIGNAL split (same population,
// differing ONLY in the condition) is the confound-checklist template from
// pilot_cvd_divergence.mjs -- no structural/entry-price confound here since the
// condition is evaluated at the entry bar itself and doesn't change entry price,
// stop, or target.
// =============================================================================

import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function summarize(label, rows) {
  const n = rows.length;
  if (n === 0) return `    ${label.padEnd(22)} n=0`;
  const wins = rows.filter(r => Number(r.actual_pnl) > 0).length;
  const wr = (wins / n * 100).toFixed(1);
  const evs = rows.map(r => Number(r.actual_pnl)).filter(v => Number.isFinite(v));
  const ev = evs.length ? (evs.reduce((a, b) => a + b, 0) / evs.length).toFixed(2) : 'n/a';
  const flag = n >= 20 ? '' : ' (N<20)';
  let rigorStr = '';
  if (n >= 20) {
    const rigor = computeRigor(rows, { dateField: 'dateStr', pnlFn: r => Number(r.actual_pnl) });
    const distinctDays = new Set(rows.map(r => r.dateStr)).size;
    rigorStr = `  days=${distinctDays}  clustered=${rigor.clustered} stable=${rigor.stable} clean=${rigor.clean}`;
  }
  return `    ${label.padEnd(22)} n=${String(n).padEnd(5)} WR=${wr.padStart(5)}%  EV=$${ev}${flag}${rigorStr}`;
}

const SETUP_TYPES = process.argv[2] ? process.argv.slice(2) : null;

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

  const enrichedAll = [];

  for (const setupType of setupTypes) {
    const direction = directionFromType(setupType);
    if (!direction) continue;
    const setupsRes = await query(`
      SELECT id, trade_date, fired_at, resolution, actual_pnl, setup_type
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

    for (const [date, dateSetups] of byDate) {
      const barsRes = await query(`
        SELECT ts, high::float, low::float,
               COALESCE(volume,0)::int AS volume,
               COALESCE(bid_volume,0)::int AS bid_volume, COALESCE(ask_volume,0)::int AS ask_volume
        FROM price_bars_primary WHERE symbol='NQ' AND ts::date = $1 ORDER BY ts
      `, [date]);
      const allBars = barsRes.rows;
      if (allBars.length < 25) continue;

      for (const s of dateSetups) {
        // Entry bar: the last bar at or before fired_at (no lookahead into the future).
        let entryIdx = -1;
        for (let i = allBars.length - 1; i >= 0; i--) {
          if (allBars[i].ts <= s.fired_at) { entryIdx = i; break; }
        }
        if (entryIdx < 20) continue; // need 20 strictly-prior bars for the baseline
        const priorBars = allBars.slice(entryIdx - 20, entryIdx);
        const entryBar = allBars[entryIdx];

        const meanVol = priorBars.reduce((a, b) => a + b.volume, 0) / priorBars.length;
        const meanRange = priorBars.reduce((a, b) => a + (b.high - b.low), 0) / priorBars.length;
        if (meanVol <= 0 || meanRange <= 0) continue;

        const volRatio = entryBar.volume / meanVol;
        const rangeRatio = (entryBar.high - entryBar.low) / meanRange;
        const delta = entryBar.ask_volume - entryBar.bid_volume;

        enrichedAll.push({
          ...s, dateStr: date, direction, volRatio, rangeRatio, delta,
        });
      }
    }
  }

  console.log(`Enriched touches (real resolved BACKFILL setups, N>=50/type): ${enrichedAll.length}\n`);
  if (enrichedAll.length < 40) {
    console.log('Too few touches to establish pooled percentile cutoffs. Aborting.');
    process.exit(0);
  }

  // Pooled percentile cutoffs -- data-derived, not hardcoded (no-static-thresholds rule).
  const volRatioSorted = [...enrichedAll.map(r => r.volRatio)].sort((a, b) => a - b);
  const rangeRatioSorted = [...enrichedAll.map(r => r.rangeRatio)].sort((a, b) => a - b);
  const volP75 = percentile(volRatioSorted, 0.75);
  const rangeP25 = percentile(rangeRatioSorted, 0.25);
  // Absorption's joint condition (high vol AND tight range AND opposing delta) turned out
  // far too strict at quartile cutoffs (N=1 of 7200 -- high-volume bars are naturally
  // WIDE-range, not narrow, so the two quartile conditions are close to mutually
  // exclusive by construction, not merely rare). Loosened to median splits for a
  // testable sample size -- still data-derived, not hardcoded, just less restrictive.
  const volP50 = percentile(volRatioSorted, 0.50);
  const rangeP50 = percentile(rangeRatioSorted, 0.50);
  console.log(`Pooled volRatio p75 cutoff (VOLUME_CLIMAX threshold): ${volP75.toFixed(2)}x`);
  console.log(`Pooled rangeRatio p25 cutoff (tight-range threshold, quartile version): ${rangeP25.toFixed(2)}x`);
  console.log(`Pooled volRatio/rangeRatio p50 cutoffs (ABSORPTION, loosened to median): ${volP50.toFixed(2)}x / ${rangeP50.toFixed(2)}x\n`);

  // ── Test 1: Volume Climax ──
  const climaxRows = enrichedAll.filter(r => r.volRatio >= volP75);
  const noClimaxRows = enrichedAll.filter(r => r.volRatio < volP75);
  console.log('='.repeat(90));
  console.log('TEST 1: VOLUME CLIMAX (entry bar volRatio >= pooled p75)');
  console.log('='.repeat(90));
  console.log(summarize('VOLUME_CLIMAX', climaxRows));
  console.log(summarize('NO_CLIMAX (same pop)', noClimaxRows));
  if (climaxRows.length >= 20 && noClimaxRows.length >= 20) {
    const climaxEv = climaxRows.reduce((s, x) => s + Number(x.actual_pnl), 0) / climaxRows.length;
    const noClimaxEv = noClimaxRows.reduce((s, x) => s + Number(x.actual_pnl), 0) / noClimaxRows.length;
    console.log(`  Marginal contribution: $${(climaxEv - noClimaxEv).toFixed(2)}/trade`);
  }

  // ── Test 2: Absorption (median-split version -- see comment above) ──
  const absorptionRows = [];
  const noAbsorptionRows = [];
  for (const r of enrichedAll) {
    const deltaAbsorbed = r.direction === 'LONG' ? r.delta < 0 : r.delta > 0;
    const isAbsorption = r.volRatio >= volP50 && r.rangeRatio <= rangeP50 && deltaAbsorbed;
    if (isAbsorption) absorptionRows.push(r); else noAbsorptionRows.push(r);
  }
  console.log('\n' + '='.repeat(90));
  console.log('TEST 2: ABSORPTION (above-median volume + below-median range + delta opposing direction)');
  console.log('='.repeat(90));
  console.log(summarize('ABSORPTION', absorptionRows));
  console.log(summarize('NO_ABSORPTION (same pop)', noAbsorptionRows));
  if (absorptionRows.length >= 20 && noAbsorptionRows.length >= 20) {
    const absEv = absorptionRows.reduce((s, x) => s + Number(x.actual_pnl), 0) / absorptionRows.length;
    const noAbsEv = noAbsorptionRows.reduce((s, x) => s + Number(x.actual_pnl), 0) / noAbsorptionRows.length;
    console.log(`  Marginal contribution: $${(absEv - noAbsEv).toFixed(2)}/trade`);
  }

  // Decomposition: check the vol/range correlation directly, and each sub-condition alone,
  // since the quartile version's N=1 suggested vol and range might be structurally
  // anti-correlated (bigger volume bars naturally have wider ranges) rather than just rare.
  const bothHighVolTightRange = enrichedAll.filter(r => r.volRatio >= volP50 && r.rangeRatio <= rangeP50).length;
  const expectedIfIndependent = Math.round(enrichedAll.length * 0.25);
  console.log(`\n  Diagnostic: touches with BOTH above-median volume AND below-median range: ${bothHighVolTightRange} (expected ~${expectedIfIndependent} if independent) -- ${bothHighVolTightRange < expectedIfIndependent * 0.7 ? 'confirms anti-correlation' : 'roughly independent'}`);
  const tightRangeOnlyRows = enrichedAll.filter(r => {
    const deltaAbsorbed = r.direction === 'LONG' ? r.delta < 0 : r.delta > 0;
    return r.rangeRatio <= rangeP50 && deltaAbsorbed;
  });
  const noTightRangeOnlyRows = enrichedAll.filter(r => {
    const deltaAbsorbed = r.direction === 'LONG' ? r.delta < 0 : r.delta > 0;
    return !(r.rangeRatio <= rangeP50 && deltaAbsorbed);
  });
  console.log('\n  TEST 2b: TIGHT RANGE + opposing delta ONLY (no volume condition):');
  console.log(summarize('  TIGHT_RANGE_OPPOSING', tightRangeOnlyRows));
  console.log(summarize('  REST (same pop)', noTightRangeOnlyRows));
  if (tightRangeOnlyRows.length >= 20 && noTightRangeOnlyRows.length >= 20) {
    const e1 = tightRangeOnlyRows.reduce((s, x) => s + Number(x.actual_pnl), 0) / tightRangeOnlyRows.length;
    const e2 = noTightRangeOnlyRows.reduce((s, x) => s + Number(x.actual_pnl), 0) / noTightRangeOnlyRows.length;
    console.log(`  Marginal contribution: $${(e1 - e2).toFixed(2)}/trade`);
  }

  // Per-setup-type breakdown for whichever test has enough pooled N to be worth decomposing.
  console.log('\n' + '='.repeat(90));
  console.log('PER-SETUP-TYPE BREAKDOWN (Volume Climax)');
  console.log('='.repeat(90));
  const byType = new Map();
  for (const r of enrichedAll) {
    if (!byType.has(r.setup_type)) byType.set(r.setup_type, []);
    byType.get(r.setup_type).push(r);
  }
  for (const [type, rows] of byType) {
    const c = rows.filter(r => r.volRatio >= volP75);
    const nc = rows.filter(r => r.volRatio < volP75);
    if (c.length < 10 && nc.length < 10) continue;
    console.log(`\n  ${type} (N=${rows.length})`);
    console.log(summarize('  CLIMAX', c));
    console.log(summarize('  NO_CLIMAX', nc));
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
