import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'roster_context_20261102', dataWindow: 'explore<=2025-05-16', kind: 'EXPLORE', tests: 4, label: 'P3 H4: BACKFILL fade rows 10:00-14:30, skip forecast top third (no-tell model, Amendment 3), simulated actual_pnl, matched random-skip placebo; plus 3 descriptive forecast-third means', script: 'scripts/amt_context/run_p3.py', prereg: 'scripts/amt_context/PREREG_ROSTER_CONTEXT.md', ref: 'roster_context_p3_20261102' });
console.log('look logged id', id); process.exit(0);
