// =============================================================================
// Compute per-setup-type optimal stops AND targets from active_setups MAE/MFE.
// Run weekly (Sunday) and daily (4:20 PM ET) after backfill_mae_mfe.
//
// Stop + Target: joint EV sweep, per setup_type (2026-07-13). Stop candidates = this
//   type's own MAE percentiles (p25/p40/p50/p60/p75/p90 — all data-derived, no fixed
//   point grid); target candidates = TARGET_SWEEP capped at p75_mfe. Picks whichever
//   (stop, target) pair maximizes:
//   EV = mean over trades of: -stop*2 if mae>stop; +target*2 if mfe>=target; else actual_pnl.
//
//   Previously stop was hardcoded to p75_mae with only target swept, and a separate
//   special-cased block re-swept stops for just IB_BULLISH/IB_BEARISH. A 2026-07-13 audit
//   found no setup-agnostic rule holds (p50_mae beats p75_mae for only 28/66 types with the
//   corrected formula, not 69/70 as an earlier flawed simulation claimed — that run wrongly
//   counted mae<=stop-but-mfe<target trades as automatic losses instead of actual_pnl) — so
//   every type now gets its own swept stop instead of a blanket rule or a type-specific carve-out.
//
//   First attempt at this swept the stop over a flat 20-150pt grid instead of percentiles.
//   That let several types (IB_BEARISH, BRACKET_BREAKOUT_LONG, C_STANDALONE_DOWN,
//   OPEN_TEST_DRIVE_SHORT) jump to stops near the 150pt ceiling — a stop that wide almost
//   never triggers, so it inflates in-sample EV without actually reducing risk (classic
//   overfitting to a finite sample). Caught before it stayed live, reverted, and replaced
//   with this percentile-anchored version: candidates are always tied to that type's real
//   MAE distribution shape, so the sweep can't wander to a value unrelated to the data.
//
// Writes signal_type='OPTIMAL_STOP' rows — one per setup_type direction.
// The live path reads these via liveStats._opt[setup_type].
// =============================================================================

import { query } from '../server/db.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { computeCorrectedTarget, makeBarIndex, WALK_WINDOW_BARS } from '../server/services/targetCalibrationService.js';

// Minimum N before we trust a computed optimal stop
const MIN_N = 20;
const DEFAULT_STOP = 65;
const DEFAULT_TARGET = 35;

// Circuit breaker (2026-08-04, shipped same-night per direct user/Opus instruction after
// GLOBEX_VWAP_FADE_LONG's live optimal_stop was found oscillating 83pt<->8pt across
// consecutive runs -- 8pt sits inside normal 1-min NQ bar noise, meaning that stop would
// get clipped on nearly every real trade. This is deliberately a PLAUSIBILITY GUARD, not
// a better calibration formula -- every attempt so far at computing a smarter fallback
// (the structural-conservative attempt tested and reverted the same day, see
// RESEARCH_CLAIM structural_conservative_fallback_worse_ev_reverted_20260804) has
// introduced its own new failure mode. This computes nothing: it just refuses to accept
// a new stop/target that moved too far, too fast, off too little new data, and keeps
// yesterday's number instead -- a strictly safer failure mode than silently shipping
// whatever the sweep produced.
//
// MAX_PCT_CHANGE reasoned (not swept/optimized -- this is a safety threshold, not a
// trading threshold) from the real spread observed the night this was built: genuinely
// stable, healthy types (FLOOR_R2_FADE_SHORT 38->42, PD_POC_FADE_LONG flat at 29 for
// weeks) moved single-digit percent run to run; the two confirmed-dangerous oscillations
// (GLOBEX_VWAP_FADE_LONG 83pt<->8pt, ~90%; PD_POC_FADE_SHORT 26pt<->40pt, ~54%) both blew
// well past 35%. Sits between the two with margin either way.
//
// TRIED deriving this from the real historical distribution instead (2026-08-04,
// same night, per direct question about the no-static-thresholds rule) -- deliberately
// NOT done, and the reason is itself worth recording so a future session doesn't repeat
// the attempt expecting a different answer. Computed day-over-day |Δstop%| across every
// OPTIMAL_STOP row in this table's full history: raw p90=87%, p95=139%. Restricted to
// transitions where BOTH endpoints sit above the real market noise floor (excluding the
// most obviously degenerate cases specifically) still gives p90=63%, p95=74%. Both are
// far too loose to serve as a breaker threshold -- they'd barely ever trip. Root cause:
// unlike the noise floor (check [13], anchored to real market bar-range data, external
// to this system's own calibration history), there is no clean external ground truth
// for "how much should a stop legitimately move run to run" -- the distribution to
// derive it FROM is this system's own OPTIMAL_STOP history, which is substantially
// populated by the exact argmax-instability pathology this breaker exists to prevent
// (see RESEARCH_CLAIM corrected_resim_guardrail_was_cleared_by_synthetic_data --
// most of this history was never real-data-validated to begin with). Deriving the
// threshold from contaminated history would be circular, not principled -- a reasoned,
// documented constant is the more honest choice here, the same way MIN_N=20 above is a
// reasoned floor, not something swept from a distribution.
//
// SECOND ATTEMPT (2026-08-04, same night, per direct follow-up question): normalize by
// realized market volatility instead of using the raw calibration history directly --
// "a legitimate stop change should track realized volatility" (external ground truth,
// same source check [13]'s noise floor already uses). Tested k = stop / trailing-30-day
// median 1-min NQ bar range (computed AS OF each historical run_date, not just today),
// then compared the distribution of day-over-day |Δk/k| against the raw |Δstop/stop|
// distribution above. Result: nearly IDENTICAL (p50 0.20->0.19, p90 0.87->0.86, p95
// 1.39->1.39 essentially unchanged) -- normalizing by volatility did not meaningfully
// separate legitimate from pathological changes. Root cause checked directly: NQ's
// trailing-30-day median bar range stayed in an 11.75-13pt band across this ENTIRE
// calibration history (2026-07-05 through today) -- there was no volatility regime
// shift within the window this data spans, so a vol-normalized measure and a raw
// point measure are nearly the same thing when the normalizer barely moves. The idea
// itself is sound and worth retrying once real calibration history spans a genuine
// vol regime change (a real basis to re-test would be: pick a period straddling a
// >=30% shift in the trailing-30d median bar range, then re-run this same comparison)
// -- it just has nothing to prove itself against yet in a ~1-month-old dataset.
const CIRCUIT_BREAKER_MAX_PCT_CHANGE = 0.35;
// MIN_DELTA_N: every dangerous swing found the same night was triggered by exactly ONE
// new resolved trade moving the argmax (GLOBEX_VWAP_FADE_LONG N 211->212,
// PD_POC_FADE_SHORT N 123->124, FLOOR_R3_FADE_SHORT N 28->29) -- an argmax steered by a
// single observation is the root cause the pct-change check alone can't fully address
// (it only catches it AFTER the fact). Require real growth since the last time a
// recalibration was actually accepted (tracked via notes.lastRecalibratedN, not just
// yesterday's stored N, so slow +1/day growth still eventually accumulates enough to
// re-check) before even attempting a new value.
function minDeltaNRequired(baselineN) {
  return Math.max(3, Math.ceil((baselineN || 0) * 0.05));
}
// Applies both gates to a freshly-computed (stop, target, ev) candidate against the prior
// stored row for the same setup_type. Returns { stop, target, ev, notes } -- notes always
// includes a circuitBreaker object recording what happened, even when nothing tripped,
// so the decision is inspectable without re-deriving it.
function applyCircuitBreaker({ setupType, currentN, attemptedStop, attemptedTarget, attemptedEv, prior, bypass = false }) {
  // One-time re-baseline escape hatch (2026-08-09, rawByType_origin_status_filter). Named
  // with the date deliberately so it can't be casually reused as a generic "skip the
  // breaker" flag later -- this run's whole point is that the population feeding every
  // candidate is changing (BACKFILL-contaminated -> real-only), which by design can and
  // should move many stops by more than 35% in one shot; the breaker's normal job (catch a
  // single new trade steering the argmax) doesn't apply to a deliberate population change.
  // Still fully logged and still updates lastRecalibratedN to the current real N, so every
  // NORMAL run after this one compares against today's fresh baseline, not the stale
  // pre-rebaseline one -- the breaker re-arms itself automatically the moment this flag is
  // gone, nothing to remember to undo.
  if (bypass) {
    console.error(`  [CIRCUIT BREAKER BYPASSED -- one-time 2026-08-09 re-baseline] ${setupType}: accepting attempted stop=${attemptedStop} target=${attemptedTarget} unconditionally (prior stop=${prior?.stop ?? 'none'} target=${prior?.target ?? 'none'})`);
    return { stop: attemptedStop, target: attemptedTarget, ev: attemptedEv,
      circuitBreaker: { tripped: false, reason: 'bypassed_for_rebaseline_20260809', attemptedStop, attemptedTarget, priorStop: prior?.stop ?? null, priorTarget: prior?.target ?? null, lastRecalibratedN: currentN } };
  }
  if (!prior || prior.stop == null || prior.target == null) {
    // No prior row (or a null prior stop/target) -- nothing to compare against yet, let
    // the natural pipeline output through and establish the first baseline.
    return { stop: attemptedStop, target: attemptedTarget, ev: attemptedEv,
      circuitBreaker: { tripped: false, reason: 'no_prior_baseline', lastRecalibratedN: currentN } };
  }
  const baselineN = prior.lastRecalibratedN != null ? prior.lastRecalibratedN : prior.sampleSize;
  const deltaN = baselineN != null ? currentN - baselineN : Infinity;
  const required = minDeltaNRequired(baselineN);
  if (deltaN < required) {
    return { stop: prior.stop, target: prior.target, ev: prior.ev,
      circuitBreaker: { tripped: false, reason: 'min_delta_n_not_met', baselineN, currentN, deltaN, minDeltaNRequired: required,
        attemptedStop, attemptedTarget, lastRecalibratedN: baselineN } };
  }
  const stopPctChange = prior.stop ? Math.abs(attemptedStop - prior.stop) / prior.stop : 0;
  const targetPctChange = prior.target ? Math.abs(attemptedTarget - prior.target) / prior.target : 0;
  if (stopPctChange > CIRCUIT_BREAKER_MAX_PCT_CHANGE || targetPctChange > CIRCUIT_BREAKER_MAX_PCT_CHANGE) {
    console.error(`  [CIRCUIT BREAKER TRIPPED] ${setupType}: attempted stop=${attemptedStop}(${(stopPctChange * 100).toFixed(0)}%) target=${attemptedTarget}(${(targetPctChange * 100).toFixed(0)}%) vs prior stop=${prior.stop} target=${prior.target} -- keeping prior, see test_invariants.mjs`);
    return { stop: prior.stop, target: prior.target, ev: prior.ev,
      circuitBreaker: { tripped: true, reason: 'pct_change_exceeded', maxPctChange: CIRCUIT_BREAKER_MAX_PCT_CHANGE,
        attemptedStop, attemptedTarget, attemptedEv, priorStop: prior.stop, priorTarget: prior.target,
        stopPctChange: +stopPctChange.toFixed(3), targetPctChange: +targetPctChange.toFixed(3), lastRecalibratedN: baselineN } };
  }
  return { stop: attemptedStop, target: attemptedTarget, ev: attemptedEv,
    circuitBreaker: { tripped: false, reason: 'accepted', baselineN, currentN, deltaN, lastRecalibratedN: currentN } };
}
// Fallback $/pt when a setup_type has too few resolved trades to derive its own real
// value (see the dppRes query below). CORRECTED 2026-07-17: this was hardcoded to 5,
// justified by a comment claiming "real $/pt is cleanly bimodal... ~$5 for the
// level-fade family" -- that claim was never actually true. Verified directly against
// every setup_type with N>=20 STOP_HIT trades (54 types checked): EVERY ONE resolves to
// $2.01-$2.06/pt, matching MNQ's real $2/pt exactly (the ~1-6 cent excess over $2.00 is
// just the $1 flat commission spread across each trade's point distance) -- there is no
// bimodal split, no level-fade-family exception. This is the FOURTH independent
// occurrence of the wrong-$/pt-constant class of bug documented in
// server/config/instruments.js's own header (backfill_level_fades.js, a frontend modal,
// TRT_LONG's trade-brief text, now this file) -- now fixed by importing the same
// canonical LIVE_INSTRUMENT constant instead of a fourth redeclared literal. Real,
// non-trivial blast radius: 25 currently-live setup_types had an OPTIMAL_STOP row
// computed using this wrong 2.5x-overstated fallback on at least one side (stop or
// target) before this fix -- their EV sweeps are being recomputed as part of this fix.
export const DEFAULT_DPP = LIVE_INSTRUMENT.dollarsPerPoint;

