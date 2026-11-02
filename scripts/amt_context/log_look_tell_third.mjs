import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'roster_context_20261102', dataWindow: 'explore<=2025-05-16', kind: 'EXPLORE', tests: 3, label: 'Robustness (NOT confirmation) of the lead: tell trades with a top-third (causal expanding) busy forecast net less; C1 counted, E1 quarters and E2 uncounted', script: 'scripts/amt_context/run_tell_third.py', prereg: 'scripts/amt_context/PREREG_TELL_THIRD.md', ref: 'tell_third_20261102' });
console.log('look logged id', id); process.exit(0);
