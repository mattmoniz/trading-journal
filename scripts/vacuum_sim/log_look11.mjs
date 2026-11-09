import { logLook } from '../lib/look_ledger.mjs';
const r = await logLook({ family: 'vacuum_original_idea', dataWindow: 'explore<=2025-05-16 (primary) + depth_era_explore (replication)', kind: 'EXPLORE', tests: 4, label: 'Q4-5 A9 size scan: continuation after ROC10 expansion onsets at 0.5-3.0 sd; modest (1.0) > 0 and modest minus huge (2.0), RTH + Globex',
  script: 'scripts/vacuum_sim/size_scan.py', prereg: 'docs/VACUUM_COMMON_SIM_PREREG_20261108.md', claimSlug: 'vacuum_size_scan_20261109', outcome: 'RUN_PENDING', notes: { amendment: 'A9', held_back: 'unread', earlier_looks: [189, 190, 191, 192, 193, 194, 195, 196, 197, 198] } });
console.log('LOOK_ID', r); process.exit(0);
