import { logLook } from '../lib/look_ledger.mjs';
const r = await logLook({ family: 'vacuum_original_idea', dataWindow: 'depth_era_explore_2026-06-15..2026-10-09', kind: 'EXPLORE', tests: 6, label: 'Q4-5 real-depth tell (RTH): thrust with real Ratio, vacuum quintiles, burst thin vs thick, absorption wall, user full rule, corrected exits',
  script: 'scripts/vacuum_sim/depth_tell.py', prereg: 'docs/VACUUM_COMMON_SIM_PREREG_20261108.md', claimSlug: 'vacuum_real_depth_20261109', outcome: 'RUN_PENDING', notes: { amendment: 'A3', sealed_window_spent_for: 'real-depth question only (user go 2026-11-09)', confirm: 'sessions >= 2026-10-12', earlier_looks: [189, 190, 191, 192] } });
console.log('LOOK_ID', r); process.exit(0);
