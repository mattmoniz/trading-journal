import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'bookmap_stage_b_depth_20261102', dataWindow: 'depth-era 2026-06..2026-10 (RTH, raw depth joined to trades)', kind: 'EXPLORE', tests: 15, label: 'Stage B raw-depth detectors: real vs fake wall, absorption, iceberg proxy, pull, sweep-then-reject x 3 horizons', script: 'scripts/depth_stageb/run_stageb.py', prereg: 'docs/BOOKMAP_STAGE_B_DEPTH_PREREG_20261102.md', ref: 'bookmap_stage_b_20261102' });
console.log('look logged id', id); process.exit(0);
