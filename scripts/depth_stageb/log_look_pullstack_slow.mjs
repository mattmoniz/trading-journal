import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'pullstack_slow_flip_20261102', dataWindow: 'depth-era 2026-06..2026-10 (RTH)', kind: 'EXPLORE', tests: 3, label: 'Slow selective pull/stack flip (300 s window, 90th percentile threshold), no push condition: flip minus persistent same-sign state at 5/15/30 minutes', script: 'scripts/depth_stageb/run_pullstack_slow.py', prereg: 'docs/PULLSTACK_FLIP_PUSH_PREREG_20261102.md', ref: 'pullstack_slow_flip_20261102' });
console.log('look logged id', id); process.exit(0);
