import { logLook } from '../lib/look_ledger.mjs';
const r = await logLook({ family: 'vacuum_original_idea', dataWindow: 'depth_era_explore_2026-06-15..2026-10-09', kind: 'EXPLORE', tests: 3, label: 'Q4-5 A7 hard range-per-bar floor in RTH (EMA10 TR >= 13/15/17 pt) on ROC expansions: continuation above minus below the floor',
  script: 'scripts/vacuum_sim/rpb_scan.py', prereg: 'docs/VACUUM_COMMON_SIM_PREREG_20261108.md', claimSlug: 'vacuum_rpb_floor_20261109', outcome: 'RUN_PENDING', notes: { amendment: 'A7', interpretation: 'rate per bar = range per bar in points (EMA10 TR), user confirmed only the words', earlier_looks: [189, 190, 191, 192, 193, 194, 195, 196] } });
console.log('LOOK_ID', r); process.exit(0);
