// Shadow-candidate persister, extracted from server/routes/acd.js runSetupDetection (Fable audit F32 step, 2026-11-11; the F06 fix of the same day made it a named function first).
// Persists every RTH shadow candidate of a poll as an active_setups row (SHADOW, or ACTIVE when live-eligible and every gate passes), with fire tags, regime stamp, cluster roles and the
// SHADOW_CAUSE trace. `forceShadow` (the no-ACTIVE-candidate path) writes SHADOW only and can never create a live order. The body is a verbatim move: every free variable of the original closure
// arrives through `ctx` (the poll's own values) or an import of the module acd.js already imported it from. Verified decision-identical by the golden replay (scripts/replay/).
import { query } from '../db.js';
import { CONDITIONAL_VARIANTS, getBetClass } from '../config/setupTypes.js';
import { FIRE_TAG_COLS, computeFireTags, fireTagValues, minutesFromSessionOpen } from './fireTags.js';
import { REFIRE_COOLDOWN_MINUTES, getSessionBarsSinceOpen, isCrossDirectionFastFlip, isInRefireCooldown, isOppositeDirectionOpen, isPostWinOppositeFamilyBlocked, isRotationDirectionConflict, isSameSetupRefireBlocked, postWinFamilyOf, tagDirectionGateShadow, tagMomentumAgainstFadeShadow } from './acdRiskGates.js';
import { REGIME_STAMP_COLS, computeLiveVolumeBuildingSignal, computeRegimeStamp, getVaOverlapStreak, getValueAreaRegimeMap, regimeStampValues } from './acdLiveCalibration.js';
import { WIDER_TARGET_MULT } from './widerTargetWalker.js';
import { claimClusterRole, isBreakevenStopEligible, isInNewEntryDeadZone, isInRthOpenDeadZone, tagClusterBatch } from './acdShared.js';
import { isInMlVetoGateWindow, persistGateVerdict, scoreMlVetoGate } from './mlLiveVetoGate.js';
import { isLiveEligible, isLiveTimeWindowBlocked } from './setupEligibility.js';
import { isOpeningDriveCounterTrade } from './openingDriveGate.js';
import { logGatedCandidate } from './acdCandidateBuilder.js';
import { tagEntryOrderFlowShadow } from './entryOrderFlowShadow.js';
import { tagRotation65ptGateShadow } from './rotation65ptGateShadow.js';
import { tagTouchOrderflowPressureShadow } from './touchOrderflowPressureShadow.js';

