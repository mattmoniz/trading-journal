// Runner for A3 sealed look (docs/CAPITULATION_SPEED_EXIT_PREREG_20261110.md). Count gate (112 extreme-fast RTH on 83 days) and the depth-era regression passed as SEPARATE commands first (cv-111).
import { spawnSync } from 'child_process';
import { spendSealedLook } from '../lib/look_ledger.mjs';
const repo = new URL('../..', import.meta.url).pathname;
const id = await spendSealedLook({ family: 'capitulation_speed_exit_20261110', dataWindow: 'sealed_2025-05-17_2026-06-14', tests: 1, ref: 'capitulation_speed_sealed_20261110',
  label: 'Sealed confirmation of the reversed RTH speed lead: extreme-fast minus not-fast climax CONTINUE over 30 bars, one-sided alpha 0.05 (A3)', script: 'scripts/vacuum_sim/capitulation_speed_sealed.py', prereg: 'docs/CAPITULATION_SPEED_EXIT_PREREG_20261110.md',
  claimSlug: 'capitulation_speed_exit_20261110', outcome: 'RUN_PENDING', notes: { gate_met: true, extreme_fast_rth: 112, days: 83 } });
console.log('SEALED LOOK SPENT, id', id);
const r = spawnSync('bash', ['-c', `cd ${repo}; ulimit -v 4000000; python3 scripts/vacuum_sim/capitulation_speed_sealed.py run | tee scratch/capitulation_speed_sealed_20261110/run_output.txt`], { stdio: 'inherit' });
process.exit(r.status ?? 1);
