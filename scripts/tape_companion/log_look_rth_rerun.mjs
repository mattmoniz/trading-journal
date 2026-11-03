import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'level_hold_slice_20261103', dataWindow: 'explore<=2025-05-16 (RTH rerun)', kind: 'EXPLORE', tests: 0, label: 'RERUN of the registered RTH study with the session-generalized code (regression check against the recorded numbers) to save the labeled table for the RTH vs Globex comparison; no new test', script: 'scripts/tape_companion/run_hold_slice.py --primary', prereg: 'docs/LEVEL_HOLD_SLICE_PREREG_20261103.md', ref: 'level_hold_slice_rth_rerun_20261103' });
console.log('look logged id', id); process.exit(0);