// Target sweep range (pts) — all setup types, not just IB. Always capped at p75_mfe
// per-type below, so it can't select a target beyond what the type's own MFE data supports.
const TARGET_SWEEP = [10, 15, 20, 25, 30, 35, 40, 50, 60, 70, 80, 90, 100, 120, 150];

// Run EV sweep for targets — finds T1 that maximizes expected value given a fixed stop.
// Simulates: if MAE > stop → -stop*stopDpp, elif MFE >= T → +T*targetDpp, else → actual_pnl
// (expired/partial).
//
// stopDpp/targetDpp: real dollars-per-point for this setup_type, derived from its own
// resolved trades (see the dppRes query below) — NOT a flat assumed constant. CORRECTED
// 2026-07-17: this comment previously claimed real $/pt was "cleanly bimodal (~$5 for
// the level-fade family, ~$2 for IB_BULLISH/BEARISH/OPEN_DRIVE/C_STANDALONE/etc.)",
// attributed to a Gemini mining pass "cross-checked by Claude against direct SQL" — that
// cross-check was wrong (or never actually run against fresh data). Directly re-verified
// 2026-07-17 against every setup_type with N>=20 STOP_HIT trades: all 54 types checked
// resolve to $2.01-$2.06/pt, no exceptions, no bimodal split. See DEFAULT_DPP's comment
// above for the full account — this was the same wrong-$/pt-constant bug class, just
// dressed up with a false verification claim instead of a naive hardcode.
//
// maxT caps the sweep at p75_mfe so we never select a target that >75% of trades can't reach.
// Without this cap, high T values saturate to actual_pnl and look artificially optimal.
//
// The canonical single-point EV formula -- exported so anything that needs to verify
// "is this stored ev_per_trade actually the EV of this stored stop/target" (e.g.
// test_invariants.mjs) can call the REAL production formula instead of hand-copying it.
// A second hand-copied formula would itself be exactly the same bug class this exists to
// prevent (see docs/OPEN_THREADS.md, 2026-07-17: ev_per_trade silently stopped matching
// optStop/optTarget for 8 days before anyone caught it) -- import this, don't reimplement it.
// commission defaults to the real MNQ round-trip commission (LIVE_INSTRUMENT) — added
// 2026-07-19 (OPEN_DECISION compute_ev_at_stop_target_missing_commission). The first two
// branches (synthetic stop-hit/target-hit at a CANDIDATE level) previously omitted
// commission entirely, while the third (actual_pnl, sourced from real active_setups rows
// resolved by the live engine) already included it correctly — an inconsistency, not a
// uniform bias, that understated cost specifically for trades reclassified under a
// candidate stop/target rather than kept at their own real exit. Optional trailing
// parameter (not a signature-breaking change) so all 11+ existing call sites across
// scripts/ get the fix automatically via the default, with zero call-site edits needed.
export function computeEvAtStopTarget(trades, stop, target, stopDpp = DEFAULT_DPP, targetDpp = DEFAULT_DPP, commission = LIVE_INSTRUMENT.commissionPerRoundTrip) {
  if (!trades.length) return null;
  let evSum = 0;
  for (const t of trades) {
    const mae = +t.mae_points, mfe = +t.mfe_points;
    if (mae > stop)         evSum += -stop * stopDpp - commission;
    else if (mfe >= target) evSum += target * targetDpp - commission;
    else                    evSum += +t.actual_pnl;
  }
  return evSum / trades.length;
}

// Returns { target, ev }, or null if fewer than MIN_N trades or no candidates ≤ maxT.
function sweepOptimalTarget(trades, stop, maxT = 150, stopDpp = DEFAULT_DPP, targetDpp = DEFAULT_DPP, commission = LIVE_INSTRUMENT.commissionPerRoundTrip) {
  if (trades.length < MIN_N) return null;
  const candidates = TARGET_SWEEP.filter(T => T <= maxT);
  if (candidates.length === 0) return null;
  let bestT = null, bestEV = -Infinity;
  for (const T of candidates) {
    const ev = computeEvAtStopTarget(trades, stop, T, stopDpp, targetDpp, commission);
    if (ev > bestEV) { bestEV = ev; bestT = T; }
  }
  return { target: bestT, ev: bestEV };
}

