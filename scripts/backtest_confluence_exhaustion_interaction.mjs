// scripts/backtest_confluence_exhaustion_interaction.mjs
// Weekly recalibration for the confluence+exhaustion interaction finding (2026-07-23,
// user's own discretionary framework: the buyer/seller "tussle" -- volume/delta showing
// absorption or exhaustion -- is the real tell for whether a level-fade entry is safe,
// not the level touch alone). Two jobs, run together since they share the same
// touch-detection/enrichment pass:
//
// (1) Persist the LIVE-usable volRatio/rangeRatio percentile cutoffs (from the full
//     available history) that acd.js reads to compute exhaustion_signal_at_detection on
//     every live candidate -- an informational field only (see server/routes/acd.js),
//     NOT wired into sizeMultiplier or suppression. Per CLAUDE.md's no-static-thresholds
//     rule, these are data-derived and refreshed weekly, never hardcoded.
// (2) Re-run the genuine chronological holdout check (train-only cutoffs, frozen before
//     evaluating test) and record it as a RESEARCH_CLAIM every run, so the interaction
//     finding keeps getting rechecked as real (non-BACKFILL) data accumulates going
//     forward -- this is the actual point: BACKFILL data is fixed/exhausted (confirmed
//     2026-07-22: widening from BACKFILL-only to all origins barely changed N), so the
//     only way this ever gets a real, decisive sample is real touches accumulating from
//     here on, which requires exhaustion_signal_at_detection to actually be persisted
//     live starting now.
//
// First pass (scratch/confluence_exhaustion_combined.mjs) had a real leak -- percentile
// cutoffs computed from the full train+test population before splitting. Fixed version
// (scratch/confluence_exhaustion_combined_v2.mjs) is the reference methodology this
// script promotes to a real, scheduled, persisted pipeline.

import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { loadPairProximityThresholds, PROXIMITY } from './backtest_confluence.js';
import { recordClaim } from './record_claim.mjs';

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function computeStats(rows) {
  const n = rows.length;
  if (n === 0) return { n: 0, wr: null, ev: null, rigor: null };
  const wins = rows.filter(r => Number(r.actual_pnl) > 0).length;
  const wr = wins / n;
  const evs = rows.map(r => Number(r.actual_pnl)).filter(v => Number.isFinite(v));
  const ev = evs.length ? evs.reduce((a, b) => a + b, 0) / evs.length : null;
  const rigor = n >= 10 ? computeRigor(rows, { dateField: 'dateStr', pnlFn: r => Number(r.actual_pnl) }) : null;
  return { n, wr, ev, rigor };
}

