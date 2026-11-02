import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'last30_momentum_20261102', dataWindow: 'explore<=2025-04-02 (463 RTH days)', kind: 'EXPLORE', tests: 3, label: 'Last-30-minute momentum/reversal: Spearman of first-30-minute, open-to-15:30 and 15:00-15:30 moves with the 15:30-16:00 move', script: 'scripts/range_budget/run_last30.py', prereg: 'docs/LAST30_MOMENTUM_PREREG_20261102.md', ref: 'last30_momentum_20261102' });
console.log('look logged id', id); process.exit(0);
