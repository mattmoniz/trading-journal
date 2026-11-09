// Ledger look for the Q4-5 v2 outcome run, logged BEFORE any v2 outcome is read (hr-023/co-023). The first variant (look 189, 10 tests) already read outcomes, so the cumulative family count is 22.
import { logLook } from '../lib/look_ledger.mjs';
const r = await logLook({ family: 'vacuum_original_idea', dataWindow: 'explore<=2025-05-16', kind: 'EXPLORE', tests: 12, label: 'Q4-5 v2: crossing triggers, continuous windows, Open[t+1], exits scan, Wave 2 scan, absorption-wall control (RTH+GBX, proxy depth D1)',
  script: 'scripts/vacuum_sim/outcomes2.py', prereg: 'docs/VACUUM_COMMON_SIM_PREREG_20261108.md', claimSlug: 'vacuum_original_v2_20261108', outcome: 'RUN_PENDING', notes: { depth: 'D1 proxy', thirds: 'informational only', accepted_from: 'Argon Low round 7 (fixes only)', earlier_look: 189 } });
console.log('LOOK_ID', r); process.exit(0);
