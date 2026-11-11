// Row 36: null-gate claim + the RUN look (tests = 5), both logged BEFORE any outcome statistic is printed (hr-023). Every call awaited (hr-060).
import { logLook } from './lib/look_ledger.mjs';
import { recordClaim } from './record_claim.mjs';
const slug = 'globex_roc3_vacuum_20261110', prereg = 'docs/GLOBEX_ROC3_VACUUM_PREREG_20261110.md';
const c = await recordClaim({ slug: 'globex_roc3_null_mc_20261110', claimText: 'NULL MONTE CARLO PASSED for row 36: 200 iterations of per-day sign flips (cost 0, 1000 bootstrap draws, same gate and Holm 0.10) gave a family-wise false-pass rate of 0.055 (required <= 0.10).', sourceFile: prereg, sourceDate: '2026-11-10', rigorStatus: 'not_checked', status: 'CONFIRMED', unblockCondition: null, extra: { iters: 200, false_pass_rate: 0.055 } });
console.log('claim', c.slug);
const look = await logLook({ family: slug, dataWindow: 'explore_2023-03-07..2025-05-16 Globex 500V bars', kind: 'EXPLORE', tests: 5, label: 'RUN row 36: Globex ROC3 vs ROC10, 5 counted tests (T1-T5), Holm 0.10', script: 'scripts/vacuum_sim/globex_roc3_test.py', prereg, claimSlug: slug, outcome: 'RUN_STARTED', ref: `${slug}_run1` });
console.log('look', look); process.exit(0);
