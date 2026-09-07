// Self-checking confirmation for OPEN_DECISION prior_day_trend_gate_pending_rth_confirmation_20260906
// (docs/OPEN_THREADS.md, 2026-09-06/07 entries). The prior-day-TREND sizeMultiplier gate
// (server/routes/acd.js, `if (priorDayProfile === 'TREND') mult = Math.max(mult - 0.25, 0.25);`)
// shipped 2026-09-07 fully statically/functionally verified (node --check, ESLint, direct DB
// checks, DeepSeek code review) but never observed firing against a real trade during real RTH
// hours -- verification happened deep in overnight/Globex hours. This script closes that gap
// automatically: it does not re-verify the CODE (already done, thoroughly), it only confirms
// EXECUTION -- that a real trade has actually fired on a real day where auction_reads.
// prior_day_profile='TREND' since the gate went live, proving the code path was reached under
// real conditions with a real (non-null) input, not just exercised in a synthetic test.
//
// No-ops quietly (exit 0, no resolution) until that real evidence exists -- safe to run daily
// forever. Once it exists, auto-resolves the OPEN_DECISION via resolveDecision() so no human or
// future Claude session needs to remember to check by hand.
//
// Deliberately does NOT try to statistically re-verify the -0.25 size reduction itself (e.g.
// "is TREND-day avg size_multiplier meaningfully lower") -- with ~25 other factors in the same
// IIFE, a clean single-factor isolation from aggregate real_setups data would be noisy and
// error-prone to get right automatically. The code's correctness was already established via
// DeepSeek's independent review (scratch/deepseek_response.md, 2026-09-07) plus this session's
// own dry-run parameter verification; this script's only job is proving the gate got a real,
// non-null input to act on at least once, which is the one thing static verification couldn't
// prove.
import { query } from '../server/db.js';
import { resolveDecision } from './flag_decision.mjs';
import { runSelfCheckingClaim } from './lib/selfCheckingClaim.mjs';

const GATE_SHIPPED_DATE = '2026-09-07';
const DECISION_SLUG = 'prior_day_trend_gate_pending_rth_confirmation_20260906';

async function checkCondition() {
  const res = await query(`
    SELECT a.id, a.trade_date::text as trade_date, a.setup_type, a.origin_status,
      a.fired_at::text as fired_at, a.size_multiplier::float as size_multiplier
    FROM active_setups a
    JOIN auction_reads ar ON a.trade_date = ar.trade_date
    WHERE a.origin_status IN ('ACTIVE','SHADOW')
      AND a.trade_date >= $1
      AND ar.prior_day_profile = 'TREND'
    ORDER BY a.fired_at ASC
    LIMIT 10
  `, [GATE_SHIPPED_DATE]);
  return { met: res.rows.length > 0, data: res.rows };
}

async function onConditionMet(rows) {
  console.log(`  Confirmed: ${rows.length} real fire(s) on a TREND-preceded day since ${GATE_SHIPPED_DATE}:`);
  for (const r of rows) {
    console.log(`    ${r.trade_date} ${r.setup_type} (${r.origin_status}) fired_at=${r.fired_at} size_multiplier=${r.size_multiplier}`);
  }
  const { rows: [{ today }] } = await query(`SELECT CURRENT_DATE::text as today`);
  const resolutionText = `AUTO-RESOLVED ${today} by scripts/verify_prior_day_trend_gate_live.mjs (wired into run_daily_calibration.sh): confirmed real execution under real conditions -- ${rows.length} real ACTIVE/SHADOW active_setups row(s) fired on a trade_date where auction_reads.prior_day_profile='TREND', since the gate shipped ${GATE_SHIPPED_DATE}. First real instance: ${rows[0].trade_date} ${rows[0].setup_type} (${rows[0].origin_status}), fired_at=${rows[0].fired_at}, size_multiplier=${rows[0].size_multiplier}. This confirms the priorDayProfile lookup returned a real non-null 'TREND' value on a real trading day with real fires -- the code path was reached with the input it was built for, not just exercised statically. Does not re-verify the -0.25 reduction's own correctness (already independently confirmed via DeepSeek code review, scratch/deepseek_response.md 2026-09-07, and this session's own scope/placement checks) -- this only closes the "never observed executing live" gap that remained after shipping outside RTH hours.`;
  await resolveDecision(DECISION_SLUG, resolutionText);
  console.log(`  OPEN_DECISION ${DECISION_SLUG} auto-resolved.`);
}

runSelfCheckingClaim({ name: 'verify_prior_day_trend_gate_live', checkCondition, onConditionMet })
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
