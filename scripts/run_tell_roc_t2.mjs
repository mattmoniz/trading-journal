#!/usr/bin/env node
// Row 31 T2 runner (docs/TELL_VS_ROC_COINCIDENCE_PREREG_20261109.md). READS TELL OUTCOMES: run ONLY on the user's go. Logs the ledger look FIRST (hr-023, tests = 1), then runs scripts/vacuum_sim/tell_roc_t2.py --go, then records the claim. Every call awaited (hr-060).
import fs from 'fs';
import { spawnSync } from 'child_process';
import { logLook } from './lib/look_ledger.mjs';
import { recordClaim } from './record_claim.mjs';
import { etToday } from '../server/lib/dateMath.js';
if (!process.argv.includes('--go')) { console.error('REFUSED: pass --go (the user\'s go is required; this reads outcomes).'); process.exit(2); }
const id = await logLook({ family: 'tell_roc_coincidence_20261109', dataWindow: 'tell explore 1,448 entries 2023-04..2025-05-16 (T2: V1 net, thrust-flagged vs not)', kind: 'EXPLORE', tests: 1, label: 'T2: V1 net dollars with vs without a causal same-direction ROC10 onset in [t-W, t]; day-blocked, within-hour permutation placebo',
  script: 'scripts/vacuum_sim/tell_roc_t2.py', prereg: 'docs/TELL_VS_ROC_COINCIDENCE_PREREG_20261109.md', claimSlug: 'tell_roc_coincidence_t2_20261109', ref: 'tell_roc_coincidence_t2_20261109_look' });
console.log('look', id);
const r = spawnSync('venv/bin/python', ['scripts/vacuum_sim/tell_roc_t2.py', '--go'], { env: { ...process.env, T2_LOOK_ID: String(id ?? 'existing') }, stdio: 'inherit' });
if (r.status !== 0) { console.error('T2 script failed'); process.exit(1); }
const J = JSON.parse(String(fs.readFileSync(new URL('../scratch/vacuum_sim_20261108/tell_roc_t2_result.json', import.meta.url))).replace(/\bNaN\b/g, 'null')); const d = J.dollars;
console.log(await recordClaim({ slug: 'tell_roc_coincidence_t2_20261109', sourceFile: 'scratch/vacuum_sim_20261108/tell_roc_t2_result_output.txt', sourceDate: etToday(), sampleSize: d.n, rigorStatus: 'day_block_bootstrap', status: 'PROVISIONAL', unblockCondition: null,
  claimText: `Row 31 T2: V1 net dollars per tell entry with vs without a causal same-direction ROC10 onset in the prior W seconds: difference ${d.diff.toFixed(2)} dollars per entry (N ${d.n}), day-blocked one-sided 90 percent lower bound ${d.lo90.toFixed(2)}, 95 percent CI [${d.ci95[0].toFixed(2)}, ${d.ci95[1].toFixed(2)}], within-hour permutation placebo ${d.exceeds ? 'exceeded' : 'not exceeded'}, verdict ${J.verdict}.`, extra: J }));
process.exit(0);
