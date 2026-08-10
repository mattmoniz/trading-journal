// Chronologically-resimulated, guardrailed target selection -- the corrected replacement
// for the live sweepOptimalTarget()'s two structural flaws (scripts/update_optimal_stops.mjs):
//   1. It picks from a fixed point grid capped at p75_mfe, and mfe_points is truncated the
//      instant the ORIGINAL target resolves -- the live calibration has never seen genuine
//      post-target continuation (OPEN_DECISION optimal_target_blind_to_post_resolution_continuation).
//   2. It's chronologically order-blind: checks "did MAE exceed stop" and "did MFE reach
//      target" as two independent facts, no notion of which happened first.
//
// This is the SHARED core extracted 2026-07-19 from scripts/backtest_target_sweep_v2.mjs
// (where the corrected methodology was built and validated) so scripts/update_optimal_stops.mjs
// (the live pipeline) can use the identical, already-audited logic rather than a second
// hand-copied version -- see CLAUDE.md's "Share modules when the same logic would
// otherwise be reimplemented" convention. Full design conversation: docs/TARGET_CALIBRATION_SPEC.md.
//
// Guardrails (all required to return a non-null result):
//   - Thin-tail gate: a candidate needs >=MIN_TARGET_HITS trades that actually reached it.
//   - Candidate grid ANCHORED to the current live target (1.0x-2.0x) unioned with
//     percentiles of the true (untruncated) MFE distribution -- so the search can't skip
//     past the region already known to matter.
//   - Chronological out-of-sample split: best candidate picked using only the first 2/3 of
//     trade history, validated against the held-out last 1/3.
//   - Plateau check: the two candidates immediately adjacent BY VALUE must also be
//     thin-tail-eligible and in-sample-positive -- rejects isolated spikes.
//   - Must beat the baseline (100%-at-old-target, resimulated the SAME way) both
//     full-sample AND out-of-sample.
//   - Rigor-clean (computeRigor): no day-clustering, stable across chronological thirds.

import { computeRigor } from './rigorDiagnostics.js';

export const WALK_WINDOW_BARS = 390; // ~6.5hr from entry
export const CANDIDATE_PERCENTILES = [0.40, 0.50, 0.60, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95];
export const ANCHOR_MULTIPLES = [1.0, 1.1, 1.25, 1.5, 1.75, 2.0];
export const MIN_TARGET_HITS = 15;
export const MIN_N = 20;

function percentile(sortedArr, p) {
  const idx = Math.min(sortedArr.length - 1, Math.floor(sortedArr.length * p));
  return sortedArr[idx];
}

// Plateau selection (2026-08-10, roadmap item "plateau selection instead of argmax" --
// replaces argmax-then-validate-neighbors as the PRIMARY selection rule, not just an
// add-on check). Argmax picks whichever single candidate has the highest in-sample EV --
// exactly the statistic most prone to picking a noisy spike. The prior version already knew
// this (a plateau-neighbor check existed as a guardrail), but only ever validated the ARGMAX
// WINNER's own two immediate neighbors: if that specific candidate wasn't part of a genuine
// plateau, the whole computation was excluded (`failed_plateau_check`) even when a real
// plateau existed elsewhere in the candidate grid. This version searches the FULL candidate
// range for the widest contiguous run (by value-adjacency in the grid) of candidates that are
// both thin-tail-eligible and in-sample-positive, and selects from within the widest run found
// -- so a genuine, wide plateau anywhere in the grid wins over an isolated spike, rather than
// only ever checking the one candidate argmax happened to prefer.
function selectPlateauTarget(eligible, sortedCandidates, splitIdx) {
  const isEvOf = (c) => c.events.slice(0, splitIdx).reduce((s, e) => s + e.pnl, 0) / splitIdx;
  const good = new Map(); // target -> { ...candidateResult, isEv }
  for (const c of eligible) {
    const isEv = isEvOf(c);
    if (isEv > 0) good.set(c.target, { ...c, isEv });
  }
  if (good.size === 0) return null;

  // Walk the FULL candidate grid (not just the "good" subset) so a gap -- a candidate that
  // exists in the grid but isn't thin-tail-eligible or isn't in-sample-positive -- correctly
  // breaks a run, matching what "contiguous" means for this candidate set.
  const runs = [];
  let current = [];
  for (const T of sortedCandidates) {
    if (good.has(T)) {
      current.push(good.get(T));
    } else if (current.length) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length) runs.push(current);

  // Minimum width 2 -- matches the old check's own strictness (it required at least one good
  // neighbor, never accepted a fully isolated candidate). A run of exactly 1 is not a plateau.
  const plateauRuns = runs.filter(r => r.length >= 2);
  if (!plateauRuns.length) return null;

  // Widest run wins; ties broken by highest average in-sample EV within the run -- width is
  // the primary signal of a genuine region (per the roadmap's own framing), not peak height.
  plateauRuns.sort((a, b) => (b.length - a.length) || ((b.reduce((s, m) => s + m.isEv, 0) / b.length) - (a.reduce((s, m) => s + m.isEv, 0) / a.length)));
  const bestRun = plateauRuns[0];
  // Within the winning run, select its own best-EV member (not the grid's global best, and not
  // a plain average across the run either -- still requires the specific candidate to prove
  // itself, just now scoped to a run that's already shown to be a genuine region).
  const winner = bestRun.reduce((best, m) => (!best || m.isEv > best.isEv) ? m : best, null);
  return { ...winner, plateauWidth: bestRun.length, plateauMembers: bestRun.map(m => m.target) };
}

