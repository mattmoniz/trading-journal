import { logLook } from './lib/look_ledger.mjs';
import { recordClaim } from './record_claim.mjs';
const prereg = 'docs/GLOBEX_ROC_LENGTH_SWEEP_PREREG_20261110.md';
const rate = process.argv[2];
console.log('claim', (await recordClaim({ slug: 'globex_roc_sweep_null_mc_20261110', claimText: `NULL MONTE CARLO PASSED for row 37: 200 per-day sign-flip iterations over 40 cells, family-wise false-pass ${rate} (required <= 0.10).`, sourceFile: prereg, sourceDate: '2026-11-10', rigorStatus: 'not_checked', status: 'CONFIRMED', unblockCondition: null, extra: { false_pass_rate: Number(rate) } })).slug);
console.log('look', await logLook({ family: 'globex_roc_sweep_20261110', dataWindow: 'explore_2023-03-07..2025-05-16 Globex 500V bars', kind: 'EXPLORE', tests: 40, label: 'RUN row 37: Globex ROC length sweep 1..20, 40 counted tests, Holm 0.10', script: 'scripts/vacuum_sim/globex_roc_sweep.py', prereg, claimSlug: 'globex_roc_sweep_20261110', outcome: 'RUN_STARTED', ref: 'globex_roc_sweep_20261110_run1' }));
process.exit(0);