// Joint stop+target sweep. Corrected simulation (2026-07-13 audit): a trade where
// mae <= stop AND mfe < target never actually got stopped or hit target — it
// expired/partial — so it falls through to actual_pnl, NOT an automatic loss.
// (Prior Gemini analysis on 2026-07-10 miscounted that case as a loss, which
// wrongly favored tighter stops for 69/70 setups; re-derived directly against the
// DB with this fix, only 28/66 setups actually favor p50_mae over p75_mae — no
// blanket rule holds, so this must be swept per setup_type, not hardcoded.)
//
// Stop candidates are percentiles of THIS TYPE'S OWN mae_points distribution
// (p25/p40/p50/p60/p75, passed in from the caller's query as {value, pct} pairs) —
// not a fixed point grid. A flat grid let the sweep pick stops unrelated to the actual
// data (e.g. 150pt for a type whose real MAE tops out around p90≈100), which overfits:
// a stop that almost never triggers looks great on realized EV without reducing real
// risk. Percentile-anchoring keeps every candidate tied to that type's real
// distribution shape.
//
// Thin-tail gate (2026-07-14 audit): the EV sweep itself always uses all N trades to
// score a candidate stop, but the STOP VALUE at a high percentile (e.g. p75 of N=20)
// is only really informed by the ~N*(1-pct) trades whose mae falls in that tail — for
// p75 at N=20, that's ~5 trades defining where "p75" actually lands, an unstable
// estimate a single outlier can shift. Require the same MIN_N floor already used
// elsewhere in this file to apply to that tail count too, not just the type's total N
// — derived per-candidate as MIN_N/(1-pct), not a new hardcoded number.
export function sweepOptimalStopAndTarget(trades, maeCandidates, maxT, stopDpp, targetDpp, commission = LIVE_INSTRUMENT.commissionPerRoundTrip) {
  if (trades.length < MIN_N) return null;
  let best = null;
  for (const { value, pct } of maeCandidates) {
    const S = Math.round(value);
    const requiredN = Math.ceil(MIN_N / (1 - pct));
    if (trades.length < requiredN) continue; // tail too thin to trust this percentile's boundary
    const swept = sweepOptimalTarget(trades, S, maxT, stopDpp, targetDpp, commission);
    if (!swept) continue;
    if (!best || swept.ev > best.ev) best = { stop: S, target: swept.target, ev: swept.ev };
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// CHRONOLOGICAL (order-aware) sweep -- fixes the order-blindness bug above.
// Added 2026-08-05. computeEvAtStopTarget()/sweepOptimalStopAndTarget() above check
// `if (mae > stop) ... else if (mfe >= target)` against pre-aggregated mae_points/
// mfe_points, with no information about WHICH happened first -- a trade that dipped
// -40 then rallied +80 is indistinguishable from one that rallied +80 then dipped -40,
// but a real 30pt stop survives one and not the other. This systematically biases
// candidate selection toward WIDER stops (less likely to trip `mae > stop` at all).
// Confirmed via docs/DECISIONS_LOG.md 2026-08-05; design reviewed by DeepSeek before
// writing (see scratch/deepseek_response.md) -- this implementation follows its
// recommended approach: ONE bar walk per trade (not one per stop x target candidate --
// a naive per-candidate resolve() call would be ~75x more work per trade), reusing
// makeBarIndex() (targetCalibrationService.js, already used by computeCorrectedTarget's
// identical fired_at -> bar-index lookup) rather than reinventing timestamp flooring.
//
// Deliberately does NOT call scripts/backtest_unified.js's resolve() -- that function
// hardcodes PT=2/COMM=1 (its own file, lines 18-19), but this sweep needs per-setup_type
// empirically-derived stopDpp/targetDpp (see dppRes above). Instead this walks bars
// itself using the exact same conservative same-bar tie-break resolve() uses (stop wins
// if both trip on the same bar), so results stay comparable, without inheriting its
// flat $/pt constants.

// Precomputes, for ONE trade, the first bar (relative to entry) where cumulative MAE
// exceeds each stop candidate and where cumulative MFE reaches each target candidate.
// trade must have { barIdx (entry index into allBars), direction ('LONG'/'SHORT'), entry }.
// Returns null if the trade has no bars available at all (predates the bar history, or
// fired at/after the last available bar).
export function precomputeCrossovers(trade, allBars, stopCandidates, targetCandidates, maxBars = WALK_WINDOW_BARS) {
  const isLong = trade.direction === 'LONG';
  const entry = trade.entry;
  const endIdx = Math.min(allBars.length, trade.barIdx + maxBars);
  if (trade.barIdx >= endIdx) return null;

  const stopSorted = [...new Set(stopCandidates)].sort((a, b) => a - b);
  const targetSorted = [...new Set(targetCandidates)].sort((a, b) => a - b);
  const stopHitAt = {}, targetHitAt = {};
  let stopPtr = 0, targetPtr = 0;
  let mae = 0, mfe = 0;
  let lastClose = null;

  for (let i = trade.barIdx; i < endIdx; i++) {
    const b = allBars[i];
    const rel = i - trade.barIdx;
    const adverse = isLong ? entry - b.low : b.high - entry;
    const favorable = isLong ? b.high - entry : entry - b.low;
    if (adverse > mae) mae = adverse;
    if (favorable > mfe) mfe = favorable;
    // Conservative same-bar tie-break (matches backtest_unified.js's resolve()): if a bar
    // crosses BOTH a stop and target candidate for the first time on the same bar, the
    // stop-crossing loop below still runs first, so stopHitAt gets recorded -- the
    // comparator in computeEvAtStopTargetChronological then prefers stop on a tie.
    while (stopPtr < stopSorted.length && mae > stopSorted[stopPtr]) {
      stopHitAt[stopSorted[stopPtr]] = rel; stopPtr++;
    }
    while (targetPtr < targetSorted.length && mfe >= targetSorted[targetPtr]) {
      targetHitAt[targetSorted[targetPtr]] = rel; targetPtr++;
    }
    lastClose = b.close ?? b.high; // fallback if this bar shape has no close field
    // Guard added 2026-08-10: with BOTH candidate lists empty (the uncensoredMaeCandidates()
    // raw-excursion-only use case), stopPtr(0)>=stopSorted.length(0) is vacuously true on the
    // very first bar -- without this guard the walk would break after just 1 bar instead of
    // covering the full window, defeating the entire point of computing a genuinely uncensored
    // mae/mfe. Only allow the early-exit when there's at least one real candidate to satisfy.
    if (stopSorted.length + targetSorted.length > 0 && stopPtr >= stopSorted.length && targetPtr >= targetSorted.length) break;
  }
  // Mark-to-market at the walk's own cutoff for any candidate neither leg reached --
  // matches the live system's own TIME_EXPIRED convention (mark-to-market at the last
  // available bar, not a circular fallback to the trade's real actual_pnl under whatever
  // stop/target was actually live when it fired -- DeepSeek design review flagged the old
  // computeEvAtStopTarget()'s actual_pnl fallback as exactly this kind of circularity).
  const mtmPts = lastClose == null ? 0 : (isLong ? lastClose - entry : entry - lastClose);
  // mae/mfe here are the TRUE (uncensored) max adverse/favorable excursion over the full
  // maxBars window -- independent of stopCandidates/targetCandidates, computed on every bar
  // regardless of whether/when a candidate crossing was recorded. Returned (2026-08-10,
  // "uncensored MAE candidate grid" roadmap item) so a caller can use this same walk to build
  // an unbiased candidate GRID, not just evaluate EV for an already-chosen one -- see
  // uncensoredMaeCandidates() below for why the pre-computed mae_points column can't be used
  // for this (it's right-censored by whatever stop was live when each trade fired).
  return { stopHitAt, targetHitAt, mtmPts, mae, mfe };
}

// EV for ONE (stop, target) candidate pair against a precomputed crossover set. Returns
// dollars, or null if crossovers is null (trade had no usable bars).
export function computeEvAtStopTargetChronological(crossovers, stop, target, stopDpp, targetDpp, commission = LIVE_INSTRUMENT.commissionPerRoundTrip) {
  if (!crossovers) return null;
  const stopBar = crossovers.stopHitAt[stop];
  const targetBar = crossovers.targetHitAt[target];
  if (stopBar != null && (targetBar == null || stopBar <= targetBar)) {
    return -stop * stopDpp - commission;
  }
  if (targetBar != null) {
    return target * targetDpp - commission;
  }
  // Neither leg reached within the walk window -- self-contained mark-to-market, not the
  // old actual_pnl circularity.
  return crossovers.mtmPts * LIVE_INSTRUMENT.dollarsPerPoint - commission;
}

// Joint chronological stop+target sweep -- same candidate structure as
// sweepOptimalStopAndTarget() above, but genuinely order-aware. trades must already carry
// `barIdx`/`direction`/`entry` (attach via makeBarIndex() + inferDirection() before calling).
// Precomputes crossovers ONCE per trade (not once per candidate pair), per DeepSeek's design
// review -- for a 300-trade setup_type with ~75 (stop,target) pairs, this is 300 bar walks
// instead of 22,500.
export function sweepOptimalStopAndTargetChronological(trades, allBars, maeCandidates, maxT, stopDpp, targetDpp, commission = LIVE_INSTRUMENT.commissionPerRoundTrip) {
  if (trades.length < MIN_N) return null;
  const targetCandidates = TARGET_SWEEP.filter(T => T <= maxT);
  if (!targetCandidates.length) return null;
  const stopCandidates = maeCandidates.map(c => Math.round(c.value));

  const crossoversByTrade = trades.map(t => precomputeCrossovers(t, allBars, stopCandidates, targetCandidates));
  const usable = crossoversByTrade.filter(c => c != null).length;
  if (usable < MIN_N) return { insufficientBarData: true, usable, total: trades.length };

  let best = null;
  for (const { value, pct } of maeCandidates) {
    const S = Math.round(value);
    const requiredN = Math.ceil(MIN_N / (1 - pct));
    if (trades.length < requiredN) continue;
    for (const T of targetCandidates) {
      let evSum = 0, n = 0;
      for (const cx of crossoversByTrade) {
        const ev = computeEvAtStopTargetChronological(cx, S, T, stopDpp, targetDpp, commission);
        if (ev == null) continue;
        evSum += ev; n++;
      }
      if (n < MIN_N) continue;
      const ev = evSum / n;
      if (!best || ev > best.ev) best = { stop: S, target: T, ev, n };
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// Real-population helpers for the stop-side sweep (2026-08-09 re-baseline). Exported (not
// left as closures inside main()) specifically so test_invariants.mjs check [5] can import
// and call the SAME functions to re-derive an expected value, instead of hand-copying a
// second version of this logic -- exactly the "share modules" principle this codebase's own
// CLAUDE.md repeatedly documents being violated and fixed elsewhere. See
// computeStopTargetForType() below for the full decision tree these feed into.
export function percentileOf(sortedArr, p) {
  if (!sortedArr.length) return null;
  const idx = Math.min(sortedArr.length - 1, Math.floor(sortedArr.length * p));
  return sortedArr[idx];
}
// Noise-floor guard added AFTER a first dry-run of this exact re-baseline (2026-08-09)
// surfaced it live: 6 of 11 types that reached the chronological sweep landed at 1-13pt
// stops, comfortably inside normal single-bar noise. This is the EXACT "candidate finer
// than the data's own resolution" failure this codebase already has a named precedent for
// (CLAUDE.md's backtest_scaleout_runner.mjs trailing-stop-width incident, 2026-07-19) -- a
// real-N-cleared, statistically-legitimate-looking sweep can still pick a candidate the
// underlying 1-minute bar data structurally cannot resolve, since OHLC bars record a bar's
// high/low, not its intra-bar path. Filtering candidates below the floor here (not just
// checking the FINAL chosen stop after the fact, the way test_invariants.mjs check [13]
// does) stops the sweep from ever being able to choose one in the first place.
export function realMaeCandidates(trades, floor) {
  const maes = trades.map(t => t.mae_points).sort((a, b) => a - b);
  return [0.25, 0.40, 0.50, 0.60, 0.75]
    .map(pct => ({ value: percentileOf(maes, pct), pct }))
    .filter(c => c.value != null && c.value >= floor);
}
export function realP75Mfe(trades) {
  const mfes = trades.map(t => t.mfe_points).sort((a, b) => a - b);
  return percentileOf(mfes, 0.75);
}

// Uncensored MAE candidate grid (2026-08-10, roadmap "MAE candidate grid... breaks the
// self-referential loop" -- the last named structural defect in the measurement layer).
// realMaeCandidates() above builds its percentile grid from the stored mae_points column --
// but resolveSetupsByPrice()'s bar walk STOPS the moment a trade's ORIGINAL stop or target is
// hit, so mae_points is right-censored by whatever stop was actually live when that trade
// fired: a trade that stopped out at 26pt has mae_points=~26pt regardless of whether a wider
// 40pt candidate would have seen adverse excursion continue to 60pt or reverse back to
// profit -- the data to tell the difference was never recorded. Feeding this censored column
// into the candidate grid creates a feedback loop: the stop that was live when trades fired
// determines how far the candidate grid can even see, which anchors the NEXT calibration
// round near wherever the stop already sits rather than discovering a genuinely different one.
//
// Fixed by reusing precomputeCrossovers()'s own bar walk (same WALK_WINDOW_BARS window
// sweepOptimalStopAndTargetChronological()'s EV computation already uses, so candidate
// generation and candidate evaluation are drawn from the SAME uncensored source) with EMPTY
// candidate lists -- this makes it walk the full window purely to report each trade's true,
// uncensored max adverse excursion (mae), independent of when/whether the original stop or
// target actually fired. Percentiled the same way realMaeCandidates() already does (0.25/0.40/
// 0.50/0.60/0.75, same floor guard) so this is a drop-in replacement with the identical output
// shape -- only the SOURCE of the underlying mae values changed.
//
// trades must already carry barIdx/direction/entry (same precondition as
// sweepOptimalStopAndTargetChronological's own chronoTrades, built by the caller).
export function uncensoredMaeCandidates(trades, allBars, floor) {
  const maes = [];
  for (const t of trades) {
    const cx = precomputeCrossovers(t, allBars, [], []);
    if (cx) maes.push(cx.mae);
  }
  if (!maes.length) return [];
  maes.sort((a, b) => a - b);
  return [0.25, 0.40, 0.50, 0.60, 0.75]
    .map(pct => ({ value: percentileOf(maes, pct), pct }))
    .filter(c => c.value != null && c.value >= floor);
}

// Volatility-scaled-default ratios (2026-08-05, exported 2026-08-10). Extracted here after
// being hand-copied THREE times in 6 days (this file's own main(), test_invariants.mjs check
// [5], and backtest_ib_daytype_stop_target.mjs's origin_status fix) -- the exact "share
// modules" violation CLAUDE.md's own history repeatedly documents and fixes elsewhere;
// catching it on attempt #3 instead of letting a 4th copy happen. Derived FRESH each call
// from whichever setup_types currently clear the real-N floor and have a prior stored
// calibration -- not a hardcoded multiplier. Deliberately circular in a SAFE way (using
// well-calibrated types' own real ratio to scale a default for poorly-calibrated ones), not
// the self-referential CENSORING loop documented in
// optimal_stop_candidate_grid_self_censoring_feedback_loop -- that defect is a single type's
// OWN thin/censored MAE feeding its OWN candidate grid; this instead pools ACROSS every type
// that already has enough real data to trust, so no single thin type can feed back into its
// own default.
//
// priorStoredByType: { [signalName]: { stop, target, ... } } -- latest stored OPTIMAL_STOP
// per signal_name (any population; callers with a day-type-scoped population should still
// pass the MAIN, whole-system priorStoredByType here, not a day-type-local one -- pooling
// across the full system gives a more robust ratio than deriving one from 2 setup_types'
// own thin day-type buckets).
// realNByType: { [signalName]: number } -- real (origin_status-filtered) trade count per
// signal_name, same population shape as priorStoredByType's keys.
export function computeVolatilityDefaultRatios({ priorStoredByType, realNByType, medianBarRange, minN = MIN_N }) {
  const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const qualifyingRatios = [];
  for (const [type, stored] of Object.entries(priorStoredByType)) {
    const n = realNByType[type] || 0;
    if (n >= minN && stored.stop != null && stored.stop > 0 && stored.target != null) {
      qualifyingRatios.push({ stopToBarRange: stored.stop / medianBarRange, targetToStop: stored.target / stored.stop });
    }
  }
  const volScaleRatio = median(qualifyingRatios.map(r => r.stopToBarRange));
  const targetStopRatio = median(qualifyingRatios.map(r => r.targetToStop));
  const canComputeVolDefault = volScaleRatio != null && targetStopRatio != null && medianBarRange > 0;
  // ceilingRatio (2026-08-10, "uncensored MAE candidate grid" roadmap item): p90 of the SAME
  // qualifying-type stopToBarRange distribution used for volScaleRatio (its median) -- i.e.
  // "the widest stop-to-market-volatility ratio among setup_types the system ALREADY trusts on
  // real, calibrated data." DeepSeek design review (scratch/deepseek_response.md, 2026-08-10)
  // rejected capping uncensoredMaeCandidates()'s grid against the OLD censored mae_points
  // distribution -- that just re-introduces the self-referential censoring loop the uncensored
  // walk was built to escape, through a different door. This is a genuinely external, already-
  // validated reference instead: reuses the SAME qualifyingRatios array already being computed
  // for volScaleRatio (p50) rather than inventing a new statistic, so "typical" and "ceiling"
  // are two percentiles of one real distribution, not two independently-chosen numbers.
  const ceilingRatio = percentileOf([...qualifyingRatios.map(r => r.stopToBarRange)].sort((a, b) => a - b), 0.9);
  return { volScaleRatio, targetStopRatio, ceilingRatio, canComputeVolDefault, qualifyingCount: qualifyingRatios.length };
}

// Full stop+target decision tree for ONE setup_type, given its real (origin_status-filtered)
// trades and the run-wide volatility-default parameters. Extracted 2026-08-09 (same session
// as the re-baseline that needed it) so test_invariants.mjs check [5] can call this EXACT
// function to re-derive an expected value, rather than a hand-copied second decision tree --
// the precise bug class check [5]'s own header comment already warns about. Pure function:
// no DB access, no console output -- callers own logging/side effects.
//
// Params: realTradesStop (this type's real TARGET_HIT/STOP_HIT trades), direction ('LONG'/
// 'SHORT'/null), allBars + firstIndexAfter (shared bar index for the chronological walk),
// stopDpp/targetDpp (real $/pt for this type), noiseFloorPt, volScaleRatio/targetStopRatio/
// medianBarRange (run-wide volatility-default parameters, null if canComputeVolDefault is
// false), canComputeVolDefault.
// Returns { optStop, optTarget, optEV, targetMethod, usedVolDefault }.
export function computeStopTargetForType({ realTradesStop, direction, allBars, firstIndexAfter, stopDpp, targetDpp, noiseFloorPt, volScaleRatio, targetStopRatio, ceilingRatio, medianBarRange, canComputeVolDefault }) {
  const realNStop = realTradesStop.length;
  let swept, optStop, optTarget, targetMethod, usedVolDefault = false;
  let ceilingFullyRejected = null;

  if (realNStop < MIN_N && canComputeVolDefault) {
    swept = null;
    optStop = Math.max(Math.round(volScaleRatio * medianBarRange), Math.ceil(noiseFloorPt));
    optTarget = Math.round(optStop * targetStopRatio);
    targetMethod = 'volatility-scaled-default';
    usedVolDefault = true;
  } else if (realNStop >= MIN_N) {
    // realCandidates (censored mae_points column) stays the fallback for the order-blind sweep
    // below, which has no bar-walk infrastructure of its own and evaluates EV against the same
    // censored mae_points/mfe_points columns -- feeding it an uncensored candidate grid would be
    // internally inconsistent with how it scores each candidate. The chronological path's own EV
    // computation (precomputeCrossovers) is ALREADY a fresh bar walk, so it gets a matching
    // uncensored candidate grid too -- see uncensoredMaeCandidates()'s own comment.
    const realCandidates = realMaeCandidates(realTradesStop, noiseFloorPt);
    const realMaxT = Math.round(realP75Mfe(realTradesStop) || DEFAULT_TARGET);
    let chronoResult = null;
    if (direction) {
      const chronoTrades = realTradesStop.map(t => ({
        ...t,
        entry: t.entry_zone_high ?? t.entry_zone_low,
        direction,
        barIdx: firstIndexAfter(new Date(t.fired_at).getTime()),
      }));
      const uncensoredCandidates = uncensoredMaeCandidates(chronoTrades, allBars, noiseFloorPt);
      const chronoCandidates = uncensoredCandidates.length ? uncensoredCandidates : realCandidates;
      chronoResult = sweepOptimalStopAndTargetChronological(chronoTrades, allBars, chronoCandidates, realMaxT, stopDpp, targetDpp);

      // Risk ceiling (2026-08-10, DeepSeek-reviewed -- see comment on ceilingRatio above).
      // uncensoredMaeCandidates() measures honestly and is left unconstrained; this only
      // constrains what the SWEEP is allowed to pick, and only when its unconstrained winner
      // actually exceeds the ceiling -- most types never hit this, since most real MAE
      // distributions aren't as wide as IB_BEARISH's turned out to be.
      if (chronoResult && !chronoResult.insufficientBarData && ceilingRatio != null && medianBarRange > 0) {
        const ceiling = ceilingRatio * medianBarRange;
        if (chronoResult.stop > ceiling) {
          const cappedCandidates = chronoCandidates.filter(c => c.value <= ceiling);
          const uncappedStop = chronoResult.stop, uncappedTarget = chronoResult.target, uncappedEv = chronoResult.ev;
          const cappedResult = cappedCandidates.length
            ? sweepOptimalStopAndTargetChronological(chronoTrades, allBars, cappedCandidates, realMaxT, stopDpp, targetDpp)
            : null;
          if (cappedResult && !cappedResult.insufficientBarData) {
            chronoResult = { ...cappedResult, cappedByRiskCeiling: true, uncappedStop, uncappedTarget, uncappedEv, riskCeiling: Math.round(ceiling) };
          } else {
            // No candidate (uncensored OR the original censored realCandidates, since
            // chronoCandidates falls back to realCandidates when the uncensored grid is empty)
            // clears the ceiling -- falls through to the order-blind sweep below, on the OLD
            // censored candidates, same as if the chronological path had never run at all.
            // Recorded so this isn't indistinguishable from an ordinary "chronological path
            // unusable" case in the final notes.
            ceilingFullyRejected = { uncappedStop, uncappedTarget, uncappedEv, riskCeiling: Math.round(ceiling) };
            chronoResult = null;
          }
        }
      }
    }
    if (chronoResult && !chronoResult.insufficientBarData) {
      swept = chronoResult;
      targetMethod = 'chronological-sweep-real';
    } else {
      swept = sweepOptimalStopAndTarget(realTradesStop, realCandidates, realMaxT, stopDpp, targetDpp);
      targetMethod = swept ? 'EV-sweep-real' : 'p75mae-real-fallback';
    }
    if (swept) {
      optStop = swept.stop; optTarget = swept.target;
    } else {
      const rawP75 = percentileOf([...realTradesStop.map(t => t.mae_points)].sort((a, b) => a - b), 0.75) || DEFAULT_STOP;
      optStop = Math.max(Math.round(rawP75), Math.ceil(noiseFloorPt));
      optTarget = Math.round(realMaxT);
      swept = { stop: optStop, target: optTarget, ev: computeEvAtStopTarget(realTradesStop, optStop, optTarget, stopDpp, targetDpp) };
    }
  } else {
    // realNStop < MIN_N AND canComputeVolDefault false -- only reachable on a genuinely
    // first-ever run (no setup_type anywhere clears the real-N floor yet). No sane fallback
    // exists without ANY real-N-qualified type to derive a ratio from -- returns null
    // (caller must handle; update_optimal_stops.mjs's own pre-2026-08-09 blended fallback
    // for this one edge case stays inline there, not duplicated here).
    return { optStop: null, optTarget: null, optEV: null, targetMethod: 'insufficient_data_no_fallback', usedVolDefault: false };
  }

  const optEV = usedVolDefault ? null : swept.ev;
  return {
    optStop, optTarget, optEV, targetMethod, usedVolDefault,
    // Present only when the risk ceiling actually engaged (see ceilingRatio comment above) --
    // absent (undefined) on every normal row, so JSON.stringify naturally omits it rather than
    // writing a clutter of always-null fields onto rows that were never capped.
    ...(swept?.cappedByRiskCeiling ? {
      cappedByRiskCeiling: true, uncappedStop: swept.uncappedStop,
      uncappedTarget: swept.uncappedTarget, uncappedEv: swept.uncappedEv, riskCeiling: swept.riskCeiling,
    } : {}),
    // Distinct from cappedByRiskCeiling above: the ceiling engaged but NOTHING cleared it, so
    // the chronological path was abandoned entirely and targetMethod fell through to whatever
    // the order-blind path produced -- without this, that fallback is indistinguishable from
    // the chronological path simply not having enough bar data, which is a materially
    // different (and much less interesting) reason.
    ...(ceilingFullyRejected ? { ceilingFullyRejected } : {}),
  };
}

// --dry-run (2026-08-04, DeepSeek-recommended before shipping the structural-conservative
// fallback below, given its blast radius — it can change the stored stop/target for every
// setup_type simultaneously on the next real run, with no other staging point). Computes
// everything identically but writes nothing to the database; prints a before/after comparison
// (old stop/target/EV vs new) for every row instead of the normal per-row summary line, plus an
// aggregate count of how many rows would flip to structural-conservative and how their EV
// compares to the swept EV they'd otherwise have kept. Run once, review the output, then run for
// real without the flag — this codebase has a real history (optStopQ, ev_per_trade, the
// origin_status fix) of a technically-correct calibration change producing an unanticipated
// large-scale recalibration that nobody noticed until queried directly.
const DRY_RUN = process.argv.includes('--dry-run');
// See applyCircuitBreaker()'s comment above for why this exists and why it's dated rather
// than a generic name. Deliberately requires the FULL exact flag, not a short alias, so it
// can't be fat-fingered into a normal run.
const BYPASS_BREAKER = process.argv.includes('--bypass-breaker-for-rebaseline-20260809');
if (BYPASS_BREAKER) console.log('⚠️  CIRCUIT BREAKER BYPASSED THIS RUN -- one-time 2026-08-09 re-baseline. Every setup_type accepts its freshly-computed value unconditionally, regardless of size of change. Review the diff carefully before trusting anything.');

async function main() {
  console.log(`Computing optimal stops + EV-sweep targets from active_setups MAE/MFE data...${DRY_RUN ? ' [DRY RUN — no writes]' : ''}`);

  // 0. Mark corrupted MAE/MFE rows as BAD_DATA so they're excluded from all analysis.
  //    Opus audit 2026-07-07: 303/304 rows from 2023 have mae or mfe > 300pt (max 11,766pt).
  //    Root cause: bad bar data in price_bars_primary for Nov–Dec 2023 (price_at_resolution IS NULL).
  //    300pt is the clear boundary — 2024+ data is clean (0/1083 bad in 2024).
  let badRows = { rows: [] };
  if (!DRY_RUN) {
    badRows = await query(`
      UPDATE active_setups
      SET replay_resolution = 'BAD_DATA'
      WHERE (mae_points > 300 OR mfe_points > 300)
        AND replay_resolution IN ('TARGET_HIT', 'STOP_HIT')
      RETURNING id
    `);
  }
  if (badRows.rows.length > 0) console.log(`Marked ${badRows.rows.length} corrupted MAE/MFE rows as BAD_DATA`);

  // 1. Compute p75_mae (optimal stop) and p50_mfe (optimal target) per setup_type
  //    Only resolved trades with clean MAE data; exclude EXPIRED (they inflate MAE/MFE)
  //    Excludes BAD_DATA rows (mae/mfe > 300pt from 2023 corruption).
  const statsRes = await query(`
    SELECT
      setup_type,
      COUNT(*)                                                                            AS n,
      ROUND(100.0 * SUM(CASE WHEN actual_pnl > 0 THEN 1 ELSE 0 END)/COUNT(*)::numeric, 1) AS wr,
      ROUND(AVG(actual_pnl)::numeric, 0)                                                 AS ev,
      ROUND(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY mae_points)::numeric, 1)       AS p25_mae,
      ROUND(PERCENTILE_CONT(0.40) WITHIN GROUP (ORDER BY mae_points)::numeric, 1)       AS p40_mae,
      ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY mae_points)::numeric, 1)       AS p50_mae,
      ROUND(PERCENTILE_CONT(0.60) WITHIN GROUP (ORDER BY mae_points)::numeric, 1)       AS p60_mae,
      ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY mae_points)::numeric, 1)       AS p75_mae,
      ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY mae_points)::numeric, 1)       AS p90_mae,
      ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY mfe_points)::numeric, 1)       AS p50_mfe,
      ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY mfe_points)::numeric, 1)       AS p75_mfe
    FROM active_setups
    WHERE mae_points     IS NOT NULL
      AND mfe_points     IS NOT NULL
      AND actual_pnl     IS NOT NULL
      AND mae_points     <= 300
      AND mfe_points     <= 300
      AND status         = 'RESOLVED'
      AND replay_resolution IN ('TARGET_HIT', 'STOP_HIT')
    GROUP BY setup_type
    HAVING COUNT(*) >= ${MIN_N}
    ORDER BY setup_type
  `);

  const rows = statsRes.rows;
  console.log(`Found ${rows.length} setup types with N≥${MIN_N}`);

  // Currently-stored values, fetched once. Used for the --dry-run before/after comparison
  // AND (2026-08-04) as the circuit breaker's comparison baseline on every real run too --
  // no longer diagnostic-only, see applyCircuitBreaker() above.
  let priorStoredByType = {};
  {
    const priorRes = await query(`
      SELECT DISTINCT ON (signal_name) signal_name, optimal_stop, optimal_target, ev_per_trade, sample_size, notes
      FROM performance_audit WHERE signal_type = 'OPTIMAL_STOP'
      ORDER BY signal_name, run_date DESC
    `);
    for (const p of priorRes.rows) {
      let priorNotes = null;
      try { priorNotes = JSON.parse(p.notes); } catch (_) { /* not JSON or null */ }
      priorStoredByType[p.signal_name] = {
        stop: p.optimal_stop != null ? parseFloat(p.optimal_stop) : null,
        target: p.optimal_target != null ? parseFloat(p.optimal_target) : null,
        ev: p.ev_per_trade != null ? parseFloat(p.ev_per_trade) : null,
        sampleSize: p.sample_size != null ? parseInt(p.sample_size) : null,
        lastRecalibratedN: priorNotes?.circuitBreaker?.lastRecalibratedN ?? null,
      };
    }
  }

  // 1a2. Real per-setup_type dollars-per-point, derived from resolved trades' actual dollar
  // P&L vs. their real point distance to stop/target — NOT a flat assumed constant, though
  // in practice every setup_type resolves to the same ~$2.01-2.06/pt (MNQ's real $2/pt plus
  // the $1 commission spread across the trade's point distance) — see DEFAULT_DPP's comment
  // above, corrected 2026-07-17. Falls back to DEFAULT_DPP per type/side when N < MIN_N for
  // that specific branch (stop-hit or target-hit) — same floor used everywhere else in this
  // file, and now the same real value rather than a wrong 2.5x-inflated one.
  const dppRes = await query(`
    SELECT setup_type,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(actual_pnl) / NULLIF(ABS(entry_zone_low - stop_level), 0))
        FILTER (WHERE replay_resolution = 'STOP_HIT')                                    AS stop_dpp,
      COUNT(*) FILTER (WHERE replay_resolution = 'STOP_HIT')                             AS n_stop,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(actual_pnl) / NULLIF(ABS(t1_level - entry_zone_low), 0))
        FILTER (WHERE replay_resolution = 'TARGET_HIT')                                  AS target_dpp,
      COUNT(*) FILTER (WHERE replay_resolution = 'TARGET_HIT')                           AS n_target
    FROM active_setups
    WHERE status = 'RESOLVED' AND entry_zone_low IS NOT NULL
      AND stop_level IS NOT NULL AND t1_level IS NOT NULL
      AND actual_pnl IS NOT NULL
    GROUP BY setup_type
  `);
  const dppByType = {};
  for (const r of dppRes.rows) {
    const stopDpp   = (+r.n_stop >= MIN_N && r.stop_dpp != null) ? +r.stop_dpp : DEFAULT_DPP;
    const targetDpp = (+r.n_target >= MIN_N && r.target_dpp != null) ? +r.target_dpp : DEFAULT_DPP;
    dppByType[r.setup_type] = { stopDpp, targetDpp };
  }

  // 1b. Fetch all raw trades in one query for the target sweep
  const rawRes = await query(`
    SELECT setup_type, mae_points::float, mfe_points::float, actual_pnl::float,
      fired_at, entry_zone_low::float, entry_zone_high::float
    FROM active_setups
    WHERE mae_points IS NOT NULL AND mfe_points IS NOT NULL AND actual_pnl IS NOT NULL
      AND mae_points <= 300 AND mfe_points <= 300
      AND status = 'RESOLVED'
      AND replay_resolution IN ('TARGET_HIT', 'STOP_HIT')
  `);
  const rawByType = {};
  for (const t of rawRes.rows) {
    if (!rawByType[t.setup_type]) rawByType[t.setup_type] = [];
    rawByType[t.setup_type].push(t);
  }
  console.log(`Loaded ${rawRes.rows.length} raw trades for EV target sweep`);

  // 1c. Corrected target methodology (chronological resimulation, thin-tail/plateau/OOS/
  // rigor guardrails) -- see server/services/targetCalibrationService.js and
  // docs/TARGET_CALIBRATION_SPEC.md. Loads real bars once and attempts a corrected target
  // for every setup_type below; falls back to the existing EV-sweep/p50_mfe methodology
  // for any setup_type that doesn't clear every guardrail. This replaces the need for a
  // manually-maintained "which setups get a corrected target" list -- every weekly/daily
  // run re-evaluates all of them automatically, per CLAUDE.md's no-dead-ends rule.
  //
  // Deliberately a SEPARATE, wider trade population than rawByType above: rawByType
  // excludes TIME_EXPIRED (a pre-existing, unrelated convention of the OLD EV-sweep, left
  // untouched here) but a TIME_EXPIRED trade timed out under whatever SHORTER live
  // resolution window was in effect when it fired -- computeCorrectedTarget's own 390-bar
  // walk from entry can correctly re-evaluate it and often finds it actually would have
  // hit target or stop. Excluding it here would just be a second instance of the exact
  // truncation problem this whole fix exists to solve. Verified directly (2026-07-19):
  // CAM_S2_FADE_LONG flips from surviving (oosEv=+$0.23, N=157) to failing (oosEv=-$13.78,
  // N=154) purely from excluding its 3 TIME_EXPIRED trades -- confirms this isn't a
  // cosmetic choice.
  // origin_status IN ('ACTIVE','SHADOW') -- found 2026-08-02: BACKFILL rows can carry a
  // fired_at that doesn't correspond to when entry_zone_low/high was actually observed in
  // the market (confirmed for a batch of VWAP_MAGNET_LONG BACKFILL rows from 2026-06-09 --
  // fired_at was ~4hrs early vs. when the stored entry price actually printed, a naive
  // ET-as-UTC-style offset). computeCorrectedTarget()'s 390-bar walk is keyed entirely off
  // fired_at, so on those rows it walked from the WRONG point in time and picked up PAST
  // price action (a real, sustained ~1,590pt overnight move that happened BEFORE the true
  // entry) as if it were future favorable excursion -- a genuine lookahead artifact, not
  // real edge. This silently promoted a 454.5pt target for VWAP_MAGNET_LONG (real p75_mfe
  // is 30.8pt) and the same pattern across all 4 VWAP-magnet variants -- the highest-volume
  // live setups, so the live impact was real, not theoretical. BACKFILL rows' own
  // mae_points/mfe_points (used elsewhere, e.g. rawByType above) were computed by whatever
  // wrote them and aren't necessarily wrong -- this filter only affects the fresh,
  // fired_at-keyed re-walk here. Real (ACTIVE/SHADOW) N still clears MIN_N for every setup
  // that was actually corrupted (VWAP_MAGNET_LONG=82, GLOBEX_VWAP_MAGNET_LONG=88,
  // GLOBEX_VWAP_MAGNET_SHORT=54) -- see docs/OPEN_THREADS.md for the full writeup.
  const rawResExpanded = await query(`
    SELECT setup_type, mae_points::float, mfe_points::float, actual_pnl::float,
      fired_at, entry_zone_low::float, entry_zone_high::float
    FROM active_setups
    WHERE mae_points IS NOT NULL AND mfe_points IS NOT NULL AND actual_pnl IS NOT NULL
      AND mae_points <= 300 AND mfe_points <= 300
      AND resolution IN ('TARGET_HIT', 'STOP_HIT', 'TIME_EXPIRED')
      AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL
      AND origin_status IN ('ACTIVE', 'SHADOW')
    ORDER BY fired_at ASC
  `);
  const rawByTypeExpanded = {};
  for (const t of rawResExpanded.rows) (rawByTypeExpanded[t.setup_type] ||= []).push(t);

  console.log('Loading NQ bars for corrected-target resimulation...');
  const barsRes = await query(`SELECT ts, high::float as high, low::float as low FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
  const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), high: b.high, low: b.low }));
  console.log(`${allBars.length} bars loaded.`);
  const firstIndexAfter = makeBarIndex(allBars);

  // ── Real (origin_status-filtered) population for the STOP sweep (2026-08-09 re-baseline,
  // resolves rawByType_origin_status_filter, HIGH). rawByType above (feeding the legacy
  // maeCandidates/sweepOptimalStopAndTarget call in the final else-branch below) has NEVER
  // been origin_status-filtered -- both the stop CANDIDATE VALUES (MAE percentiles) and the
  // trades scored against them came from a population that's typically 75-95% synthetic
  // BACKFILL data (RESEARCH_CLAIM live_stop_population_synthetic_composition_audit_20260804).
  // Filtering only one side (candidates OR trades) would still let contamination in through
  // whichever side stayed unfiltered -- this query mirrors rawByType's exact WHERE clause,
  // adding ONLY the origin_status filter, and both the candidate percentiles AND the EV-
  // scoring trades below are computed from this SAME array, so there's no half-fixed seam.
  const rawResReal = await query(`
    SELECT setup_type, mae_points::float, mfe_points::float, actual_pnl::float,
      fired_at, entry_zone_low::float, entry_zone_high::float
    FROM active_setups
    WHERE mae_points IS NOT NULL AND mfe_points IS NOT NULL AND actual_pnl IS NOT NULL
      AND mae_points <= 300 AND mfe_points <= 300
      AND status = 'RESOLVED'
      AND replay_resolution IN ('TARGET_HIT', 'STOP_HIT')
      AND origin_status IN ('ACTIVE', 'SHADOW')
    ORDER BY fired_at ASC
  `);
  const rawByTypeReal = {};
  for (const t of rawResReal.rows) (rawByTypeReal[t.setup_type] ||= []).push(t);
  console.log(`Loaded ${rawResReal.rows.length} REAL (origin_status-filtered) trades for the stop-side sweep -- ${rawRes.rows.length - rawResReal.rows.length} BACKFILL/UNKNOWN rows excluded from ${rawRes.rows.length} total.`);

  // percentileOf/realMaeCandidates/realP75Mfe: now module-level exports (moved 2026-08-09,
  // see their definitions above main()) so test_invariants.mjs check [5] can import and call
  // the SAME functions instead of a second hand-copied version.

  // ── Volatility-scaled default for real-N-thin setup_types (2026-08-05) ──────────────
  // Replaces "run the sweep on whatever data exists, clamp the result against a noise-floor
  // guard" with "don't run the sweep at all below a real-N floor -- use a default scaled to
  // CURRENT real market volatility instead." A noise-floor CLAMP was tried first and
  // rejected: it makes a degenerate sweep result look plausible with the same false
  // confidence a real calibration carries (proven live the same night -- VWAP_MAGNET_LONG's
  // chronological sweep picked a 7pt stop on unfiltered ~93%-synthetic data; a floor would
  // have silently substituted 18.4pt with zero indication that number wasn't actually
  // computed from anything). Re-verified directly before building this: on VWAP_MAGNET_LONG's
  // REAL-only population (origin_status IN ACTIVE/SHADOW, N=78 -- well above MIN_N=20), the
  // SAME chronological sweep produces a perfectly sane 29pt/25pt (ratio 2.37x the trailing
  // bar range, right at this cohort's own 2.45x median) -- confirming the 7pt result was
  // specifically an artifact of missing the origin_status filter (rawByType_origin_status_filter,
  // still pending), not evidence this type's data can't support calibration at all. The
  // real-N gate below is still the right general mechanism regardless -- most of this
  // system's ~130 live-ish setup_types have real N in the single digits (RESEARCH_CLAIM
  // live_stop_population_synthetic_composition_audit_20260804, the "7.2% real census"), and
  // those genuinely should not be calibrated off contaminated data no matter how the sweep
  // is implemented.
  // Reuses rawByTypeExpanded (already origin_status IN ('ACTIVE','SHADOW')-filtered, see the
  // corrected-target path above) as the single source of truth for "real N" -- deliberately
  // not a second, separately-defined real-N query, matching this codebase's own single-
  // source-of-truth discipline.
  const realNByType = Object.fromEntries(Object.entries(rawByTypeExpanded).map(([type, arr]) => [type, arr.length]));

  const medianBarRangeRes = await query(`
    SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (high - low)) as median_range
    FROM price_bars_primary WHERE symbol='NQ' AND ts >= NOW() - INTERVAL '30 days'
  `);
  const medianBarRange = +medianBarRangeRes.rows[0].median_range;
  // Same 1.5x convention as test_invariants.mjs check [13] -- see realMaeCandidates()'s
  // comment above for why this needs to gate candidate GENERATION, not just be checked
  // against the final chosen stop after the fact.
  const NOISE_FLOOR_PT = 1.5 * medianBarRange;

  // See computeVolatilityDefaultRatios()'s own header comment above for the full reasoning
  // -- extracted 2026-08-10 after being hand-copied 3 times in 6 days.
  const { volScaleRatio, targetStopRatio, ceilingRatio, canComputeVolDefault, qualifyingCount } =
    computeVolatilityDefaultRatios({ priorStoredByType, realNByType, medianBarRange, minN: MIN_N });
  console.log(`Volatility-scaled default: ${qualifyingCount} real-N-qualified types (n>=${MIN_N}) inform the ratio -- stop=${volScaleRatio?.toFixed(2)}x median bar range (${medianBarRange.toFixed(1)}pt), target=${targetStopRatio?.toFixed(2)}x stop. Risk ceiling (p90 of the same distribution): ${ceilingRatio?.toFixed(2)}x = ${ceilingRatio != null ? Math.round(ceilingRatio * medianBarRange) : 'n/a'}pt.`);

  let upserted = 0, correctedCount = 0, volDefaultCount = 0;
  for (const r of rows) {
    const p75mae    = parseFloat(r.p75_mae) || DEFAULT_STOP;
    const p75mfe    = Math.round(parseFloat(r.p75_mfe) || DEFAULT_TARGET);
    // Capped at p75 — NOT p90. Opus audit (2026-07-13) found the EV sim checks `mae > stop`
    // before checking the target, with no knowledge of chronological order within the trade.
    // At p90, trades whose real mae landed in the 76th-90th percentile range get "rescued"
    // into simulated wins whenever mfe happened to clear the target *at any point* in the bar
    // walk, regardless of whether target was actually reached before the real (tighter,
    // historical) stop would have triggered. IB_BEARISH: 8 such trades scored as +$100 wins
    // in the sim, but their real average actual_pnl was -$97.80 (they lost) — this artifact,
    // not genuine edge, is what pushed IB_BEARISH to a 150pt stop and BRACKET_BREAKOUT_LONG to
    // 165pt. This is the exact same failure mode sweepOptimalTarget's `maxT` cap already guards
    // against for targets (see its comment: "high T values saturate to actual_pnl and look
    // artificially optimal") — p90 just wasn't capped symmetrically for stops when the stop
    // sweep was added. p75 still isn't perfectly immune (same bias at lower magnitude, per the
    // audit) but the artifact was concentrated at p90 in practice (7/66 types landed there).
    const maeCandidates = [
      { value: r.p25_mae, pct: 0.25 }, { value: r.p40_mae, pct: 0.40 },
      { value: r.p50_mae, pct: 0.50 }, { value: r.p60_mae, pct: 0.60 },
      { value: r.p75_mae, pct: 0.75 },
    ].map(c => ({ ...c, value: parseFloat(c.value) })).filter(c => !isNaN(c.value) && c.value > 0);
    const trades    = rawByType[r.setup_type] || [];
    const { stopDpp, targetDpp } = dppByType[r.setup_type] || { stopDpp: DEFAULT_DPP, targetDpp: DEFAULT_DPP };
    // realN/realNByType (from rawByTypeExpanded) still gates the SEPARATE corrected-target
    // override below (unchanged, already origin_status-filtered since 2026-08-02) -- kept
    // distinct from realNStop, which gates THIS stop-sweep decision specifically and is
    // scoped to the narrower TARGET_HIT/STOP_HIT-only population sweepOptimalStopAndTarget
    // actually consumes. hoisted here (was further below) so both this block and the
    // corrected-target block can share one inferDirection() call.
    const realN = realNByType[r.setup_type] || 0;
    const direction = inferDirection(r.setup_type);

    // ── Real (origin_status-filtered) population + real percentile candidates for THIS
    // type's stop sweep (2026-08-09 re-baseline). realNStop gates whether we trust a sweep
    // on real data at all -- the volatility-scaled default (built 2026-08-05, never run
    // against a properly filtered realN until now) is the fallback below that floor.
    const realTradesStop = rawByTypeReal[r.setup_type] || [];
    const realNStop = realTradesStop.length;

    // Decision tree extracted to computeStopTargetForType() (2026-08-09, exported above
    // main()) so test_invariants.mjs check [5] can call the exact same function to re-derive
    // an expected value, instead of a second hand-copied version.
    const decision0 = computeStopTargetForType({
      realTradesStop, direction, allBars, firstIndexAfter, stopDpp, targetDpp,
      noiseFloorPt: NOISE_FLOOR_PT, volScaleRatio, targetStopRatio, ceilingRatio, medianBarRange, canComputeVolDefault,
    });
    let optStop, optTarget, targetMethod, usedVolDefault, swept;
    if (decision0.targetMethod === 'insufficient_data_no_fallback') {
      // Only reachable on a genuinely first-ever run (no setup_type anywhere yet clears the
      // real-N floor to derive a volatility-scale ratio from) -- computeStopTargetForType()
      // can't help here since there's no real-data-only fallback possible. Matches this
      // file's pre-2026-08-09 behavior for this one edge case only; every other path is
      // real-data-only now.
      swept     = sweepOptimalStopAndTarget(trades, maeCandidates, p75mfe, stopDpp, targetDpp);
      optStop     = swept ? swept.stop : Math.round(p75mae);
      optTarget = swept ? swept.target : Math.round(parseFloat(r.p50_mfe) || DEFAULT_TARGET);
      targetMethod = swept ? 'EV-sweep' : 'p50_mfe fallback';
      usedVolDefault = false;
    } else {
      ({ optStop, optTarget, targetMethod, usedVolDefault } = decision0);
      swept = { ev: decision0.optEV }; // shape-compatible with the optEV line below
      if (usedVolDefault) volDefaultCount++;
    }
    const riskCappedInfo = decision0.cappedByRiskCeiling ? {
      capped_by_risk_ceiling: true, uncapped_stop: decision0.uncappedStop,
      uncapped_target: decision0.uncappedTarget, uncapped_ev: decision0.uncappedEv != null ? +decision0.uncappedEv.toFixed(2) : null,
      risk_ceiling_pt: decision0.riskCeiling,
    } : decision0.ceilingFullyRejected ? {
      ceiling_fully_rejected: true, uncapped_stop: decision0.ceilingFullyRejected.uncappedStop,
      uncapped_target: decision0.ceilingFullyRejected.uncappedTarget,
      uncapped_ev: decision0.ceilingFullyRejected.uncappedEv != null ? +decision0.ceilingFullyRejected.uncappedEv.toFixed(2) : null,
      risk_ceiling_pt: decision0.ceilingFullyRejected.riskCeiling,
    } : null;
    // FIXED 2026-07-17: ev_per_trade used to be parseFloat(r.ev) -- ROUND(AVG(actual_pnl)),
    // a raw historical average using whatever stop/target each trade ACTUALLY fired with --
    // completely disconnected from optStop/optTarget above (the EV-sweep's real chosen pair).
    // Bug dated to this file's original commit (a04b2fd, 2026-07-05), before the EV-sweep even
    // existed (optTarget was just p50_mfe back then, so the raw average was a defensible
    // standalone stat); broke silently on 2026-07-09 (de3e407, "EV-sweep targets") when the
    // sweep was added without rewiring this field to match. Full writeup + git-history trace:
    // docs/OPEN_THREADS.md. optEV now reports the EV *of* optStop/optTarget specifically --
    // falls back to the raw average only when no sweep candidate was valid (thin-tail gate
    // rejected every percentile candidate), matching optStop/optTarget's own fallback.
    // usedVolDefault: optEV deliberately left null, not the raw historical average -- that
    // average describes whatever stop/target each trade ACTUALLY fired with historically,
    // not this default pairing, and borrowing it would misrepresent an untested default as
    // having a real backtested EV.
    let optEV     = usedVolDefault ? null : (swept ? swept.ev : parseFloat(r.ev));
    let correctedNotes = null;

    // Corrected target attempt (2026-07-19): chronologically-resimulated, guardrailed
    // methodology from server/services/targetCalibrationService.js -- fixes the EV-sweep
    // above's two structural flaws (truncated MFE, order-blind EV check). Stop stays FIXED
    // at optStop (this only re-derives the target). If it clears every guardrail (thin-tail,
    // plateau, chronological OOS beats baseline, rigor-clean), it OVERRIDES the EV-sweep
    // target above; otherwise falls through to the existing methodology unchanged -- no
    // regression risk for setup_types that don't have enough data for the stricter check
    // yet. This is what makes the fix durable: every future run re-evaluates every
    // setup_type automatically instead of relying on a manually-maintained list.
    // (direction hoisted above, shared with the stop-sweep block)
    const expandedTrades = rawByTypeExpanded[r.setup_type] || [];
    if (direction && expandedTrades.length >= 20) {
      const corrected = computeCorrectedTarget({
        trades: expandedTrades, allBars, stop: optStop, oldTarget: optTarget,
        long: direction === 'LONG', pnlPerPoint: DEFAULT_DPP, commission: LIVE_INSTRUMENT.commissionPerRoundTrip,
      });
      if (!corrected.exclusionReason) {
        // oldTarget persisted alongside the new one (2026-07-19) so "is the corrected
        // methodology actually capturing more of the move, not just a different number"
        // is queryable/visible going forward, not something that has to be re-derived by
        // hand each time someone asks — see AlphaEngineOverview.jsx's calibration panel.
        // Captured BEFORE optTarget is overwritten below, from the same value already
        // passed in as computeCorrectedTarget's own `oldTarget` argument.
        const preCorrectionTarget = optTarget;
        optTarget = corrected.bestTarget;
        optEV = corrected.fullEv;
        targetMethod = 'corrected-resim';
        correctedNotes = JSON.stringify({ method: 'corrected-resim', oldTarget: preCorrectionTarget, ...corrected, ...(riskCappedInfo ? { risk_capping: riskCappedInfo } : {}) });
        correctedCount++;
      } else {
        // Structural-conservative fallback: DESIGNED, DRY-RUN TESTED, REVERTED before going
        // live (2026-08-04) -- do not re-enable without redesigning the formula first.
        //
        // Original proposal (Opus via user, DeepSeek design-reviewed): when corrected-resim
        // fails (100% of the time as of 2026-08-04 -- see the claim below), stop falling
        // through to the unguarded, confirmed order-blind EV-sweep -- use a non-optimized
        // structural stop/target instead (p40 MAE as stop, target = stop*(p50_mfe/p75_mae)
        // capped at p75_mfe). DeepSeek's review required a target cap, defensive guards, EV
        // computed at the stored pair (not the swept EV), and — critically — a `--dry-run`
        // mode before deploying, given the blast radius (all 130 types simultaneously, no
        // staging point). That dry-run is exactly what caught this: run against real current
        // data, ALL 11 rows that would have flipped to structural-conservative showed WORSE
        // EV than their current swept value, and several (VWAP_MAGNET_LONG/SHORT,
        // GLOBEX_VWAP_MAGNET_LONG/SHORT) flipped from POSITIVE EV to STRONGLY NEGATIVE EV --
        // directly contradicting the design review's own stated worst case ("lower EV, not
        // negative EV"). p40 MAE is apparently too tight a stop for these real populations,
        // producing far more premature stop-outs than the current (biased but empirically
        // less harmful) EV-sweep stop. Reverted before this could reach the live cron.
        //
        // Diagnostic-only: report what the structural fallback WOULD compute, without
        // applying it, so this remains inspectable without repeating the dry-run by hand.
        // Recorded via RESEARCH_CLAIM structural_conservative_fallback_worse_ev_reverted_20260804.
        const p40 = parseFloat(r.p40_mae) || DEFAULT_STOP;
        const p50mfeRaw = parseFloat(r.p50_mfe) || DEFAULT_TARGET;
        const p75maeRaw = parseFloat(r.p75_mae) || 1; // denominator guard, never 0
        const wouldBeStop = Math.round(p40);
        const wouldBeTarget = Math.round(Math.min(wouldBeStop * (p50mfeRaw / p75maeRaw), p75mfe || DEFAULT_TARGET));
        const wouldBeEv = computeEvAtStopTarget(trades, wouldBeStop, wouldBeTarget, stopDpp, targetDpp);
        correctedNotes = JSON.stringify({
          method: targetMethod, correctionAttempted: true,
          exclusionReason: corrected.exclusionReason, exclusionDetail: corrected.exclusionDetail,
          structuralFallbackNotApplied: { stop: wouldBeStop, target: wouldBeTarget, ev: wouldBeEv, evDelta: +(wouldBeEv - optEV).toFixed(2) },
          ...(riskCappedInfo ? { risk_capping: riskCappedInfo } : {}),
        });
      }
    } else {
      correctedNotes = JSON.stringify({ method: targetMethod, correctionAttempted: false, exclusionReason: !direction ? 'no_inferred_direction' : 'insufficient_trade_count', exclusionDetail: `expandedTrades=${expandedTrades.length}`, ...(riskCappedInfo ? { risk_capping: riskCappedInfo } : {}) });
    }

    // Circuit breaker (see applyCircuitBreaker() above) -- the LAST gate applied to
    // whatever method chain produced optStop/optTarget/optEV above, regardless of which
    // method it was. Reassigns optStop/optTarget/optEV to the frozen prior value if
    // either gate rejects the freshly-computed candidate; everything downstream (DRY_RUN
    // print, the real INSERT) uses these post-breaker values.
    {
      const attemptedStop = optStop, attemptedTarget = optTarget, attemptedEv = optEV;
      // currentN: was parseInt(r.n) -- the BLENDED (BACKFILL-inclusive) count from statsRes
      // -- until 2026-08-09. Now realNStop (this type's own real, origin_status-filtered
      // TARGET_HIT/STOP_HIT count), matching what the stop sweep itself is actually
      // computed from as of this same re-baseline. Using the blended count here would have
      // measured "has blended N grown enough since last accepted recalibration" while the
      // sweep above measures real N -- two different populations, same footgun class this
      // whole fix exists to close. lastRecalibratedN in prior/notes is written by this same
      // (now real-N-based) metric going forward, so this stays self-consistent run to run.
      const decision = applyCircuitBreaker({
        setupType: r.setup_type, currentN: realNStop,
        attemptedStop, attemptedTarget, attemptedEv,
        prior: priorStoredByType[r.setup_type],
        bypass: BYPASS_BREAKER,
      });
      optStop = decision.stop; optTarget = decision.target; optEV = decision.ev;
      let baseNotes = null;
      try { baseNotes = JSON.parse(correctedNotes); } catch (_) { baseNotes = { method: targetMethod }; }
      correctedNotes = JSON.stringify({ ...baseNotes, circuitBreaker: decision.circuitBreaker });
    }

    if (DRY_RUN) {
      const prior = priorStoredByType[r.setup_type];
      const stopDelta = prior?.stop != null ? optStop - prior.stop : null;
      const targetDelta = prior?.target != null ? optTarget - prior.target : null;
      const evDelta = prior?.ev != null ? optEV - prior.ev : null;
      const flippedToStructural = targetMethod === 'structural-conservative';
      let breakerNotes = null; try { breakerNotes = JSON.parse(correctedNotes)?.circuitBreaker; } catch (_) {}
      const marker = flippedToStructural ? ' ← NOW STRUCTURAL-CONSERVATIVE'
        : breakerNotes?.tripped ? ` ← CIRCUIT BREAKER TRIPPED (attempted stop=${breakerNotes.attemptedStop} target=${breakerNotes.attemptedTarget})`
        : breakerNotes?.reason === 'min_delta_n_not_met' ? ` ← held (ΔN=${breakerNotes.deltaN}<${breakerNotes.minDeltaNRequired})`
        : '';
      // optEV can be null now (volatility-scaled-default's EV is deliberately unknown, not
      // borrowed from a differently-computed stat) -- guard the print, don't assume a number.
      const optEvStr = optEV != null ? optEV.toFixed(2) : 'n/a';
      console.log(`  ${r.setup_type.padEnd(40)} OLD stop=${prior?.stop ?? '?'} t1=${prior?.target ?? '?'} EV=$${prior?.ev?.toFixed(2) ?? '?'}  ->  NEW stop=${optStop}(${stopDelta != null ? (stopDelta >= 0 ? '+' : '') + stopDelta : '?'}) t1=${optTarget}(${targetDelta != null ? (targetDelta >= 0 ? '+' : '') + targetDelta : '?'}) EV=$${optEvStr}(${evDelta != null ? (evDelta >= 0 ? '+$' : '-$') + Math.abs(evDelta).toFixed(2) : '?'}) method=${targetMethod}${marker}`);
      upserted++; // counts "would upsert", matches the real-run semantics for the summary line below
      continue;
    }

    await query(`
      INSERT INTO performance_audit (
        run_date, window_days, signal_type, signal_name,
        sample_size, win_rate, ev_per_trade,
        p50_mae, p75_mae, p50_mfe, p75_mfe,
        optimal_stop, optimal_target, notes
      ) VALUES (
        CURRENT_DATE, 9999, 'OPTIMAL_STOP', $1,
        $2, $3, $4,
        $5, $6, $7, $8,
        $9, $10, $11
      )
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
        sample_size    = EXCLUDED.sample_size,
        win_rate       = EXCLUDED.win_rate,
        ev_per_trade   = EXCLUDED.ev_per_trade,
        p50_mae        = EXCLUDED.p50_mae,
        p75_mae        = EXCLUDED.p75_mae,
        p50_mfe        = EXCLUDED.p50_mfe,
        p75_mfe        = EXCLUDED.p75_mfe,
        optimal_stop   = EXCLUDED.optimal_stop,
        optimal_target = EXCLUDED.optimal_target,
        notes          = EXCLUDED.notes
    `, [
      r.setup_type,
      parseInt(r.n),
      parseFloat(r.wr) / 100,
      optEV,
      parseFloat(r.p50_mae),
      parseFloat(r.p75_mae),
      parseFloat(r.p50_mfe),
      parseFloat(r.p75_mfe),
      optStop,
      optTarget,
      correctedNotes,
    ]);

    upserted++;
    // Prints both the (now-correct) swept EV and the raw historical average side by side --
    // deliberately visible so a future divergence this large is caught by eye immediately,
    // not just by the automated invariant check in test_invariants.mjs. optEV can be null
    // (volatility-scaled-default) -- FIXED 2026-08-09: this real-run print crashed on the
    // very first null EV it hit (10D_IB_MID_FADE_LONG), a bug that existed since the
    // volatility-scaled default shipped 2026-08-05 but stayed dormant because vol-default
    // rarely fired under the old unfiltered real-N gate; today's origin_status fix makes it
    // the majority path (104 of 123 types), which is what finally triggered it. The DRY_RUN
    // print branch above already had this exact guard -- this one just never got the same
    // fix when that one was added, the same "two copies of near-identical logic drift
    // apart" class of bug this codebase's own conventions warn about repeatedly.
    const optEvStr = optEV != null ? optEV.toFixed(2) : 'n/a';
    console.log(`  ${r.setup_type.padEnd(40)} stop=${optStop}pt  t1=${optTarget}pt(${targetMethod})  WR=${r.wr}%  N=${r.n}  EV=$${optEvStr}  (raw avg pnl=$${r.ev})`);
  }

  console.log(`\n${DRY_RUN ? '[DRY RUN] Would upsert' : 'Done.'} ${upserted} rows ${DRY_RUN ? '' : 'upserted '}into performance_audit (signal_type=OPTIMAL_STOP). ${correctedCount} used the corrected-resim target methodology this run.`);
  console.log('Every setup_type now gets its own stop swept across its own MAE percentiles (p25/p40/p50/p60/p75/p90), not a blanket p75_mae rule.');
  if (DRY_RUN) console.log('DRY RUN — nothing was written. Re-run without --dry-run to commit.');
  process.exit(0);
}

// Guarded so this file can be safely `import`ed (e.g. by test_invariants.mjs for
// computeEvAtStopTarget/DEFAULT_DPP) without triggering a live DB run as a side effect.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error('FATAL:', err); process.exit(1); });
}
