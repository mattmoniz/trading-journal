// Runner for the sealed flip time-of-day test. Phase 1 (replay + counts + detectable effect, no outcome printed) -> spendSealedLook() only if testable -> phase 2 (verdict).
// Usage: node flip_time_sealed.mjs sealed | explore-check   (explore-check = same code on the explore window via the explore_sim path, logged as an explore look with 0 tests)
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { logLook, spendSealedLook } from '../../lib/look_ledger.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)); const repo = path.resolve(here, '..', '..', '..');
const mode = process.argv[2]; if (!['sealed', 'explore-check'].includes(mode)) { console.error('usage: sealed | explore-check'); process.exit(1); }
const win = mode === 'sealed' ? 'sealed' : 'explore_sim';
const run = (phase) => spawnSync('bash', ['-c', `ulimit -v 4000000; ${repo}/venv/bin/python ${here}/flip_time_sealed.py --phase ${phase} --window ${win}`], { stdio: 'inherit' });
const p1 = run(1);
if (p1.status === 3) { console.log('Phase 1: INCONCLUSIVE IN ADVANCE, sealed look not spent.'); process.exit(0); }
if (p1.status !== 0) { console.error('phase 1 failed, nothing spent'); process.exit(1); }
const meta = { script: 'scripts/tell_context/research_20261103/flip_time_sealed.py', prereg: 'docs/FLIP_TIME_OF_DAY_SEALED_PREREG_20261103.md (section 6)' };
if (mode === 'sealed') { const id = await spendSealedLook({ family: 'flip_time_of_day_20261103', dataWindow: 'sealed_2025-05-19_2026-10-19', tests: 3, label: 'Sealed confirmation, amendment A1 (user-approved after the counts): flip minus tell on AGAINST fires from 12:00 ET (primary); secondaries early gap, early-minus-late, all-day', ...meta }); console.log('SEALED LOOK SPENT, ledger id', id); }
else { const id = await logLook({ family: 'flip_time_of_day_20261103', dataWindow: 'explore_2023-03-07_2025-05-16', kind: 'EXPLORE', tests: 0, ref: 'flip_time_explore_check_20261103', label: 'Regression check of the sealed runner on the explore window (explore_sim path); expects early +13.9 / late -44.4; no new test', ...meta }); console.log('explore-check look id', id); }
const p2 = run(2); process.exit(p2.status ?? 1);
