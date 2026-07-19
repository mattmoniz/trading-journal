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

  const trueMfes = walked.map(w => {
    let maxFav = -Infinity;
    for (let i = w.startIdx; i < w.endIdx; i++) {
      const bar = allBars[i];
      const fav = long ? bar.high - w.entry : w.entry - bar.low;
      if (fav > maxFav) maxFav = fav;
    }
    return maxFav;
  }).filter(v => v > 0).sort((a, b) => a - b);
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

  let bestInSample = null;
  for (const c of eligible) {
    const isSlice = c.events.slice(0, splitIdx);
    const isEv = isSlice.reduce((s, e) => s + e.pnl, 0) / splitIdx;
    if (!bestInSample || isEv > bestInSample.isEv) bestInSample = { ...c, isEv };
  }

  const idx = candidates.indexOf(bestInSample.target);
  const neighborTargets = [candidates[idx - 1], candidates[idx + 1]].filter(t => t !== undefined);
  const neighborResults = neighborTargets.map(t => candidateResults.find(c => c.target === t));
  const plateauPassed = neighborResults.length > 0 && neighborResults.every(n => {
    if (n.targetHits < MIN_TARGET_HITS) return false;
    const isEv = n.events.slice(0, splitIdx).reduce((s, e) => s + e.pnl, 0) / splitIdx;
    return isEv > 0;
  });
  if (!plateauPassed) return { exclusionReason: 'failed_plateau_check', exclusionDetail: `best candidate T=${bestInSample.target} (isEv=$${bestInSample.isEv.toFixed(2)}) is an isolated spike` };

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
  };
}
