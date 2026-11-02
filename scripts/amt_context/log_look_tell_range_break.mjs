import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'tell_range_break_20261102', dataWindow: 'explore<=2025-05-16', kind: 'EXPLORE', tests: 6, label: 'Tell then enter the break of the tell own 10-bar range within 15 minutes: stop-order sneak (S) and close-confirmed (C) x 15/30/60 minutes, TELL vs CONTROL', script: 'scripts/amt_context/run_tell_range_break.py', prereg: 'docs/TELL_RANGE_BREAK_PREREG_20261102.md', ref: 'tell_range_break_20261102' });
console.log('look logged id', id); process.exit(0);
