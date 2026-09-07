// Self-checking recheck for RESEARCH_CLAIM wide_ib_turbulent_hold_longer_exit_timing_20260906.
// The original finding (hold-longer on wide-IB + LIVE-TURBULENT-reassessed days costs
// -$15.09/trade, stable-signed) was real but concentrated in only 5 distinct calendar dates --
// explicitly flagged as "too thin to trust the magnitude yet, recheck once N clears roughly
// 10+ distinct dates." This watches for that threshold and re-updates the claim once it clears,
// reusing the exact same computation as the original analysis (scripts/lib/wideIbTurbulentExit.mjs)
// -- not a re-derivation.
import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { computeWideIbTurbulentExitDeltas } from './lib/wideIbTurbulentExit.mjs';
import { recordClaim } from './record_claim.mjs';
import { runSelfCheckingClaim } from './lib/selfCheckingClaim.mjs';

const DISTINCT_DATE_THRESHOLD = 10;

async function checkCondition() {
  const results = await computeWideIbTurbulentExitDeltas(query);
  if (results.length === 0) return { met: false };
  const rigor = computeRigor(results, { dateField: 'trade_date', pnlFn: x => x.delta });
  return { met: rigor.distinctDates >= DISTINCT_DATE_THRESHOLD, data: { results, rigor } };
}

async function onConditionMet({ results, rigor }) {
  const meanDelta = results.reduce((s, r) => s + r.delta, 0) / results.length;
  console.log(`  N=${results.length}, distinctDates=${rigor.distinctDates} (threshold ${DISTINCT_DATE_THRESHOLD} cleared), mean delta=$${meanDelta.toFixed(2)}`);
  console.log('  Rigor:', JSON.stringify(rigor));

  const { rows: [{ today }] } = await query(`SELECT CURRENT_DATE::text as today`);
  await recordClaim({
    slug: 'wide_ib_turbulent_hold_longer_exit_timing_20260906',
    claimText: `AUTO-UPDATED ${today} by scripts/verify_wide_ib_turbulent_exit_timing_recheck.mjs: distinct-date count has cleared the ${DISTINCT_DATE_THRESHOLD}-date threshold the original 2026-09-06 finding was waiting on (now ${rigor.distinctDates} distinct dates, was 5). Reusing the exact same computation (scripts/lib/wideIbTurbulentExit.mjs -- real stepWiderTarget()/getLiveDayTypeRead() simulation, not re-derived): N=${results.length}, mean P&L delta (hold-longer - status-quo) = $${meanDelta.toFixed(2)}/trade. computeRigor(): clean=${rigor.clean}, stable=${rigor.stable}, clustered=${rigor.clustered}, top5DayPct=${rigor.top5DayPct}. ${rigor.clean ? 'Now clears this project\'s own clean+stable bar -- worth a real decision on whether to wire this into the live exit-timing logic.' : 'Still not clean by computeRigor()\'s own bar even at this N -- keep tracking, do not wire yet.'}`,
    sourceFile: 'scripts/lib/wideIbTurbulentExit.mjs',
    sourceDate: today,
    sampleSize: results.length,
    evPerTrade: +meanDelta.toFixed(2),
    rigorStatus: rigor.clean ? 'clean_stable_at_recheck_threshold' : 'still_not_clean_at_recheck_threshold',
    status: rigor.clean ? 'CONFIRMED' : 'PROVISIONAL',
  });
  console.log('  RESEARCH_CLAIM wide_ib_turbulent_hold_longer_exit_timing_20260906 auto-updated.');
}

runSelfCheckingClaim({ name: 'verify_wide_ib_turbulent_exit_timing_recheck', checkCondition, onConditionMet })
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
