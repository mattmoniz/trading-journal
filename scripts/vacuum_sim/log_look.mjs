// Logs the ledger look for the Q4-5 outcome run BEFORE any outcome is read (CLAUDE.md hr-023/co-023). Prereg docs/VACUUM_COMMON_SIM_PREREG_20261108.md, 10 counted tests.
import { logLook } from '../lib/look_ledger.mjs';
const r = await logLook({ family: 'vacuum_original_idea', dataWindow: 'explore<=2025-05-16', kind: 'EXPLORE', tests: 10, label: 'Q4-5 original 500V vacuum: thrust vs moving-only, pace dose-response (RTH+GBX, proxy depth D1)',
  script: 'scripts/vacuum_sim/outcomes.py', prereg: 'docs/VACUUM_COMMON_SIM_PREREG_20261108.md', claimSlug: 'vacuum_original_proxy_outcomes_20261108', outcome: 'RUN_PENDING', notes: { depth: 'D1 proxy', thirds: 'informational only' } });
console.log('LOOK_ID', r); process.exit(0);
