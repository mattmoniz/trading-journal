import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'roster_context_20261102', dataWindow: 'explore<=2025-05-16', kind: 'EXPLORE', tests: 5, label: 'P3b Amendment 4: forecast vs the fade trades own excursion (mfe+mae) and |pnl| by forecast third, Spearman with day-blocked CI', script: 'scripts/amt_context/run_p3b.py', prereg: 'scripts/amt_context/PREREG_ROSTER_CONTEXT.md', ref: 'roster_context_p3b_20261102' });
console.log('look logged id', id); process.exit(0);
