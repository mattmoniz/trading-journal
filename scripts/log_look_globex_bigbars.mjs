import { logLook } from './lib/look_ledger.mjs';
import { recordClaim } from './record_claim.mjs';
const prereg = 'docs/GLOBEX_BIG_BARS_PREREG_20261110.md';
console.log('claim', (await recordClaim({ slug: 'globex_bigbars_null_mc_20261110', claimText: 'NULL MONTE CARLO for row 41: 1000 iterations at Holm 0.10 gave 0.103 (> 0.10), so the pre-declared fallback applied (real run at Holm 0.05); re-estimated 1000 iterations seed 785 at Holm 0.05: see null_gate.json, passed.', sourceFile: prereg, sourceDate: '2026-11-10', rigorStatus: 'not_checked', status: 'CONFIRMED', unblockCondition: null, extra: { first_estimate_holm_0_10: 0.103, final_alpha: 0.05 } })).slug);
console.log('look', await logLook({ family: 'globex_bigbars_20261110', dataWindow: 'explore_2023-03-07..2025-05-16 Globex 1000/2000/500V bars', kind: 'EXPLORE', tests: 16, label: 'RUN row 41: Globex 1000V and 2000V bars, ROC 3/10, two holds, 16 counted tests, Holm 0.05 (pre-declared fallback)', script: 'scripts/vacuum_sim/globex_barsize_test.py', prereg, claimSlug: 'globex_bigbars_20261110', outcome: 'RUN_STARTED', ref: 'globex_bigbars_20261110_run1' }));
process.exit(0);
