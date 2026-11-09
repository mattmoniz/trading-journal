import { logLook } from '../lib/look_ledger.mjs';
const r = await logLook({ family: 'vacuum_original_idea', dataWindow: 'depth_era_explore_2026-06-15..2026-10-09', kind: 'EXPLORE', tests: 2, label: 'Q4-5 Globex exit variants A6: 300 s clock scalp (primary) net > 0 and minus matched random-bar control; 30-bar hold descriptive',
  script: 'scripts/vacuum_sim/globex_candidate.py', prereg: 'docs/VACUUM_COMMON_SIM_PREREG_20261108.md', claimSlug: 'vacuum_globex_scalp_explore_20261109', outcome: 'RUN_PENDING', notes: { amendment: 'A6', stage: 'explore', earlier_looks: [189, 190, 191, 192, 193, 194, 195] } });
console.log('LOOK_ID', r); process.exit(0);
