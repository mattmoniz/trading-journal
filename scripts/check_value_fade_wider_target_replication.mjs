// The one gating check DeepSeek's design critique (scratch/deepseek_wider_target_calib_design_review.md,
// 2026-08-19) named before any wider-target-multiplier calibration wiring gets built: the
// VALUE_FADE bet_class's clean-looking +2.0x finding (scratch/wider_target_multiplier_calibration_RESULTS.md,
// N=138, CLEAN at 1.5x/1.8x/2.0x) is a POOLED average across multiple individually-thin (N<20)
// setup_types. computeRigor() only checks internal stability of the pooled bucket — it cannot
// see whether that pooled average is broadly shared across VALUE_FADE's constituent setup_types
// or carried by one dominant one, exactly the failure mode that reversed
// volume_confirmed_candle_pattern_low_vol_trap (+$25/trade -> -$10.26 on held-out replication).
//
// Reuses the real mechanism (stepWiderTarget) and the real rigor/replication primitives —
// no reimplementation, per this codebase's "export the real function" convention. Mirrors
// scripts/backtest_calibrated_wider_target.mjs's population/eligibility logic exactly (same
// query, same origin_status filter, same "armed within MAX_BARS_TO_T1_FOR_WIDER" definition)
// so this check is testing the SAME population the original finding was drawn from, not a
// re-derived one.
//
// Run: node scripts/check_value_fade_wider_target_replication.mjs
import { query } from '../server/db.js';
import { resolveDirection, getBetClass } from '../server/config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeReplication } from '../server/services/rigorDiagnostics.js';
import { stepWiderTarget, MAX_BARS_TO_T1_FOR_WIDER } from '../server/services/widerTargetWalker.js';
import fs from 'fs';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const CANDIDATE_MULT = 2.0; // the specific candidate under test, per DeepSeek's instruction

