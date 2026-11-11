// Registers amendment A4 of row 30 (historical replay arm) and new row 34 (vacuum thrust as an entry trigger). Registration only: tests=0, no outcome read. Every call awaited (hr-060).
import { logLook } from './lib/look_ledger.mjs';
import { recordClaim } from './record_claim.mjs';
const items = [
  { rows: '30 (A4 replay)', family: 'capitulation_exit_replay_20261109', slug: 'capitulation_exit_replay_20261109', prereg: 'docs/CAPITULATION_EXIT_SHADOW_PREREG_20261109.md', window: 'explore 2023-04..2025-05-16 + depth-era 2026-06-15..2026-10-09; sealed and >=2026-10-12 untouched', kind: 'EXPLORE', tests: 0,
    label: 'REGISTRATION row 30 A4: historical replay arm R1 (VALUE_FADE) and R2 (GLOBEX_LEVEL), exit at the first same-direction extended vacuum thrust vs the row exit; 2 counted tests, none run',
    claim: 'REGISTERED, NOT RUN. Row 30 amendment A4: two explore-lead tests (VALUE_FADE, GLOBEX_LEVEL) of mean d = virtual exit at the next bar open after the first same-direction extended vacuum thrust minus actual P&L, no-signal rows 0, Holm 0.10, day-blocked bootstrap, winsorized/drop-top-2/leave-one-day-out/halves gates, hold-matched placebo, MDE printed first. Phase 1 counts (look 219): every class clears 20 independent / 10 days.', unblock: 'write run script (imports the logger virtual-P&L function), log the ledger look, run with --go' },
  { rows: '34', family: 'vacuum_entry_timing_20261109', slug: 'vacuum_entry_timing_20261109', prereg: 'docs/VACUUM_ENTRY_TIMING_PREREG_20261109.md', window: 'none yet (Phase 1 counts first)', kind: 'EXPLORE', tests: 0,
    label: 'REGISTRATION row 34: vacuum thrust as an ENTRY trigger for the other setups (confirmation entry, same stop/target price levels); no test run',
    claim: 'REGISTERED, NOT RUN, NOT BUILT. Row 34: enter a setup row at the next bar open after the first same-direction ROC10 thrust inside its life instead of at its own fire; needs an entry-price-only control, did-it-fill check, no-thrust rows counted as lost trades. Phase 1 outcome-blind counts first (user go).', unblock: 'Phase 1 counts per bet class (user go)' },
];
for (const it of items) {
  const look = await logLook({ family: it.family, dataWindow: it.window, kind: it.kind, tests: it.tests, label: it.label, prereg: it.prereg, claimSlug: it.slug, outcome: 'REGISTERED', ref: `${it.slug}_registration` });
  console.log('rows', it.rows, 'look', look);
  const c = await recordClaim({ slug: it.slug, claimText: it.claim, sourceFile: it.prereg, sourceDate: '2026-11-09', rigorStatus: 'not_checked', status: 'PROVISIONAL', unblockCondition: null, extra: { registered: '2026-11-09', register_rows: it.rows, prereg: it.prereg, run: false, unblock_note: it.unblock } });
  console.log('claim', it.slug, c);
}
process.exit(0);
