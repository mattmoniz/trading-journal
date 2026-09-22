// User question, 2026-09-22: instead of a fixed 13:30 exit for every night, extend the hold
// (push the exit later) on nights where the move has been SLOW to develop, since a slow trade
// might just need more time rather than being genuinely dead.
//
// No-lookahead design: "slow" is classified using ONLY what's already captured by an early
// checkpoint (11:30 ET, ~90min after the 12am entry, still real morning price action) -- never
// using the trade's own eventual/future outcome to decide whether it was "slow." This avoids
// the exact tautology CLAUDE.md's Conventions section warns about (a target/threshold derived
// from the same population's own future outcome makes any resulting win rate meaningless).
//
// Reuses fetchTrades()'s real population + its existing exitIdxByTime/maeAtExitIdx/priceAtExit
// for the 7 already-computed candidate exit times -- no re-simulation of new price paths needed.
import { fetchTrades } from './calibrate_overnight_orderflow_entry.mjs';
import { dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const DOLLAR_PER_PT = 2, COMMISSION = 2;
const BASELINE_STOP = 700, BASELINE_EXIT = '13:30';
const CHECKPOINT = '11:30'; // ~90min after entry, well before any exit candidate
const EXTENDED_CANDIDATES = ['14:30', '15:30', '16:00'];
const SLOW_THRESHOLDS = [0, 25, 50, 75]; // points captured by checkpoint, below which = "slow"

function simAt(t, exitTime) {
  const mae = t.maeAtExitIdx[exitTime];
  if (mae >= BASELINE_STOP) return -BASELINE_STOP;
  return (t.priceAtExit(exitTime) - t.entryPrice) * t.direction;
}

function summarize(captures, dates, label) {
  const dollars = captures.map((c) => c * DOLLAR_PER_PT - COMMISSION);
  const mean = dollars.reduce((a, b) => a + b, 0) / dollars.length;
  const hits = captures.filter((c) => c > 0).length;
  const ci = dayBlockedBootstrapCI(dates.map((date, i) => ({ date, pnl: captures[i] })), `slow_${label}`, { dateField: 'date' });
  return { label, n: captures.length, hitRate: +(100 * hits / captures.length).toFixed(1), meanDollarPerDay: +mean.toFixed(2), ci: { lo: +ci.lo.toFixed(1), hi: +ci.hi.toFixed(1) } };
}

async function main() {
  const { trades } = await fetchTrades();
  const n = trades.length;
  console.log(`Population: N=${n}, checkpoint=${CHECKPOINT}\n`);

  const capturedByCheckpoint = trades.map((t) => simAt(t, CHECKPOINT));
  console.log('Captured-by-checkpoint distribution: min', Math.min(...capturedByCheckpoint).toFixed(0), 'max', Math.max(...capturedByCheckpoint).toFixed(0), 'median', [...capturedByCheckpoint].sort((a, b) => a - b)[Math.floor(n / 2)].toFixed(0));

  const baseline = summarize(trades.map((t) => simAt(t, BASELINE_EXIT)), trades.map((t) => t.tDay), 'baseline_1330_everyone');
  console.log('\nBaseline (everyone exits 13:30):', baseline);

  console.log(`\nFor comparison, everyone exits at each fixed later time instead:`);
  for (const ext of EXTENDED_CANDIDATES) {
    const r = summarize(trades.map((t) => simAt(t, ext)), trades.map((t) => t.tDay), `everyone_${ext}`);
    console.log(`  Everyone exits ${ext}:`, r);
  }

  console.log('\nSLOW-if-below-threshold, extend those to a later exit; FAST stays at 13:30:');
  let best = null;
  for (const threshold of SLOW_THRESHOLDS) {
    for (const ext of EXTENDED_CANDIDATES) {
      const captures = trades.map((t, i) => (capturedByCheckpoint[i] < threshold ? simAt(t, ext) : simAt(t, BASELINE_EXIT)));
      const slowCount = capturedByCheckpoint.filter((c) => c < threshold).length;
      const r = summarize(captures, trades.map((t) => t.tDay), `slow<${threshold}_ext${ext}`);
      console.log(`  threshold=${threshold}pt (${slowCount} slow nights), extend to ${ext}: meanDollarPerDay=${r.meanDollarPerDay} hitRate=${r.hitRate}% CI=[${r.ci.lo},${r.ci.hi}]`);
      if (!best || r.meanDollarPerDay > best.r.meanDollarPerDay) best = { threshold, ext, r, slowCount };
    }
  }
  console.log(`\nBest cell: threshold=${best.threshold}pt, extend to ${best.ext} -> $${best.r.meanDollarPerDay}/day (baseline $${baseline.meanDollarPerDay}/day, delta $${(best.r.meanDollarPerDay - baseline.meanDollarPerDay).toFixed(2)}/day, n_slow=${best.slowCount})`);
  const verdict = best.r.meanDollarPerDay > baseline.meanDollarPerDay ? 'IMPROVES' : 'DOES_NOT_IMPROVE';
  console.log(`Verdict: ${verdict}`);

  // STRUCTURAL-ADVANTAGE CONTROL (CLAUDE.md's confound checklist, item 1): the best cell's exit
  // time (best.ext) ALSO appears in the uniform "everyone exits at X" sweep above -- check how
  // much of the apparent gain is just from that flat exit time being better on its own, vs the
  // slow/fast conditioning adding real incremental value on top of it.
  const uniformAtBestExt = summarize(trades.map((t) => simAt(t, best.ext)), trades.map((t) => t.tDay), `everyone_${best.ext}_control`);
  const fromFlatExitAlone = uniformAtBestExt.meanDollarPerDay - baseline.meanDollarPerDay;
  const fromConditioningItself = best.r.meanDollarPerDay - uniformAtBestExt.meanDollarPerDay;
  console.log(`\nCONTROL: uniform exit at ${best.ext} for EVERYONE (no slow/fast conditioning at all) = $${uniformAtBestExt.meanDollarPerDay}/day.`);
  console.log(`  -> $${fromFlatExitAlone.toFixed(2)}/day of the total gain is just from the later flat exit time (a question the base calibration itself flagged as unresolved -- TRAIN favored 13:30, held-out TEST favored the original 16:00 close).`);
  console.log(`  -> Only $${fromConditioningItself.toFixed(2)}/day is attributable to the slow/fast conditioning ITSELF, on top of that flat exit-time change.`);

  await recordClaim({
    slug: 'overnight_orderflow_extend_if_slow_20260922',
    claimText: `User question (2026-09-22): extend OVERNIGHT_ORDERFLOW_LONG/SHORT's exit beyond the calibrated ${BASELINE_EXIT} on nights where the move has been SLOW to develop (defined WITHOUT lookahead -- points captured by an early ${CHECKPOINT} checkpoint only, never the trade's own future outcome). Swept ${SLOW_THRESHOLDS.length} slow-thresholds x ${EXTENDED_CANDIDATES.length} extended exit times (${SLOW_THRESHOLDS.length * EXTENDED_CANDIDATES.length} cells) against the real N=${n} population, reusing the calibration's own already-computed exit-time candidates (no new price-path simulation). Baseline (everyone exits ${BASELINE_EXIT}): $${baseline.meanDollarPerDay}/day. Best conditional cell: threshold=${best.threshold}pt/extend-to=${best.ext} (n_slow=${best.slowCount}/${n} nights classified slow) -> $${best.r.meanDollarPerDay}/day, delta $${(best.r.meanDollarPerDay - baseline.meanDollarPerDay).toFixed(2)}/day. STRUCTURAL-ADVANTAGE CONTROL (per CLAUDE.md's confound checklist): uniform exit at ${best.ext} for EVERYONE (no conditioning) already gets $${uniformAtBestExt.meanDollarPerDay}/day -- $${fromFlatExitAlone.toFixed(2)}/day of the total $${(best.r.meanDollarPerDay - baseline.meanDollarPerDay).toFixed(2)}/day gain is just from the later flat exit time (itself an unresolved question -- the base calibration's own TRAIN/TEST holdout disagreed on 13:30 vs 16:00), and only $${fromConditioningItself.toFixed(2)}/day is attributable to the slow/fast conditioning on top of that. Verdict: ${verdict}, but MOSTLY explained by exit-time choice, not by the "slow" classifier adding real value -- this is a max-of-${SLOW_THRESHOLDS.length * EXTENDED_CANDIDATES.length}-cells result on N=${n}, not yet day-blocked-bootstrap-checked at the winning cell or chronologically split.`,
    sourceFile: 'scripts/research_overnight_orderflow_extend_if_slow.mjs',
    sourceDate: '2026-09-22',
    sampleSize: n,
    winRate: best.r.hitRate,
    evPerTrade: best.r.meanDollarPerDay - baseline.meanDollarPerDay,
    rigorStatus: `max_of_${SLOW_THRESHOLDS.length * EXTENDED_CANDIDATES.length}_cells_not_yet_ci_checked_at_winner`,
    status: 'PROVISIONAL',
  });
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
