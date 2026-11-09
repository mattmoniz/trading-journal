// Runner for the sealed tighten-only watcher-stop confirmation (docs/IB_TIGHTEN_LEVELS_PREREG_20261104.md part B + amendment B-A1). Phase 1 (replay, counts, detectable effect; no outcome printed) -> spendSealedLook() only if testable -> phase 2 (verdict).
// Usage: node watcher_stop_sealed.mjs sealed   (the explore_sim phase 1 + 2 must have run and passed first as SEPARATE commands, cv-111)
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { spendSealedLook } from '../../lib/look_ledger.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)); const repo = path.resolve(here, '..', '..', '..');
const mode = process.argv[2]; if (mode !== 'sealed') { console.error('usage: sealed (run the explore phase 2 separately first)'); process.exit(1); }
const run = (phase) => spawnSync('bash', ['-c', `ulimit -v 4000000; ${repo}/venv/bin/python ${here}/watcher_stop_sealed.py --phase ${phase} --window sealed`], { stdio: 'inherit' });
const p1 = run(1);
if (p1.status === 3) { console.log('Phase 1: INCONCLUSIVE IN ADVANCE, sealed look not spent.'); process.exit(0); }
if (p1.status !== 0) { console.error('phase 1 failed, nothing spent'); process.exit(1); }
const id = await spendSealedLook({ family: 'watcher_stop_tighten_20261104', dataWindow: 'sealed_2025-05-19_2026-10-19', tests: 1, ref: 'watcher_stop_tighten_sealed_20261104', label: 'Sealed confirmation: tighten-only watcher stop (adverse drive -> 0.5 x the node distance, once) vs the static node stop on the tell entries; AC and AIB printed as context', script: 'scripts/tell_context/research_20261103/watcher_stop_sealed.py', prereg: 'docs/IB_TIGHTEN_LEVELS_PREREG_20261104.md (part B, amendment B-A1)' });
console.log('SEALED LOOK SPENT, ledger id', id);
const p2 = run(2); process.exit(p2.status ?? 1);
