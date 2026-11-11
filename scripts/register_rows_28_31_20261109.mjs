// Registers improvement-register rows 28-31 (user go 2026-11-09 "Register rows 28-31"): one ledger look (registration, tests=0: no outcome is read) and one PROVISIONAL claim per prereg.
// The counted tests are charged to the look that the run script logs before it reads an outcome (hr-023). Every call is awaited (hr-060).
import { logLook } from './lib/look_ledger.mjs';
import { recordClaim } from './record_claim.mjs';
const items = [
  { rows: '28+29', family: 'vacuum_context_exit_20261109', slug: 'vacuum_context_exit_20261109', prereg: 'docs/VACUUM_CONTEXT_EXIT_PREREG_20261109.md',
    window: 'depth_era_explore_2026-06-15..2026-10-09 (primary) + explore 2023-03-07..2025-05-16 (replication); >=2026-10-12 unread', kind: 'EXPLORE', tests: 0,
    label: 'REGISTRATION rows 28+29: extension context (skip/fade) and ratchet vs 30-bar hold on the live expansion rule; 4 counted tests, none run',
    claim: 'REGISTERED, NOT RUN. Rows 28+29: on the live ROC10 expansion rule, (A) skipping thrusts that follow an extended move (top tercile of 240-trading-minute displacement in ADR20, expanding window) and (B) a ratcheting 2.5 x EMA10(TR) stop versus the 30-bar hold on non-extended thrusts. 4 counted tests (A, B x RTH, Globex), Holm 0.10, day-blocked, matched-bar control, mirrored placebo, leave-one-session-out. Phase 1 (outcome-blind counts and MDE) first. No outcome read. Prior: look 192 (ROC crosses after a running burst are worse) and one-session hindsight illustrations, not evidence.',
    unblock: 'reopen/run: phase 1 outcome-blind counts (script not yet written); verdict only via the frozen pass rule' },
  { rows: '30', family: 'capitulation_exit_shadow_20261109', slug: 'capitulation_exit_shadow_20261109', prereg: 'docs/CAPITULATION_EXIT_SHADOW_PREREG_20261109.md',
    window: 'FORWARD from the logger start date (not built yet)', kind: 'FORWARD', tests: 0,
    label: 'REGISTRATION row 30: capitulation-as-exit overlay on open setups, forward shadow, AT_BOUNDARY and AT_DEFENDED_PIVOT tags; 2 counted tests, logger not built',
    claim: 'REGISTERED, NOT RUN, LOGGER NOT BUILT. Row 30: for open SHORT/LONG setup rows (ACTIVE/SHADOW, cluster primary), a same-direction ROC10 expansion onset with extension in the rolling top tercile is the virtual exit (next-bar open); virtual minus actual P&L judged forward on rows tagged at_boundary (prior RTH/ON levels within 0.05 x ADR20) and at_defended_pivot (user definition, existing pivot modules). 2 counted tests, floor 20 signalled rows on 10 days each. One-session illustration (+$1,669 held vs +$478 actual) is hindsight, not evidence.',
    unblock: 'build the logger (user go), then judge at the floor in the prereg' },
  { rows: '31', family: 'tell_roc_coincidence_20261109', slug: 'tell_roc_coincidence_20261109', prereg: 'docs/TELL_VS_ROC_COINCIDENCE_PREREG_20261109.md',
    window: 'tell explore 1,451 scored entries 2023-04-04..2025-05-16; live 43 fires descriptive only', kind: 'EXPLORE', tests: 0,
    label: 'REGISTRATION row 31: AMT tell vs ROC10 thrust coincidence (pace-matched control) and thrust-present vs absent split; 2 counted tests, none run',
    claim: 'REGISTERED, NOT RUN. Row 31: (T1) outcome-blind coincidence lift of tell entries with a causal same-direction ROC10 onset in [t-W, t] (W = 10 x median same-hour bar duration) against random bars matched on date, hour AND pace tercile (the by-construction control); (T2) V1 net dollars thrust-present minus absent with a within-hour permutation placebo. Holm 0.10, day-blocked. User observation on the 2026-11-05 chart (seen session, excluded). No outcome read.',
    unblock: 'run step 1 (outcome-blind) then T2; script not yet written' },
];
for (const it of items) {
  const look = await logLook({ family: it.family, dataWindow: it.window, kind: it.kind, tests: it.tests, label: it.label, prereg: it.prereg, claimSlug: it.slug, outcome: 'REGISTERED', ref: `${it.slug}_registration` });
  console.log('rows', it.rows, 'look', look);
  const c = await recordClaim({ slug: it.slug, claimText: it.claim, sourceFile: it.prereg, sourceDate: '2026-11-09', rigorStatus: 'not_checked', status: 'PROVISIONAL', unblockCondition: null, extra: { registered: '2026-11-09', register_rows: it.rows, prereg: it.prereg, run: false, unblock_note: it.unblock } });
  console.log('claim', it.slug, c);
}
process.exit(0);
