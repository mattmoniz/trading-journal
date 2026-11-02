import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'tell_pullback_20261102', dataWindow: 'explore<=2025-05-16', kind: 'EXPLORE', tests: 2, label: 'Tell pullback limit at the signal close after a one-bar confirmation: filled mean vs original, per-signal total vs original', script: 'scripts/amt_context/run_tell_pullback.py', prereg: 'docs/TELL_PULLBACK_AND_LEVEL_DIRECTION_PREREG_20261102.md', ref: 'tell_pullback_20261102' });
console.log('look logged id', id); process.exit(0);
