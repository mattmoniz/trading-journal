// Closed-loop monitoring for the wider-target-on-fast-resolving-trades mechanism
// (docs/OPEN_THREADS.md 2026-08-17, server/services/widerTargetWalker.js). Design +
// scope both DeepSeek-reviewed twice before this was written (design pass, then a
// scope pass that caught a real pre-existing direction bug -- see below).
//
// Reads the REAL, live-fired outcomes of the mechanism (not the frozen one-time backtest,
// RESEARCH_CLAIM velocity_fast_wider_target_positive_provisional, which stays untouched as
// the historical reference) and asks: is the SHADOW mechanism reproducing its backtested
// positive delta, or has it drifted? Writes one performance_audit row per run
// (signal_type='WIDER_TARGET_LIVE_STATUS') and flags an OPEN_DECISION only on a verdict
// TRANSITION (never auto-promotes -- the mechanism is SHADOW-only by construction, ACTIVE
// rows structurally cannot carry the flag, so a REPRODUCED verdict only ever surfaces a
// human decision to consider building the ACTIVE-row wiring).
//
// Counterfactual baseline is deterministic, no bar-replay needed: stepWiderTarget() only
// arms when T1 is hit cleanly with no same-bar stop conflict, so the fixed-T1 exit the
// plain branch would have produced is exactly |t1_level - entry| * $/pt - commission,
// computable from the row alone.
//
// Direction resolution (fixed 2026-08-18, B1 of the DeepSeek-QA'd wider-target bug hunt --
// docs/OPEN_THREADS.md 2026-08-18): this script used to reproduce the LOCAL, buggy
// isLongSetup() heuristic from acd.js (misclassifies _GAP_UP/_GAP_DOWN conditional variants,
// e.g. WPP_FADE_SHORT_GAP_UP read as LONG via a bare '_UP' substring match) purely to detect
// disagreement with inferDirection() and exclude the mismatch. That local reproduction is gone
// -- resolveSetupsByPrice() itself was already fixed elsewhere to use the shared, canonical
// resolveDirection() (server/config/setupTypes.js), so comparing against the OLD buggy
// heuristic here was itself stale and wrongly excluding correctly-resolved rows (DeepSeek's
// QA catch: inferDirection() alone is also name-only and returns null for ZONE_EDGE_FADE,
// which the live path resolves via resolveDirection()'s price-derived fallback -- using
// resolveDirection() here closes that gap too, not just the original _GAP_* one). The
// independent price_at_resolution reconstruction check below is a strictly stronger check
// on its own and already catches genuine corruption regardless of direction source.
//
// Run: node scripts/audit_wider_target_live.mjs
import { query } from '../server/db.js';
import { resolveDirection, getBetClass } from '../server/config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { flagDecision } from './flag_decision.mjs';

const SIGNAL_TYPE = 'WIDER_TARGET_LIVE_STATUS';
const SIGNAL_NAME = 'wider_target_1p5x';
const RECHECK_OF = 'velocity_fast_wider_target_positive_provisional';
// Exported for reference/future import -- server/ routes don't currently import from
// scripts/ (scripts are standalone, not imported by the running app, per CLAUDE.md
// convention), so GET /acd/runner-wider-target-status currently mirrors this as a literal
// (nArmedFloor: 20 in acd.js) rather than importing it. If that convention ever relaxes, or
// this value changes, update both together.
export const MIN_N = 20;
const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

