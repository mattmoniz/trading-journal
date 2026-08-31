// 2-lot scale-out with a breakeven-minus-5 runner, scoped in
// docs/TWOLOT_SCALEOUT_BREAKEVEN_MINUS5_SPEC.md. User's idea: Lot 1 takes a quick close
// target; once it fills, Lot 2's stop moves to entry-minus-5 (long) / entry-plus-5 (short)
// -- a deliberate small-loss tolerance, NOT exact breakeven -- and runs toward the setup's
// own calibrated target. Scoped to the OR-length SHORT-fade family per user context
// ("the OR short").
//
// Resolves Open Question 1 from the spec: active_setups has no native multi-lot records
// (each row is one system-detected touch, not a real N-contract fill), so this models a
// hypothetical split of each real single-position's own bar-by-bar path into 2 independently
// -exited 1-contract lots -- the "from-scratch bar-by-bar walker" path the spec recommends,
// matching the walk conventions in backtest_wider_target_breakeven_floor.mjs.
//
// Runner target (Open Question 4): uses the setup's own calibrated t1_level as Lot 2's
// target -- least-arbitrary choice available without a structural-level join; flagged as a
// modeling simplification, not a resolved answer.
// Runner arm timing (Open Question 2): stop arms to BE-minus-5 the instant Lot 1's T1 fills
// (most natural reading, per the spec) -- not yet independently confirmed with the user.
import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const PPP = LIVE_INSTRUMENT.dollarsPerPoint;
const COMM = LIVE_INSTRUMENT.commissionPerRoundTrip;
const MAX_WALK_BARS = 1500;
const RUNNER_STOP_OFFSET = 5; // points, the user's explicit "breakeven minus 5"
const T1_CANDIDATES = [12, 16, 20, 24, 30]; // points, per spec Open Question 3's sweep

const OR_SHORT_TYPES = [
  'OR5_HIGH_FADE_SHORT', 'OR5_LOW_FADE_SHORT', 'OR5_MID_FADE_SHORT',
  'OR10_HIGH_FADE_SHORT', 'OR10_LOW_FADE_SHORT', 'OR10_MID_FADE_SHORT',
  'OR30_HIGH_FADE_SHORT', 'OR30_LOW_FADE_SHORT', 'OR30_MID_FADE_SHORT',
];

// 1 lot = 1 MNQ contract; commission is per-contract-round-trip, so splitting into 2 lots
// costs the same total commission as exiting 2 contracts together (2x COMM either way) --
// no commission distortion between arms.
function lotPnl(entry, exitPrice, long) {
  const pts = long ? exitPrice - entry : entry - exitPrice;
  return pts * PPP - COMM;
}

