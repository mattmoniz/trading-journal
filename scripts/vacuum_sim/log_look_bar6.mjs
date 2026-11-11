import { logLook } from '../lib/look_ledger.mjs';
const r = await logLook({ family: 'vacuum_bar6_exit_20261110', dataWindow: 'explore_2023-04-04..2025-05-16', kind: 'EXPLORE', tests: 4,
  label: 'Vacuum bar-6 DETERIORATING exit (Q4-8): T1 arm B minus arm A, T2 minus the opposite-direction placebo, RTH and Globex, Holm 0.10',
  script: 'scripts/vacuum_sim/vacuum_bar6_exit.py', prereg: 'docs/VACUUM_BAR6_EXIT_PREREG_20261110.md', claimSlug: 'vacuum_bar6_exit_20261110', outcome: 'RUN_PENDING', notes: { queue: 'Q4-8', null_gate: 0.082 } });
console.log('LOOK_ID', r); process.exit(0);
