import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'bookmap_stage_b_bursts_20261102', dataWindow: 'depth-era 2026-06..2026-10 (RTH bursts)', kind: 'EXPLORE', tests: 8, label: 'Part C2 causal burst study: burst continuation excess plus 7 signed book features vs continuation', script: 'scripts/depth_stageb/run_bursts.py', prereg: 'docs/BOOKMAP_STAGE_B_DEPTH_PREREG_20261102.md', ref: 'bookmap_stage_b_bursts_20261102' });
console.log('look logged id', id); process.exit(0);