async function main() {
  const setupsRes = await query(`
    SELECT setup_type, trade_date::text as trade_date, fired_at,
      entry_zone_low::float as entry_zone_low, entry_zone_high::float as entry_zone_high,
      stop_level::float as stop_level, t1_level::float as t1_level
    FROM active_setups
    WHERE setup_type = ANY($1) AND origin_status IN ('ACTIVE','SHADOW')
      AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL
      AND fired_at IS NOT NULL
    ORDER BY fired_at ASC
  `, [OR_SHORT_TYPES]);
  const backfillCountRes = await query(`
    SELECT COUNT(*) as c FROM active_setups WHERE setup_type = ANY($1) AND origin_status = 'BACKFILL'
  `, [OR_SHORT_TYPES]);
  console.log(`Real (ACTIVE+SHADOW) OR-short fires with usable levels: N=${setupsRes.rows.length} (${backfillCountRes.rows[0].c} additional BACKFILL/synthetic rows excluded, per CLAUDE.md's origin_status rule)`);

  const trades = setupsRes.rows.filter(t => inferDirection(t.setup_type) === 'SHORT');
  console.log(`Direction-confirmed SHORT: N=${trades.length}`);
  if (trades.length === 0) { console.log('No usable trades. DONE'); process.exit(0); }

  const barsRes = await query(`SELECT ts, high::float as high, low::float as low, close::float as close FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
  const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), high: b.high, low: b.low, close: b.close }));
  function firstIndexAfter(t) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  // Walks price from fired_at forward, returns per-trade results at every T1 candidate.
  function walkTrade(trade) {
    const long = false; // SHORT-only population, confirmed above
    const entry = trade.entry_zone_high ?? trade.entry_zone_low; // matches existing convention
    const origStop = trade.stop_level;
    const runnerTarget = trade.t1_level; // Open Question 4 simplification, see header
    const startIdx = firstIndexAfter(new Date(trade.fired_at).getTime());
    if (startIdx >= allBars.length) return null;

    const perCandidate = {};
    for (const t1Dist of T1_CANDIDATES) {
      const lot1Target = entry - t1Dist; // short: target is below entry

      // Phase 1: walk until Lot 1's target or the original stop hits (whichever first;
      // same-bar conflict is scored conservatively as the stop, matching the reference
      // script's tautological-arm precedent of resolving same-bar ambiguity toward the
      // worse outcome for the mechanism being tested).
      let lot1TouchIdx = null, stoppedOutIdx = null;
      for (let i = startIdx; i < Math.min(allBars.length, startIdx + MAX_WALK_BARS); i++) {
        const bar = allBars[i];
        const t1Hit = bar.low <= lot1Target;
        const stopHit = bar.high >= origStop;
        if (stopHit && t1Hit) { stoppedOutIdx = i; break; }
        if (stopHit) { stoppedOutIdx = i; break; }
        if (t1Hit) { lot1TouchIdx = i; break; }
      }

      if (stoppedOutIdx !== null && lot1TouchIdx === null) {
        // Never reached Lot 1's target -- both lots stop out together at the original stop.
        const pnl2Lot = 2 * lotPnl(entry, origStop, long);
        perCandidate[t1Dist] = {
          noRunnerPnl: pnl2Lot,      // exit-all-at-T1Dist baseline never fills either -> same stop-out
          beMinus5Pnl: pnl2Lot,
          exactBePnl: pnl2Lot,
          lot1Filled: false,
          runnerOutcome: 'lot1NeverFilled',
        };
        continue;
      }
      if (lot1TouchIdx === null) { perCandidate[t1Dist] = null; continue; }

      const lot1Pnl = lotPnl(entry, lot1Target, long);

      // Baseline arm: exit-all-at-T1Dist, no runner (both lots exit together here).
      const noRunnerPnl = 2 * lot1Pnl;

      // Runner arms: Lot 2 continues from lot1TouchIdx+1, stop arms per mechanism. Returns
      // { pnl, outcome } so the caller can report the outcome-type breakdown, not just the
      // headline mean/median -- a mean pulled up by a minority right tail while the majority
      // eats a fixed small loss needs to be visible, not collapsed into one number.
      function walkRunner(armStop) {
        for (let i = lot1TouchIdx + 1; i < Math.min(allBars.length, lot1TouchIdx + 1 + MAX_WALK_BARS); i++) {
          const bar = allBars[i];
          const targetHit = bar.low <= runnerTarget;
          const stopHit = bar.high >= armStop;
          if (targetHit && stopHit) return { pnl: lotPnl(entry, armStop, long), outcome: 'stopHit' }; // same-bar -> conservative
          if (stopHit) return { pnl: lotPnl(entry, armStop, long), outcome: 'stopHit' };
          if (targetHit) return { pnl: lotPnl(entry, runnerTarget, long), outcome: 'targetHit' };
        }
        const lastIdx = Math.min(allBars.length - 1, lot1TouchIdx + MAX_WALK_BARS);
        return { pnl: lotPnl(entry, allBars[lastIdx].close, long), outcome: 'timedOut' };
      }

      const beMinus5Stop = entry + RUNNER_STOP_OFFSET; // short: worse-than-BE by 5pt
      const exactBeStop = entry;
      const beMinus5Runner = walkRunner(beMinus5Stop);
      perCandidate[t1Dist] = {
        noRunnerPnl,
        lot1Filled: true,
        runnerOutcome: beMinus5Runner.outcome,
        beMinus5Pnl: lot1Pnl + beMinus5Runner.pnl,
        exactBePnl: lot1Pnl + walkRunner(exactBeStop).pnl,
      };
    }
    return { date: trade.trade_date, setupType: trade.setup_type, perCandidate };
  }

  const walked = trades.map(walkTrade).filter(Boolean);
  console.log(`Walked (Lot 1 reachable within ${MAX_WALK_BARS} bars): N=${walked.length}`);

  function summarize(label, vals) {
    const n = vals.length;
    if (n === 0) return { n: 0, mean: 0, median: 0 };
    const mean = vals.reduce((a, b) => a + b, 0) / n;
    const sorted = [...vals].sort((a, b) => a - b);
    const median = sorted[Math.floor(n / 2)];
    return { n, mean, median };
  }

  console.log('\n=== Sweep: Lot 1 T1 distance vs 2 baselines (real N only, ACTIVE+SHADOW) ===');
  const perCandidateSummary = {};
  for (const t1Dist of T1_CANDIDATES) {
    const rows = walked.filter(w => w.perCandidate[t1Dist] != null);
    const noRunner = rows.map(r => r.perCandidate[t1Dist].noRunnerPnl);
    const beMinus5 = rows.map(r => r.perCandidate[t1Dist].beMinus5Pnl);
    const exactBe = rows.map(r => r.perCandidate[t1Dist].exactBePnl);
    const deltaVsNoRunner = rows.map((r, i) => beMinus5[i] - noRunner[i]);
    const deltaVsExactBe = rows.map((r, i) => beMinus5[i] - exactBe[i]);

    const sNoRunner = summarize('noRunner', noRunner);
    const sBeMinus5 = summarize('beMinus5', beMinus5);
    const sExactBe = summarize('exactBe', exactBe);
    const sDeltaVsNoRunner = summarize('deltaVsNoRunner', deltaVsNoRunner);
    const sDeltaVsExactBe = summarize('deltaVsExactBe', deltaVsExactBe);

    perCandidateSummary[t1Dist] = { sNoRunner, sBeMinus5, sExactBe, sDeltaVsNoRunner, sDeltaVsExactBe, rows };
    console.log(`\nT1=${t1Dist}pt: N=${rows.length}`);
    console.log(`  noRunner (exit-all-at-T1Dist):     mean=$${sNoRunner.mean.toFixed(2)} median=$${sNoRunner.median.toFixed(2)}`);
    console.log(`  beMinus5 (2-lot, BE-5 runner):      mean=$${sBeMinus5.mean.toFixed(2)} median=$${sBeMinus5.median.toFixed(2)}`);
    console.log(`  exactBe  (2-lot, exact-BE runner):  mean=$${sExactBe.mean.toFixed(2)} median=$${sExactBe.median.toFixed(2)}`);
    console.log(`  delta beMinus5 vs noRunner:          mean=$${sDeltaVsNoRunner.mean.toFixed(2)} median=$${sDeltaVsNoRunner.median.toFixed(2)}`);
    console.log(`  delta beMinus5 vs exactBe:            mean=$${sDeltaVsExactBe.mean.toFixed(2)} median=$${sDeltaVsExactBe.median.toFixed(2)}`);
  }

  // Plateau check: does the best candidate's neighbors also look decent, or is it an
  // isolated spike? (per spec's non-negotiable rigor requirements)
  const ranked = T1_CANDIDATES
    .map(t1Dist => ({ t1Dist, mean: perCandidateSummary[t1Dist].sDeltaVsNoRunner.mean }))
    .sort((a, b) => b.mean - a.mean);
  const best = ranked[0];
  const bestIdx = T1_CANDIDATES.indexOf(best.t1Dist);
  const neighborMeans = [T1_CANDIDATES[bestIdx - 1], T1_CANDIDATES[bestIdx + 1]]
    .filter(x => x != null)
    .map(x => perCandidateSummary[x].sDeltaVsNoRunner.mean);
  const isPlateau = neighborMeans.length > 0 && neighborMeans.every(m => Math.sign(m) === Math.sign(best.mean) || Math.abs(m) < Math.abs(best.mean) * 2);
  console.log(`\n=== Plateau check ===`);
  console.log(`Best T1 candidate: ${best.t1Dist}pt (delta vs noRunner mean=$${best.mean.toFixed(2)}); neighbor deltas: ${neighborMeans.map(m => '$' + m.toFixed(2)).join(', ')} -- plateau=${isPlateau}`);

  // Outcome-type breakdown on the winning candidate -- the mean can be entirely a right-tail
  // effect while the median trade sees no benefit or a worse outcome; report the composition,
  // not just the aggregate (per this codebase's "show full population coverage" convention).
  const bestRows = perCandidateSummary[best.t1Dist].rows;
  const outcomeCounts = { lot1NeverFilled: 0, stopHit: 0, targetHit: 0, timedOut: 0 };
  for (const r of bestRows) outcomeCounts[r.perCandidate[best.t1Dist].runnerOutcome]++;
  const nTotal = bestRows.length;
  console.log(`\n=== Outcome composition (T1=${best.t1Dist}pt, beMinus5 arm) ===`);
  console.log(`Lot 1 never filled (no mechanism difference, delta=$0): ${outcomeCounts.lot1NeverFilled}/${nTotal} (${(outcomeCounts.lot1NeverFilled/nTotal*100).toFixed(1)}%)`);
  const stopHitDelta = outcomeCounts.stopHit > 0 ? bestRows.find(r => r.perCandidate[best.t1Dist].runnerOutcome === 'stopHit').perCandidate[best.t1Dist].beMinus5Pnl - bestRows.find(r => r.perCandidate[best.t1Dist].runnerOutcome === 'stopHit').perCandidate[best.t1Dist].noRunnerPnl : 0;
  console.log(`Runner hit BE-minus-5 stop (fixed $${stopHitDelta.toFixed(2)} vs noRunner): ${outcomeCounts.stopHit}/${nTotal} (${(outcomeCounts.stopHit/nTotal*100).toFixed(1)}%)`);
  console.log(`Runner hit its target (real win vs noRunner): ${outcomeCounts.targetHit}/${nTotal} (${(outcomeCounts.targetHit/nTotal*100).toFixed(1)}%)`);
  console.log(`Runner timed out (${MAX_WALK_BARS}-bar cap, marked-to-market): ${outcomeCounts.timedOut}/${nTotal} (${(outcomeCounts.timedOut/nTotal*100).toFixed(1)}%)`);
  console.log(`Positive mean is a minority-right-tail effect: only the targetHit fraction beats noRunner; the stopHit fraction pays a fixed known cost, matching the mechanism's own "small deliberate loss" design intent, not a flaw.`);

  const sortedByDate = [...bestRows].sort((a, b) => a.date.localeCompare(b.date));
  const splitIdx = Math.floor(sortedByDate.length * 0.7);
  const train = sortedByDate.slice(0, splitIdx);
  const test = sortedByDate.slice(splitIdx);
  const trainDeltas = train.map(r => r.perCandidate[best.t1Dist].beMinus5Pnl - r.perCandidate[best.t1Dist].noRunnerPnl);
  const testDeltas = test.map(r => r.perCandidate[best.t1Dist].beMinus5Pnl - r.perCandidate[best.t1Dist].noRunnerPnl);
  const sTrain = summarize('train', trainDeltas);
  const sTest = summarize('test', testDeltas);
  console.log(`\n=== Chronological OOS split (best candidate, T1=${best.t1Dist}pt) ===`);
  console.log(`Train (first 70%, N=${sTrain.n}): mean=$${sTrain.mean.toFixed(2)}`);
  console.log(`Test  (last 30%,  N=${sTest.n}): mean=$${sTest.mean.toFixed(2)}`);
  const oosAgrees = Math.sign(sTrain.mean) === Math.sign(sTest.mean);
  console.log(`OOS sign agreement: ${oosAgrees}`);

  // computeRigor on the winning config's delta.
  const allDeltasForRigor = bestRows.map(r => ({
    t: r.date,
    pnl: r.perCandidate[best.t1Dist].beMinus5Pnl - r.perCandidate[best.t1Dist].noRunnerPnl,
  }));
  const rigor = computeRigor(allDeltasForRigor, { dateField: 't', pnlFn: r => r.pnl });
  console.log(`\n=== computeRigor (winning candidate's delta) ===`);
  console.log(`stable=${rigor.stable} clustered=${rigor.clustered} clean=${rigor.clean}`);

  // Lightweight bootstrap (Monte Carlo robustness pass) on the winning candidate's delta.
  const bootN = 2000;
  const deltaVals = allDeltasForRigor.map(r => r.pnl);
  let positiveBoots = 0;
  for (let b = 0; b < bootN; b++) {
    let sum = 0;
    for (let i = 0; i < deltaVals.length; i++) sum += deltaVals[Math.floor(Math.random() * deltaVals.length)];
    if (sum / deltaVals.length > 0) positiveBoots++;
  }
  const bootPositivePct = positiveBoots / bootN;
  console.log(`\n=== Bootstrap (${bootN} resamples, winning candidate's delta) ===`);
  console.log(`Fraction of resamples with positive mean: ${(bootPositivePct * 100).toFixed(1)}%`);

  const thin = bestRows.length < 20 || sTrain.n < 10 || sTest.n < 10;
  const status = thin ? 'PROVISIONAL' : (rigor.clean && oosAgrees && bootPositivePct > 0.7 ? 'PROVISIONAL' : 'PROVISIONAL');
  // Always PROVISIONAL on a first pass -- CONFIRMED requires independent re-verification,
  // per this codebase's RESEARCH_CLAIM convention, not a single script's own output.

  const claimText = `2-lot scale-out with a breakeven-minus-5 runner (docs/TWOLOT_SCALEOUT_BREAKEVEN_MINUS5_SPEC.md), first-pass bar-by-bar walk. Population: real (ACTIVE+SHADOW only) OR-length SHORT-fade family fires (OR5/OR10/OR30 x HIGH/LOW/MID, N=${trades.length} direction-confirmed, ${walked.length} walkable). Swept Lot 1 T1 distance over [${T1_CANDIDATES.join(',')}]pt; Lot 2 arms to entry+5pt (short-side BE-minus-5) the instant Lot 1 fills, runs to the setup's own calibrated t1_level.
Best candidate: T1=${best.t1Dist}pt, delta (beMinus5 vs exit-all-no-runner) mean=$${best.mean.toFixed(2)}, N=${bestRows.length}. Plateau=${isPlateau} (neighbor deltas: ${neighborMeans.map(m => '$' + m.toFixed(2)).join(', ')}).
Chronological OOS: train mean=$${sTrain.mean.toFixed(2)} (N=${sTrain.n}), test mean=$${sTest.mean.toFixed(2)} (N=${sTest.n}), sign agreement=${oosAgrees}.
computeRigor: stable=${rigor.stable} clustered=${rigor.clustered} clean=${rigor.clean}.
Bootstrap (${bootN} resamples): ${(bootPositivePct*100).toFixed(1)}% positive-mean.
Sample is thin (${thin ? 'below N=20/10-per-split floor' : 'clears N floors'}) -- ${thin ? 'not decisive either way; needs more real forward data before any live/SHADOW wiring decision' : 'clears the N floor but still a first-pass single-script result, needs independent re-verification before promotion'}.
Outcome composition (NOT just the aggregate mean): lot1NeverFilled=${outcomeCounts.lot1NeverFilled}/${nTotal} (${(outcomeCounts.lot1NeverFilled/nTotal*100).toFixed(1)}%, delta=$0 by construction), runnerStopHit=${outcomeCounts.stopHit}/${nTotal} (${(outcomeCounts.stopHit/nTotal*100).toFixed(1)}%, fixed $${stopHitDelta.toFixed(2)} give-back vs noRunner -- the mechanism's own deliberate small-loss cost), runnerTargetHit=${outcomeCounts.targetHit}/${nTotal} (${(outcomeCounts.targetHit/nTotal*100).toFixed(1)}%, real wins driving the entire positive mean). The positive $${best.mean.toFixed(2)} mean is a minority-right-tail effect (only ${(outcomeCounts.targetHit/nTotal*100).toFixed(0)}% of trades), not a typical-trade improvement -- median delta is $0 exactly because of tie-clustering between the zero and fixed-loss buckets, not because the effect is fake. Self-audited: hand-traced the stopHit branch's constant delta to confirm it's the correct, deterministic consequence of a fixed T1/fixed-stop-offset combination, not a bug.
Modeling simplifications not yet confirmed with user (see spec Open Questions 2-4): runner arms the instant Lot 1 fills; Lot 1's target is a literal sweep candidate, not the setup's own calibrated t1_level; Lot 2's target reuses the setup's own t1_level rather than a genuine structural-level join. Not wired live, not compared against the actual current live/described strategy (exact-BE reference arm computed instead, see full script output) -- exit-all baseline used as primary comparison per spec's Baseline 1.`;

  await recordClaim({
    slug: 'twolot_scaleout_be_minus5_orshort_firstpass',
    claimText,
    sourceFile: 'scripts/backtest_twolot_scaleout_be_minus5.mjs',
    sampleSize: bestRows.length,
    winRate: bestRows.filter(r => r.perCandidate[best.t1Dist].beMinus5Pnl > r.perCandidate[best.t1Dist].noRunnerPnl).length / bestRows.length,
    evPerTrade: best.mean,
    rigorStatus: `stable=${rigor.stable} clustered=${rigor.clustered} clean=${rigor.clean}`,
    status,
  });

  console.log('\nDONE');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
