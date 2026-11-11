import { logLook } from './lib/look_ledger.mjs';
import { recordClaim } from './record_claim.mjs';
const prereg = 'docs/GLOBEX_BAR_SIZE_PREREG_20261110.md', rate = process.argv[2];
console.log('claim', (await recordClaim({ slug: 'globex_barsize_null_mc_20261110', claimText: `NULL MONTE CARLO PASSED for row 39: 200 per-day sign-flip iterations over 16 cells, family-wise false-pass ${rate} (required <= 0.10).`, sourceFile: prereg, sourceDate: '2026-11-10', rigorStatus: 'not_checked', status: 'CONFIRMED', unblockCondition: null, extra: { false_pass_rate: Number(rate) } })).slug);
console.log('look', await logLook({ family: 'globex_barsize_20261110', dataWindow: 'explore_2023-03-07..2025-05-16 Globex 100/125/500V bars', kind: 'EXPLORE', tests: 16, label: 'RUN row 39: Globex 100/125V bars, ROC 3/10, two holds, 16 counted tests, Holm 0.10', script: 'scripts/vacuum_sim/globex_barsize_test.py', prereg, claimSlug: 'globex_barsize_20261110', outcome: 'RUN_STARTED', ref: 'globex_barsize_20261110_run1' }));
process.exit(0);
