import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'roster_context_20261102', dataWindow: 'explore<=2025-05-16', kind: 'EXPLORE', tests: 1, label: 'Amendment 6: overnight bar-count volume (ONV) added to the no-tell 30-minute forecast; incremental out-of-sample Spearman PLUS minus BASE', script: 'scripts/amt_context/run_overnight_volume.py', prereg: 'scripts/amt_context/PREREG_ROSTER_CONTEXT.md', ref: 'roster_context_amendment6_20261102' });
console.log('look logged id', id); process.exit(0);
