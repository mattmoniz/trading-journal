// SHADOW-only tagging for the 65pt-rotation-direction gate (RESEARCH_CLAIM roster_65pt_
// rotation_direction_gate_20261008, user-originated idea, 2026-10-08). Reuses the EXACT
// live detection function (detectSignalEvents(), server/services/pocRotationService.js --
// the same one POC_ROTATION_JOIN itself uses) and the same session/theta helpers
// POC_ROTATION_JOIN's own live detector uses (currentSessionDate()/getTheta(), exported
// from pocRotationJoinDetector.js specifically so this file doesn't reimplement them --
// "export the real function" rule) -- per this codebase's own standing discipline.
//
// CORRECTED METHODOLOGY (do not regress this): the first backtest pass of this idea
// measured "the most recently ENDED 65pt leg," which DeepSeek's design review caught as
// NOT what a live poller would compute (a stateless live call only ever sees bars up to
// "now," so the leg it reads is whichever one is CURRENTLY IN PROGRESS, not the one that
// just confirmed -- and because leg directions strictly alternate by construction, those
// two readings disagree 97.4% of the time). This function deliberately truncates bars to
// "up to now" before calling detectSignalEvents(), so the LAST entry in all_leg_records is
// always the live, in-progress leg -- the same quantity verified in
// scratch/poc_65pt_gate_current_leg_verify_20261008.mjs (AGREE WR=64.3%/mean=+$37.61,
// DISAGREE WR=28.5%/mean=-$29.40, both RTH and Globex independently, n=5,474, 2025-06-01
// to present) and RTH/Globex-checked in
// scratch/poc_65pt_gate_rth_globex_scoped_20261008.mjs (holds in both sessions, no
// reversal -- RTH stronger (71.4%/28.6% WR) than Globex (50.8%/29.5% WR), but same
// direction in both). Cross-checked against the existing live momentum_against_fade_shadow
// tag (scratch/poc_65pt_gate_momfade_overlap_20261008.mjs) and found genuinely
// incremental, not redundant (only 57.7% overlap; this gate separates outcomes cleanly
// within both of MomFade's own buckets).
//
// SHADOW-ONLY / OBSERVATION-ONLY, same posture as tagMomentumAgainstFadeShadow()/
// tagDirectionGateShadow(): never changes a real candidate's ACTIVE/SHADOW eligibility or
// touches a real trade's resolution/actual_pnl. Keyed by the row's own `id` via a
// follow-up UPDATE, not threaded through the INSERT's own positional params.
import { query } from '../db.js';
import { detectSignalEvents } from './pocRotationService.js';
import { getTheta, currentSessionDate } from './pocRotationJoinDetector.js';

/** Computes the CURRENT (in-progress, live) 65pt rotation leg direction as of right now --
 * 'UP' | 'DOWN' | null (no leg has formed yet this session, or during the 5-6PM gap). */
export async function getCurrentRotationDirection() {
  try {
    const nowEtRow = await query(`SELECT (NOW() AT TIME ZONE 'America/New_York')::text as now_et`);
    const nowEt = new Date(nowEtRow.rows[0].now_et.replace(' ', 'T') + 'Z');
    const sessionDate = currentSessionDate(nowEt);
    if (!sessionDate) return null; // 5-6PM maintenance gap

    const barsQ = await query(`
      SELECT ts::text as ts, open::float, high::float, low::float, close::float, volume::float as volume
      FROM price_bars_primary WHERE symbol='NQ' AND (
        (ts::date = $1::date - 1 AND EXTRACT(hour FROM ts) >= 18) OR
        (ts::date = $1::date AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) < 1020)
      ) AND ts <= $2
      ORDER BY ts ASC
    `, [sessionDate, nowEtRow.rows[0].now_et]);
    const bars = barsQ.rows;
    if (bars.length < 40) return null; // matches pocRotationJoinDetector.js's own MIN_SESSION_BARS floor

    const theta = await getTheta();
    const { all_leg_records } = detectSignalEvents(65, 'standard', theta, [{ t: sessionDate, bars }], 'fixed');
    if (!all_leg_records.length) return null;
    const lastLeg = all_leg_records[all_leg_records.length - 1];
    return lastLeg.direction || null;
  } catch (_) {
    return null; // fail closed -- never guess, never block the candidate this is tagging
  }
}

/** Tags a real (ACTIVE/SHADOW) row, right after insert, with whether its own direction
 * agrees with the current live 65pt rotation direction. SHADOW-ONLY -- see file header. */
export async function tagRotation65ptGateShadow(insertedId, direction) {
  if (!insertedId || !direction) return;
  try {
    const rotationDir = await getCurrentRotationDirection();
    if (rotationDir == null) return; // no leg formed yet, or maintenance gap -- don't guess
    const tradeIsLong = direction === 'LONG';
    const agree = (rotationDir === 'UP') === tradeIsLong;
    await query(
      `UPDATE active_setups SET rotation_65pt_gate_shadow = $1 WHERE id = $2`,
      [JSON.stringify({ rotationDirection: rotationDir, tradeDirection: direction, agree, checkedAt: new Date().toISOString() }), insertedId]
    );
  } catch (_) { /* observation-only -- never let a tagging failure surface anywhere */ }
}
