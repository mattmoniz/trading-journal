// Runner for the sealed-era replay of the range model (docs/STRUCTURE_MODEL_SEALED_REPLAY_PREREG_20261108.md). Phase 1 (rows, counts, detectable effect, NO outcome) -> spendSealedLook() only if testable -> phase 2 (verdict).
// Usage: node sealed_replay.mjs sealed | explore-check   (explore-check = same code on 40 explore sessions, logged as an explore look with 0 tests; run it as a SEPARATE command first, cv-111)
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { logLook, spendSealedLook } from '../lib/look_ledger.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)); const repo = path.resolve(here, '..', '..');
const mode = process.argv[2]; if (!['sealed', 'explore-check'].includes(mode)) { console.error('usage: sealed | explore-check'); process.exit(1); }
const win = mode === 'sealed' ? 'sealed' : 'explore_check';
const run = (phase) => spawnSync('bash', ['-c', `ulimit -v 5500000; ${repo}/venv/bin/python ${here}/sealed_replay.py --phase ${phase} --window ${win}`], { stdio: 'inherit' });
const p1 = run(1);
if (p1.status === 3) { console.log('Phase 1: INCONCLUSIVE IN ADVANCE, sealed look not spent.'); process.exit(0); }
if (p1.status !== 0) { console.error('phase 1 failed, nothing spent'); process.exit(1); }
const meta = { script: 'scripts/structure_model/sealed_replay.py', prereg: 'docs/STRUCTURE_MODEL_SEALED_REPLAY_PREREG_20261108.md' };
if (mode === 'sealed') { const id = await spendSealedLook({ family: 'structure_model_sealed_replay_20261108', dataWindow: 'sealed_2025-05-19_2026-10-19', tests: 2, label: 'Frozen explore-only range model (ridge M2) replayed on the sealed era: improvement over the hard persistence baseline (T1) and over HAR-X + clock (T2); day-block CI, halves rule', ...meta }); console.log('SEALED LOOK SPENT, ledger id', id); }
else { const id = await logLook({ family: 'structure_model_sealed_replay_20261108', dataWindow: 'explore_2025-03-04_2025-05-16', kind: 'EXPLORE', tests: 0, ref: 'structure_model_sealed_replay_explore_check_20261108', label: 'Regression check of the sealed replay runner on 40 explore sessions (in-sample; asserts the live-path features equal explore_features.csv); no new test', ...meta }); console.log('explore-check look id', id); }
const p2 = run(2); process.exit(p2.status ?? 1);
