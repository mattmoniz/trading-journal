// Registers row 35 (setup library census + overlay tests by structural group). Registration only: tests=0. Every call awaited (hr-060).
import { logLook } from './lib/look_ledger.mjs';
import { recordClaim } from './record_claim.mjs';
const slug = 'setup_library_census_20261109', prereg = 'docs/SETUP_LIBRARY_CENSUS_PREREG_20261109.md';
const look = await logLook({ family: slug, dataWindow: 'real-forward 2026-06-15..2026-10-09; sealed and >=2026-10-12 untouched', kind: 'EXPLORE', tests: 0, label: 'REGISTRATION row 35: descriptive census of every setup family + counted overlay tests per structural group; none run', prereg, claimSlug: slug, outcome: 'REGISTERED', ref: `${slug}_registration` });
console.log('look', look);
const c = await recordClaim({ slug, claimText: 'REGISTERED, NOT RUN. Row 35: a descriptive census of the ~106 setup families (N, days, win rate, sum/N, day-blocked CI, rigor, thrust overlap) and counted capitulation-exit / vacuum-entry tests per structural group (flush, defended-level, order-flow, sweep-auction, continuation-daytype; level-based as reference), Holm 0.10, after the user classifies families 9 and 17-23 and Argon reviews the design.', sourceFile: prereg, sourceDate: '2026-11-09', rigorStatus: 'not_checked', status: 'PROVISIONAL', unblockCondition: null, extra: { registered: '2026-11-09', register_rows: '35', prereg, run: false, unblock_note: 'Argon design answers + user classification of families 9 and 17-23' } });
console.log('claim', c.slug); process.exit(0);
