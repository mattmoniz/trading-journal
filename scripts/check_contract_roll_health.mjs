// Standalone daily NQ contract-roll health check, wired into run_daily_calibration.sh.
// Shares its actual queries with data_sanity_audit.mjs's check [6] via
// scripts/lib/contractRollHealth.mjs -- see that file's header for the full incident
// writeup (OPEN_DECISION contract_calendar_roll_race_stale_price_20260915) and why this
// needs to run DAILY rather than only as part of the weekly data_sanity_audit.mjs (a real
// roll's overlap window can span 12+ days; the other checks in that script don't need daily
// granularity and already trip on known historical issues, so running the whole script
// daily would just be alert fatigue).
//
// Exit code 0 = clean. Exit code 1 = a real anomaly found (vanished day or calendar/volume
// disagreement) -- the dual-contract-overlap report is informational only and never
// contributes to the exit code.
import { checkContractRollHealth } from './lib/contractRollHealth.mjs';

const { flagged, info } = await checkContractRollHealth('NQ', 45);

console.log(`NQ contract-roll health check — ${new Date().toISOString()}`);
if (flagged.length === 0) {
  console.log('  ✅ No vanished trading days or calendar/volume disagreements in the last 45 days');
} else {
  for (const f of flagged) console.log(`  🔴 ${f.message}`);
}
for (const i of info) console.log(`  ℹ️  ${i.message}`);

process.exit(flagged.length === 0 ? 0 : 1);
