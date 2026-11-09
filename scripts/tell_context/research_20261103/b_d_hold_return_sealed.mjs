// Runner for the sealed confirmation of the 13:30 hold-or-return test. Phase 1 (no target read) prints counts and the detectable effect; the sealed look is spent via spendSealedLook() ONLY if testable; then phase 2 prints the verdict.
// Usage: node b_d_hold_return_sealed.mjs sealed | node b_d_hold_return_sealed.mjs explore-check   (explore-check = regression run of the same code on the explore window, logged as an explore look with 0 new tests, expects look 120's 13:30 numbers)
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { logLook, spendSealedLook } from '../../lib/look_ledger.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)); const repo = path.resolve(here, '..', '..', '..');
const mode = process.argv[2]; if (!['sealed', 'explore-check'].includes(mode)) { console.error('usage: sealed | explore-check'); process.exit(1); }
const win = mode === 'sealed' ? 'sealed' : 'explore';
const run = (phase) => spawnSync('bash', ['-c', `ulimit -v 4000000; ${repo}/venv/bin/python ${here}/b_d_hold_return_sealed.py --phase ${phase} --window ${win}`], { stdio: 'inherit' });
const p1 = run(1);
if (p1.status === 3) { console.log('Phase 1: INCONCLUSIVE IN ADVANCE, sealed look not spent.'); process.exit(0); }
if (p1.status !== 0) { console.error('phase 1 failed, nothing spent'); process.exit(1); }
const meta = { script: 'scripts/tell_context/research_20261103/b_d_hold_return_sealed.py', prereg: 'docs/B_D_HOLD_OR_RETURN_1330_SEALED_PREREG_20261103.md' };
if (mode === 'sealed') {
  const id = await spendSealedLook({ family: 'b_d_hold_return_1330_20261103', dataWindow: 'sealed_2025-05-19_2026-10-19', tests: 4, label: 'Sealed confirmation: T=13:30 hold-or-return vs the final multi-hump flag (primary), secondaries 12:30, 11:30, strong B vs D', ...meta });
  console.log('SEALED LOOK SPENT, ledger id', id);
} else {
  const id = await logLook({ family: 'b_d_hold_return_1330_20261103', dataWindow: 'explore_2023-03-07_2025-05-16', kind: 'EXPLORE', tests: 0, ref: 'b_d_hold_return_1330_explore_check_20261103', label: 'Regression check of the sealed runner on the explore window (same 13:30 numbers as look 120 secondary d expected; no new test)', ...meta });
  console.log('explore-check look id', id);
}
const p2 = run(2); process.exit(p2.status ?? 1);
