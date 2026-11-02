import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'roster_context_20261102', dataWindow: 'explore<=2025-05-16', kind: 'EXPLORE', tests: 3, label: 'P3c Amendment 5: H4 with forecast horizon matched to median hold (H*), no-tell model; skip test, excursion link, hold distribution', script: 'scripts/amt_context/run_p3c.py', prereg: 'scripts/amt_context/PREREG_ROSTER_CONTEXT.md', ref: 'roster_context_p3c_20261102' });
console.log('look logged id', id); process.exit(0);
