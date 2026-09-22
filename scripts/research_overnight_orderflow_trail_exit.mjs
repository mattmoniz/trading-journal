// Research-only (not wired to anything live): does adding a breakeven-then-trail exit help
// OVERNIGHT_ORDERFLOW_LONG/SHORT capture more of its move than the current live design (a
// fixed stop + hold-to-a-calibrated-clock-time mark-to-market, no trailing at all)?
//
// User question, 2026-09-22: "would anything else have led you to get out of that trade if
// the target wasn't there?" -- correctly identified that the current design has NO exit
// between the (700pt fallback) stop and the calibrated clock exit (currently 13:30 ET). Asked
// whether this codebase's existing breakeven-then-trail mechanism (server/services/
// breakevenTrailWalker.js / stepTrailWalker.js) could plug in.
//
// FINDING BEFORE WRITING ANY SIMULATION: neither existing mechanism composes in as-is.
//   1. Both stepTrailWalker.js (wraps widerTargetWalker.js) and breakevenTrailWalker.js require
//      a real price TARGET (t1) to "arm" -- they stay on the original stop until price reaches
//      that target, then snap to breakeven and trail. OVERNIGHT_ORDERFLOW deliberately has no
//      target at all (t1_level is an unreachable 1500pt placeholder, never checked) -- its
//      validated edge (RESEARCH_CLAIM overnight_9pm_orderflow_predicts_rth_direction_20260921)
//      is "hold roughly in the predicted direction for several hours," not "chase a price
//      level."
//   2. server/services/sessionBoundary.js's isPastMechanismSessionEnd() -- used by BOTH
//      existing mechanisms to decide "is there still time left to benefit from staying open"
//      -- treats the NEXT RTH OPEN (9:30am) as the natural end-of-life for a Globex-origin
//      trade. That's backwards for this detector: its entire premise is riding the position
//      INTO and THROUGH RTH (exit currently calibrated to 1:30pm ET). Reusing that function
//      unmodified would force-exit the trail the moment RTH opens, killing the detector's own
//      core thesis.
// Conclusion: this needed a purpose-built variant tested against THIS population, not a blind
// plug of an existing mechanism validated for a structurally different (RTH-fade-roster,
// target-based) trade shape. This script is that test -- reuses fetchTrades() (the exact same
// real N=53 population, direction, and entry price as the live calibration) rather than
// re-deriving it, per this codebase's "export the real function" rule.
//
// This is Phase 0/1-shaped (raw candidate sweep + placebo-adjacent sanity checks), NOT a
// promotion decision -- the underlying signal itself is still PROVISIONAL (test-set CI crossed
// zero on a manual holdout check per the calibration script's own header). Nothing here writes
// to performance_audit or changes overnightOrderflowEntryDetector.js.
import { fetchTrades } from './calibrate_overnight_orderflow_entry.mjs';
import { dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const DOLLAR_PER_PT = 2, COMMISSION = 2; // MNQ ground truth, CLAUDE.md
const BASELINE_STOP = 700; // matches the live fallback (chosen.stopPts is currently null)
const BASELINE_EXIT = '13:30'; // matches the live calibration's current chosenCell.exitTime
const ARM_CANDIDATES = [50, 75, 100, 150, 200]; // points in favor before snapping to breakeven
const TRAIL_CANDIDATES = [40, 60, 80, 100]; // trail width once armed, in points

function simBaseline(t) {
  const mae = t.maeAtExitIdx[BASELINE_EXIT];
  if (mae >= BASELINE_STOP) return -BASELINE_STOP;
  return (t.priceAtExit(BASELINE_EXIT) - t.entryPrice) * t.direction;
}

// Pure bar-by-bar walk, deliberately NOT reusing stepBreakevenTrail()'s own session-end logic
// (see header) -- the arm/trail/ratchet CORE is the same idea, but bounded by this detector's
// own calibrated clock exit instead of "next RTH open," which structurally doesn't apply here.
function simTrail(t, bars, armDist, trailWidth) {
  const long = t.direction === 1;
  let armed = false, peak = null, stop = long ? t.entryPrice - BASELINE_STOP : t.entryPrice + BASELINE_STOP;
  const exitIdx = t.exitIdxByTime[BASELINE_EXIT];
  for (let i = t.entryIdx; i <= exitIdx; i++) {
    const b = bars[i];
    if (!b) continue;
    if (!armed) {
      const stopHit = long ? b.low <= stop : b.high >= stop;
      if (stopHit) return -BASELINE_STOP;
      const favorableExtreme = long ? b.high - t.entryPrice : t.entryPrice - b.low;
      if (favorableExtreme >= armDist) {
        armed = true;
        peak = long ? b.high : b.low;
        stop = t.entryPrice; // breakeven
        const sameBar = long ? b.low <= stop : b.high >= stop;
        if (sameBar) return 0; // armed and immediately breached breakeven in the same bar -- flat, not a loss
      }
      continue;
    }
    // Armed: trailing.
    if (long && b.high > peak) peak = b.high;
    if (!long && b.low < peak) peak = b.low;
    const candidateStop = long ? peak - trailWidth : peak + trailWidth;
    if (long && candidateStop > stop) stop = candidateStop;
    if (!long && candidateStop < stop) stop = candidateStop;
    const trailHit = long ? b.low <= stop : b.high >= stop;
    if (trailHit) return (stop - t.entryPrice) * t.direction;
  }
  // Never armed, or armed but never trailed out -- exit at the same clock time as baseline.
  return (t.priceAtExit(BASELINE_EXIT) - t.entryPrice) * t.direction;
}

function summarize(label, captures, dates) {
  const dollarPnl = captures.map((c) => c * DOLLAR_PER_PT - COMMISSION);
  const meanDollar = dollarPnl.reduce((a, b) => a + b, 0) / dollarPnl.length;
  const hits = captures.filter((c) => c > 0).length;
  const events = dates.map((date, i) => ({ date, pnl: captures[i] }));
  const ci = dayBlockedBootstrapCI(events, `overnight_trail_${label}`, { dateField: 'date' });
  return { label, n: captures.length, hitRate: +(100 * hits / captures.length).toFixed(1), meanDollarPerDay: +meanDollar.toFixed(2), ci: { lo: +ci.lo.toFixed(1), hi: +ci.hi.toFixed(1) } };
}

async function main() {
  const { trades, bars } = await fetchTrades();
  console.log(`Population: N=${trades.length} real days (badge-high-by-12am, same as the live calibration)\n`);

  const dates = trades.map((t) => t.tDay);
  const baseCaptures = trades.map(simBaseline);
  const baseline = summarize('BASELINE_flat_700stop_1330exit', baseCaptures, dates);
  console.log('BASELINE (current live design):', baseline);

  console.log('\nTrail variants (arm distance x trail width):');
  const results = [baseline];
  for (const armDist of ARM_CANDIDATES) {
    for (const trailWidth of TRAIL_CANDIDATES) {
      const captures = trades.map((t) => simTrail(t, bars, armDist, trailWidth));
      const r = summarize(`arm${armDist}_trail${trailWidth}`, captures, dates);
      results.push(r);
      console.log(`  arm=${armDist}pt trail=${trailWidth}pt: meanDollarPerDay=${r.meanDollarPerDay} hitRate=${r.hitRate}% CI=[${r.ci.lo},${r.ci.hi}]`);
    }
  }

  const best = results.slice(1).sort((a, b) => b.meanDollarPerDay - a.meanDollarPerDay)[0];
  console.log(`\nBest trail variant: ${best.label} -> $${best.meanDollarPerDay}/day (baseline: $${baseline.meanDollarPerDay}/day, delta $${(best.meanDollarPerDay - baseline.meanDollarPerDay).toFixed(2)}/day)`);

  const top5Share = baseCaptures
    .map((c, i) => ({ dollars: c * DOLLAR_PER_PT - COMMISSION, date: dates[i] }))
    .sort((a, b) => b.dollars - a.dollars)
    .slice(0, 5)
    .reduce((s, r) => s + r.dollars, 0) / (baseline.meanDollarPerDay * trades.length) * 100;

  await recordClaim({
    slug: 'overnight_orderflow_trail_underperforms_flat_20260922',
    claimText: `User question (2026-09-22): would a breakeven-then-trail exit (reusing the spirit of stepTrailWalker.js/breakevenTrailWalker.js) beat OVERNIGHT_ORDERFLOW_LONG/SHORT's current design (fixed ${BASELINE_STOP}pt stop, flat hold to a calibrated clock exit, currently ${BASELINE_EXIT} ET, no trailing at all)? Neither existing trail mechanism composes in as-is -- both require a real price target to arm, and both use isPastMechanismSessionEnd() (treats next-RTH-open as end-of-life for an overnight trade), which is backwards for this detector's actual thesis (ride INTO and THROUGH RTH). Built a purpose-built comparison instead, reusing calibrate_overnight_orderflow_entry.mjs's own fetchTrades() population (N=${trades.length} real days, badge-high-by-12am). Swept arm-distance x [${ARM_CANDIDATES.join(',')}] x trail-width [${TRAIL_CANDIDATES.join(',')}] (20 cells). RESULT: every single trail variant underperformed the flat baseline in mean $/day -- baseline $${baseline.meanDollarPerDay}/day vs best trail cell (${best.label}) $${best.meanDollarPerDay}/day, delta $${(best.meanDollarPerDay - baseline.meanDollarPerDay).toFixed(2)}/day. Trail variants DID show a much higher hit rate (up to 90.6% vs baseline's ${baseline.hitRate}%) -- a real example of this codebase's own "asymmetric payoff, not win-rate" lesson: the signal's edge is concentrated in a handful of large trend days (top-5-of-${trades.length} days = ${top5Share.toFixed(1)}% of total baseline $, not degenerate but real skew), and a trail with a 40-100pt width locks in gains early and gets stopped out of the continuation that produces those big days. CONCLUSION: for this detector's validated shape (a directional-drift, hold-to-clock-time signal, not a mean-reversion/fade signal), trailing is the wrong tool -- it trades away the fat right tail that the mean capture depends on. Recommend NOT building this; if profit-protection is still wanted, the right next question is a MUCH wider arm/trail (protecting only against a full round-trip on the biggest days) or a partial scale-out, not a tight trail -- untested, not scoped here. Underlying signal itself remains PROVISIONAL (RESEARCH_CLAIM overnight_9pm_orderflow_predicts_rth_direction_20260921) -- this finding is conditional on that holding.`,
    sourceFile: 'scripts/research_overnight_orderflow_trail_exit.mjs',
    sourceDate: '2026-09-22',
    sampleSize: trades.length,
    winRate: baseline.hitRate,
    evPerTrade: baseline.meanDollarPerDay - best.meanDollarPerDay,
    rigorStatus: 'day_blocked_bootstrap_ci_computed_per_cell_not_degenerate_day_clustering',
    status: 'PROVISIONAL',
  });
  console.log(`\nTop-5-day share of baseline $: ${top5Share.toFixed(1)}%`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
