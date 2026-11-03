import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'level_hold_slice_20261103', dataWindow: 'explore<=2025-05-16 (RTH, 09:35-15:30 contacts)', kind: 'EXPLORE', tests: 1, label: 'Tape increment (F vs B1) over structure+price behaviour for hold-vs-slice at major levels, per-second RTH, prereg sha256 f30ccdf31b9e34a4f535ca742beb59c814e4059ce328f7a1fe238375f25d473a', script: 'scripts/tape_companion/run_hold_slice.py', prereg: 'docs/LEVEL_HOLD_SLICE_PREREG_20261103.md', ref: 'level_hold_slice_20261103' });
console.log('look logged id', id); process.exit(0);