async function main() {
  const armedRes = await query(`
    SELECT id, setup_type, trade_date::text as trade_date, fired_at::text as fired_at,
      entry_zone_low::float as entry_zone_low, entry_zone_high::float as entry_zone_high,
      stop_level::float as stop_level, t1_level::float as t1_level,
      wider_target_mult::float as wider_target_mult,
      price_at_resolution::float as price_at_resolution, actual_pnl::float as actual_pnl,
      resolution_method
    FROM active_setups
    WHERE resolution_method IN ('WIDER_TARGET_HIT','WIDER_STOP_HIT','WIDER_TIME_EXPIRED')
      AND origin_status = 'SHADOW'
    ORDER BY fired_at ASC
  `);

  const flaggedTotalRes = await query(`
    SELECT COUNT(*)::int as n FROM active_setups
    WHERE wider_target_mult IS NOT NULL AND origin_status = 'SHADOW'
      AND status IN ('RESOLVED', 'EXPIRED')
  `);
  const flaggedTotal = flaggedTotalRes.rows[0].n;

  // Direction resolution + P&L reconstruction. Excludes (not silently corrects) any row
  // where resolveDirection() can't resolve a direction (reason 'direction_unresolved' --
  // see header for what that means). Also reconstructs actual_pnl from price_at_resolution
  // independently of the stored value, per DeepSeek's "strictly stronger check" review --
  // a mismatch here means something OTHER than a direction issue corrupted the row, and
  // must not be silently trusted either.
  const excludedRows = [];
  const validRows = [];
  for (const r of armedRes.rows) {
    const direction = resolveDirection(r);
    if (direction === null) {
      excludedRows.push({ ...r, reason: 'direction_unresolved' });
      continue;
    }
    const long = direction === 'LONG';
    const entry = r.entry_zone_high ?? r.entry_zone_low;
    const fixedT1Pnl = Math.round(((long ? r.t1_level - entry : entry - r.t1_level) * PNL_PER_POINT - COMMISSION) * 100) / 100;
    // Independent reconstruction from price_at_resolution, cross-checked against the
    // stored actual_pnl -- a stronger check than re-deriving delta from the same inputs.
    const reconstructedPnl = r.price_at_resolution != null
      ? Math.round(((long ? r.price_at_resolution - entry : entry - r.price_at_resolution) * PNL_PER_POINT - COMMISSION) * 100) / 100
      : null;
    if (reconstructedPnl != null && Math.abs(reconstructedPnl - r.actual_pnl) > 0.02) {
      excludedRows.push({ ...r, reason: 'actual_pnl_mismatch_price_reconstruction', reconstructedPnl });
      continue;
    }
    const delta = Math.round((r.actual_pnl - fixedT1Pnl) * 100) / 100;
    validRows.push({ ...r, direction, entry, fixedT1Pnl, delta });
  }

  const armedN = validRows.length;

  const today = (await query(`SELECT CURRENT_DATE::text as d`)).rows[0].d;

  // Prior run (most recent before today) -- for delta_since_last_check, transition detection,
  // AND (2026-08-17) the --daily-check throttle below. Moved up from its original position
  // right before the `notes` object so the throttle can use nAtLastCheck; reused later for
  // deltaSinceLastCheck, no duplicate query.
  const priorRes = await query(`
    SELECT run_date::text, recommendation, notes FROM performance_audit
    WHERE signal_type=$1 AND signal_name=$2 AND run_date < $3
    ORDER BY run_date DESC LIMIT 1
  `, [SIGNAL_TYPE, SIGNAL_NAME, today]);
  const prior = priorRes.rows[0] || null;
  let priorNotes = null;
  try { priorNotes = prior?.notes ? (typeof prior.notes === 'string' ? JSON.parse(prior.notes) : prior.notes) : null; } catch (_) {}
  const nAtLastCheck = priorNotes?.n_armed ?? 0;

  const dailyCheckMode = process.argv.includes('--daily-check');

  console.log(`Armed (resolution_method IN WIDER_*): ${armedRes.rows.length} raw, ${armedN} valid, ${excludedRows.length} excluded.`);
  if (excludedRows.length) {
    console.log('Excluded rows (reason):', excludedRows.map(r => `id=${r.id} ${r.setup_type} (${r.reason})`).join('; '));
  }
  console.log(`Flagged total (wider_target_mult set, terminal): ${flaggedTotal}. Never-armed: ${flaggedTotal - armedRes.rows.length}.`);

  if (armedN === 0) {
    console.log('Zero valid armed rows -- writing THIN_N with N=0.');
  } else {
    // Mandatory first-run self-check: print the full reconstruction for the first valid
    // armed row so this is verified fresh every run, not trusted from a one-time manual check.
    const first = validRows[0];
    console.log(`Self-check (row id=${first.id}, ${first.setup_type}): entry=${first.entry} t1=${first.t1_level} storedPnl=${first.actual_pnl} fixedT1Pnl=${first.fixedT1Pnl} delta=${first.delta}`);
    const recheckDelta = Math.round((first.actual_pnl - first.fixedT1Pnl) * 100) / 100;
    if (recheckDelta !== first.delta) {
      console.error(`SELF-CHECK FAILED: recomputed delta ${recheckDelta} != stored ${first.delta}. Aborting without writing.`);
      process.exit(1);
    }
  }

  const deltas = validRows.map(r => r.delta);
  const meanDelta = mean(deltas);
  const medianDelta = median(deltas);
  // 0-1 scale, matching this codebase's standing performance_audit.win_rate convention
  // (CLAUDE.md/ANTIGRAVITY_CONSTRAINTS.md: "0-1 scale... do not store on 0-100 scale") --
  // caught in DeepSeek's code review: storing a raw percent here would be self-consistent
  // with this script's own two consumers today, but would silently double-multiply once
  // the generic Unified Signal Table (/api/performance-audit/unified) reads this
  // signal_type's win_rate and applies its own *100 for display.
  const winRateVsFixed = armedN ? +(deltas.filter(d => d > 0).length / armedN).toFixed(3) : null;

  const events = validRows.map(r => ({ trade_date: r.trade_date, delta: r.delta }));
  const rigor = armedN ? computeRigor(events, { dateField: 'trade_date', pnlFn: e => e.delta }) : null;

  // Day-sign majority + largest-day-exclusion -- reported only, never gating (per design:
  // selection bias isn't the live risk here, the population isn't a cherry-picked subset).
  let daySignMajority = null, largestDayShare = null, survivesLargestDayExclusion = null;
  if (armedN) {
    const byDay = {};
    for (const r of validRows) (byDay[r.trade_date] ||= []).push(r.delta);
    const dayEntries = Object.entries(byDay).map(([d, ds]) => ({ date: d, n: ds.length, mean: mean(ds) }));
    daySignMajority = +(100 * dayEntries.filter(d => d.mean > 0).length / dayEntries.length).toFixed(1);
    const sortedByN = [...dayEntries].sort((a, b) => b.n - a.n);
    largestDayShare = +(100 * sortedByN[0].n / armedN).toFixed(1);
    const withoutLargest = validRows.filter(r => r.trade_date !== sortedByN[0].date).map(r => r.delta);
    survivesLargestDayExclusion = withoutLargest.length ? mean(withoutLargest) > 0 : null;
  }

  const bySetupType = {};
  for (const r of validRows) (bySetupType[r.setup_type] = (bySetupType[r.setup_type] || 0) + 1);
  const topEntry = Object.entries(bySetupType).sort((a, b) => b[1] - a[1])[0];
  const topSetupType = topEntry ? topEntry[0] : null;
  const topSetupTypeShare = topEntry ? +(100 * topEntry[1] / armedN).toFixed(1) : null;

  // byBetClass/topBetClass (2026-08-18, docs/SLOW_DEEP_EARLY_EXIT_SPEC.md step 4): this
  // mechanism has the identical "single pooled constant, not per-bet_class" gap as the
  // slow-deep-early-exit finding, but a different urgency -- upside-only (worst case gives
  // back a paper gain down to the original stop, not a locked-in real loss) and already
  // closed-loop monitored here. User explicitly deprioritized a full per-bet_class
  // recalibration of WIDER_TARGET_MULT until real extra-MFE benefit is confirmed first --
  // this is just visibility, so a family-specific drift would surface here before any
  // promotion decision, not a recalibration.
  const byBetClassMap = {};
  for (const r of validRows) {
    const bc = getBetClass(r.setup_type);
    (byBetClassMap[bc] ||= []).push(r.delta);
  }
  const byBetClass = Object.entries(byBetClassMap)
    .map(([betClass, deltas]) => ({ betClass, n: deltas.length, meanDelta: +mean(deltas).toFixed(2), share: +(100 * deltas.length / armedN).toFixed(1) }))
    .sort((a, b) => b.n - a.n);
  const topBetClass = byBetClass[0]?.betClass ?? null;
  const topBetClassShare = byBetClass[0]?.share ?? null;

  const nWiderTargetHit = validRows.filter(r => r.resolution_method === 'WIDER_TARGET_HIT').length;
  const nWiderStopHit = validRows.filter(r => r.resolution_method === 'WIDER_STOP_HIT').length;
  const nWiderTimeExpired = validRows.filter(r => r.resolution_method === 'WIDER_TIME_EXPIRED').length;

  let verdict;
  if (armedN < MIN_N) verdict = 'THIN_N';
  else if (meanDelta <= 0) verdict = 'CONTRADICTED';
  else if (rigor.clean) verdict = 'REPRODUCED';
  else verdict = 'UNSTABLE';

  // today/priorRes/prior/priorNotes/nAtLastCheck are all computed earlier now (moved up for
  // the --daily-check throttle) -- reused here, no duplicate query.
  const deltaSinceLastCheck = armedN - nAtLastCheck;

  const notes = {
    recheck_of: RECHECK_OF,
    n_flagged: flaggedTotal,
    n_armed: armedN,
    n_armed_raw: armedRes.rows.length,
    n_excluded: excludedRows.length,
    // Breakdown by reason (DeepSeek QA suggestion, 2026-08-18): self-documents whether an
    // armedN jump after the B1 fix came from previously-wrongly-excluded-now-included rows,
    // or from a genuinely corrupted row moving from the old (removed) direction-mismatch
    // bucket into actual_pnl_mismatch_price_reconstruction instead -- those are different
    // findings and should not be conflated when reading this row later.
    n_excluded_by_reason: excludedRows.reduce((acc, r) => { acc[r.reason] = (acc[r.reason] || 0) + 1; return acc; }, {}),
    n_wider_target_hit: nWiderTargetHit,
    n_wider_stop_hit: nWiderStopHit,
    n_wider_time_expired: nWiderTimeExpired,
    n_flagged_never_armed: flaggedTotal - armedRes.rows.length,
    median_delta: medianDelta,
    day_sign_majority: daySignMajority,
    largest_day_share: largestDayShare,
    top_setup_type: topSetupType,
    top_setup_type_share: topSetupTypeShare,
    top_bet_class: topBetClass,
    top_bet_class_share: topBetClassShare,
    by_bet_class: byBetClass,
    rigor: rigor ? { distinctDates: rigor.distinctDates, top5DayPct: rigor.top5DayPct, clustered: rigor.clustered, stable: rigor.stable, thirds: rigor.thirds, clean: rigor.clean } : null,
    survives_largest_day_exclusion: survivesLargestDayExclusion,
    n_at_last_check: nAtLastCheck,
    delta_since_last_check: deltaSinceLastCheck,
    win_rate_semantics: 'the win_rate COLUMN (0-1 scale) is the fraction of armed rows where delta > fixed-T1 counterfactual, not a classic win rate -- multiply by 100 for display, per this codebase\'s standing win_rate convention',
  };

  console.log(`\nVerdict: ${verdict} (N=${armedN}, meanDelta=${meanDelta}, rigor.clean=${rigor?.clean})`);

  // Daily self-throttle (user request 2026-08-17, docs/RUNNER_FOLLOWUPS_SPEC_20260817.md
  // Item 0): scripts/run_daily_calibration.sh invokes this with --daily-check Mon-Fri so the
  // mechanism gets checked daily while real armed N is thin, self-throttling back to the
  // existing weekly-only cadence (scripts/run_weekly_backtests.sh, unflagged, always runs in
  // full) once N clears the floor -- no manual cron edit needed later. Gates on
  // nAtLastCheck (the PRIOR stored row's N), not the just-computed armedN, so the daily run
  // that FIRST discovers armedN>=MIN_N still writes (the verdict-transition flagDecision
  // fires promptly, not delayed to Sunday) -- only subsequent daily runs after that point
  // throttle. The `armedN >= nAtLastCheck` guard (DeepSeek design-critique, 2026-08-17)
  // catches the one real edge case: if a same-day repair/exclusion change pushed fresh N
  // back below the floor, do NOT suppress the write that would record the THIN_N reversion.
  // Placed HERE (right before the write), not earlier -- DeepSeek's code-review caught that
  // an earlier placement would have skipped the full computation/verdict/rigor entirely on a
  // throttled day, contradicting this very comment's promise that only the WRITE is skipped.
  // Only the performance_audit INSERT + flagDecision calls below are skipped -- everything
  // above (armedN, meanDelta, verdict, rigor, and the verdict line just logged) already ran
  // and printed, every day, regardless of throttle state.
  if (dailyCheckMode && nAtLastCheck >= MIN_N && armedN >= nAtLastCheck) {
    console.log(`Throttled (--daily-check): N=${nAtLastCheck} at last check, N=${armedN} now -- already cleared the floor, deferring to weekly cadence (scripts/run_weekly_backtests.sh). Not persisting/flagging today.`);
    return;
  }

  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, total_pnl, recommendation, notes)
    VALUES ($1, 0, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
      SET sample_size=EXCLUDED.sample_size, win_rate=EXCLUDED.win_rate, ev_per_trade=EXCLUDED.ev_per_trade,
          total_pnl=EXCLUDED.total_pnl, recommendation=EXCLUDED.recommendation, notes=EXCLUDED.notes
  `, [today, SIGNAL_TYPE, SIGNAL_NAME, armedN, winRateVsFixed, meanDelta, deltas.reduce((a, b) => a + b, 0), verdict, JSON.stringify(notes)]);

  console.log(`Persisted to performance_audit (${SIGNAL_TYPE}/${SIGNAL_NAME}).`);

  // Flag a human decision only on a genuine verdict TRANSITION -- comparing against the
  // prior run's own stored recommendation is sufficient (and correct even across a
  // resolved-then-reopened OPEN_DECISION, per DeepSeek's review); no listDecisions() call.
  const priorVerdict = prior?.recommendation ?? null;
  if (verdict === 'REPRODUCED' && priorVerdict !== 'REPRODUCED') {
    await flagDecision({
      slug: 'wider_target_live_recheck_cleared_promotion_consideration',
      priority: 'MEDIUM',
      sourceFile: 'scripts/audit_wider_target_live.mjs',
      decisionText: `The SHADOW-only wider-target mechanism's REAL, live-fired outcomes now reproduce its backtested positive delta: N=${armedN} armed trades, mean delta=$${meanDelta?.toFixed(2)}/trade vs. the fixed-T1 counterfactual, computeRigor clean (stable=${rigor.stable}, not day-clustered, top5DayPct=${rigor.top5DayPct}%). This is the live confirmation the original backtest (RESEARCH_CLAIM ${RECHECK_OF}) needed before any promotion could be considered. Consider building the ACTIVE-row wiring (a real-capital code change, NOT done automatically by this script or any other) -- this decision only surfaces the option, it does not act on it.`,
    });
    console.log('Flagged wider_target_live_recheck_cleared_promotion_consideration (transition into REPRODUCED).');
  } else if (verdict === 'CONTRADICTED' && priorVerdict !== 'CONTRADICTED') {
    await flagDecision({
      slug: 'wider_target_live_recheck_contradicted',
      priority: 'MEDIUM',
      sourceFile: 'scripts/audit_wider_target_live.mjs',
      decisionText: `The SHADOW-only wider-target mechanism's REAL, live-fired outcomes now CONTRADICT its backtested positive delta: N=${armedN} armed trades, mean delta=$${meanDelta?.toFixed(2)}/trade vs. the fixed-T1 counterfactual (<=0, wrong direction). MEDIUM priority not HIGH -- this is zero-capital SHADOW tracking, nothing real is at risk, so urgency is low. Consider removing the wider_target_mult flag from the 4 insert sites (server/routes/acd.js) if this persists across further rechecks.`,
    });
    console.log('Flagged wider_target_live_recheck_contradicted (transition into CONTRADICTED).');
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
