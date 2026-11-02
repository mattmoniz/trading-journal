import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'pullstack_flip_push_20261102', dataWindow: 'depth-era 2026-06..2026-10 (RTH)', kind: 'EXPLORE', tests: 3, label: 'Pull/stack flip (own definition from raw depth) then price push in the same direction: FLIP+PUSH minus PUSH-ONLY at 60/300/900 s', script: 'scripts/depth_stageb/run_pullstack.py', prereg: 'docs/PULLSTACK_FLIP_PUSH_PREREG_20261102.md', ref: 'pullstack_flip_push_20261102' });
console.log('look logged id', id); process.exit(0);
