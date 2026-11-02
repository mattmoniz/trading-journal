import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'bookmap_stage_b_bigmoves_20261102', dataWindow: 'depth-era 2026-06..2026-10 (RTH big-move event study)', kind: 'EXPLORE', tests: 8, label: 'Part C big-move event study: 8 signed pre-move book features, AUC for UP vs DOWN among big 5-minute moves; volatility comparison and story paths uncounted', script: 'scripts/depth_stageb/run_bigmoves.py', prereg: 'docs/BOOKMAP_STAGE_B_DEPTH_PREREG_20261102.md', ref: 'bookmap_stage_b_bigmoves_20261102' });
console.log('look logged id', id); process.exit(0);
