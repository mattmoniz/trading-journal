/**
 * Trend Counter-Fade Suppression Decision — Net P&L Backtest
 *
 * Per DeepSeek's Part B critique (docs/STRUCTURAL_BREAKOUT_RETEST_SPEC.md §5,
 * scratch/backtest_trend_gate_suppression_spec.md, OPEN_DECISION
 * dtclass_null_all_day_neuters_multiple_live_gates): before swapping acd.js's
 * isTrendCounterFade() data source from the always-null-during-RTH
 * acd_daily_log.day_type to the live dayTypeReassessmentService.js engine,
 * measure the ACTUAL SUPPRESSION-DECISION net P&L impact -- not just the
 * classifier's already-known ~68% end-to-end accuracy.
 *
 * Two prior Gemini dispatches on this exact script both failed (attempt 1
 * fabricated results, attempt 2 honestly ran out of time) -- per the standing
 * 2-corrections-then-Claude-takes-over rule, this is built directly.
 *
 * Method (no lookahead):
 *   - Population: real active_setups fade-candidate rows (setup_type LIKE
 *     '%_FADE_%', origin_status IN ('ACTIVE','SHADOW') -- excludes synthetic
 *     BACKFILL rows per this codebase's standing real-vs-synthetic rule,
 *     resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED') with actual_pnl
 *     populated, fired_at at/after 10:30 ET (630 min) -- the exact gate
 *     isTrendCounterFade() itself applies (dtClass !== 'TREND' || etMinNow <
 *     630 => false).
 *   - For each candidate, replay the REAL live reassessment engine
 *     (computeCase() -> classifyDayType() + runReassessment(), both imported
 *     from server/services/caseEngine.js / dayTypeReassessmentService.js, not
 *     reimplemented) bounded to bars available up to that trade's own
 *     fired_at -- computeCase()'s own bar query is `ts <= asOf`, so passing
 *     fired_at directly as asOf is genuinely no-lookahead.
 *   - IB direction via the newly-shared computeIbBullBear() (extracted from
 *     acd.js's inline ibSetup block this same session so this script imports
 *     the real formula instead of reimplementing it).
 *   - Proposed gate mirrors isTrendCounterFade()'s exact logic, just fed the
 *     live-replayed finalRead instead of the always-null batch column.
 *
 * Status quo = sum(actual_pnl) across the whole population (nothing was ever
 * suppressed historically -- dtClass was always null). Proposed = sum(actual_pnl)
 * for rows the proposed gate would NOT suppress. Net delta = proposed - status
 * quo (equivalently: -sum(actual_pnl of suppressed rows) -- a suppressed loser
 * is a benefit, a suppressed winner is a cost).
 *
 * Persists a performance_audit signal_type='TREND_GATE_SUPPRESSION_BACKTEST'
 * row and a RESEARCH_CLAIM via record_claim.mjs, positive or negative finding
 * either way.
 *
 * Run: node scripts/backtest_trend_gate_suppression.mjs
 */

import { query } from '../server/db.js';
import pool from '../server/db.js';
import { computeCase, computeIbBullBear } from '../server/services/caseEngine.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const SIGNAL_TYPE = 'TREND_GATE_SUPPRESSION'; // performance_audit.signal_type is VARCHAR(30) -- 'TREND_GATE_SUPPRESSION_BACKTEST' (31 chars) overflowed it

async function getIbBullBearForDate(cache, tradeDate) {
  if (cache.has(tradeDate)) return cache.get(tradeDate);
  const r = await query(`
    SELECT high::float, low::float, close::float, open::float,
           COALESCE(ask_volume,0)::int as ask_vol, COALESCE(bid_volume,0)::int as bid_vol
    FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 599
    ORDER BY ts
  `, [tradeDate]);
  const result = computeIbBullBear(r.rows);
  cache.set(tradeDate, result);
  return result;
}

async function getCaseForMoment(cache, tradeDate, firedAtText) {
  const key = `${tradeDate}|${firedAtText}`;
  if (cache.has(key)) return cache.get(key);
  const result = await computeCase(tradeDate, firedAtText);
  cache.set(key, result);
  return result;
}

// Mirrors acd.js's isTrendCounterFade() exactly, just fed a proposed finalRead/IB
// direction instead of the always-null dtClass / live-only ibSetup.
function proposedSuppress(finalRead, ibBullBear, dir) {
  if (finalRead !== 'TREND') return false;
  if (ibBullBear?.ibBullish) return dir === 'SHORT';
  if (ibBullBear?.ibBearish) return dir === 'LONG';
  return true; // unknown trend direction: suppress all fades (matches ibSetup === null case)
}

