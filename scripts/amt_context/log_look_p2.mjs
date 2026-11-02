import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'roster_context_20261102', dataWindow: 'explore<=2025-05-16', kind: 'EXPLORE', tests: 5, label: 'P2 forecast: H2, H3a, H3b counted at E_30 (walk-forward ridge vs baselines, permutation null) + E_15 and E_60 reported uncounted', script: 'scripts/amt_context/run_p2.py', prereg: 'scripts/amt_context/PREREG_ROSTER_CONTEXT.md', ref: 'roster_context_p2_20261102' });
console.log('look logged id', id); process.exit(0);
