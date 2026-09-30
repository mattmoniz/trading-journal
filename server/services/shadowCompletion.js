// Shadow-completion follow-up passes for the step-trail and pitch-catch observational
// mechanisms. Extracted from server/routes/acd.js 2026-09-05 (DeepSeek-planned extraction,
// Candidate B -- see docs/OPEN_THREADS.md's 2026-09-05 entry and OPEN_DECISION
// acdjs_deferred_cleanup_from_deepseek_audit_20260905). Pure relocation, behavior-identical --
// verified line-for-line before moving. Both are called together, right after
// resolveSetupsByPrice(), on every setup-detection poll (server/routes/acd.js).

import { query } from '../db.js';
import { LIVE_INSTRUMENT } from '../config/instruments.js';
import { resolveDirection } from '../config/setupTypes.js';
import { firedAtToMod } from './sessionBoundary.js';
import { stepWiderTarget, MAX_BARS_TO_T1_FOR_WIDER, WIDER_TARGET_MULT } from './widerTargetWalker.js';
import { stepStepTrail } from './stepTrailWalker.js';
import { stepT1FloorRunner, t1FloorPnlFromResolution } from './t1FloorRunnerWalker.js';
import { getGlobalCalib, getCached, DAY_CACHE_TTL } from './acdShared.js';

