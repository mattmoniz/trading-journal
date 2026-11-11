import { logLook } from './lib/look_ledger.mjs';
import { recordClaim } from './record_claim.mjs';
const look = await logLook({ family: 'capitulation_exit_shadow_20261109', dataWindow: 'depth_era_2026-06-15..2026-10-09 (sealed 2025-05-17..2026-06-14 and >=2026-10-12 untouched)', kind: 'EXPLORE', tests: 2,
  label: 'Row 30 A6: capitulation exit on WIDE-BRACKET rows of all real setups, W_RTH and W_GBX, Holm 0.10 (registration; run pending)', script: 'scripts/vacuum_sim/capitulation_replay_a6.py', prereg: 'docs/CAPITULATION_EXIT_ALL_SETUPS_PREREG_20261109.md', claimSlug: 'capitulation_exit_all_setups_20261110', outcome: 'RUN_PENDING', ref: 'cap_a6_register_20261110' });
console.log('look', look);
console.log(await recordClaim({ slug: 'capitulation_exit_all_setups_20261110', status: 'PROVISIONAL', rigorStatus: 'not_checked', sourceFile: 'docs/CAPITULATION_EXIT_ALL_SETUPS_PREREG_20261109.md', sourceDate: '2026-11-10', sampleSize: null,
  claimText: 'REGISTERED, NOT RUN. Row 30 A6: does a same-direction extended vacuum thrust exit beat each real setup\'s own exit on WIDE-bracket rows (target distance in the top tercile of earlier rows in ADR20 units), RTH and Globex separately, 2026 depth-era window, 5,200 real rows, Holm 0.10, risk-set placebo, signalled stratum. Lead only; forward logger is the verdict.' }));
process.exit(0);
