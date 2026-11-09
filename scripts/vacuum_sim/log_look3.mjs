// Ledger look for the institutional-tell scan, BEFORE any outcome of it is read (hr-023). 12 counted tests; the Q4-5 family total becomes 34 (10 + 12 + 12).
import { logLook } from '../lib/look_ledger.mjs';
const r = await logLook({ family: 'vacuum_original_idea', dataWindow: 'explore<=2025-05-16', kind: 'EXPLORE', tests: 12, label: 'Q4-5 institutional-tell scan: pace, print size, one-sidedness, range per 500, Ratio Z (proxy), burst; top vs bottom quintile of continuation after ROC expansions (RTH+GBX)',
  script: 'scripts/vacuum_sim/tell_scan.py', prereg: 'docs/INSTITUTIONAL_TELL_SCAN_PREREG_20261108.md', claimSlug: 'vacuum_tell_scan_20261108', outcome: 'RUN_PENDING', notes: { exploration: true, depth: 'D1 proxy for Ratio only', earlier_looks: [189, 190] } });
console.log('LOOK_ID', r); process.exit(0);
