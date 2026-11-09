import { logLook } from '../lib/look_ledger.mjs';
const r = await logLook({ family: 'vacuum_original_idea', dataWindow: 'depth_era_explore_2026-06-15..2026-10-09', kind: 'EXPLORE', tests: 4, label: 'Q4-5 A8 (Argon Low round 10b): Wave 2 re-ignition with HOLD exits (RTH), near-touch depletion ahead, Globex one-sided continuation with HOLD exit (2 tests)',
  script: 'scripts/vacuum_sim/a8_tests.py', prereg: 'docs/VACUUM_COMMON_SIM_PREREG_20261108.md', claimSlug: 'vacuum_a8_20261109', outcome: 'RUN_PENDING', notes: { amendment: 'A8', held_back: 'unread', earlier_looks: [189, 190, 191, 192, 193, 194, 195, 196, 197] } });
console.log('LOOK_ID', r); process.exit(0);
