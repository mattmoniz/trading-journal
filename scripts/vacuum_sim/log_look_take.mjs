import { logLook } from '../lib/look_ledger.mjs';
const r = await logLook({ family: 'vacuum_take_20261110', dataWindow: 'explore_2023-04-04..2025-05-16', kind: 'EXPLORE', tests: 0,
  label: 'Vacuum item 1: favourable run (MFE_pre in stop units) of the live-rule onset vs a direction-blind placebo, RTH and Globex apart; descriptive, 0 counted tests',
  script: 'scripts/vacuum_sim/vacuum_take_look.py', prereg: 'docs/VACUUM_TAKE_PREREG_20261110.md', claimSlug: 'vacuum_take_20261110', outcome: 'RUN_PENDING', notes: { item: 1, descriptive: true } });
console.log('LOOK_ID', r); process.exit(0);
