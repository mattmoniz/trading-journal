// Row 37 registration: Globex ROC length sweep 1..20 (40 counted tests). Registration look tests=0; the run look (tests=40) is logged by the run step. Every call awaited (hr-060).
import { readFileSync, writeFileSync } from 'node:fs';
import { logLook } from './lib/look_ledger.mjs';
import { recordClaim } from './record_claim.mjs';
const slug = 'globex_roc_sweep_20261110', prereg = 'docs/GLOBEX_ROC_LENGTH_SWEEP_PREREG_20261110.md';
console.log('look', await logLook({ family: slug, dataWindow: 'explore_2023-03-07..2025-05-16 Globex 500V bars; sealed untouched', kind: 'EXPLORE', tests: 0, label: 'REGISTRATION row 37: Globex ROC length sweep 1..20, 40 counted tests, none run', prereg, claimSlug: slug, outcome: 'REGISTERED', ref: `${slug}_registration` }));
const c = await recordClaim({ slug, claimText: 'REGISTERED, NOT RUN. Row 37: the row-36 Globex expansion rule at ROC length 1..20; per length continuation and reversion net > 0 (40 one-sided day-blocked tests, Holm 0.10, gate 100 events / 60 days). Lengths 3 and 10 were already read in row 36 and are re-counted. Survivors are leads for forward testing only.', sourceFile: prereg, sourceDate: '2026-11-10', rigorStatus: 'not_checked', status: 'PROVISIONAL', unblockCondition: null, extra: { registered: '2026-11-10', register_rows: '37', run: false } });
console.log('claim', c.slug);
const p = 'docs/IMPROVEMENT_REGISTER_20261104.md'; let t = readFileSync(p, 'utf8');
if (!t.includes('| 37 |')) { const row = '| 37 | GLOBEX VACUUM ROC LENGTH SWEEP 1..20 (user 2026-11-10: "different ROC 1-10... maybe 1-20") | REGISTERED 2026-11-10: prereg `docs/GLOBEX_ROC_LENGTH_SWEEP_PREREG_20261110.md`, claim `globex_roc_sweep_20261110`; follows row 36 (ROC3 and ROC10 both no gross edge). 40 counted tests. | Any gross edge by length, or the shape across lengths | Run `scripts/vacuum_sim/globex_roc_sweep.py` build / null / run; other variations (Z threshold, hold, band) = separate row | Nothing survives with MDE <= 0.015 ADR20: second null with row 36, park the ROC-onset entry (co-025), next is the M4 fade | REGISTERED |\n'; t = t.replace('Review: when any row', row + '\nReview: when any row'); writeFileSync(p, t); }
process.exit(0);
