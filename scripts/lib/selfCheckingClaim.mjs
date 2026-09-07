// Shared scaffold for "self-checking claim" scripts: a recurring cron check that waits for a
// real-data condition to become true, then runs a real analysis and updates the tracking
// system (recordClaim()/resolveDecision()) itself, so no human or future Claude session needs
// to remember to come back and check by hand.
//
// Extracted 2026-09-07 (user request, after the 2nd near-identical script in one session --
// "we should probably make a class that just handles auto deploy and all the steps") from
// scripts/verify_prior_day_trend_gate_live.mjs, the first instance of this pattern. Every
// script using this shares the same check-then-act shape and logging format; only the
// condition query and the real analysis differ per claim.
//
// Usage:
//   import { runSelfCheckingClaim } from './lib/selfCheckingClaim.mjs';
//   await runSelfCheckingClaim({
//     name: 'my_check_name',                 // for log lines only
//     checkCondition: async () => ({ met: bool, data: <anything checkCondition wants to pass to onConditionMet> }),
//     onConditionMet: async (data) => { ...run the real analysis, call recordClaim()/resolveDecision()... },
//   });
//
// checkCondition must be cheap and side-effect-free -- it runs every time this is invoked
// (daily, typically), including every day the condition stays unmet. onConditionMet only runs
// once the condition is met; it's expected to do the real work (re-running an analysis script's
// logic, writing to performance_audit). Errors in either are caught and logged, never silently
// swallowed, and always exit non-zero so a real failure is visible in the cron log --- but a
// condition simply not being met yet is NOT an error and always exits 0.
export async function runSelfCheckingClaim({ name, checkCondition, onConditionMet }) {
  console.log(`[${name}] Checking condition...`);
  let result;
  try {
    result = await checkCondition();
  } catch (e) {
    console.error(`[${name}] checkCondition() threw:`, e.message);
    throw e;
  }
  if (!result?.met) {
    console.log(`[${name}] Condition not yet met -- still pending, will keep checking.`);
    return { ran: false };
  }
  console.log(`[${name}] Condition met -- running analysis and updating tracking...`);
  try {
    await onConditionMet(result.data);
  } catch (e) {
    console.error(`[${name}] onConditionMet() threw:`, e.message);
    throw e;
  }
  console.log(`[${name}] Done.`);
  return { ran: true };
}
