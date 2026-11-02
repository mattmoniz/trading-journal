import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'tell_at_level_20261102', dataWindow: 'explore<=2025-05-16', kind: 'EXPLORE', tests: 3, label: 'Tell as launch pad at VWAP/overnight/IB levels, direction from the 1-3 bar level rejection; TELL vs CONTROL events at 15/30/60 minutes', script: 'scripts/amt_context/run_tell_at_level.py', prereg: 'docs/TELL_AT_LEVEL_REJECTION_PREREG_20261102.md', ref: 'tell_at_level_20261102' });
console.log('look logged id', id); process.exit(0);
