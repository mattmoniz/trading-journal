import { logLook } from '../lib/look_ledger.mjs';
const r = await logLook({ family: 'vacuum_entry_timing_20261109', dataWindow: 'explore_2023-03-07..2025-05-16 + depth_era_2026-06-15..2026-10-09 (sealed 2025-05-17..2026-06-14 and >=2026-10-12 untouched)', kind: 'EXPLORE', tests: 0,
  label: 'Row 34 PHASE 1 outcome-blind counts: per bet class and track, rows with a same-direction ANY / EXTENDED vacuum thrust inside their life, independent thrusts, days, share of life elapsed at the first thrust (reads fired_at/resolved_at only, no P&L)',
  script: 'scripts/vacuum_sim/row34_phase1.py', prereg: 'docs/VACUUM_ENTRY_TIMING_PREREG_20261109.md', claimSlug: 'vacuum_entry_timing_20261109', outcome: 'RUN_PENDING', notes: { counts_only: true, p_and_l_read: false } });
console.log('LOOK_ID', r); process.exit(0);