export async function persistShadowCandidates(ctx, { forceShadow = false } = {}) {
  const { todayET, firedAtTs, firedEtMin, etMin, liveStats, active, shadowCandidates, computeExpiry, STOP_SWEEP_PAUSED } = ctx;
          // Cluster tagging (2026-09-08, found via a same-day self-check on cluster-tagging
          // coverage, not the specific OR15/OR30_MID example that motivated it -- that one
          // turned out to be the early-touch-backfill path instead, see that fix's own comment).
          // This loop is the file's own-documented "5th active_setups INSERT" (see the
          // vol_building_signal comment a few lines below) and, like the other 2 real gaps found
          // the same day, never had any cluster-tagging at all. Multiple shadowCandidates entries
          // can legitimately share the exact same entry price within one poll -- most often two
          // different OR-length windows whose underlying high/low hadn't moved between them, so
          // their computed MID/HIGH/LOW levels are numerically identical. Uses the shared
          // tagClusterBatch() (server/services/acdShared.js) grouped by entry price, within THIS
          // poll's batch only -- same no-EV-ranking-available convention as the backfill loop.
          // Primary/sibling status is claimed via claimClusterRole() AFTER each row's own INSERT
          // actually succeeds (see acdShared.js's header comment on both functions for the
          // gated-out-position-0 bug this ordering fixes) -- not decided upfront from raw array
          // position, which is why this pre-loop step only produces per-key touchIds now.
          const shadowClusterTouchIds = tagClusterBatch(shadowCandidates, s => s?.entry ?? null);
          const shadowClusterAssigned = new Set();

          const vaMap = await getValueAreaRegimeMap(todayET).catch(() => ({}));
          const shadowFireTags = await computeFireTags(todayET, 'RTH', etMin);
          for (const shadow of shadowCandidates) {
            if (!shadow || shadow.type === active?.type) continue;
            const isLongS = shadow.direction === 'LONG';
            const riskOk = shadow.stop == null || (isLongS ? shadow.stop < shadow.entry : shadow.stop > shadow.entry);
            if (!riskOk) {
              logGatedCandidate({ tradeDate: todayET, setupType: shadow.type, gateName: 'RISK_CHECK_SHADOW', gateReason: `non-positive risk: stop ${shadow.stop} vs entry ${shadow.entry} (${shadow.direction})`, entry: shadow.entry, stop: shadow.stop, target: shadow.target });
              continue;
            }
            // Found 2026-08-19 (live "everything says expired" report): this loop -- where
            // IB_BEARISH/STOP_SWEEP_LONG/C_PAIRED_SHORT actually fire from in practice, not
            // the `active` slot above -- never checked REFIRE_COOLDOWN_MINUTES at all, so
            // that map was structurally dead for anything reaching active_setups via
            // shadowCandidates rather than winning the single `active` pick. Confirmed live:
            // IB_BEARISH/STOP_SWEEP_LONG/C_PAIRED_SHORT each fired 60+ times in the trailing
            // 7 days, ~93% TIME_EXPIRED, often one fresh row per ~15s-1min poll cycle with no
            // gap at all. See isInRefireCooldown()/REFIRE_COOLDOWN_MINUTES at module scope
            // (~line 192) for the full history.
            if (await isInRefireCooldown(todayET, shadow.type)) {
              logGatedCandidate({ tradeDate: todayET, setupType: shadow.type, gateName: 'REFIRE_COOLDOWN_SHADOW', gateReason: `resolved within the last ${REFIRE_COOLDOWN_MINUTES[shadow.type]}min`, entry: shadow.entry, stop: shadow.stop, target: shadow.target });
              continue;
            }
            // 4-6PM no-new-entries dead zone (2026-09-16, user request). CORRECTED 2026-09-25:
            // this comment used to claim this loop is "real-time" (unlike the early-touch-backfill
            // loop above) and so the outer/current inNewEntryDeadZone/inRthOpenDeadZone was the
            // correct flag -- that was wrong. The INSERT below (~line 7317) uses firedAtTs, the
            // exact same triggering-BAR timestamp the main active-slot path uses, not NOW() -- so
            // this loop has the identical staleness risk the main path had (see the firedEtMin
            // comment ~line 6700 for the full incident: a touch whose bar fell inside 9:30-9:35
            // could still slip through if the poll processing it ran a few minutes late). Switched
            // to firedEtMin-derived flags, matching the main active-slot fix.
            const shadowInNewEntryDeadZone = isInNewEntryDeadZone(firedEtMin);
            const shadowInRthOpenDeadZone = isInRthOpenDeadZone(firedEtMin);
            if (shadowInNewEntryDeadZone || shadowInRthOpenDeadZone) {
              logGatedCandidate({ tradeDate: todayET, setupType: shadow.type, gateName: 'POST_RTH_DEAD_ZONE_SHADOW', gateReason: shadowInRthOpenDeadZone ? '9:30-9:35 ET no-new-entries window' : '4-6PM ET no-new-entries window', entry: shadow.entry, stop: shadow.stop, target: shadow.target });
              continue;
            }
            let sT1 = shadow.target;
            if (sT1 != null && ((isLongS && sT1 <= shadow.entry) || (!isLongS && sT1 >= shadow.entry))) sT1 = null;
            // FIXED 2026-08-16 (promotion-pipeline structural fix, Layer 1/F3): shadowCandidates
            // used to hardcode 'SHADOW','SHADOW' with no promotion path (the "promoted after 30+
            // forward trades" comment was never implemented) -- see
            // docs/PROMOTION_PIPELINE_STRUCTURAL_FIX_SPEC.md. A type the SETUP_STATUS pipeline has
            // promoted to ACTIVE (not suppressed, not DOW-suppressed today, and has a real
            // SETUP_STATUS row at all -- isLiveEligible defaults to ineligible for an unknown
            // type, per the fail-open hole DeepSeek's QA caught same session) now fires live via
            // the same suppression sets (liveStats._suppressedSetups/_dowSuppressToday) the main
            // candidates path reads directly -- and, as of 2026-09-02 (base-eligibility divergence
            // fix, docs/UNIFIED_LIVE_GATE_CHECKPOINT_SPEC.md sequencing item 2), the main
            // candidates path ALSO calls isLiveEligible() now (was fail-open on an unknown type
            // via a raw `_suppressedSetups?.has()` read for over 2 weeks after this comment was
            // first corrected to say otherwise -- see that fix's own comment, ~line 10089, for the
            // full writeup). Both sites now share the same function, not just the same underlying
            // data. STOP_SWEEP_LONG/SHORT
            // stay SHADOW-only regardless (OPEN_DECISION stop_sweep_long_calibrated_target_pause_or_keep,
            // resolved to PAUSED 2026-08-05 pending target re-calibration; remove this exclusion
            // once unpaused). `?.` matches every other liveStats._suppressedSetups consumer in
            // this file -- defensive only, getCached always has a value here in practice (setCached
            // at ~6384 runs before this IIFE is ever constructed in the same request).
            const shadowIsLive = !forceShadow && !STOP_SWEEP_PAUSED.has(shadow.type)
              && isLiveEligible(shadow.type, {
                   suppressedSetups: liveStats?._suppressedSetups ?? new Set(),
                   dowSuppressToday: liveStats?._dowSuppressToday ?? new Set(),
                   knownTypes: liveStats?._knownSetupTypes ?? new Set(),
                 });
            // Cross-direction fast-flip gate (2026-09-02) -- see isCrossDirectionFastFlip()
            // header (~line 292). User-flagged live gap: this loop is where most level-fade
            // candidates that DON'T win the single `active` slot actually fire from, so a
            // same-family opposite-direction touch reaching here bypassed this gate entirely --
            // same structural shape as the sibling-reversal gap just below, fixed the same way.
            const shadowLevelBase = shadow.type.replace(/_(LONG|SHORT)$/, '');
            const shadowCrossDirectionCooldownMin = shadow.direction && await isCrossDirectionFastFlip(todayET, shadowLevelBase, shadow.direction);
            // Sibling-reversal gate (2026-09-02) -- see isPostWinOppositeFamilyBlocked() header
            // (~line 356). This loop (STOP_SWEEP/VWAP_MAGNET/C_PAIRED/C_REVERSAL/TRT/
            // BRACKET_BREAKOUT etc, per the comment at ~10256) was the headline coverage gap
            // DeepSeek's code review found in the initial (RTH-active-slot + Globex only) wiring
            // -- this is the one insert site that can actually fire ACTIVE from this loop.
            const shadowPostWinBlocked = !shadowCrossDirectionCooldownMin && shadow.direction && await isPostWinOppositeFamilyBlocked(todayET, postWinFamilyOf(shadow.type), shadow.direction);
            // Directional-conflict gate (2026-09-03) -- see isOppositeDirectionOpen() header
            // (~line 443). Fourth and last insert site wired (docs/SINGLE_FIRING_DIRECTIONAL_
            // CONFLICT_SPEC.md) -- this loop is where most level-fade candidates that don't win
            // the single `active` slot actually fire ACTIVE from (per the comment above), so it
            // needs the same coverage the other 3 sites already have. Short-circuited the same
            // way as the two checks just above.
            const shadowOppositeDirectionOpen = !shadowCrossDirectionCooldownMin && !shadowPostWinBlocked
              && shadow.direction && await isOppositeDirectionOpen(shadow.direction);
            // Same-type refire gate (2026-09-13) -- see isSameSetupRefireBlocked() header
            // (~line 367). Fourth insert site wired (Globex, STACK_VOL_BREAK_LIVE, RTH main are
            // the other 3) -- no direction required (unlike the 3 checks just above), same
            // short-circuit pattern.
            const shadowSameTypeRefireBlocked = !shadowCrossDirectionCooldownMin && !shadowPostWinBlocked && !shadowOppositeDirectionOpen
              && await isSameSetupRefireBlocked(todayET, shadow.type, 'RTH');
            // Opening-drive counter-trade gate (2026-09-25) -- see openingDriveGate.js header.
            // Only evaluated when this row would otherwise go ACTIVE (it can't change a SHADOW row).
            const shadowOpeningDriveCounter = shadowIsLive && !shadowCrossDirectionCooldownMin && !shadowPostWinBlocked && !shadowOppositeDirectionOpen && !shadowSameTypeRefireBlocked
              && shadow.direction && (await isOpeningDriveCounterTrade(shadow.direction)).blocked;
            // 65pt rotation-direction gate (2026-10-11) -- see isRotationDirectionConflict()
            // header (acdRiskGates.js). Fifth insert site wired (Globex, STACK_VOL_BREAK_LIVE,
            // RTH main, cluster-sibling are the other 4) -- this loop is where most level-fade
            // candidates that don't win the single `active` slot actually fire ACTIVE from, same
            // reasoning that drove every other gate's coverage here.
            const shadowRotationDirectionConflict = shadowIsLive && !shadowCrossDirectionCooldownMin && !shadowPostWinBlocked
              && !shadowOppositeDirectionOpen && !shadowSameTypeRefireBlocked && !shadowOpeningDriveCounter
              && shadow.direction && await isRotationDirectionConflict(shadow.direction, shadow.type);
            // FIXED 2026-09-25 (OPEN_DECISION live_time_window_blocked_etmin_staleness_20260925) --
            // same firedEtMin fix as the main active-slot site above; this loop's INSERT also
            // stamps fired_at from firedAtTs (the triggering bar's time), not NOW().
            const shadowLiveTimeWindowBlocked = isLiveTimeWindowBlocked(shadow.type, firedEtMin);
            // ML meta-labeling VETO gate (2026-09-29) -- see mlLiveVetoGate.js's header.
            // Fourth and last RTH insert site wired (Globex, STACK_VOL_BREAK_LIVE, RTH main
            // are the other 3). Same "only run if this would otherwise go ACTIVE, and only
            // inside the approved window" short-circuit as every other site. confluenceScore
            // is null here -- this loop has no equivalent of the main path's confluenceCount
            // (it processes one shadow candidate at a time, not a same-instant touch cluster).
            // minutesFromOpen uses etMin, not firedEtMin -- FIXED 2026-09-29 (DeepSeek RTH-wiring
            // review), same reasoning as the main active-slot site above: this loop's own
            // fireTags call a few lines below uses wall-clock etMin, so the gate must match that,
            // not the (also real, but different) bar-derived firedEtMin.
            let shadowMlGateResult = null;
            const shadowMlVetoBlocked = shadowIsLive && !shadowCrossDirectionCooldownMin && !shadowPostWinBlocked
              && !shadowOppositeDirectionOpen && !shadowSameTypeRefireBlocked && !shadowOpeningDriveCounter
              && !shadowRotationDirectionConflict
              && !shadowLiveTimeWindowBlocked && isInMlVetoGateWindow(firedEtMin)
              ? (shadowMlGateResult = await scoreMlVetoGate({
                  entry: shadow.entry, tradeDate: todayET, confluenceScore: null, isRth: true,
                  minutesFromOpen: minutesFromSessionOpen(etMin, 'RTH'),
                })).shadow
              : false;
            const st = (shadowIsLive && !shadowCrossDirectionCooldownMin && !shadowPostWinBlocked && !shadowOppositeDirectionOpen && !shadowSameTypeRefireBlocked && !shadowOpeningDriveCounter && !shadowRotationDirectionConflict && !shadowLiveTimeWindowBlocked && !shadowMlVetoBlocked) ? 'ACTIVE' : 'SHADOW';
            const regimeStamp = computeRegimeStamp(shadow.entry, vaMap);
            const shadowVaOverlapStreak = await getVaOverlapStreak(todayET).catch(() => null);
            // Volume-building signal (2026-08-29, informational only -- see touchQuality.js's
            // computeVolumeBuildingMeasures/classifyVolumeBuilding header comment). Found missing
            // from this insert site entirely (a 5th active_setups INSERT this file has, distinct
            // from the 4 wired 2026-08-28) while checking whether STOP_SWEEP -- which fires via
            // shadowCandidates, not the main candidates array -- was being tracked. It wasn't;
            // fixed here for every setup_type that fires through this loop (STOP_SWEEP_LONG/SHORT,
            // IB_BEARISH, C_PAIRED_SHORT, etc.), not just STOP_SWEEP specifically.
            const shadowVbSessionBars = await getSessionBarsSinceOpen(570);
            const shadowVolBuildingSignal = await computeLiveVolumeBuildingSignal(todayET, shadowVbSessionBars);
            const shadowIns = await query(`
              INSERT INTO active_setups (trade_date, setup_type, fired_at, expires_at,
                entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label,
                status, origin_status, ${REGIME_STAMP_COLS.join(', ')}, ${FIRE_TAG_COLS.join(', ')}, bet_class, wider_target_mult, vol_building_signal, va_overlap_streak,
                breakeven_stop_eligible)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10, ${REGIME_STAMP_COLS.map((_, i) => `$${11 + i}`).join(', ')},
                ${FIRE_TAG_COLS.map((_, i) => `$${11 + REGIME_STAMP_COLS.length + i}`).join(', ')},
                $${11 + REGIME_STAMP_COLS.length + FIRE_TAG_COLS.length}, $${11 + REGIME_STAMP_COLS.length + FIRE_TAG_COLS.length + 1},
                $${11 + REGIME_STAMP_COLS.length + FIRE_TAG_COLS.length + 2}, $${11 + REGIME_STAMP_COLS.length + FIRE_TAG_COLS.length + 3},
                $${11 + REGIME_STAMP_COLS.length + FIRE_TAG_COLS.length + 4})
              ON CONFLICT DO NOTHING
              RETURNING id
            `, [
              todayET, shadow.type, firedAtTs, computeExpiry(shadow.type),
              shadow.entry, shadow.entry, shadow.stop, sT1, shadow.targetLabel || null,
              st,
              ...regimeStampValues(regimeStamp),
              ...fireTagValues(shadowFireTags),
              getBetClass(shadow.type),
              // Wider-target-on-fast-resolving-trades (docs/OPEN_THREADS.md 2026-08-17,
              // WIRED LIVE TO ACTIVE 2026-08-24 -- see the twin site ~9091 for the full
              // decision rationale, same change applied here for consistency across both
              // real insert paths). ABSORPTION_LONG/COIL_SURGE mirror the resolver's own
              // needsBars exclusion (acd.js ~505) -- they have their own custom resolution
              // and never reach the wider-target branch, so tagging them would be dead
              // value. CONDITIONAL_VARIANTS[...]?.trailSignalName exclusion (added
              // 2026-08-18, C1) preserves the "no row sets more than one exit-mechanism
              // flag" invariant against trail variants.
              (shadow.type !== 'ABSORPTION_LONG' && !shadow.type.startsWith('COIL_SURGE')
                && CONDITIONAL_VARIANTS[shadow.type]?.trailSignalName == null) ? WIDER_TARGET_MULT : null,
              JSON.stringify(shadowVolBuildingSignal),
              shadowVaOverlapStreak,
              isBreakevenStopEligible(shadow.type),
            ]).catch(() => ({ rows: [] }));
            if (shadowIns.rows[0]) {
              // Cause for a SHADOW row (2026-10-19): this INSERT has no suppression_reason column, so a row gated here
              // was indistinguishable from "no reason" -- 190 such rows 10-09..10-16. Recorded in gated_candidates
              // (SHADOW_CAUSE), NOT in suppression_reason: calibration (EDGE_ATTRIBUTABLE_TRADE_FILTER) and the
              // recent-fire check near line 6469 treat a NULL reason as meaningful, so labeling the column would
              // silently change them. First matching reason only (labeling, never gating).
              if (st === 'SHADOW') {
                const shadowCause = forceShadow ? 'NO_ACTIVE_SLOT_PERSIST (F06: persisted from a poll with no ACTIVE candidate, forced SHADOW)' : STOP_SWEEP_PAUSED.has(shadow.type) ? 'STOP_SWEEP_PAUSED'
                  : !shadowIsLive ? 'NOT_LIVE_ELIGIBLE (setup_status suppress/thin/unknown/manual list)'
                  : shadowCrossDirectionCooldownMin ? `CROSS_DIRECTION_FAST_FLIP_${shadowCrossDirectionCooldownMin}min`
                  : shadowPostWinBlocked ? 'POST_WIN_OPP_FAMILY_REV'
                  : shadowOppositeDirectionOpen ? 'OPPOSITE_DIRECTION_OPEN'
                  : shadowSameTypeRefireBlocked ? 'SAME_TYPE_REFIRE'
                  : shadowOpeningDriveCounter ? 'OPENING_DRIVE_COUNTER_TRADE'
                  : shadowRotationDirectionConflict ? 'ROTATION_DIRECTION_CONFLICT'
                  : shadowLiveTimeWindowBlocked ? 'LIVE_TIME_WINDOW'
                  : shadowMlVetoBlocked ? (shadowMlGateResult?.reason || 'ML_VETO_GATE')
                  : 'UNKNOWN_SHOULD_NOT_HAPPEN';
                logGatedCandidate({ tradeDate: todayET, setupType: shadow.type, gateName: 'SHADOW_CAUSE',
                  gateReason: `setup_id=${shadowIns.rows[0].id} ${shadowCause}`, entry: shadow.entry, stop: shadow.stop, target: sT1 });
              }
              await tagDirectionGateShadow(shadowIns.rows[0].id, shadow.direction);
              await tagMomentumAgainstFadeShadow(shadowIns.rows[0].id, shadow.direction);
              await tagTouchOrderflowPressureShadow(shadowIns.rows[0].id, { direction: shadow.direction, firedAt: firedAtTs });
              await tagRotation65ptGateShadow(shadowIns.rows[0].id, shadow.direction);
              tagEntryOrderFlowShadow(shadowIns.rows[0].id, { direction: shadow.direction, setupType: shadow.type, entryPrice: shadow.entry }).catch(() => {}); // fire-and-forget -- see the first call site comment (line 1630) for why
              if (shadowMlGateResult) persistGateVerdict(shadowIns.rows[0].id, shadowMlGateResult).catch(() => {});
              // Cluster role claimed HERE, after the insert actually succeeded -- not before
              // gating -- so a candidate that got risk-checked/cooldown/eligibility-gated out
              // can never consume the primary slot for a group it was never actually written
              // into. See acdShared.js's claimClusterRole() header for the bug this ordering
              // fixes (found via code review 2026-09-08, same day as the rest of this fix).
              const shadowClusterKey = shadow.entry ?? null;
              const shadowTouchId = shadowClusterKey != null ? shadowClusterTouchIds.get(shadowClusterKey) : null;
              if (shadowTouchId) {
                const { isPrimary } = claimClusterRole(shadowClusterAssigned, shadowClusterKey);
                await query(
                  isPrimary
                    ? `UPDATE active_setups SET cluster_touch_id=$2 WHERE id=$1`
                    : `UPDATE active_setups SET is_cluster_primary=false, cluster_touch_id=$2 WHERE id=$1`,
                  [shadowIns.rows[0].id, shadowTouchId]
                ).catch(() => {});
              }
            }
          }
      }
