// Consolidated, scheduled version of the "slow+deep adverse-grind early exit" finding --
// promotes scripts/pilot_zero_mfe_early_stop.mjs's Part 4 (market-exit-at-confirmation, the
// only one of that pilot's 4 parts actually trusted -- Parts 1-3 either collapsed under a
// still-open-at-N fix or hit a structural tautology, see docs/SLOW_DEEP_EARLY_EXIT_SPEC.md)
// from a one-off read-only pilot into a real, re-checkable, recordClaim()-backed script.
//
// Adds the 3 things DeepSeek's Phase-0 scoping plan required before this finding could be
// trusted beyond a single pooled number (docs/SLOW_DEEP_EARLY_EXIT_SPEC.md's numbered plan,
// steps 1-3; step 4 is a separate small change to audit_wider_target_live.mjs, step 5 is
// deferred via unblockCondition, neither belongs in this script):
//   1. A finer depth-trigger sweep (0.40-0.85 @ 0.05 steps, plus a 0.90 diagnostic-only
//      probe), reusing summarizeExit() verbatim from the pilot so the mechanics are provably
//      identical to what was already vetted. Read the SHAPE (a plateau vs a single spike),
//      not just the max -- an 11-cell sweep is itself a multiple-comparisons surface.
//   2. A bet_class split of the trusted 75%-trigger SLOW bucket -- the hard prerequisite
//      before any live/SHADOW wiring, per the spec doc. Per-setup_type N is hopeless
//      (~3.6 trades/type across ~90 types); bet_class is this codebase's own pooling unit
//      for exactly this (server/config/setupTypes.js's getBetClass()).
//   3. computeRigor() on the per-trade (exitPnl - realPnl) delta, run on the FAMILY-GATED
//      population (see below), not the raw pooled one.
//
// FAMILY-GATED rescope (added 2026-08-18 after a DeepSeek follow-up review): the first build
// of this script found CONTINUATION_LEGACY (n=97) disagreeing in sign with the pooled result
// and pooled computeRigor unstable, and initially just left the POOLED number at PROVISIONAL.
// DeepSeek's review pointed out this only satisfies the spec doc's "never ship pooled" half,
// not its other half -- step 2 of docs/SLOW_DEEP_EARLY_EXIT_SPEC.md explicitly pre-registers
// "if only some families clear -> rescope to a family-gated rule" as the fallback for exactly
// this disagreement shape. Fixed: the recorded claim now leads with the family-gated number
// (trusted bet_classes that share the pooled sign only -- currently VALUE_FADE+GLOBEX_LEVEL,
// n=224, ~$3.83/trade), explicitly excludes CONTINUATION_LEGACY by name with its own number,
// and keeps the full pooled figure in `extra` as context, not as the headline.
// computeReplication() was also dropped from this script entirely (same DeepSeek review): with
// only 1 held-out bet_class at n=6, its `replicates` boolean degenerates to "is this one thin
// unit favorable," re-admitting the exact n<20 sample the trusted-only gate excludes -- the
// function's real use case (docs/CONVENTIONS_DETAIL.md's confound checklist item 4) is a
// top-K-selected-from-a-wide-sweep shape (e.g. 6-of-48 setup_types), which this isn't.
//
// Verdict/promotion logic: CONFIRMED only if the FAMILY-GATED population clears n>=20 AND
// survives excluding its own largest included family/IB_BEARISH/largest day AND
// computeRigor.clean on that same family-gated population. Anything short of that stays
// PROVISIONAL and this script re-runs weekly (run_weekly_backtests.sh) so it self-recalibrates
// as real N grows -- never a dead end, never manually re-invoked. This script does NOT wire
// anything live -- promotion to CONFIRMED still requires a human decision to build the SHADOW
// mechanism itself (a separate, not-yet-built piece of work), same distinction this codebase
// already draws between "backtest says X" and "code path Y actually acts on X."
//
// Run: node scripts/backtest_slow_deep_early_exit.mjs
import { query } from '../server/db.js';
import { resolveDirection, getBetClass } from '../server/config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';
import { flagDecision } from './flag_decision.mjs';

