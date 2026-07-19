// Corrected Layer 1 target calibration (see docs/TARGET_CALIBRATION_SPEC.md for the full
// design conversation this came out of). Replaces the two flaws in the LIVE
// sweepOptimalTarget() (scripts/update_optimal_stops.mjs):
//
//   1. It picks from a fixed point grid (TARGET_SWEEP = [10..150]) capped at p75_mfe --
//      and mfe_points is truncated the instant the ORIGINAL target resolves, so the live
//      calibration has never seen genuine post-target continuation (OPEN_DECISION
//      optimal_target_blind_to_post_resolution_continuation, 2026-07-19).
//   2. It's chronologically order-blind: computeEvAtStopTarget checks "did MAE exceed
//      stop" and "did MFE reach target" as two independent facts with no notion of which
//      happened first.
//
// Fix: candidate targets are drawn from PERCENTILES of the real, untruncated MFE
// (walked fresh from ENTRY) -- data-derived, not a hardcoded list. Each candidate is
// scored via genuine bar-by-bar chronological resimulation from entry. Stop is held
// FIXED at the current live OPTIMAL_STOP value -- this script only re-derives the target.
//
// v2.1 (2026-07-19, second pass): the FIRST version of this script failed its own
// sanity check -- several setups picked absurd "best" targets (e.g. 719.8pt) off a
// SINGLE outlier trade (targetHits=1). Root cause: (a) no thin-tail gate, so a candidate
// backed by 1-2 trades could "win" purely off one lucky dollar figure; (b) the candidate
// grid jumped straight to the 40th-95th percentile of true MFE, skipping past the
// already-validated region near the CURRENT live target entirely (for
// PD_SESSION_MID_FADE_SHORT, the smallest candidate tested was 88.5pt even though the
// earlier, properly-guardrailed wider-target test had already found ~75pt (1.5x) to be
// a real, positive improvement -- the sweep never even looked there).
//
// Fixed by applying the SAME guardrail methodology that made
// scripts/backtest_scaleout_runner.mjs trustworthy (Gemini-authored, Claude-audited,
// same day): (1) a thin-tail gate requiring a real number of trades to have actually
// reached a candidate before it's eligible to be picked "best"; (2) a candidate grid
// ANCHORED to the current live target (1.0x/1.1x/1.25x/1.5x/1.75x/2.0x) unioned with the
// true-MFE percentiles, so the sweep can't skip past the region that's already known to
// matter; (3) a genuine chronological out-of-sample split (pick best using only the
// first 2/3 of each setup's trade history, validate on the held-out last 1/3); (4) a
// plateau check against the immediate candidate neighbors (both must also be thin-tail-
// eligible and positive in-sample) so an isolated spike can't win; (5) computeRigor.
//
// Writes to signal_type='TARGET_SWEEP_V2' -- a NEW signal_type, deliberately NOT
// overwriting live OPTIMAL_STOP. Backtest-only, pending a promotion decision.
//
// Run: node scripts/backtest_target_sweep_v2.mjs
import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const WALK_WINDOW_BARS = 390; // ~6.5hr from entry
const CANDIDATE_PERCENTILES = [0.40, 0.50, 0.60, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95];
const ANCHOR_MULTIPLES = [1.0, 1.1, 1.25, 1.5, 1.75, 2.0]; // anchored to the CURRENT live target
const MIN_N = 20;
const MIN_TARGET_HITS = 15; // thin-tail gate, matches backtest_scaleout_runner.mjs's own floor

function percentile(sortedArr, p) {
  const idx = Math.min(sortedArr.length - 1, Math.floor(sortedArr.length * p));
  return sortedArr[idx];
}

