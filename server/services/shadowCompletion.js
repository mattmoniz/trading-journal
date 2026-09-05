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
import { stepWiderTarget, MAX_BARS_TO_T1_FOR_WIDER } from './widerTargetWalker.js';
import { stepStepTrail } from './stepTrailWalker.js';
import { stepPitchCatch } from './pitchCatchWalker.js';
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

// Pitch and Catch shadow follow-up pass -- exact same structural need and design as
// completeStepTrailShadows() just above (see its own header for the full explanation of why
// this second half is necessary given resolveSetupsByPrice()'s stateless-every-poll,
// drops-out-of-the-query-on-resolve architecture). UNVALIDATED mechanism (server/services/
// pitchCatchWalker.js), tracked at the user's explicit request, observation-only.
export async function completePitchCatchShadows() {
  const pending = await query(`
    SELECT id, setup_type, trade_date::text as trade_date, fired_at::text as fired_at,
           entry_zone_low::float as entry_zone_low, entry_zone_high::float as entry_zone_high,
           stop_level::float as stop_level, t1_level::float as t1_level,
           wider_target_mult::float as wider_target_mult, actual_pnl::float as actual_pnl
    FROM active_setups
    WHERE status='RESOLVED' AND wider_target_mult IS NOT NULL
      AND resolution_method IN ('WIDER_TARGET_HIT', 'WIDER_STOP_HIT', 'WIDER_TIME_EXPIRED')
      AND pitch_catch_shadow IS NULL
  `);
  if (!pending.rows.length) return 0;

  const pitchCatchCalib = await getGlobalCalib('pitchCatchCalib', async () => {
    const r = await query(`SELECT notes FROM performance_audit WHERE signal_type='PITCH_CATCH_FILTER' AND signal_name='FILTER' ORDER BY run_date DESC LIMIT 1`);
    let val = null;
    try {
      if (r.rows[0]) {
        const n = JSON.parse(r.rows[0].notes);
        if (n.rvolLo != null && n.rvolHi != null && n.minBarsToConfirm != null && n.adxThreshold != null) {
          val = { rvolLo: n.rvolLo, rvolHi: n.rvolHi, minBarsToConfirm: n.minBarsToConfirm, adxThreshold: n.adxThreshold };
        }
      }
    } catch (_) {}
    return val;
  });
  if (pitchCatchCalib == null) return 0; // no calibration -- nothing to complete, fail closed

  // Deliberately just a cache PEEK, not getGlobalCalib -- dailyAdxByDate is an expensive
  // full-history daily-bars query, already computed by resolveSetupsByPrice() earlier in
  // the SAME poll (server/index.js's poll ordering: resolveSetupsByPrice ->
  // completeStepTrailShadows -> completePitchCatchShadows), so re-fetching here would
  // duplicate that work every poll. `?? {}` is the correct null-check fix (was `!==
  // undefined ? cached : {}`, the same finding #0 bug -- but since `!== undefined` was
  // always true, it actually returned `null` on every miss, NEVER the `{}` fallback;
  // caught and corrected by an independent DeepSeek review pass 2026-09-05 after this
  // comment first shipped with the wrong claim). It was harmless anyway, but for a
  // DIFFERENT reason than "fell back to {} either way": `pitchCatchCalib == null) return
  // 0;` just above always fired too (same bug, its own reader), so the
  // `dailyAdxByDate[row.trade_date]` deref below -- which WOULD throw on a null
  // `dailyAdxByDate` -- was never reached. Two independent instances of the same bug
  // happened to cancel out; `?? {}` here removes the reliance on that coincidence going
  // forward.
  const dailyAdxByDate = getCached('_global', 'dailyAdxByDate', DAY_CACHE_TTL) ?? {};

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
    const dailyAdx = dailyAdxByDate[row.trade_date] ?? null;

    const barsRes = await query(`
      SELECT ts::text as ts, high::float, low::float, close::float, bid_volume, ask_volume,
        (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as mod
      FROM price_bars_primary WHERE symbol='NQ' AND ts > $1 ORDER BY ts ASC
    `, [row.fired_at]);
    if (!barsRes.rows.length) continue;

    const widerTarget = long ? entry + Math.abs(t1 - entry) * row.wider_target_mult : entry - Math.abs(t1 - entry) * row.wider_target_mult;

    let widerTargetState = { widening: false };
    let shadowState = {
      inner: { widening: false }, phase: 'ARMING', firstLegVolSum: 0, firstLegVolCount: 0,
      runningPeak: null, belowCount: 0, pullbackExtreme: null, settleBarVols: [], firstLegAvgVol: null, reentry: null,
    };
    let shadowResolution = null;
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

      const pcStep = stepPitchCatch(shadowState, bar, {
        entry, stop, t1, widerTarget, long, barCount, maxBarsToT1: MAX_BARS_TO_T1_FOR_WIDER, firedMod,
        pressureReading, pressureThreshold: widerTargetPressureThreshold, filterCalib: pitchCatchCalib, dailyAdx, origStop: stop,
      });
      shadowState = pcStep.state;
      if (pcStep.resolution) { shadowResolution = { ...pcStep.resolution, resolvedAt: bar.ts }; break; }
    }
    if (!shadowResolution) continue; // still not resolved -- retry again next poll

    const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
    const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
    let hypotheticalPnl = null;
    if (shadowResolution.qualified) {
      const pcPts = long ? shadowResolution.priceAtRes - shadowResolution.entryPrice : shadowResolution.entryPrice - shadowResolution.priceAtRes;
      hypotheticalPnl = Math.round((pcPts * PNL_PER_POINT - COMMISSION) * 100) / 100;
    }
    const payload = JSON.stringify({
      qualified: shadowResolution.qualified,
      hypothetical_resolution: shadowResolution.resolution, hypothetical_method: shadowResolution.method,
      hypothetical_exit_price: shadowResolution.priceAtRes, hypothetical_entry_price: shadowResolution.entryPrice ?? null,
      hypothetical_pnl: hypotheticalPnl, real_pnl: row.actual_pnl,
      delta: hypotheticalPnl != null ? Math.round((hypotheticalPnl - row.actual_pnl) * 100) / 100 : null,
      resolved_at: shadowResolution.resolvedAt, direction: long ? 'LONG' : 'SHORT', completed_inline: false,
    });
    await query(`UPDATE active_setups SET pitch_catch_shadow=$2::jsonb, updated_at=NOW() WHERE id=$1 AND pitch_catch_shadow IS NULL`, [row.id, payload]);
    completed++;
   } catch (e) {
     console.error(`completePitchCatchShadows row id=${row.id} error (non-critical, retrying next poll):`, e.message);
   }
  }
  return completed;
}