async function main() {
  console.log('Loading real resolved trades (same population as backtest_calibrated_wider_target.mjs)...');
  const tradesRes = await query(`
    SELECT id, setup_type, origin_status, status,
      fired_at::text as fired_at, trade_date::text as trade_date,
      entry_zone_low::float as entry_zone_low, entry_zone_high::float as entry_zone_high,
      stop_level::float as stop_level, t1_level::float as t1_level
    FROM active_setups
    WHERE origin_status IN ('ACTIVE', 'SHADOW')
      AND status IN ('RESOLVED', 'EXPIRED')
      AND t1_level IS NOT NULL AND stop_level IS NOT NULL AND entry_zone_low IS NOT NULL
  `);
  const allTrades = tradesRes.rows;
  console.log(`Loaded ${allTrades.length} candidate real trades.`);

  console.log('Loading NQ price bars (correct timezone treatment, both sides)...');
  const barsRes = await query(`
    SELECT to_char(ts AT TIME ZONE 'America/New_York', 'YYYY-MM-DD"T"HH24:MI:SS') as ts_et,
           extract(epoch from (ts AT TIME ZONE 'America/New_York'))*1000 as ts_ms,
           high::float as high, low::float as low, close::float as close
    FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC
  `);
  const allBars = barsRes.rows;
  console.log(`Loaded ${allBars.length} price bars.`);

  function firstIndexAfter(tsMs) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts_ms <= tsMs) lo = mid + 1; else hi = mid; }
    return lo;
  }

  function runSim(trade, direction, mult) {
    const long = direction === 'LONG';
    const entry = trade.entry_zone_high ?? trade.entry_zone_low;
    const stop = trade.stop_level;
    const t1 = trade.t1_level;
    const origDistance = Math.abs(t1 - entry);
    const widerTarget = +(long ? entry + origDistance * mult : entry - origDistance * mult).toFixed(2);

    let state = { widening: false };
    // fired_at is naive ET wall-clock text; extract its epoch the SAME way as the bars query
    // (AT TIME ZONE 'America/New_York') via a matching SQL-side conversion done once below,
    // not JS Date parsing -- this is the exact bug the prior run had and was corrected for.
    const startIdx = firstIndexAfter(trade._firedAtMs);
    let resolution = null;

    for (let i = startIdx; i < allBars.length; i++) {
      const barCount = i - startIdx + 1;
      const b = allBars[i];
      const bar = { ts: b.ts_et, high: b.high, low: b.low, close: b.close };
      const stepRes = stepWiderTarget(state, bar, { entry, stop, t1, widerTarget, long, barCount, maxBarsToT1: MAX_BARS_TO_T1_FOR_WIDER });
      if (stepRes.resolution) { resolution = stepRes.resolution; break; }
      state = stepRes.state;
      if (barCount > 3000) { resolution = { resolution: 'RUNAWAY', priceAtRes: null }; break; }
    }

    const baselinePnl = Math.round((origDistance * PNL_PER_POINT - COMMISSION) * 100) / 100;
    let simPnl = null;
    if (resolution && resolution.priceAtRes != null) {
      const points = long ? resolution.priceAtRes - entry : entry - resolution.priceAtRes;
      simPnl = Math.round((points * PNL_PER_POINT - COMMISSION) * 100) / 100;
    }
    return { armed: state.widening || resolution?.method === 'WIDER_TARGET_HIT' || resolution?.method === 'WIDER_STOP_HIT' || resolution?.method === 'WIDER_TIME_EXPIRED', resolution, baselinePnl, simPnl };
  }

  // fired_at epochs, computed in SQL with the SAME AT TIME ZONE treatment as the bars query
  const firedAtIds = allTrades.map(t => t.id);
  const firedAtRes = await query(`
    SELECT id, extract(epoch from (fired_at AT TIME ZONE 'America/New_York'))*1000 as ms
    FROM active_setups WHERE id = ANY($1)
  `, [firedAtIds]);
  const firedAtMsById = new Map(firedAtRes.rows.map(r => [r.id, parseFloat(r.ms)]));
  for (const t of allTrades) t._firedAtMs = firedAtMsById.get(t.id);

  console.log('Simulating trades, identifying VALUE_FADE-bet_class armed population...');
  const valueFadeArmed = []; // { setupType, n contribution: 1 row per trade }
  let checked = 0, armedTotal = 0;

  for (const trade of allTrades) {
    const direction = resolveDirection(trade);
    if (!direction) continue;
    checked++;
    const betClass = getBetClass(trade.setup_type);
    if (betClass !== 'VALUE_FADE') continue;

    const dummy = runSim(trade, direction, 1.5);
    if (!dummy.armed) continue;
    armedTotal++;

    const atCandidate = runSim(trade, direction, CANDIDATE_MULT);
    if (atCandidate.simPnl === null) continue;

    valueFadeArmed.push({
      setupType: trade.setup_type,
      delta: atCandidate.simPnl - dummy.baselinePnl,
    });
  }

  console.log(`Checked ${checked} directionally-resolved trades, ${armedTotal} armed within VALUE_FADE bet_class, ${valueFadeArmed.length} with a valid ${CANDIDATE_MULT}x simulation.`);

  // Group by constituent setup_type
  const byType = {};
  for (const row of valueFadeArmed) (byType[row.setupType] ||= []).push(row.delta);

  const typeStats = Object.entries(byType).map(([setupType, deltas]) => ({
    setupType,
    n: deltas.length,
    meanDelta: +(deltas.reduce((a, b) => a + b, 0) / deltas.length).toFixed(2),
  })).sort((a, b) => b.n - a.n);

  console.log('\n=== VALUE_FADE constituent setup_types (armed, ' + CANDIDATE_MULT + 'x) ===');
  typeStats.forEach(t => console.log(`  ${t.setupType}: n=${t.n}, meanDelta=$${t.meanDelta}`));

  if (typeStats.length < 2) {
    console.log('\nFewer than 2 constituent setup_types found -- cannot run a selected-vs-held-out replication check (nothing to hold out). Reporting raw breakdown only.');
  } else {
    // "Selected" = the single largest-N constituent type (the one most likely to dominate
    // the pooled average) -- held out = every other constituent type, pooled.
    const dominant = typeStats[0];
    const replication = computeReplication(typeStats, {
      idFn: t => t.setupType,
      metricFn: t => ({ n: t.n, value: t.meanDelta }),
      selectedIds: [dominant.setupType],
    });
    console.log(`\n=== Replication check: "${dominant.setupType}" (n=${dominant.n}, the largest constituent) vs. all OTHER VALUE_FADE constituents pooled ===`);
    console.log(JSON.stringify(replication, null, 2));

    const summary = {
      candidateMult: CANDIDATE_MULT,
      totalArmedN: valueFadeArmed.length,
      constituentTypeCount: typeStats.length,
      constituentBreakdown: typeStats,
      dominantType: dominant.setupType,
      replication,
      verdict: replication.replicates
        ? 'REPLICATES: held-out constituents (excluding the dominant type) still show the same-sign, majority-favorable effect -- the +2.0x finding is broadly shared, not carried by one setup_type.'
        : 'DOES NOT REPLICATE: excluding the dominant constituent, the remaining VALUE_FADE types do not show a majority-favorable, same-sign effect -- the pooled +2.0x finding is likely concentrated in one setup_type, not a broad VALUE_FADE property. Do not build per-bet_class calibration wiring on this finding as-is; recalibrate at the individual setup_type level once each clears its own real-N floor, or treat the dominant type\'s finding as its own separate, narrower claim.',
    };
    fs.writeFileSync('scratch/value_fade_wider_target_replication_RESULTS.md',
      `# VALUE_FADE wider-target ${CANDIDATE_MULT}x replication check\n\n` +
      '```json\n' + JSON.stringify(summary, null, 2) + '\n```\n\n' +
      `## Verdict\n\n${summary.verdict}\n`
    );
    console.log('\nWritten to scratch/value_fade_wider_target_replication_RESULTS.md');
    console.log('\nVERDICT: ' + summary.verdict);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