// Step-trail shadow follow-up pass (Opus Audit #12, 2026-09-04). resolveSetupsByPrice()'s
// inline step-trail computation (the widerTargetMult branch above) can only ever see bars
// through "now" at the moment the REAL wider-target mechanism resolves — and the instant it
// does, this row's `status` flips to 'RESOLVED' and it drops out of resolveSetupsByPrice()'s
// own `active` query forever, so there is no way for that same function to keep walking it on
// a later poll. This is the deliberate second half of that design: a small, separate query
// scoped only to rows whose real path already went all the way through the widerTarget branch
// (proven by resolution_method) but whose shadow never got the chance to finish, re-deriving
// the ENTIRE shadow walk from scratch (fired_at -> now, same stateless-every-poll convention as
// resolveSetupsByPrice() itself) with a NOW that keeps growing on each call — exactly mirroring
// how the real mechanism itself gets re-walked from scratch every poll while still open. Never
// touches status/resolution/actual_pnl/stop_level — the real trade is already finished and
// stays untouched; this only ever writes step_trail_shadow once it resolves.
export async function completeStepTrailShadows() {
  const pending = await query(`
    SELECT id, setup_type, trade_date::text as trade_date, fired_at::text as fired_at,
           entry_zone_low::float as entry_zone_low, entry_zone_high::float as entry_zone_high,
           stop_level::float as stop_level, t1_level::float as t1_level,
           wider_target_mult::float as wider_target_mult, actual_pnl::float as actual_pnl
    FROM active_setups
    WHERE status='RESOLVED' AND wider_target_mult IS NOT NULL
      AND resolution_method IN ('WIDER_TARGET_HIT', 'WIDER_STOP_HIT', 'WIDER_TIME_EXPIRED')
      AND step_trail_shadow IS NULL
  `);
  if (!pending.rows.length) return 0;

  const stepTrailCalib = await getGlobalCalib('stepTrailCalib', async () => {
    const r = await query(`SELECT notes FROM performance_audit WHERE signal_type='STEP_TRAIL_FRACTION' AND signal_name='FRACTION' ORDER BY run_date DESC LIMIT 1`);
    let val = null;
    try { if (r.rows[0]) { const n = JSON.parse(r.rows[0].notes); if (n.frac != null && n.p10BaseFloor != null) val = { frac: n.frac, p10BaseFloor: n.p10BaseFloor }; } } catch (_) {}
    return val;
  });
  if (stepTrailCalib == null) return 0; // no calibration -- nothing to complete, fail closed

  const widerTargetPressureThreshold = await getGlobalCalib('widerTargetPressureThreshold', async () => {
    const r = await query(`SELECT notes FROM performance_audit WHERE signal_type='WIDER_TARGET_PRESSURE_GATE' AND signal_name='THRESHOLD' ORDER BY run_date DESC LIMIT 1`);
    let val = null;
    try { val = r.rows[0] ? JSON.parse(r.rows[0].notes).threshold : null; } catch (_) {}
    return val;
  });

  let completed = 0;
  for (const row of pending.rows) {
   try {
    const dir = resolveDirection(row);
    if (dir === null) continue;
    const long = dir === 'LONG';
    const entry = row.entry_zone_high ?? row.entry_zone_low;
    const stop = row.stop_level, t1 = row.t1_level;
    if (entry == null || stop == null || t1 == null) continue;
    const firedMod = firedAtToMod(row.fired_at);

    const barsRes = await query(`
      SELECT ts::text as ts, high::float, low::float, close::float, bid_volume, ask_volume,
        (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as mod
      FROM price_bars_primary WHERE symbol='NQ' AND ts > $1 ORDER BY ts ASC
    `, [row.fired_at]);
    if (!barsRes.rows.length) continue;

    const widerTarget = long ? entry + Math.abs(t1 - entry) * row.wider_target_mult : entry - Math.abs(t1 - entry) * row.wider_target_mult;
    const riskDist = Math.abs(widerTarget - entry);
    const effectiveBase = Math.max(riskDist, stepTrailCalib.p10BaseFloor);
    const stepSize = stepTrailCalib.frac * effectiveBase;

    let widerTargetState = { widening: false };
    let shadowState = { inner: { widening: false }, ratcheting: false, currentStop: null, highestMfe: null };
    let shadowResolution = null, shadowArmedAt = null;
    let barCount = 0;
    for (const bar of barsRes.rows) {
      barCount++;
      const barTotalVol = (bar.bid_volume || 0) + (bar.ask_volume || 0);
      const pressureReading = barTotalVol > 0
        ? ((long ? bar.ask_volume : bar.bid_volume) - (long ? bar.bid_volume : bar.ask_volume)) / barTotalVol
        : null;
      const step = stepWiderTarget(widerTargetState, bar, {
        entry, stop, t1, widerTarget, long, barCount, maxBarsToT1: MAX_BARS_TO_T1_FOR_WIDER, firedMod,
        pressureReading, pressureThreshold: widerTargetPressureThreshold,
      });
      widerTargetState = step.state;

      const shadowStep = stepStepTrail(shadowState, bar, {
        entry, stop, t1, widerTarget, long, barCount, maxBarsToT1: MAX_BARS_TO_T1_FOR_WIDER, firedMod,
        pressureReading, pressureThreshold: widerTargetPressureThreshold, stepSize,
      });
      shadowState = shadowStep.state;
      if (shadowState.ratcheting && shadowArmedAt == null) shadowArmedAt = bar.ts;
      if (shadowStep.resolution) { shadowResolution = { ...shadowStep.resolution, resolvedAt: bar.ts }; break; }
    }
    if (!shadowResolution) continue; // still not resolved -- retry again next poll

    const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
    const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
    const shadowPts = long ? shadowResolution.priceAtRes - entry : entry - shadowResolution.priceAtRes;
    const shadowPnl = shadowPts * PNL_PER_POINT - COMMISSION;
    const payload = JSON.stringify({
      frac: stepTrailCalib.frac, armed_at: shadowArmedAt,
      hypothetical_resolution: shadowResolution.resolution, hypothetical_method: shadowResolution.method,
      hypothetical_exit_price: shadowResolution.priceAtRes, hypothetical_pnl: Math.round(shadowPnl * 100) / 100,
      real_pnl: row.actual_pnl, delta: Math.round((shadowPnl - row.actual_pnl) * 100) / 100,
      resolved_at: shadowResolution.resolvedAt, completed_inline: false,
    });
    await query(`UPDATE active_setups SET step_trail_shadow=$2::jsonb, updated_at=NOW() WHERE id=$1 AND step_trail_shadow IS NULL`, [row.id, payload]);
    completed++;
   } catch (e) {
     // Per-row isolation -- this whole function is already isolated from the real trade
     // path (separate function, separate .catch(() => {}) at its call site), but one bad
     // row's error must not stop the rest of this poll's batch from being attempted too.
     console.error(`completeStepTrailShadows row id=${row.id} error (non-critical, retrying next poll):`, e.message);
   }
  }
  return completed;
}

// completePitchCatchShadows() REMOVED 2026-09-29 (DeepSeek design-critique audit: 0/213 real
// qualifying rate after 3+ weeks live, plus a structurally degenerate calibration loop -- see
// server/services/resolveSetups.js's pitchCatchCalib comment for the full account). Historical
// pitch_catch_shadow rows are left alone; nothing writes to that column anymore.

