import { logLook } from '../lib/look_ledger.mjs';
const r = await logLook({ family: 'capitulation_exit_shadow_20261109', dataWindow: 'explore_2023-03-07..2025-05-16 + depth_era_2026-06-15..2026-10-09 (sealed 2025-05-17..2026-06-14 and >=2026-10-12 untouched)', kind: 'EXPLORE', tests: 0,
  label: 'Row 30 replay PHASE 1, outcome-blind counts: per bet class, how many setup rows had a same-direction extended vacuum thrust during their life and how much of the life was left (reads fired_at/resolved_at only, no P&L)',
  script: 'scripts/vacuum_sim/capitulation_replay_phase1.py', prereg: 'docs/CAPITULATION_EXIT_SHADOW_PREREG_20261109.md', claimSlug: 'capitulation_exit_shadow_20261109', outcome: 'RUN_PENDING', notes: { counts_only: true, p_and_l_read: false } });
console.log('LOOK_ID', r); process.exit(0);
