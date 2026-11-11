import { logLook } from '../lib/look_ledger.mjs';
console.log('LOOK_ID', await logLook({ family: 'vacuum_ml_stop_exit_20261110', dataWindow: 'explore_2023-03-07..2025-05-16', kind: 'EXPLORE', tests: 4,
  label: 'Vacuum ML: V1 learned stop multiplier vs best constant, V2 learned exit (predictability gate first), RTH and Globex separate, walk-forward by quarter', script: 'scripts/vacuum_sim/vacuum_ml.py', prereg: 'docs/VACUUM_ML_STOP_EXIT_PREREG_20261110.md', claimSlug: 'vacuum_ml_stop_exit_20261110', outcome: 'RUN_PENDING' })); process.exit(0);
