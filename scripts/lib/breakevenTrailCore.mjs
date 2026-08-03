// Shared breakeven-then-trail simulation core, extracted from backtest_breakeven_trail.mjs
// 2026-08-03 so a day-type-partitioned variant (backtest_ib_daytype_breakeven_trail.mjs)
// doesn't have to hand-copy the bar-by-bar trail state machine — per this codebase's own
// "share modules, don't reimplement" rule (a second copy of an error-prone state machine
// is exactly the failure class that produced the two-independent-classifyRegime()-
// implementations-disagreeing incident this rule exists to prevent).
//
// testTrailForPopulation() is a byte-for-byte behavioral extraction of the original
// script's per-setupType loop body (walk -> pullback distribution -> candidate trail
// widths -> per-candidate simulation -> plateau/IS-OOS/rigor selection). Verified by
// re-running backtest_breakeven_trail.mjs after the extraction and confirming identical
// funnel counts and survivor set to the pre-refactor version.

import { LIVE_INSTRUMENT } from '../../server/config/instruments.js';
import { computeRigor } from '../../server/services/rigorDiagnostics.js';

export const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
export const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;

export function exactPnl(entry, exitPrice, long) {
  const signedPoints = long ? (exitPrice - entry) : (entry - exitPrice);
  return signedPoints * PNL_PER_POINT - COMMISSION;
}

export const WALK_WINDOW_BARS = 390;
export const TRAIL_PERCENTILES_A = [0.25, 0.35, 0.50];
export const TRAIL_PERCENTILES_B = [0.65, 0.75, 0.85, 0.90, 0.95];
export const MIN_N = 20;

export function percentile(sortedArr, p) {
  if (!sortedArr.length) return null;
  const idx = Math.min(sortedArr.length - 1, Math.floor(sortedArr.length * p));
  return sortedArr[idx];
}

export function firstIndexAfter(allBars, t) {
  let lo = 0, hi = allBars.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts <= t) lo = mid + 1; else hi = mid; }
  return lo;
}

/**
 * Runs the full breakeven-then-trail candidate test for ONE (population, tier) pair.
 *
 * trades: array of rows with { fired_at (Date), entry_zone_low, entry_zone_high,
 *   resolution, replay_resolution, actual_pnl } — same shape as the active_setups
 *   columns both callers query.
 * long: boolean direction.
 * stop/originalTarget: the fixed baseline stop/target this population's OPTIMAL_STOP
 *   row currently carries.
 * allBars: full NQ 1-min bar array (symbol='NQ', ordered by ts ASC), shared across
 *   every population tested in a run.
 * tier: 'A' (snug trail) | 'B' (wide trail).
 * minTrailWidth/minTightTrail: market-derived floors (median 1-min bar range, and 2x
 *   that) — same value used for every population in a run, computed once by the caller.
 *
 * Returns { funnelReason } if the population didn't clear a gate (one of
 * 'tooFewWalked'|'noPullbackData'|'thinTail'|'noPlateauPass'|'failedOosOrBaseline'|
 * 'notRigorClean'), or { funnelReason: 'survived', result } on success — result has
 * the exact same fields the original script persisted to BREAKEVEN_TRAIL_TEST.
 */
