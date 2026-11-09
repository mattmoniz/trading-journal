import { logLook } from '../lib/look_ledger.mjs';
const r = await logLook({ family: 'vacuum_original_idea', dataWindow: 'depth_era_explore_2026-06-15..2026-10-09', kind: 'EXPLORE', tests: 3, label: 'Q4-5 A10 looser stops (4x, 6x EMA10 TR, none) on the Globex 30-bar hold: net per trade > 0',
  script: 'scripts/vacuum_sim/globex_candidate.py', prereg: 'docs/VACUUM_COMMON_SIM_PREREG_20261108.md', claimSlug: 'vacuum_stop_sensitivity_20261109', outcome: 'RUN_PENDING', notes: { amendment: 'A10', held_back: 'unread' } });
console.log('LOOK_ID', r); process.exit(0);
