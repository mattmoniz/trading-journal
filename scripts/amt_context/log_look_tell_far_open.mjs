import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'tell_far_open_20261102', dataWindow: 'explore<=2025-05-16', kind: 'EXPLORE', tests: 1, label: 'First-hour tell far from the 09:30 open pointing toward it vs matched no-tell moving bars, y30 ATR20 units (prereg sha256 535d0f43f7e3cd7211a2e9c1c109f8e0a0c5e4dd5c408b13135b45929f07271d)', script: 'scripts/amt_context/run_tell_far_open.py', prereg: 'docs/TELL_FAR_FROM_OPEN_PREREG_20261102.md', ref: 'tell_far_open_20261102' });
console.log('look logged id', id); process.exit(0);
