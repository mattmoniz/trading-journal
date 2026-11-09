import { logLook } from '../lib/look_ledger.mjs';
const r = await logLook({ family: 'vacuum_original_idea', dataWindow: 'explore<=2025-05-16', kind: 'EXPLORE', tests: 6, label: 'Q4-5 tell scan part 2: pace burst onset vs move-only, burst + one-sided, ROC expansions with vs without a preceding burst (RTH+GBX)',
  script: 'scripts/vacuum_sim/burst_scan.py', prereg: 'docs/INSTITUTIONAL_TELL_SCAN_PREREG_20261108.md', claimSlug: 'vacuum_burst_scan_20261109', outcome: 'RUN_PENDING', notes: { exploration: true, earlier_looks: [189, 190, 191] } });
console.log('LOOK_ID', r); process.exit(0);