async function main() {
  console.log('Loading current live OPTIMAL_STOP (stop held fixed, only re-deriving target)...');
  const optRes = await query(`
    SELECT DISTINCT ON (signal_name) signal_name as setup_type, optimal_stop, optimal_target
    FROM performance_audit WHERE signal_type='OPTIMAL_STOP'
    ORDER BY signal_name, run_date DESC
  `);
  const optMap = {};
  for (const r of optRes.rows) optMap[r.setup_type] = { stop: parseFloat(r.optimal_stop), oldTarget: parseFloat(r.optimal_target) };
  console.log(`${Object.keys(optMap).length} setup_types with a live OPTIMAL_STOP row.`);

  console.log('Loading eligible trades (entry+stop+resolution known, clean mae/mfe)...');
  const tradesRes = await query(`
    SELECT setup_type, fired_at, resolved_at, entry_zone_low::float as entry_zone_low,
      entry_zone_high::float as entry_zone_high, stop_level::float as stop_level,
      t1_level::float as t1_level, actual_pnl::float as actual_pnl, resolution
    FROM active_setups
    WHERE resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED') AND mae_points IS NOT NULL AND mfe_points IS NOT NULL
      AND mae_points <= 300 AND mfe_points <= 300 AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL
    ORDER BY fired_at ASC
  `);
  const allTrades = tradesRes.rows;
  console.log(`${allTrades.length} eligible trades.`);

  const byType = {};
  for (const t of allTrades) (byType[t.setup_type] ||= []).push(t);

  console.log('Loading NQ price bars...');
  const barsRes = await query(`SELECT ts, high::float as high, low::float as low FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
  const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), high: b.high, low: b.low }));
  console.log(`${allBars.length} bars loaded.`);

  function firstIndexAfter(t) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  const results = {};
  const funnel = { total: 0, noWalkedData: 0, noPlateauPass: 0, failedOosOrBaseline: 0, notRigorClean: 0, survived: 0 };
  const exclusions = {}; // setupType -> { reason, detail } -- per-setup context, not just aggregate counts
  const setupTypes = Object.keys(byType).filter(st => optMap[st] && byType[st].length >= MIN_N);
  funnel.total = setupTypes.length;
  console.log(`Sweeping ${setupTypes.length} setup_types with N>=${MIN_N} and a live stop...`);

  for (const setupType of setupTypes) {
    const trades = byType[setupType];
    const stop = optMap[setupType].stop;
    const oldTarget = optMap[setupType].oldTarget;
    const direction = inferDirection(setupType);
    if (!direction) continue;
    const long = direction === 'LONG';

    // Pass 1: walk from ENTRY through a bounded window, get the TRUE max favorable
    // excursion per trade -- used to build the candidate grid.
    const walked = [];
    for (const t of trades) {
      const entry = t.entry_zone_high ?? t.entry_zone_low;
      const startIdx = firstIndexAfter(new Date(t.fired_at).getTime());
      const endIdx = Math.min(allBars.length, startIdx + WALK_WINDOW_BARS);
      if (startIdx >= endIdx) continue;
      walked.push({ trade: t, entry, startIdx, endIdx });
    }
    if (walked.length < MIN_N) {
      funnel.noWalkedData++;
      exclusions[setupType] = { reason: 'insufficient_bar_data', detail: `only ${walked.length} of ${trades.length} trades had bars available within the window (need >=${MIN_N})` };
      continue;
    }

    const trueMfes = walked.map(w => {
      let maxFav = -Infinity;
      for (let i = w.startIdx; i < w.endIdx; i++) {
        const bar = allBars[i];
        const fav = long ? bar.high - w.entry : w.entry - bar.low;
        if (fav > maxFav) maxFav = fav;
      }
      return maxFav;
    }).filter(v => v > 0).sort((a, b) => a - b);
    if (!trueMfes.length) {
      funnel.noWalkedData++;
      exclusions[setupType] = { reason: 'no_positive_mfe', detail: 'every walked trade had zero/negative favorable excursion (should not happen for a real setup -- investigate)' };
      continue;
    }

    // Candidate grid: ANCHORED to the current live target (so the sweep can't skip past
    // the already-validated region) UNIONED with percentiles of the true MFE distribution
    // (for candidates beyond what's already been tested). Sorted ascending -- needed for
    // the plateau check below to mean "adjacent in value", not "adjacent in list order".
    const anchored = ANCHOR_MULTIPLES.map(m => +(oldTarget * m).toFixed(1));
    const percentileCands = CANDIDATE_PERCENTILES.map(p => +percentile(trueMfes, p).toFixed(1));
    const candidates = [...new Set([...anchored, ...percentileCands])].filter(c => c > 0).sort((a, b) => a - b);

    // Pass 2: for each candidate target, chronologically resimulate every trade from
    // entry, storing PER-TRADE pnl (chronologically ordered, same order as `walked`) so
    // we can do a genuine chronological out-of-sample split below.
    const candidateResults = candidates.map(T => {
      const targetPrice0 = null; // computed per-trade below (direction-dependent)
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
        // Exact commission formula (points*PNL_PER_POINT +/- COMMISSION), not a flat dpp
        // multiplier -- FIXED (Claude audit, 2026-07-19, per user question "are you
        // including commissions"). A flat empirically-derived dpp (~1.97-2.06, calibrated
        // on whatever distance a setup's historical trades typically used) is only an
        // approximation of the true formula, and drifts further from it the more a
        // candidate target/stop differs from that calibration distance -- worst for
        // setups with unusually tight stops (a few pt), where the flat $1 commission is a
        // much larger fraction of the trade's total point value. The live resolution path
        // (server/routes/acd.js) always uses the exact formula; this script now matches it.
        let pnl;
        if (outcome === 'TARGET') { pnl = T * PNL_PER_POINT - COMMISSION; targetHits++; }
        else if (outcome === 'STOP') { pnl = -(stop * PNL_PER_POINT + COMMISSION); stopHits++; }
        else { pnl = w.trade.actual_pnl; unresolved++; }
        events.push({ date: w.trade.fired_at.toISOString().slice(0, 10), pnl });
      }
      return { target: T, events, targetHits, stopHits, unresolved, n: walked.length };
    });

    // Thin-tail gate: a candidate is only eligible to be "best" if enough trades ACTUALLY
    // reached it over the full sample (targetHits >= MIN_TARGET_HITS) -- a candidate
    // backed by 1-2 lucky trades (the exact bug this rewrite fixes) never becomes eligible.
    const numWalked = walked.length;
    const splitIdx = Math.floor(numWalked * (2 / 3));
    const eligible = candidateResults.filter(c => c.targetHits >= MIN_TARGET_HITS);

    if (!eligible.length) {
      funnel.noWalkedData++;
      exclusions[setupType] = { reason: 'no_candidate_cleared_thin_tail', detail: `N=${numWalked}, best candidate targetHits=${Math.max(...candidateResults.map(c => c.targetHits), 0)} (need >=${MIN_TARGET_HITS})` };
      continue;
    }

    // Pick best-in-sample among ELIGIBLE candidates only (using first-2/3 EV).
    let bestInSample = null;
    for (const c of eligible) {
      const isSlice = c.events.slice(0, splitIdx);
      const isEv = isSlice.reduce((s, e) => s + e.pnl, 0) / splitIdx;
      if (!bestInSample || isEv > bestInSample.isEv) bestInSample = { ...c, isEv };
    }

    // Plateau check: the two candidates immediately adjacent BY VALUE must also be
    // thin-tail-eligible and have positive in-sample EV -- an isolated spike (eligible
    // itself, but surrounded by thin/negative neighbors) fails this.
    const idx = candidates.indexOf(bestInSample.target);
    const neighborTargets = [candidates[idx - 1], candidates[idx + 1]].filter(t => t !== undefined);
    const neighborResults = neighborTargets.map(t => candidateResults.find(c => c.target === t));
    const plateauPassed = neighborResults.length > 0 && neighborResults.every(n => {
      if (n.targetHits < MIN_TARGET_HITS) return false;
      const isEv = n.events.slice(0, splitIdx).reduce((s, e) => s + e.pnl, 0) / splitIdx;
      return isEv > 0;
    });

    if (!plateauPassed) {
      funnel.noPlateauPass++;
      exclusions[setupType] = { reason: 'failed_plateau_check', detail: `best candidate T=${bestInSample.target} (isEv=$${bestInSample.isEv.toFixed(2)}) is an isolated spike -- neighbor(s) at T=${neighborTargets.join(',')} are thin or non-positive` };
      continue;
    }

    const oosSlice = bestInSample.events.slice(splitIdx);
    const oosEv = oosSlice.reduce((s, e) => s + e.pnl, 0) / (numWalked - splitIdx);
    const fullEv = bestInSample.events.reduce((s, e) => s + e.pnl, 0) / numWalked;

    // Baseline: the CURRENT live target, resimulated the SAME chronological way (fair
    // apples-to-apples comparison, not the old order-blind computeEvAtStopTarget number).
    const baselineCand = candidateResults.find(c => c.target === +oldTarget.toFixed(1))
      || candidateResults.find(c => Math.abs(c.target - oldTarget) < 0.5);
    const baselineEv = baselineCand ? baselineCand.events.reduce((s, e) => s + e.pnl, 0) / numWalked : null;

    if (baselineEv === null || !(oosEv > 0 && fullEv > baselineEv)) {
      funnel.failedOosOrBaseline++;
      exclusions[setupType] = { reason: baselineEv === null ? 'no_baseline_candidate' : 'failed_oos_or_baseline', detail: baselineEv === null ? 'old live target was not among the candidate set (should not happen -- investigate)' : `T=${bestInSample.target}: oosEv=$${oosEv.toFixed(2)} (need >0), fullEv=$${fullEv.toFixed(2)} vs baselineEv=$${baselineEv.toFixed(2)}` };
      continue;
    }

    const rigor = computeRigor(bestInSample.events, { pnlFn: e => e.pnl });
    if (!rigor.clean) {
      funnel.notRigorClean++;
      exclusions[setupType] = { reason: 'not_rigor_clean', detail: `T=${bestInSample.target}: ${JSON.stringify(rigor)}` };
      continue;
    }

    funnel.survived++;
    results[setupType] = {
      stop, n: numWalked, oldTarget, baselineEv: +baselineEv.toFixed(2),
      bestTarget: bestInSample.target, isEv: +bestInSample.isEv.toFixed(2),
      oosEv: +oosEv.toFixed(2), fullEv: +fullEv.toFixed(2),
      targetHits: bestInSample.targetHits, candidatesTested: candidates, rigor,
    };
    console.log(`${setupType}: stop=${stop} oldTarget=${oldTarget} (baselineEv=$${baselineEv.toFixed(2)}) -> NEW target=${bestInSample.target} fullEv=$${fullEv.toFixed(2)} oosEv=$${oosEv.toFixed(2)} (N=${numWalked}, targetHits=${bestInSample.targetHits})`);
  }
  console.log('\nGuardrail funnel:', JSON.stringify(funnel));
  console.log('\nPer-setup exclusion reasons:');
  for (const [st, ex] of Object.entries(exclusions)) console.log(`  ${st}: ${ex.reason} -- ${ex.detail}`);

  const today = (await query(`SELECT CURRENT_DATE::text as d`)).rows[0].d;
  for (const [setupType, r] of Object.entries(results)) {
    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, ev_per_trade, notes)
      VALUES ($1, 0, 'TARGET_SWEEP_V2', $2, $3, $4, $5)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
        SET sample_size=EXCLUDED.sample_size, ev_per_trade=EXCLUDED.ev_per_trade, notes=EXCLUDED.notes
    `, [today, setupType, r.n, r.fullEv, JSON.stringify(r)]);
  }
  console.log(`\nPersisted ${Object.keys(results).length} rows to performance_audit (signal_type='TARGET_SWEEP_V2').`);

  // Self-cleaning (CLAUDE.md hard rule, 2026-07-19): this exact table needed a manual
  // 85-row cleanup once already after a guardrail-tightening rewrite left the OLD
  // (spike-picking) run's rows sitting untouched under the same run_date. Delete anything
  // this run didn't produce so it can't happen silently again.
  const survivorNames = Object.keys(results);
  const staleRes = await query(`
    DELETE FROM performance_audit WHERE signal_type='TARGET_SWEEP_V2' AND NOT (signal_name = ANY($1))
    RETURNING signal_name
  `, [survivorNames]);
  if (staleRes.rows.length) console.log(`Cleaned up ${staleRes.rows.length} stale row(s) no longer surviving: ${staleRes.rows.map(r => r.signal_name).join(', ')}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