export function testTrailForPopulation({ trades, long, stop, originalTarget, allBars, tier, minTrailWidth, minTightTrail }) {
  const walked = [];
  for (const t of trades) {
    const entry = t.entry_zone_high ?? t.entry_zone_low;
    const startIdx = firstIndexAfter(allBars, new Date(t.fired_at).getTime());
    const endIdx = Math.min(allBars.length, startIdx + WALK_WINDOW_BARS);
    if (startIdx >= endIdx) continue;
    walked.push({ trade: t, entry, startIdx, endIdx });
  }
  if (walked.length < MIN_N) return { funnelReason: 'tooFewWalked' };

  const pullbacks = [];
  for (const w of walked) {
    if (!(w.trade.replay_resolution === 'TARGET_HIT' || w.trade.resolution === 'TARGET_HIT')) continue;
    let maxFav = -Infinity;
    let maxPullbackSinceNewFav = 0;
    for (let i = w.startIdx; i < w.endIdx; i++) {
      const bar = allBars[i];
      const fav = long ? bar.high - w.entry : w.entry - bar.low;
      if (fav > maxFav) {
        if (maxPullbackSinceNewFav > 0) pullbacks.push(maxPullbackSinceNewFav);
        maxFav = fav;
        maxPullbackSinceNewFav = 0;
      } else {
        const currentAdvFromMax = maxFav - fav;
        if (currentAdvFromMax > maxPullbackSinceNewFav) maxPullbackSinceNewFav = currentAdvFromMax;
      }
    }
  }
  pullbacks.sort((a, b) => a - b);
  if (pullbacks.length === 0) return { funnelReason: 'noPullbackData' };

  const percentiles = tier === 'A' ? TRAIL_PERCENTILES_A : TRAIL_PERCENTILES_B;
  const minTrail = tier === 'A' ? minTightTrail : minTrailWidth;
  const trailCandidates = [...new Set(percentiles.map(p => +percentile(pullbacks, p).toFixed(1)))].filter(c => c >= minTrail);
  if (trailCandidates.length === 0) return { funnelReason: 'noPullbackData' };

  const simResults = [];
  let t1ReachedTotal = 0;
  const baselineEvents = [];

  for (const w of walked) {
    const entry = w.entry;
    const targetPrice = long ? entry + originalTarget : entry - originalTarget;
    const stopPrice = long ? entry - stop : entry + stop;
    let outcomeA = null;
    let t1Reached = false;
    let pnlA = null;

    for (let i = w.startIdx; i < w.endIdx; i++) {
      const bar = allBars[i];
      if (outcomeA === null) {
        const tHit = long ? bar.high >= targetPrice : bar.low <= targetPrice;
        const sHit = long ? bar.low <= stopPrice : bar.high >= stopPrice;
        if (tHit && sHit) outcomeA = 'STOP';
        else if (tHit) outcomeA = 'TARGET';
        else if (sHit) outcomeA = 'STOP';

        if (outcomeA === 'TARGET') { pnlA = exactPnl(entry, targetPrice, long); t1Reached = true; }
        else if (outcomeA === 'STOP') { pnlA = exactPnl(entry, stopPrice, long); }
      }
    }
    if (t1Reached) t1ReachedTotal++;
    baselineEvents.push({ date: w.trade.fired_at.toISOString().slice(0, 10), pnl: pnlA === null ? w.trade.actual_pnl : pnlA });
  }

  if (t1ReachedTotal < 15) return { funnelReason: 'thinTail' };

  const baselineSplitIdx = Math.floor(baselineEvents.length * (2 / 3));
  const baselineEv = baselineEvents.reduce((s, e) => s + e.pnl, 0) / baselineEvents.length;
  const baselineOosEv = baselineEvents.slice(baselineSplitIdx).reduce((s, e) => s + e.pnl, 0) / (baselineEvents.length - baselineSplitIdx);

  for (const trail of trailCandidates) {
    let totalEv = 0;
    const events = [];
    let scratches = 0;
    let t1Wins = 0;

    for (const w of walked) {
      const entry = w.entry;
      const targetPrice = long ? entry + originalTarget : entry - originalTarget;
      let currentStopPrice = long ? entry - stop : entry + stop;
      let outcome = null;
      let pnl = null;
      let runningExtreme = -Infinity;
      let targetHit = false;
      let scratched = false;

      for (let i = w.startIdx; i < w.endIdx; i++) {
        const bar = allBars[i];

        const hours = bar.dateObj.getUTCHours();
        const mins = bar.dateObj.getUTCMinutes();
        let sessionEnd = false;
        if (i === w.endIdx - 1) sessionEnd = true;
        else if ((hours > 16) || (hours === 16 && mins >= 0)) sessionEnd = true;

        if (!targetHit) {
          const tHit = long ? bar.high >= targetPrice : bar.low <= targetPrice;
          const sHit = long ? bar.low <= currentStopPrice : bar.high >= currentStopPrice;

          if (tHit && sHit) outcome = 'STOP';
          else if (tHit) {
            targetHit = true;
            currentStopPrice = entry;
            runningExtreme = long ? bar.high : bar.low;

            const sHitBE = long ? bar.low <= currentStopPrice : bar.high >= currentStopPrice;
            if (sHitBE) {
              outcome = 'TRAIL_STOP';
              pnl = exactPnl(entry, currentStopPrice, long);
              scratched = true;
            }
          }
          else if (sHit) outcome = 'STOP';

          if (outcome === 'STOP') { pnl = exactPnl(entry, currentStopPrice, long); }
        } else if (outcome === null) {
          const high = bar.high, low = bar.low;
          if (long && high > runningExtreme) runningExtreme = high;
          if (!long && low < runningExtreme) runningExtreme = low;

          const rawTrailStop = long ? runningExtreme - trail : runningExtreme + trail;
          const candidateStop = long ? Math.max(entry, rawTrailStop) : Math.min(entry, rawTrailStop);

          if (long && candidateStop > currentStopPrice) currentStopPrice = candidateStop;
          if (!long && candidateStop < currentStopPrice) currentStopPrice = candidateStop;

          const trHit = long ? low <= currentStopPrice : high >= currentStopPrice;
          if (trHit) {
            outcome = 'TRAIL_STOP';
            pnl = exactPnl(entry, currentStopPrice, long);
            if (currentStopPrice === entry) scratched = true;
          }
        }

        if (outcome === null && sessionEnd) {
          outcome = 'TIME_EXPIRED';
          pnl = exactPnl(entry, bar.close, long);
          if (pnl <= 0 && targetHit) scratched = true;
        }

        if (outcome !== null) break;
      }

      if (outcome === null) {
        pnl = exactPnl(entry, allBars[w.endIdx - 1].close, long);
        if (pnl <= 0 && targetHit) scratched = true;
      }

      if (targetHit) {
        t1Wins++;
        if (scratched) scratches++;
      }

      totalEv += pnl;
      events.push({ date: w.trade.fired_at.toISOString().split('T')[0], tradeEv: pnl });
    }

    const ev = totalEv / walked.length;
    simResults.push({ trail, ev, events, scratches, t1Wins });
  }

  const numWalked = walked.length;
  const splitIdx = Math.floor(numWalked * (2 / 3));

  let bestInSample = null;
  for (const res of simResults) {
    const isEv = res.events.slice(0, splitIdx).reduce((acc, e) => acc + e.tradeEv, 0) / splitIdx;
    if (!bestInSample || isEv > bestInSample.isEv) {
      bestInSample = { ...res, isEv };
    }
  }

  let plateauPassed = false;
  let trailNeighborsNotes = '';
  if (bestInSample) {
    const b_t = bestInSample.trail;
    let tIdx = trailCandidates.indexOf(b_t);

    const neighbors = [];
    const trNeighbors = [];

    if (tIdx > 0) {
      const n = simResults.find(r => r.trail === trailCandidates[tIdx - 1]);
      neighbors.push(n); if (n) trNeighbors.push(n);
    }
    if (tIdx < trailCandidates.length - 1) {
      const n = simResults.find(r => r.trail === trailCandidates[tIdx + 1]);
      neighbors.push(n); if (n) trNeighbors.push(n);
    }

    plateauPassed = neighbors.every(n => n && n.events.slice(0, splitIdx).reduce((acc, e) => acc + e.tradeEv, 0) / splitIdx > 0);

    const getOosEv = (events) => events.slice(splitIdx).reduce((acc, e) => acc + e.tradeEv, 0) / (events.length - splitIdx);
    trailNeighborsNotes = trNeighbors.map(n => `trail=${n.trail}: IS $${(n.events.slice(0, splitIdx).reduce((acc, e) => acc + e.tradeEv, 0) / splitIdx).toFixed(2)} OOS $${getOosEv(n.events).toFixed(2)}`).join(', ');
  }

  if (!bestInSample) return { funnelReason: 'noPullbackData' };
  if (!plateauPassed) return { funnelReason: 'noPlateauPass' };

  const oosEv = bestInSample.events.slice(splitIdx).reduce((acc, e) => acc + e.tradeEv, 0) / (numWalked - splitIdx);
  const fullEv = bestInSample.ev;

  if (!(oosEv > 0 && fullEv > baselineEv && oosEv > baselineOosEv)) return { funnelReason: 'failedOosOrBaseline' };

  const rigor = computeRigor(bestInSample.events, { dateField: 'date', pnlFn: e => e.tradeEv });
  if (!rigor.clean) return { funnelReason: 'notRigorClean' };

  const scratchRate = bestInSample.scratches / bestInSample.t1Wins;
  return {
    funnelReason: 'survived',
    result: {
      trail: bestInSample.trail, baselineEv, baselineOosEv, fullEv, isEv: bestInSample.isEv, oosEv,
      t1Reached: t1ReachedTotal, scratchRate, scratches: bestInSample.scratches, t1Wins: bestInSample.t1Wins,
      rigor, trailNeighborsNotes,
    },
  };
}
