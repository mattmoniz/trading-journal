import { logLook } from '../lib/look_ledger.mjs';
const r = await logLook({ family: 'vacuum_bar6_exit_20261110', dataWindow: 'explore_2023-04-04..2025-05-16', kind: 'EXPLORE', tests: 0,
  label: 'Vacuum bar-6 exit amendment A1: Globex split by entry clock block (reopen 18-20, 20-24, 0-6, 6-9:25); descriptive, 0 counted tests',
  script: 'scripts/vacuum_sim/vacuum_bar6_exit.py', prereg: 'docs/VACUUM_BAR6_EXIT_PREREG_20261110.md', claimSlug: 'vacuum_bar6_exit_globex_20261110', outcome: 'RUN_PENDING', notes: { amendment: 'A1', descriptive: true } });
console.log('LOOK_ID', r); process.exit(0);
