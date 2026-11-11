import { logLook } from '../lib/look_ledger.mjs';
const r = await logLook({ family: 'capitulation_exit_shadow_20261109', dataWindow: 'explore_2023-03-07..2025-05-16 + depth_era_2026-06-15..2026-10-09 (sealed 2025-05-17..2026-06-14 and >=2026-10-12 untouched)', kind: 'EXPLORE', tests: 2,
  label: 'Row 30 replay A5 counted tests R1 (VALUE_FADE) and R2 (GLOBEX_LEVEL): paired d = virtual exit at next 500V open after first extended thrust minus actual_pnl, signalled stratum, risk-set placebo, Holm 0.10',
  script: 'scripts/vacuum_sim/capitulation_replay_a5.py', prereg: 'docs/CAPITULATION_EXIT_SHADOW_PREREG_20261109.md', claimSlug: 'capitulation_exit_replay_20261109', outcome: 'RUN_PENDING', notes: { amendment: 'A5', co025_bar_adr20: 0.015 } });
console.log('LOOK_ID', r); process.exit(0);
