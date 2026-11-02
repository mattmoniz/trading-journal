// Logs the P1 look BEFORE run_p1.py reads any outcome (PREREG_ROSTER_CONTEXT.md; ledger convention docs/AGENTIC_SYSTEM_SCOPE_20261101.md s9).
import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'roster_context_20261102', dataWindow: 'explore<=2025-05-16', kind: 'EXPLORE', tests: 3, label: 'P1 H1 descriptive: E_W (W=15,30,60) tell-on minus tell-off, tell30 vs strata', script: 'scripts/amt_context/run_p1.py', prereg: 'scripts/amt_context/PREREG_ROSTER_CONTEXT.md', ref: 'roster_context_p1_20261102' });
console.log('look logged id', id); process.exit(0);