// T1-floor runner shadow follow-up pass (2026-09-25, PROVISIONAL -- RESEARCH_CLAIM
// t1floor_runner_positive_slow_population_20260925). Same structural need as the two passes
// above (resolveSetupsByPrice()'s inline attempt can only see bars through "now" at the moment
// the REAL trade resolves, and the row then drops out of its own `active` query forever) --
// but scoped DIFFERENTLY: this mechanism applies to the PLAIN PRICE_CLEAN path (the "slow"
// majority the wider-target mechanism's fast+pressure gate never sees at all), not to trades
// that armed wider_target_mult. No arming phase to re-derive -- the runner starts the instant
// the real trade resolves, so this walk is simpler than the other two (a single
// stepT1FloorRunner call per bar, no composed inner widerTargetState).
export async function completeT1FloorRunnerShadows() {
  // FIXED 2026-09-25 (DeepSeek code review, before this mechanism's forward data had a chance to
  // accumulate any real rows -- caught same day it shipped): the WHERE below now mirrors the
  // INLINE gate's eligibility exactly (resolveSetups.js's generic terminal branch is only
  // reached when wider_target_mult/runner_trail_width/extend_target_level are all null, and
  // ABSORPTION_LONG's own snapshot branch -- resolved_at=NOW(), not a bar-walk touch -- never
  // reaches that branch at all). Without this, the completion pass silently picked up
  // wider-target-eligible-but-too-slow-to-arm rows and ABSORPTION_LONG snapshot rows the inline
  // shadow correctly excludes -- a different, broader population than what was backtested.
  const pending = await query(`
    SELECT id, trade_date::text as trade_date, fired_at::text as fired_at, resolved_at::text as resolved_at,
           entry_zone_low::float as entry_zone_low, entry_zone_high::float as entry_zone_high,
           t1_level::float as t1_level, actual_pnl::float as actual_pnl
    FROM active_setups
    WHERE status='RESOLVED' AND resolution='TARGET_HIT' AND resolution_method='PRICE_CLEAN'
      AND wider_target_mult IS NULL AND runner_trail_width IS NULL AND extend_target_level IS NULL
      AND setup_type <> 'ABSORPTION_LONG'
      AND resolved_at IS NOT NULL
      AND t1_floor_runner_shadow IS NULL
  `);
  if (!pending.rows.length) return 0;

  let completed = 0;
  for (const row of pending.rows) {
   try {
    const dir = resolveDirection(row);
    if (dir === null) continue;
    const long = dir === 'LONG';
    const entry = row.entry_zone_high ?? row.entry_zone_low;
    const t1 = row.t1_level;
    if (entry == null || t1 == null) continue;
    const firedMod = firedAtToMod(row.fired_at);
    const ft = long ? entry + WIDER_TARGET_MULT * Math.abs(t1 - entry) : entry - WIDER_TARGET_MULT * Math.abs(t1 - entry);

    // FIXED 2026-09-25 (DeepSeek code review, CRITICAL): was `ts > row.fired_at` -- stepT1FloorRunner
    // has NO arming phase (it assumes T1 is ALREADY banked the instant it starts walking), so
    // feeding it bars from fired_at (near entry, well before t1) made its own floorHit check
    // (bar.low <= t1 for a long) fire almost immediately on bar 1, resolving nearly every row as
    // T1_FLOOR_HIT/delta≈0 without ever actually walking the runner. Must start strictly after the
    // real T1-touch bar (resolved_at), matching the inline path's own bars.rows.slice(barCount)
    // exactly -- resolved_at IS the touch bar's own bar.ts for this population (the generic
    // branch writes resolvedAt=bar.ts), so `ts > resolved_at` is the correct equivalent.
    const barsRes = await query(`
      SELECT ts::text as ts, high::float, low::float, close::float,
        (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as mod
      FROM price_bars_primary WHERE symbol='NQ' AND ts > $1 ORDER BY ts ASC
    `, [row.resolved_at]);
    if (!barsRes.rows.length) continue;

    let floorState = {};
    let shadowResolution = null;
    for (const bar of barsRes.rows) {
      const step = stepT1FloorRunner(floorState, bar, { t1, ft, long, firedMod });
      floorState = step.state;
      if (step.resolution) { shadowResolution = { ...step.resolution, resolvedAt: bar.ts }; break; }
    }
    if (!shadowResolution) continue; // still not resolved -- retry again next poll

    const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
    const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
    const hypotheticalPnl = t1FloorPnlFromResolution(shadowResolution, { entry, t1, long, dollarsPerPoint: PNL_PER_POINT, commission: COMMISSION });
    const payload = JSON.stringify({
      target_mult: WIDER_TARGET_MULT,
      hypothetical_resolution: shadowResolution.resolution, hypothetical_method: shadowResolution.method,
      hypothetical_exit_price: shadowResolution.priceAtRes, hypothetical_pnl: Math.round(hypotheticalPnl * 100) / 100,
      real_pnl: row.actual_pnl, delta: Math.round((hypotheticalPnl - row.actual_pnl) * 100) / 100,
      resolved_at: shadowResolution.resolvedAt, completed_inline: false,
    });
    await query(`UPDATE active_setups SET t1_floor_runner_shadow=$2::jsonb, updated_at=NOW() WHERE id=$1 AND t1_floor_runner_shadow IS NULL`, [row.id, payload]);
    completed++;
   } catch (e) {
     console.error(`completeT1FloorRunnerShadows row id=${row.id} error (non-critical, retrying next poll):`, e.message);
   }
  }
  return completed;
}
