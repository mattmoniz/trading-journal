import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'roster_context_20261102', dataWindow: 'explore<=2025-05-16', kind: 'EXPLORE', tests: 1, label: 'P2b Amendment 2 H3b2: E_30 full2 vs notell2 (recent realized range rr15/30/60 added to both), walk-forward ridge, permutation null', script: 'scripts/amt_context/run_p2b.py', prereg: 'scripts/amt_context/PREREG_ROSTER_CONTEXT.md', ref: 'roster_context_p2b_20261102' });
console.log('look logged id', id); process.exit(0);
