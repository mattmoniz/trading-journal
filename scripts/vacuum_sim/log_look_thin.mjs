import { logLook } from '../lib/look_ledger.mjs';
const r = await logLook({ family: 'vacuum_thin_crowded_20261110', dataWindow: 'explore_2023-04-04..2025-05-16', kind: 'EXPLORE', tests: 4,
  label: 'Vacuum item 2 (Q4-7): thrust pace (fast = crowded, slow = thin; Claude reading of the user duration idea) vs extra favourable run over a direction-blind placebo; T1 fast and T2 fast-minus-slow, RTH and Globex, Holm 0.10',
  script: 'scripts/vacuum_sim/vacuum_thin_crowded.py', prereg: 'docs/VACUUM_THIN_VS_CROWDED_PREREG_20261110.md', claimSlug: 'vacuum_thin_crowded_20261110', outcome: 'RUN_PENDING', notes: { item: 2, queue: 'Q4-7', null_gate: 0.068 } });
console.log('LOOK_ID', r); process.exit(0);