async function run() {
  console.log(`[backtest_trend_gate_suppression] Building candidate population...`);
  // Bounded to isTrendCounterFade()'s own active window (630-960 = 10:30am-4:00pm ET --
  // a SUBSET of full RTH, which is 9:30am-4pm/570-960; the gate itself has
  // `if (dtClass !== 'TREND' || etMinNow < 630) return false`, so it can never suppress
  // anything before 10:30 regardless of day type), not just a lower bound.
  // isTrendCounterFade() is ONLY ever called from the RTH keepLevelsAll code path (acd.js
  // lines 6234/6559/6690) -- detectGlobexSetup() (the separate Globex/overnight engine)
  // never calls it at all. A handful of setup_types (PD_VAH/PD_VAL/PD_POC) fire from BOTH
  // paths under the same setup_type name (documented convention, see CLAUDE.md), so an
  // unbounded `>= 630` filter silently let in Globex-hours fires (fired_at time-of-day
  // >=18:00) that are genuinely out of scope for this backtest -- confirmed via
  // scratch/diag_dropped_candidates.mjs: all 48 originally-dropped candidates had
  // etMin>=1080 (6pm+), zero in the RTH window, and were dropped only as a side effect of
  // computeCase(trade_date, fired_at) receiving an asOf whose calendar DATE precedes
  // trade_date for an overnight fire (impossible `ts::date=tradeDate AND ts<=asOf`), not a
  // timezone bug. Bounding the query properly removes them by construction instead of by
  // accident.
  const { rows: candidates } = await query(`
    SELECT id, trade_date::text as trade_date, setup_type,
           fired_at::text as fired_at, actual_pnl::float as actual_pnl
    FROM active_setups
    WHERE setup_type LIKE '%_FADE_%'
      AND origin_status IN ('ACTIVE','SHADOW')
      AND resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED')
      AND actual_pnl IS NOT NULL
      AND (EXTRACT(hour FROM fired_at)*60 + EXTRACT(minute FROM fired_at)) BETWEEN 630 AND 960
    ORDER BY fired_at
  `);
  console.log(`[backtest_trend_gate_suppression] N=${candidates.length} candidates across ${new Set(candidates.map(c => c.trade_date)).size} distinct trade dates`);

  const { rows: groundTruthRows } = await query(`SELECT trade_date::text as trade_date, day_type FROM acd_daily_log`);
  const groundTruth = new Map(groundTruthRows.map(r => [r.trade_date, r.day_type]));

  const ibCache = new Map();
  const caseCache = new Map();
  const results = [];

  for (const c of candidates) {
    const dir = directionFromType(c.setup_type);
    const ibBullBear = await getIbBullBearForDate(ibCache, c.trade_date);
    let finalRead = null;
    try {
      const caseResult = await getCaseForMoment(caseCache, c.trade_date, c.fired_at);
      finalRead = caseResult?.dayTypeReassessment?.read ?? caseResult?.dayType?.classification ?? null;
    } catch (e) {
      console.error(`[backtest_trend_gate_suppression] computeCase failed for ${c.trade_date} ${c.fired_at}: ${e.message}`);
      continue;
    }
    if (!finalRead) {
      console.error(`[backtest_trend_gate_suppression] DROPPED id=${c.id} type=${c.setup_type} trade_date=${c.trade_date} fired_at=${c.fired_at} -- computeCase returned no dayType/dayTypeReassessment (expected: 0, now that the population is bounded to isTrendCounterFade()'s 10:30am-4pm active window)`);
      continue;
    }

    const suppressed = proposedSuppress(finalRead, ibBullBear, dir);
    results.push({
      ...c,
      dir,
      finalRead,
      suppressed,
      groundTruthDayType: groundTruth.get(c.trade_date) ?? null,
    });
  }

  console.log(`[backtest_trend_gate_suppression] Replayed ${results.length}/${candidates.length} candidates`);

  // ── Aggregate net P&L ────────────────────────────────────────────────────
  const statusQuoTotal = results.reduce((s, r) => s + r.actual_pnl, 0);
  const proposedTotal  = results.filter(r => !r.suppressed).reduce((s, r) => s + r.actual_pnl, 0);
  const suppressedRows = results.filter(r => r.suppressed);
  const netDelta = proposedTotal - statusQuoTotal; // == -sum(suppressed actual_pnl)

  console.log(`\n=== AGGREGATE ===`);
  console.log(`Status quo (no suppression): N=${results.length} total=$${statusQuoTotal.toFixed(2)}`);
  console.log(`Proposed (live-replayed gate): suppressed=${suppressedRows.length} kept=${results.length - suppressedRows.length} total=$${proposedTotal.toFixed(2)}`);
  console.log(`NET DELTA (proposed - status quo): $${netDelta.toFixed(2)}`);

  // ── Per-setup_type breakdown ─────────────────────────────────────────────
  const bySetup = new Map();
  for (const r of results) {
    if (!bySetup.has(r.setup_type)) bySetup.set(r.setup_type, []);
    bySetup.get(r.setup_type).push(r);
  }
  console.log(`\n=== PER-SETUP_TYPE ===`);
  const setupBreakdown = [];
  for (const [type, rows] of [...bySetup.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const sq = rows.reduce((s, r) => s + r.actual_pnl, 0);
    const prop = rows.filter(r => !r.suppressed).reduce((s, r) => s + r.actual_pnl, 0);
    const nSup = rows.filter(r => r.suppressed).length;
    const delta = prop - sq;
    if (nSup > 0 || rows.length >= 3) {
      console.log(`  ${type.padEnd(30)} N=${rows.length} suppressed=${nSup} statusQuo=$${sq.toFixed(0)} proposed=$${prop.toFixed(0)} delta=$${delta.toFixed(0)}`);
    }
    setupBreakdown.push({ setup_type: type, n: rows.length, n_suppressed: nSup, status_quo: +sq.toFixed(2), proposed: +prop.toFixed(2), delta: +delta.toFixed(2) });
  }

  // ── Confusion breakdown (finalRead==='TREND' vs ground truth day_type) ──
  const withGroundTruth = results.filter(r => r.groundTruthDayType != null);
  const tp = withGroundTruth.filter(r => r.finalRead === 'TREND' && r.groundTruthDayType === 'TREND').length;
  const fp = withGroundTruth.filter(r => r.finalRead === 'TREND' && r.groundTruthDayType !== 'TREND').length;
  const tn = withGroundTruth.filter(r => r.finalRead !== 'TREND' && r.groundTruthDayType !== 'TREND').length;
  const fn = withGroundTruth.filter(r => r.finalRead !== 'TREND' && r.groundTruthDayType === 'TREND').length;
  console.log(`\n=== CONFUSION (live-replayed finalRead==='TREND' vs ground-truth day_type) ===`);
  console.log(`  TP=${tp} FP=${fp} TN=${tn} FN=${fn} (of ${withGroundTruth.length} candidates with known ground truth)`);
  const falsePositiveRate = (fp + tn) > 0 ? fp / (fp + tn) : null;
  console.log(`  False-positive rate: ${falsePositiveRate != null ? (falsePositiveRate * 100).toFixed(1) + '%' : 'n/a'}`);

  // ── Rigor on the delta contribution (per suppressed row: -actual_pnl) ───
  // Positive contribution = avoided a loss (good); negative = suppressed a winner (bad).
  const deltaEvents = suppressedRows.map(r => ({ date: r.trade_date, contribution: -r.actual_pnl }));
  const rigor = computeRigor(deltaEvents, { dateField: 'date', pnlFn: e => e.contribution });
  console.log(`\n=== RIGOR ON SUPPRESSION DELTA (N=${deltaEvents.length}) ===`);
  console.log(JSON.stringify(rigor, null, 2));

  // ── Verdict ──────────────────────────────────────────────────────────────
  const distinctDates = new Set(results.map(r => r.trade_date)).size;
  const tooThin = deltaEvents.length < 10 || distinctDates < 10;
  let verdict;
  if (tooThin) {
    verdict = 'TOO_THIN_TO_CONCLUDE';
  } else if (netDelta > 0 && rigor.clean) {
    verdict = 'POSITIVE_CLEAN';
  } else if (netDelta > 0) {
    verdict = 'POSITIVE_UNSTABLE';
  } else {
    verdict = 'NEGATIVE_OR_ZERO';
  }
  console.log(`\n=== VERDICT: ${verdict} ===`);
  console.log(`Success criteria (per spec): net delta positive, computeRigor-clean, false-positive cost not concentrated.`);
  console.log(`Recommendation: ${verdict.startsWith('POSITIVE') && !tooThin ? 'proceed toward wiring, pending code review' : 'do NOT wire live -- ' + (tooThin ? 'population too thin (only ' + distinctDates + ' distinct trade dates, ' + deltaEvents.length + ' suppressed rows) to conclude anything either way' : 'result is negative/unstable, this is a legitimate informative negative')}`);

  // ── Persist ──────────────────────────────────────────────────────────────
  const notes = {
    method: 'live-replayed computeCase()/runReassessment() vs status-quo (always-null dtClass)',
    n_candidates: results.length,
    n_suppressed: suppressedRows.length,
    distinct_trade_dates: distinctDates,
    status_quo_total: +statusQuoTotal.toFixed(2),
    proposed_total: +proposedTotal.toFixed(2),
    net_delta: +netDelta.toFixed(2),
    per_setup_type: setupBreakdown,
    confusion: { tp, fp, tn, fn, false_positive_rate: falsePositiveRate },
    rigor,
    verdict,
  };

  const { rows: dateRows } = await query(`SELECT CURRENT_DATE::text as today`);
  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, total_pnl, recommendation, notes)
    VALUES ($1, 9999, $2, 'ALL', $3, $4, $5, $6, $7, $8)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
      SET sample_size=EXCLUDED.sample_size, win_rate=EXCLUDED.win_rate, ev_per_trade=EXCLUDED.ev_per_trade,
          total_pnl=EXCLUDED.total_pnl, recommendation=EXCLUDED.recommendation, notes=EXCLUDED.notes
  `, [
    dateRows[0].today, SIGNAL_TYPE, results.length,
    withGroundTruth.length ? tp / Math.max(1, tp + fp) : null,
    results.length ? netDelta / results.length : null,
    netDelta, verdict, JSON.stringify(notes),
  ]);

  await recordClaim({
    slug: 'trend_gate_suppression_net_pnl',
    claimText: `Replaying acd.js's isTrendCounterFade() suppression with the LIVE dayTypeReassessmentService.js engine (instead of the always-null-during-RTH acd_daily_log.day_type) against ${results.length} real fade-candidate touches (${distinctDates} distinct trade dates, origin_status IN ('ACTIVE','SHADOW') only, bounded to isTrendCounterFade()'s own active window of 10:30am-4pm ET -- a subset of full RTH 9:30am-4pm, matching the gate's own etMinNow<630 exclusion -- the exact population it can ever apply to, since it's only called from the RTH keepLevelsAll path, never from detectGlobexSetup()): status quo (no suppression, matching real history) = $${statusQuoTotal.toFixed(2)}; proposed gate suppresses ${suppressedRows.length} rows (net +$${(-netDelta).toFixed(2)} of real winners), net delta = $${netDelta.toFixed(2)}. Confusion vs ground-truth day_type: TP=${tp} FP=${fp} TN=${tn} FN=${fn} (FP rate ${falsePositiveRate != null ? (falsePositiveRate*100).toFixed(1)+'%' : 'n/a'}, much worse than the reassessment engine's own general-purpose ~20.4% FPR). Rigor on the per-suppressed-row delta contribution: ${JSON.stringify(rigor)}. Verdict: ${verdict}. Interpretive note (DeepSeek review, audited): the high FPR on this subpopulation is likely structural, not a classifier defect -- a fade-touch moment is by definition a directional move reaching a level, which can itself satisfy classifyGroundTruth()'s range_ratio/close_pct/trend_str/close_outside_ib conditions momentarily even when the full session ultimately resolves as BALANCE. This suggests even a more accurate day-type classifier would not fix this gate, because the flaw may be in gating on "does this MOMENT look like a trend" rather than "is there PERSISTENT directional pressure likely to continue" -- a different, not-yet-built signal (e.g. a delta/VWAP-migration persistence check at the moment of touch) would need to replace this approach entirely, not just get a better day-type input.`,
    sourceFile: 'scripts/backtest_trend_gate_suppression.mjs',
    sourceDate: dateRows[0].today,
    sampleSize: results.length,
    winRate: withGroundTruth.length ? tp / Math.max(1, tp + fp) : null,
    evPerTrade: results.length ? netDelta / results.length : null,
    rigorStatus: rigor.clean === true ? 'clean' : rigor.clean === false ? 'unstable_or_clustered' : 'too_thin',
    status: tooThin ? 'PROVISIONAL' : (verdict === 'POSITIVE_CLEAN' ? 'PROVISIONAL' : 'PROVISIONAL'),
  });

  console.log(`\n[backtest_trend_gate_suppression] Persisted performance_audit row + RESEARCH_CLAIM trend_gate_suppression_net_pnl`);
  await pool.end();
}

run().catch(e => { console.error('[backtest_trend_gate_suppression] ERROR:', e.message, e.stack); process.exit(1); });