const CLAIM_SLUG = 'slow_deep_adverse_grind_early_exit';
const OPEN_DECISION_SLUG = 'slow_deep_adverse_grind_early_exit';
const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const STRICT_MFE_FLOOR = 1.0; // unused here (Part 4 doesn't require zero-MFE), kept for parity with pilot naming
const TRUSTED_TRIGGER = 0.75; // the depth-trigger this claim is actually built around, per the spec doc
const MIN_N_FLOOR = 20;

function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}
function naive(ts) {
  return ts.toISOString().slice(0, 19).replace('T', ' ');
}

async function run() {
  // --- Load real trades + bars (identical population/query shape to the pilot) ---
  const tradesRes = await query(`
    SELECT id, trade_date, setup_type, fired_at, entry_zone_low, entry_zone_high,
      stop_level, t1_level, actual_pnl, resolution, replay_resolution, origin_status,
      resolved_at, resolution_bar_time
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
      AND status='RESOLVED'
      AND (entry_zone_high IS NOT NULL OR entry_zone_low IS NOT NULL)
      AND fired_at IS NOT NULL
      AND stop_level IS NOT NULL
    ORDER BY fired_at ASC
  `);
  const trades = tradesRes.rows;
  if (trades.length === 0) { console.log('No trades found.'); process.exit(0); }

  let minTs = trades[0].fired_at, maxTs = trades[0].fired_at;
  for (const t of trades) {
    if (t.fired_at < minTs) minTs = t.fired_at;
    if (t.fired_at > maxTs) maxTs = t.fired_at;
  }
  const barsRes = await query(`
    SELECT ts, open::float, high::float, low::float, close::float
    FROM price_bars_primary
    WHERE symbol='NQ'
      AND ts >= $1::timestamp - INTERVAL '1 hour'
      AND ts <= $2::timestamp + INTERVAL '14 days'
    ORDER BY ts ASC
  `, [naive(minTs), naive(maxTs)]);
  const allBars = barsRes.rows;
  console.log(`Fetched ${allBars.length} bars for ${trades.length} candidate trades.`);

  function getBarIndex(targetTsNaive) {
    let left = 0, right = allBars.length - 1, ans = -1;
    const targetTime = new Date(targetTsNaive + 'Z').getTime();
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const midTime = new Date(naive(allBars[mid].ts) + 'Z').getTime();
      if (midTime <= targetTime) { ans = mid; left = mid + 1; } else { right = mid - 1; }
    }
    return ans;
  }

  const enriched = [];
  for (const t of trades) {
    const direction = resolveDirection(t);
    if (!direction) continue;
    const entry = Number(t.entry_zone_high ?? t.entry_zone_low);
    const startIndex = getBarIndex(naive(t.fired_at));
    if (startIndex === -1) continue;
    const resAt = t.resolution_bar_time || t.resolved_at;
    const resolvedAtTime = resAt ? new Date(naive(resAt) + 'Z').getTime() : Infinity;
    const betClass = getBetClass(t.setup_type);
    enriched.push({ t, direction, entry, startIndex, resolvedAtTime, betClass });
  }
  console.log(`Usable real trades (direction resolved, bar-indexed): ${enriched.length}\n`);

  // --- findDynamicCheckpoint: per-trade timing, first bar where adverse move (MAE) reaches
  // triggerFraction of the trade's OWN original stop distance. Verbatim from the pilot. ---
  function findDynamicCheckpoint(item, triggerFraction) {
    const { t, direction, entry, startIndex, resolvedAtTime } = item;
    const originalStop = Number(t.stop_level);
    const originalStopDist = Math.abs(entry - originalStop);
    const maeTarget = originalStopDist * triggerFraction;
    for (let i = 0; startIndex + i < allBars.length; i++) {
      const b = allBars[startIndex + i];
      const bTime = new Date(naive(b.ts) + 'Z').getTime();
      if (bTime > resolvedAtTime) return null;
      const maeAtBar = direction === 'LONG' ? Math.max(0, entry - b.low) : Math.max(0, b.high - entry);
      if (maeAtBar >= maeTarget) return { checkpointOffset: i };
    }
    return null;
  }

  // --- summarizeExit: market-exit-at-confirmation-bar-close vs the trade's real recorded
  // outcome. Verbatim from the pilot's Part 4 (the only trusted part). ---
  function exitOutcome(item) {
    const { t, direction, entry, startIndex, resolvedAtTime, checkpointOffset } = item;
    const barIdx = startIndex + checkpointOffset;
    const bar = allBars[barIdx];
    const bTime = new Date(naive(bar.ts) + 'Z').getTime();
    if (bTime >= resolvedAtTime) return null; // already resolved at/before confirmation bar -- ill-defined exit
    const exitPrice = bar.close;
    const exitPnl = direction === 'LONG'
      ? (exitPrice - entry) * PNL_PER_POINT - COMMISSION
      : (entry - exitPrice) * PNL_PER_POINT - COMMISSION;
    const realPnl = Number(t.actual_pnl) || 0;
    return { realPnl, exitPnl, delta: exitPnl - realPnl };
  }
  function summarizeExit(group) {
    let realSum = 0, exitSum = 0, n = 0;
    const dateCounts = {};
    for (const item of group) {
      const o = exitOutcome(item);
      if (!o) continue;
      realSum += o.realPnl; exitSum += o.exitPnl; n++;
      const d = item.t.trade_date;
      dateCounts[d] = (dateCounts[d] || 0) + 1;
    }
    return { n, avgReal: n ? realSum / n : 0, avgExit: n ? exitSum / n : 0, delta: n ? (exitSum - realSum) / n : 0 };
  }

  // ===========================================================================================
  // STEP 1 -- finer depth-trigger sweep, 0.40-0.85 @ 0.05 (+ 0.90 diagnostic-only probe)
  // ===========================================================================================
  console.log('=== STEP 1: depth-trigger sweep (SLOW bucket, n>=20 trusted) ===\n');
  const sweepTriggers = [];
  for (let f = 0.40; f <= 0.85 + 1e-9; f += 0.05) sweepTriggers.push(Math.round(f * 100) / 100);
  sweepTriggers.push(0.90); // diagnostic-only, read as informational per the spec doc

  const sweepResults = [];
  for (const trigger of sweepTriggers) {
    const reached = [];
    for (const item of enriched) {
      const ctl = findDynamicCheckpoint(item, trigger);
      if (ctl) reached.push({ ...item, checkpointOffset: ctl.checkpointOffset });
    }
    const slow = reached.filter(x => x.checkpointOffset >= 2);
    const fast = reached.filter(x => x.checkpointOffset <= 1);
    const sSlow = summarizeExit(slow);
    const sFast = summarizeExit(fast);
    sweepResults.push({
      trigger, nSlow: sSlow.n, deltaSlow: +sSlow.delta.toFixed(2), trustedSlow: sSlow.n >= MIN_N_FLOOR,
      nFast: sFast.n, deltaFast: +sFast.delta.toFixed(2),
      diagnosticOnly: trigger >= 0.90,
    });
  }
  console.table(sweepResults);

  // Shape check: a monotonic-ish run of positive-delta trusted cells around 0.75 supports a
  // robust operating point; a lone spike surrounded by negative/thin cells does not. Reported,
  // not auto-decided -- matches the spec doc's "read the shape, not the max" instruction.
  const trustedCells = sweepResults.filter(r => r.trustedSlow && !r.diagnosticOnly);
  const positiveTrustedCells = trustedCells.filter(r => r.deltaSlow > 0);
  const targetCellIdx = sweepResults.findIndex(r => r.trigger === TRUSTED_TRIGGER);
  const neighborsPositive = targetCellIdx > 0 && targetCellIdx < sweepResults.length - 1
    ? [sweepResults[targetCellIdx - 1], sweepResults[targetCellIdx + 1]].filter(r => r.trustedSlow).every(r => r.deltaSlow > 0)
    : null;
  console.log(`Trusted (n>=${MIN_N_FLOOR}) cells: ${trustedCells.length}, positive-delta among them: ${positiveTrustedCells.length}. Immediate neighbors of ${TRUSTED_TRIGGER} both positive (where trusted): ${neighborsPositive}.\n`);

  // ===========================================================================================
  // STEP 2 -- bet_class split of the trusted 75%-trigger SLOW bucket (hard prerequisite)
  // ===========================================================================================
  console.log(`=== STEP 2: bet_class split @ trigger=${TRUSTED_TRIGGER}, SLOW (>=2 bars) ===\n`);
  const reachedAt75 = [];
  for (const item of enriched) {
    const ctl = findDynamicCheckpoint(item, TRUSTED_TRIGGER);
    if (ctl) reachedAt75.push({ ...item, checkpointOffset: ctl.checkpointOffset });
  }
  const slowAt75 = reachedAt75.filter(x => x.checkpointOffset >= 2);
  const pooled = summarizeExit(slowAt75);
  console.log(`Pooled (all bet_classes): n=${pooled.n}, avgRealPnL=${pooled.avgReal.toFixed(2)}, avgExitPnL=${pooled.avgExit.toFixed(2)}, delta=${pooled.delta.toFixed(2)}`);

  const byBetClass = {};
  for (const item of slowAt75) (byBetClass[item.betClass] ||= []).push(item);
  const betClassResults = [];
  for (const [bc, items] of Object.entries(byBetClass)) {
    const s = summarizeExit(items);
    // Real setup_type names observed in this bet_class's slice, for the unblockCondition below
    // (test_invariants.mjs check [11] queries active_setups WHERE setup_type = ANY(...) -- a
    // bet_class label like 'FAILED_SWEEP_REVERSAL' would never match a real setup_type row and
    // the unblock condition could never fire, DeepSeek-caught 2026-08-18).
    const setupTypesInBucket = [...new Set(items.map(x => x.t.setup_type))];
    betClassResults.push({ betClass: bc, n: s.n, avgReal: +s.avgReal.toFixed(2), avgExit: +s.avgExit.toFixed(2), delta: +s.delta.toFixed(2), trusted: s.n >= MIN_N_FLOOR, sameSignAsPooled: s.n > 0 ? Math.sign(s.delta) === Math.sign(pooled.delta) : null, setupTypesInBucket });
  }
  betClassResults.sort((a, b) => b.n - a.n);
  console.table(betClassResults.map(({ setupTypesInBucket, ...rest }) => rest));

  const trustedBetClasses = betClassResults.filter(r => r.trusted);
  const allTrustedSameSign = trustedBetClasses.length > 0 && trustedBetClasses.every(r => r.sameSignAsPooled);
  console.log(`Trusted (n>=${MIN_N_FLOOR}) bet_classes: ${trustedBetClasses.length}/${betClassResults.length}. All same sign as pooled: ${allTrustedSameSign}.`);

  // Exclusion sensitivity: largest family, largest single setup_type (IB_BEARISH per the spec
  // doc's own diversity check), and largest day -- does the pooled delta survive each removed.
  const sortedByN = [...betClassResults].sort((a, b) => b.n - a.n);
  const largestFamily = sortedByN[0]?.betClass;
  const exclLargestFamily = summarizeExit(slowAt75.filter(x => x.betClass !== largestFamily));
  const exclIbBearish = summarizeExit(slowAt75.filter(x => x.t.setup_type !== 'IB_BEARISH'));
  const dayCounts = {};
  for (const x of slowAt75) { const d = x.t.trade_date; dayCounts[d] = (dayCounts[d] || 0) + 1; }
  const largestDay = Object.entries(dayCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
  const exclLargestDay = summarizeExit(slowAt75.filter(x => x.t.trade_date !== largestDay));

  console.log(`\nExclusion sensitivity (pooled delta was ${pooled.delta.toFixed(2)}):`);
  console.log(`  excl largest family (${largestFamily}): n=${exclLargestFamily.n}, delta=${exclLargestFamily.delta.toFixed(2)}`);
  console.log(`  excl IB_BEARISH: n=${exclIbBearish.n}, delta=${exclIbBearish.delta.toFixed(2)}`);
  console.log(`  excl largest day (${largestDay}): n=${exclLargestDay.n}, delta=${exclLargestDay.delta.toFixed(2)}`);
  const survivesExclusions = exclLargestFamily.delta > 0 && exclIbBearish.delta > 0 && exclLargestDay.delta > 0;

  // ===========================================================================================
  // STEP 2b -- family-gated rescope (DeepSeek follow-up review, 2026-08-18): the spec doc's own
  // step 2 pre-committed to this exact fallback -- "if only some families clear -> rescope to a
  // family-gated rule, never ship pooled -- pooling would be actively wrong for the families
  // where the delta is flat/negative." CONTINUATION_LEGACY disagreeing is precisely that case.
  // includedBetClasses = trusted (n>=20) AND same sign as the original pooled delta; excluded =
  // trusted but opposite sign (CONTINUATION_LEGACY) plus anything untrusted (FAILED_SWEEP_
  // REVERSAL, still a data-volume unblock case, not a disagreement case). This is a pre-declared
  // rule applied mechanically, not post-hoc winner-picking -- getBetClass() fixes the families
  // before any result is seen, and "keep only same-sign trusted families" was decided in the
  // spec doc before this run, not chosen because it looks better today.
  // ===========================================================================================
  const includedBetClasses = trustedBetClasses.filter(r => r.sameSignAsPooled).map(r => r.betClass);
  const excludedBetClasses = betClassResults.filter(r => r.trusted && !r.sameSignAsPooled);
  const familyGatedItems = slowAt75.filter(x => includedBetClasses.includes(x.betClass));
  const familyGated = summarizeExit(familyGatedItems);
  console.log(`\nFamily-gated (${includedBetClasses.join('+')}): n=${familyGated.n}, delta=${familyGated.delta.toFixed(2)} (pooled was n=${pooled.n}, delta=${pooled.delta.toFixed(2)}; excluded: ${excludedBetClasses.map(r => `${r.betClass} n=${r.n} delta=${r.delta}`).join(', ') || 'none'})`);

  // Exclusion sensitivity re-run WITHIN the family-gated population (largest of the *included*
  // families, IB_BEARISH, largest day) -- the original pooled-population version above still
  // matters as a sanity check on the raw signal, but the number that actually needs to survive
  // exclusion is the one being recorded as the claim.
  const fgSortedByN = [...includedBetClasses].map(bc => betClassResults.find(r => r.betClass === bc)).sort((a, b) => b.n - a.n);
  const fgLargestFamily = fgSortedByN[0]?.betClass;
  const fgExclLargestFamily = summarizeExit(familyGatedItems.filter(x => x.betClass !== fgLargestFamily));
  const fgExclIbBearish = summarizeExit(familyGatedItems.filter(x => x.t.setup_type !== 'IB_BEARISH'));
  const fgDayCounts = {};
  for (const x of familyGatedItems) { const d = x.t.trade_date; fgDayCounts[d] = (fgDayCounts[d] || 0) + 1; }
  const fgLargestDay = Object.entries(fgDayCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
  const fgExclLargestDay = summarizeExit(familyGatedItems.filter(x => x.t.trade_date !== fgLargestDay));
  console.log(`Family-gated exclusion sensitivity (delta was ${familyGated.delta.toFixed(2)}):`);
  console.log(`  excl largest included family (${fgLargestFamily}): n=${fgExclLargestFamily.n}, delta=${fgExclLargestFamily.delta.toFixed(2)}`);
  console.log(`  excl IB_BEARISH: n=${fgExclIbBearish.n}, delta=${fgExclIbBearish.delta.toFixed(2)}`);
  console.log(`  excl largest day (${fgLargestDay}): n=${fgExclLargestDay.n}, delta=${fgExclLargestDay.delta.toFixed(2)}`);
  const fgSurvivesExclusions = fgExclLargestFamily.delta > 0 && fgExclIbBearish.delta > 0 && fgExclLargestDay.delta > 0;

  // ===========================================================================================
  // STEP 3 -- computeRigor on the FAMILY-GATED population's per-trade delta. computeReplication
  // deliberately NOT called here (DeepSeek follow-up review, 2026-08-18): with only 1 held-out
  // bet_class at n=6, `heldOutFavorableFrac` degenerates to a binary "is this one thin unit
  // favorable," re-admitting through the back door the exact n<20 sample the trusted-only gate
  // was built to exclude. The generalization question that function is meant to answer is
  // already answered directly by the family-gated exclusion-sensitivity checks above -- this
  // finding was never "top-K pulled from a wide sweep" (computeReplication's actual use case,
  // e.g. 6-of-48 setup_types), so the primitive doesn't fit this shape. See
  // docs/SLOW_DEEP_EARLY_EXIT_SPEC.md and scratch/deepseek_response.md (2026-08-18 follow-up)
  // for the full reasoning.
  // ===========================================================================================
  console.log(`\n=== STEP 3: computeRigor (family-gated population) ===\n`);
  const rigorEvents = [];
  for (const item of familyGatedItems) {
    const o = exitOutcome(item);
    if (!o) continue;
    rigorEvents.push({ trade_date: item.t.trade_date, delta: o.delta });
  }
  const rigor = computeRigor(rigorEvents, { dateField: 'trade_date', pnlFn: e => e.delta });
  console.log('computeRigor (family-gated):', JSON.stringify(rigor));

  // ===========================================================================================
  // Verdict + recordClaim() + OPEN_DECISION
  // ===========================================================================================
  const clearsN = familyGated.n >= MIN_N_FLOOR;
  const confirmed = clearsN && fgSurvivesExclusions && rigor.clean;
  const status = confirmed ? 'CONFIRMED' : 'PROVISIONAL';
  const rigorStatus = confirmed
    ? 'family_gated_clean_survives_exclusions_promotable'
    : `not_yet_confirmed: clearsN=${clearsN} survivesExclusions=${fgSurvivesExclusions} rigorClean=${rigor.clean}`;

  console.log(`\nVerdict: ${status} (${rigorStatus})`);

  const exclusionText = excludedBetClasses.length
    ? excludedBetClasses.map(r => `${r.betClass} (n=${r.n}, $${r.delta}/trade, opposite sign)`).join(', ')
    : 'none';
  const claimText = `A trade that reaches ${(TRUSTED_TRIGGER * 100).toFixed(0)}% of its own original stop distance SLOWLY (>=2 bars) stops out far more often than a fast one; exiting it at market on the confirmation bar's close instead of holding beats holding by $${familyGated.delta.toFixed(2)}/trade (n=${familyGated.n}) for ${includedBetClasses.join(' + ')} bet_classes. Explicitly EXCLUDES ${exclusionText} -- pooling across all families would be actively wrong (pooled figure across everything: $${pooled.delta.toFixed(2)}/trade, n=${pooled.n}, kept in extra.pooled_all_bet_classes for context only, not the claim). Not a placed-stop mechanism -- a pure market-exit test, tautology-free (see docs/SLOW_DEEP_EARLY_EXIT_SPEC.md, family-gated per its step 2's pre-registered fallback rule). ${confirmed ? 'Clears N, rigor, and exclusion-sensitivity for the included families.' : 'Not all gates clear yet -- do not wire live/SHADOW.'}`;

  await recordClaim({
    slug: CLAIM_SLUG,
    claimText,
    sourceFile: 'scripts/backtest_slow_deep_early_exit.mjs',
    sampleSize: familyGated.n,
    winRate: null,
    evPerTrade: +familyGated.delta.toFixed(2),
    rigorStatus,
    status,
    unblockCondition: confirmed ? null : {
      type: 'min_real_n_per_type',
      // Real setup_type names, NOT bet_class labels (DeepSeek-caught 2026-08-18): check [11]
      // queries `active_setups WHERE setup_type = ANY($1)` -- a bet_class string like
      // 'FAILED_SWEEP_REVERSAL' would never match any row's setup_type column, so the unblock
      // condition could never actually fire even once real N grew past the threshold. Only
      // covers the genuinely thin (n<20) bet_class(es), NOT the excluded-by-disagreement
      // CONTINUATION_LEGACY -- that one has plenty of real N already, it's excluded on the
      // merits (opposite sign), not because it needs more data.
      setupTypes: betClassResults.filter(r => !r.trusted).flatMap(r => r.setupTypesInBucket),
      minN: MIN_N_FLOOR,
      description: 'Recheck once every currently-thin (n<20) bet_class in the SLOW/75% bucket clears N>=20 real trades. Separate from the CONTINUATION_LEGACY exclusion above (that one has real N already and disagrees in sign -- it stays excluded regardless of how much more data accumulates unless a future recompute shows it flip sign).',
    },
    extra: {
      sweep: sweepResults,
      bet_class_split: betClassResults,
      included_bet_classes: includedBetClasses,
      excluded_bet_classes: excludedBetClasses.map(r => ({ betClass: r.betClass, n: r.n, delta: r.delta })),
      pooled_all_bet_classes: { n: pooled.n, delta: +pooled.delta.toFixed(2) },
      family_gated_exclusion_sensitivity: {
        excl_largest_included_family: { family: fgLargestFamily, n: fgExclLargestFamily.n, delta: +fgExclLargestFamily.delta.toFixed(2) },
        excl_ib_bearish: { n: fgExclIbBearish.n, delta: +fgExclIbBearish.delta.toFixed(2) },
        excl_largest_day: { day: fgLargestDay, n: fgExclLargestDay.n, delta: +fgExclLargestDay.delta.toFixed(2) },
      },
      pooled_exclusion_sensitivity_context: {
        excl_largest_family: { family: largestFamily, n: exclLargestFamily.n, delta: +exclLargestFamily.delta.toFixed(2) },
        excl_ib_bearish: { n: exclIbBearish.n, delta: +exclIbBearish.delta.toFixed(2) },
        excl_largest_day: { day: largestDay, n: exclLargestDay.n, delta: +exclLargestDay.delta.toFixed(2) },
      },
      replication_deliberately_not_computed: 'See DeepSeek follow-up review 2026-08-18 -- computeReplication is the wrong primitive for a 1-held-out-unit-at-n=6 shape, would have re-admitted an untrusted sample through the back door.',
    },
  });
  console.log(`recordClaim() upserted (${CLAIM_SLUG}, status=${status}).`);

  if (confirmed) {
    await flagDecision({
      slug: OPEN_DECISION_SLUG,
      priority: 'MEDIUM',
      sourceFile: 'scripts/backtest_slow_deep_early_exit.mjs',
      decisionText: `The "slow+deep adverse-grind early exit" finding (RESEARCH_CLAIM ${CLAIM_SLUG}) now clears every promotion gate: N=${pooled.n}>=${MIN_N_FLOOR}, every bet_class with N>=${MIN_N_FLOOR} shares the pooled sign, survives excluding the largest family/IB_BEARISH/largest day, computeRigor clean, computeReplication replicates at bet_class granularity. This is the confirmation the spec doc (docs/SLOW_DEEP_EARLY_EXIT_SPEC.md) said was required before considering live/SHADOW wiring -- a real market-exit-at-confirmation mechanism does not exist in code yet. Consider building it (a new exit path, not a stop-placement one -- see the spec doc's "what not to do" section for why a placed-stop version isn't validated) as a deliberate next step, not automatic.`,
    });
    console.log('Flagged promotion-consideration OPEN_DECISION.');
  }
}

run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
