import { logLook } from '../lib/look_ledger.mjs';
const r = await logLook({ family: 'capitulation_exit_shadow_20261109', dataWindow: 'explore_2023-03-07..2025-05-16 + depth_era_2026-06-15..2026-10-09 (sealed 2025-05-17..2026-06-14 and >=2026-10-12 untouched)', kind: 'EXPLORE', tests: 0,
  label: 'Row 30 replay, Argon Q7 step 1 (pre-emption diagnostic): for signalled rows, how far price had already travelled toward the row t1 level (and past its stop) at the first extended thrust bar close; reads price_at_detection/stop_level/t1_level and bar closes, NO P&L or resolution price',
  script: 'scripts/vacuum_sim/capitulation_preemption_diag.py', prereg: 'docs/CAPITULATION_EXIT_SHADOW_PREREG_20261109.md', claimSlug: 'capitulation_exit_shadow_20261109', outcome: 'RUN_PENDING', notes: { counts_only: true, p_and_l_read: false, argon_q7_step1: true } });
console.log('LOOK_ID', r); process.exit(0);
