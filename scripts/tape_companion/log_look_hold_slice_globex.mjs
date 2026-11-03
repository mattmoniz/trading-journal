import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'level_hold_slice_globex_20261103', dataWindow: 'explore<=2025-05-16 (Globex 18:30-08:30 contacts)', kind: 'EXPLORE', tests: 1, label: 'Tape increment (F vs B1) for hold-vs-slice at major levels, GLOBEX arm, prereg sha256 1e42cbbf2475d7904ca3acfee3d586041198447f3cd3faa79242602059c74116', script: 'scripts/tape_companion/run_hold_slice.py --globex', prereg: 'docs/LEVEL_HOLD_SLICE_GLOBEX_PREREG_20261103.md', ref: 'level_hold_slice_globex_20261103' });
console.log('look logged id', id); process.exit(0);
