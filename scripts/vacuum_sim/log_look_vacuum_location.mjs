import { logLook } from '../lib/look_ledger.mjs';
console.log('LOOK_ID', await logLook({ family: 'vacuum_location_20261110', dataWindow: 'explore_2023-03-07..2025-05-16', kind: 'EXPLORE', tests: 4,
  label: 'Vacuum location: descriptive drift decomposition + open-air vs congestion split (L1, L2 per track) on the 9,116 explore vacuum trades', script: 'scripts/vacuum_sim/vacuum_location.py', prereg: 'docs/VACUUM_LOCATION_PREREG_20261110.md', claimSlug: 'vacuum_location_20261110', outcome: 'RUN_PENDING' })); process.exit(0);
