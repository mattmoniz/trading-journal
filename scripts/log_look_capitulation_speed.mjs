import { logLook } from './lib/look_ledger.mjs';
import { recordClaim } from './record_claim.mjs';
const prereg = 'docs/CAPITULATION_SPEED_EXIT_PREREG_20261110.md';
console.log('claim', (await recordClaim({ slug: 'capitulation_speed_null_mc_20261110', claimText: 'NULL MONTE CARLO PASSED for row 44: 1000 per-day sign-flip iterations over 6 tests, Holm 0.10, false-pass 0.069 (required <= 0.10).', sourceFile: prereg, sourceDate: '2026-11-10', rigorStatus: 'not_checked', status: 'CONFIRMED', unblockCondition: null, extra: { false_pass_rate: 0.069, alpha: 0.10 } })).slug);
console.log('look', await logLook({ family: 'capitulation_speed_exit_20261110', dataWindow: 'explore_2023-04..2025-05-16 500V full sessions (row 42 climaxes)', kind: 'EXPLORE', tests: 6, label: 'RUN row 44: extreme bar speed at a capitulation climax as an exit signal, RTH and Globex, 6 counted tests, Holm 0.10', script: 'scripts/vacuum_sim/capitulation_speed.py', prereg, claimSlug: 'capitulation_speed_exit_20261110', outcome: 'RUN_STARTED', ref: 'capitulation_speed_exit_20261110_run1' }));
process.exit(0);