async function main() {
  console.log('Loading validated confluence pairs...');
  const pairsRes = await query(`
    SELECT signal_name FROM performance_audit
    WHERE signal_type='CONFLUENCE_AUDIT' AND recommendation='VALIDATED_PAIR'
  `);
  const validPairs = new Set();
  const validLevels = new Set();
  for (const row of pairsRes.rows) {
    const pairStr = row.signal_name.replace('PAIR:', '');
    validPairs.add(pairStr);
    const [a, b] = pairStr.split('+');
    validLevels.add(a); validLevels.add(b);
  }
  console.log(`${validPairs.size} validated pairs across ${validLevels.size} levels.`);

  const pairThresholds = await loadPairProximityThresholds();

  const levelPricesRes = await query(`SELECT trade_date::text as trade_date, level_name, price::float as price FROM level_prices WHERE price IS NOT NULL`);
  const levelPricesByDate = new Map();
  for (const r of levelPricesRes.rows) {
    const d = r.trade_date.slice(0, 10);
    if (!levelPricesByDate.has(d)) levelPricesByDate.set(d, new Map());
    levelPricesByDate.get(d).set(r.level_name, r.price);
  }

  const setupsRes = await query(`
    SELECT id, trade_date::text as trade_date, fired_at, resolution, actual_pnl::float, setup_type
    FROM active_setups
    WHERE resolution IN ('STOP_HIT', 'TARGET_HIT') AND actual_pnl IS NOT NULL
      AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL
      AND mae_points IS NOT NULL AND mae_points <= 300
      AND mfe_points IS NOT NULL AND mfe_points <= 300
      AND origin_status IN ('ACTIVE', 'SHADOW')
    ORDER BY trade_date, fired_at
  `);
  // preflight_backtest_assertions.mjs check [1], roadmap Phase 0 sweep, 2026-08-10: was
  // unfiltered by origin_status. EXHAUSTION_SIGNAL_CALIB is informational-only (never gates
  // sizing/suppression), so the risk here was a misleading displayed cutoff, not a live
  // capital decision -- fixed to the same standard anyway.
  const setups = setupsRes.rows.filter(s => {
    const underlying = s.setup_type.replace('_FADE_LONG', '').replace('_FADE_SHORT', '');
    return validLevels.has(underlying);
  });
  console.log(`${setups.length} touches across ${validLevels.size} confluence-eligible levels.`);

  const setupsByDate = new Map();
  for (const s of setups) {
    const d = s.trade_date.slice(0, 10);
    if (!setupsByDate.has(d)) setupsByDate.set(d, []);
    setupsByDate.get(d).push(s);
  }

  const enrichedAll = [];
  for (const [date, dateSetups] of setupsByDate) {
    const barsRes = await query(`
      SELECT ts, high::float, low::float, COALESCE(volume,0)::int AS volume,
             COALESCE(bid_volume,0)::int AS bid_volume, COALESCE(ask_volume,0)::int AS ask_volume
      FROM price_bars_primary WHERE symbol='NQ' AND ts::date = $1 ORDER BY ts
    `, [date]);
    const allBars = barsRes.rows;
    if (allBars.length < 25) continue;
    const lp = levelPricesByDate.get(date) || new Map();

    for (const s of dateSetups) {
      const direction = directionFromType(s.setup_type);
      if (!direction) continue;
      let entryIdx = -1;
      for (let i = allBars.length - 1; i >= 0; i--) {
        if (allBars[i].ts <= s.fired_at) { entryIdx = i; break; }
      }
      if (entryIdx < 20) continue;

      const priorBars = allBars.slice(entryIdx - 20, entryIdx);
      const entryBar = allBars[entryIdx];
      const meanVol = priorBars.reduce((a, b) => a + b.volume, 0) / priorBars.length;
      const meanRange = priorBars.reduce((a, b) => a + (b.high - b.low), 0) / priorBars.length;
      if (meanVol <= 0 || meanRange <= 0) continue;

      const volRatio = entryBar.volume / meanVol;
      const rangeRatio = (entryBar.high - entryBar.low) / meanRange;
      const delta = entryBar.ask_volume - entryBar.bid_volume;

      const underlying = s.setup_type.replace('_FADE_LONG', '').replace('_FADE_SHORT', '');
      let hasConfluence = false;
      const myPrice = lp.get(underlying);
      if (myPrice != null) {
        for (const partner of validLevels) {
          if (partner === underlying) continue;
          const k1 = `${underlying}+${partner}`, k2 = `${partner}+${underlying}`;
          if (validPairs.has(k1) || validPairs.has(k2)) {
            const partnerPrice = lp.get(partner);
            if (partnerPrice != null) {
              const key = underlying < partner ? k1 : k2;
              const threshold = pairThresholds.get(key) ?? (2 * PROXIMITY);
              if (Math.abs(myPrice - partnerPrice) <= threshold) { hasConfluence = true; break; }
            }
          }
        }
      }
      enrichedAll.push({ ...s, dateStr: date, direction, volRatio, rangeRatio, delta, hasConfluence });
    }
  }
  console.log(`Enriched: ${enrichedAll.length} touches.`);
  if (enrichedAll.length < 40) { console.log('Too few touches, aborting.'); process.exit(0); }

  // ── (1) Live-usable cutoffs: full available history, no train/test split needed --
  // this is establishing a threshold for classifying FUTURE live touches, not testing
  // past performance against itself. ──
  const volSorted = [...enrichedAll.map(r => r.volRatio)].sort((a, b) => a - b);
  const rangeSorted = [...enrichedAll.map(r => r.rangeRatio)].sort((a, b) => a - b);
  const liveVolP50 = percentile(volSorted, 0.50);
  const liveRangeP50 = percentile(rangeSorted, 0.50);
  console.log(`Live cutoffs (full history): volRatio p50=${liveVolP50.toFixed(3)}, rangeRatio p50=${liveRangeP50.toFixed(3)}`);

  await query(`DELETE FROM performance_audit WHERE signal_type = 'EXHAUSTION_SIGNAL_CALIB'`);
  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, notes)
    VALUES (CURRENT_DATE, 9999, 'EXHAUSTION_SIGNAL_CALIB', 'LIVE_CUTOFFS', $1, $2)
  `, [enrichedAll.length, JSON.stringify({ volRatioP50: liveVolP50, rangeRatioP50: liveRangeP50 })]);
  console.log('Persisted live cutoffs to performance_audit (EXHAUSTION_SIGNAL_CALIB).');

  // ── (2) Genuine chronological holdout, train-only cutoffs frozen before test ──
  const trainSet = [], testSet = [];
  const byType = new Map();
  for (const r of enrichedAll) { if (!byType.has(r.setup_type)) byType.set(r.setup_type, []); byType.get(r.setup_type).push(r); }
  for (const rows of byType.values()) {
    rows.sort((a, b) => a.trade_date.localeCompare(b.trade_date) || a.fired_at.getTime() - b.fired_at.getTime());
    const splitIdx = Math.floor(rows.length * 0.8);
    trainSet.push(...rows.slice(0, splitIdx));
    testSet.push(...rows.slice(splitIdx));
  }
  const trainVolP50 = percentile([...trainSet.map(r => r.volRatio)].sort((a, b) => a - b), 0.50);
  const trainRangeP50 = percentile([...trainSet.map(r => r.rangeRatio)].sort((a, b) => a - b), 0.50);
  for (const r of [...trainSet, ...testSet]) {
    const deltaOpposing = r.direction === 'LONG' ? r.delta < 0 : r.delta > 0;
    r.hasExhaustion = r.volRatio >= trainVolP50 && r.rangeRatio <= trainRangeP50 && deltaOpposing;
  }

  function buckets(dataset) {
    return {
      confExh: computeStats(dataset.filter(r => r.hasConfluence && r.hasExhaustion)),
      confNoExh: computeStats(dataset.filter(r => r.hasConfluence && !r.hasExhaustion)),
      noConfExh: computeStats(dataset.filter(r => !r.hasConfluence && r.hasExhaustion)),
      noConfNoExh: computeStats(dataset.filter(r => !r.hasConfluence && !r.hasExhaustion)),
    };
  }
  const trainB = buckets(trainSet), testB = buckets(testSet);

  const additivePredictedTrain = (trainB.noConfNoExh.ev ?? 0)
    + ((trainB.confNoExh.ev ?? 0) - (trainB.noConfNoExh.ev ?? 0))
    + ((trainB.noConfExh.ev ?? 0) - (trainB.noConfNoExh.ev ?? 0));
  const interactionGapTrain = (trainB.confExh.ev ?? 0) - additivePredictedTrain;

  console.log(`\nTRAIN confluence+exhaustion: n=${trainB.confExh.n} EV=$${trainB.confExh.ev?.toFixed(2)}`);
  console.log(`TEST  confluence+exhaustion: n=${testB.confExh.n} EV=$${testB.confExh.ev?.toFixed(2)}`);
  console.log(`Additive-predicted TRAIN EV: $${additivePredictedTrain.toFixed(2)}, interaction gap: $${interactionGapTrain.toFixed(2)}`);

  await recordClaim({
    slug: 'confluence_exhaustion_interaction',
    claimText: `Weekly-rechecked interaction test: does an exhaustion signal (top-half volRatio, bottom-half rangeRatio, delta opposing fade direction, all vs a rolling 20-bar baseline) at a validated confluence zone (real RTH VALIDATED_PAIR data) behave differently than the same signal at an isolated level. Population: ${enrichedAll.length} real touches across ${validLevels.size} confluence-eligible levels (both BACKFILL and any accumulated real ACTIVE/SHADOW data). Chronological 80/20 split per setup_type, cutoffs computed from TRAIN only and frozen before evaluating TEST (fixed a real leak found in the first pass, which had computed cutoffs from the full population before splitting -- that leaked version showed CONFLUENCE+EXHAUSTION as falsely "clean/stable"; the corrected version does not). Current result: TRAIN confluence+exhaustion EV=$${trainB.confExh.ev?.toFixed(2)} (n=${trainB.confExh.n}), TEST EV=$${testB.confExh.ev?.toFixed(2)} (n=${testB.confExh.n}). Additive-effects check (would predict CONFLUENCE+EXHAUSTION's EV if confluence and exhaustion were independent, non-interacting effects): predicted $${additivePredictedTrain.toFixed(2)}, actual $${trainB.confExh.ev?.toFixed(2)}, gap $${interactionGapTrain.toFixed(2)} -- a real interaction signature survives the leak fix even though the bucket's own absolute EV is no longer clearly negative and neither train nor test show computeRigor's clean/stable flag yet. Not wired into sizeMultiplier or suppression -- user's own instinct ("watch until I get conviction") matches the current evidence bar: real, worth tracking, not yet decisive. The fundamental constraint is sample size -- BACKFILL data is fixed/exhausted for these levels (confirmed widening to all origins barely changed N), so this can only become decisive as real (non-BACKFILL) touches accumulate going forward, which requires exhaustion_signal_at_detection to be persisted live starting now (added to server/routes/acd.js, informational only).`,
    sourceFile: 'scripts/backtest_confluence_exhaustion_interaction.mjs',
    sampleSize: testB.confExh.n,
    winRate: testB.confExh.wr,
    evPerTrade: testB.confExh.ev,
    rigorStatus: trainB.confExh.rigor?.clean && testB.confExh.rigor?.clean ? 'clean_both' : 'not_yet_clean',
    status: 'PROVISIONAL',
  });
  console.log('\nRecorded RESEARCH_CLAIM: confluence_exhaustion_interaction');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
