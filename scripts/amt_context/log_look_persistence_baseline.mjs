import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'roster_context_20261102', dataWindow: 'explore<=2025-05-16', kind: 'EXPLORE', tests: 1, label: 'Amendment 7: persistence baseline (ridge on rr15/rr30/rr60 + clock + dow) vs the no-tell forecast; raw-feature Spearman and quarters uncounted', script: 'scripts/amt_context/run_persistence_baseline.py', prereg: 'scripts/amt_context/PREREG_ROSTER_CONTEXT.md', ref: 'roster_context_amendment7_20261102' });
console.log('look logged id', id); process.exit(0);