export function makeBarIndex(allBars) {
  return (t) => {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts <= t) lo = mid + 1; else hi = mid; }
    return lo;
  };
}

/**
 * trades: array of { fired_at (Date), entry_zone_low, entry_zone_high, actual_pnl }
 * allBars: array of { ts (epoch ms), high, low }, sorted ascending by ts
 * Returns null if no candidate clears every guardrail, else
 * { bestTarget, baselineEv, isEv, oosEv, fullEv, targetHits, n, candidatesTested, rigor,
 *   exclusionReason?, exclusionDetail? } -- exclusion fields set only on the null path's
 *   caller-facing diagnostic variant (computeCorrectedTargetVerbose).
 */
export function computeCorrectedTarget({ trades, allBars, stop, oldTarget, long, pnlPerPoint, commission }) {
  const firstIndexAfter = makeBarIndex(allBars);
  const walked = [];
  for (const t of trades) {
    const entry = t.entry_zone_high ?? t.entry_zone_low;
    const startIdx = firstIndexAfter(new Date(t.fired_at).getTime());
    const endIdx = Math.min(allBars.length, startIdx + WALK_WINDOW_BARS);
    if (startIdx >= endIdx) continue;
    walked.push({ trade: t, entry, startIdx, endIdx });
  }
  if (walked.length < MIN_N) return { exclusionReason: 'insufficient_bar_data', exclusionDetail: `only ${walked.length} of ${trades.length} trades had bars` };

  // Self-calibrating outlier guard (2026-08-02, matching data_sanity_audit.mjs's existing
  // "10x p95"-style convention for this exact class of problem): a walked trade whose
  // favorable excursion exceeds 10x the CURRENT live target is far more likely to be a
  // fired_at/bar-index data artifact (walking from the wrong point in time and picking up
  // unrelated price action) than genuine edge -- found via VWAP_MAGNET_LONG, where a batch
  // of BACKFILL rows with a corrupted fired_at let a real-but-unrelated ~1,590pt overnight
  // move get misattributed as "favorable excursion since entry," producing a 454.5pt
  // candidate against a real p75_mfe of 30.8pt. Filtering the BACKFILL source at the query
  // level (update_optimal_stops.mjs) is the primary fix; this is defense in depth so a
  // future bad row can't reproduce the same failure silently. Discarded count surfaced in
  // the return value rather than silently dropped, per the standing no-dead-ends rule.
  const outlierCap = oldTarget * 10;
  let outliersDiscarded = 0;
  const trueMfes = walked.map(w => {
    let maxFav = -Infinity;
    for (let i = w.startIdx; i < w.endIdx; i++) {
      const bar = allBars[i];
      const fav = long ? bar.high - w.entry : w.entry - bar.low;
      if (fav > maxFav) maxFav = fav;
    }
    return maxFav;
  }).filter(v => {
    if (v <= 0) return false;
    if (v > outlierCap) { outliersDiscarded++; return false; }
    return true;
  }).sort((a, b) => a - b);
  if (!trueMfes.length) return { exclusionReason: 'no_positive_mfe', exclusionDetail: 'every walked trade had zero/negative favorable excursion' };

  const anchored = ANCHOR_MULTIPLES.map(m => +(oldTarget * m).toFixed(1));
  const percentileCands = CANDIDATE_PERCENTILES.map(p => +percentile(trueMfes, p).toFixed(1));
  const candidates = [...new Set([...anchored, ...percentileCands])].filter(c => c > 0).sort((a, b) => a - b);

  const candidateResults = candidates.map(T => {
    const events = [];
    let targetHits = 0, stopHits = 0, unresolved = 0;
    for (const w of walked) {
      const targetPrice = long ? w.entry + T : w.entry - T;
      const stopPrice = long ? w.entry - stop : w.entry + stop;
      let outcome = null;
      for (let i = w.startIdx; i < w.endIdx; i++) {
        const bar = allBars[i];
        const targetHit = long ? bar.high >= targetPrice : bar.low <= targetPrice;
        const stopHit = long ? bar.low <= stopPrice : bar.high >= stopPrice;
        if (targetHit && stopHit) { outcome = 'STOP'; break; }
        if (targetHit) { outcome = 'TARGET'; break; }
        if (stopHit) { outcome = 'STOP'; break; }
      }
      let pnl;
      if (outcome === 'TARGET') { pnl = T * pnlPerPoint - commission; targetHits++; }
      else if (outcome === 'STOP') { pnl = -(stop * pnlPerPoint + commission); stopHits++; }
      else { pnl = w.trade.actual_pnl; unresolved++; }
      events.push({ date: w.trade.fired_at.toISOString().slice(0, 10), pnl });
    }
    return { target: T, events, targetHits, stopHits, unresolved, n: walked.length };
  });

  const numWalked = walked.length;
  const splitIdx = Math.floor(numWalked * (2 / 3));
  const eligible = candidateResults.filter(c => c.targetHits >= MIN_TARGET_HITS);
  if (!eligible.length) return { exclusionReason: 'no_candidate_cleared_thin_tail', exclusionDetail: `best candidate targetHits=${Math.max(...candidateResults.map(c => c.targetHits), 0)} (need >=${MIN_TARGET_HITS})` };

  const bestInSample = selectPlateauTarget(eligible, candidates, splitIdx);
  if (!bestInSample) {
    const argmaxPeek = eligible.reduce((best, c) => {
      const isEv = c.events.slice(0, splitIdx).reduce((s, e) => s + e.pnl, 0) / splitIdx;
      return (!best || isEv > best.isEv) ? { target: c.target, isEv } : best;
    }, null);
    return { exclusionReason: 'no_plateau_found', exclusionDetail: `no contiguous run of >=2 thin-tail-eligible, in-sample-positive candidates exists across ${candidates.length} candidates (${eligible.length} cleared thin-tail)${argmaxPeek ? ` -- single best-by-EV candidate was T=${argmaxPeek.target} (isEv=$${argmaxPeek.isEv.toFixed(2)}), an isolated spike with no qualifying neighbor` : ''}` };
  }

  const oosSlice = bestInSample.events.slice(splitIdx);
  const oosEv = oosSlice.reduce((s, e) => s + e.pnl, 0) / (numWalked - splitIdx);
  const fullEv = bestInSample.events.reduce((s, e) => s + e.pnl, 0) / numWalked;

  const baselineCand = candidateResults.find(c => c.target === +oldTarget.toFixed(1))
    || candidateResults.find(c => Math.abs(c.target - oldTarget) < 0.5);
  const baselineEv = baselineCand ? baselineCand.events.reduce((s, e) => s + e.pnl, 0) / numWalked : null;
  if (baselineEv === null || !(oosEv > 0 && fullEv > baselineEv)) {
    return { exclusionReason: baselineEv === null ? 'no_baseline_candidate' : 'failed_oos_or_baseline', exclusionDetail: baselineEv === null ? 'old target not among candidates' : `oosEv=$${oosEv.toFixed(2)}, fullEv=$${fullEv.toFixed(2)} vs baselineEv=$${baselineEv.toFixed(2)}` };
  }

  const rigor = computeRigor(bestInSample.events, { pnlFn: e => e.pnl });
  if (!rigor.clean) return { exclusionReason: 'not_rigor_clean', exclusionDetail: JSON.stringify(rigor) };

  return {
    bestTarget: bestInSample.target, baselineEv: +baselineEv.toFixed(2),
    isEv: +bestInSample.isEv.toFixed(2), oosEv: +oosEv.toFixed(2), fullEv: +fullEv.toFixed(2),
    targetHits: bestInSample.targetHits, n: numWalked, candidatesTested: candidates, rigor,
    outliersDiscarded,
    // Surfaced so a consumer can distinguish "picked from a wide, robust region" from "barely
    // cleared the width-2 floor" -- not gated on anywhere yet, but per the no-dead-ends rule this
    // needs to be visible/queryable, not just computed and dropped, the moment it exists.
    plateauWidth: bestInSample.plateauWidth, plateauMembers: bestInSample.plateauMembers,
  };
}
