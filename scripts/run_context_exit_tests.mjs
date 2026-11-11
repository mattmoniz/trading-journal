#!/usr/bin/env node
// Rows 28+29 counted tests (docs/VACUUM_CONTEXT_EXIT_PREREG_20261109.md A1-A4). READS SIGNAL OUTCOMES: run ONLY on the user's go. Logs the ledger look FIRST (hr-023; 4 counted tests on the 513-session primary corpus, the 2026 gate is uncounted),
// then runs scripts/vacuum_sim/context_exit_tests.py --go (about 10-20 minutes: simulation of every event and a random-bar control pool), then records one claim. Every call awaited (hr-060).
import fs from 'fs';
import { spawnSync } from 'child_process';
import { logLook } from './lib/look_ledger.mjs';
import { recordClaim } from './record_claim.mjs';
import { etToday } from '../server/lib/dateMath.js';
if (!process.argv.includes('--go')) { console.error("REFUSED: pass --go (the user's go is required; this reads signal outcomes)."); process.exit(2); }
const id = await logLook({ family: 'vacuum_context_exit_20261109', dataWindow: 'PRIMARY counted: explore 2023-03-07..2025-05-16 (513 sessions); 2026 depth-era 68 sessions as uncounted sign gate; >=2026-10-12 and 2026-11-05/06/09 UNREAD', kind: 'EXPLORE', tests: 4,
  label: 'counted tests A-RTH, A-GBX, B-RTH, B-GBX of rows 28/29 (extension skip; ratchet vs 30-bar hold on non-extended thrusts), Holm 0.10', script: 'scripts/vacuum_sim/context_exit_tests.py', prereg: 'docs/VACUUM_CONTEXT_EXIT_PREREG_20261109.md', claimSlug: 'vacuum_context_exit_tests_20261109', ref: 'vacuum_context_exit_tests_20261109_look' });
console.log('look', id);
fs.writeFileSync(new URL('../scratch/.cet_look_token.json', import.meta.url), JSON.stringify({ id: String(id ?? 'existing'), at: Date.now() }));      // read back by context_exit_tests.py: proves the look was logged by this runner
const r = spawnSync('venv/bin/python', ['scripts/vacuum_sim/context_exit_tests.py', '--go'], { env: { ...process.env, CET_LOOK_ID: String(id ?? 'existing') }, stdio: 'inherit' });
if (r.status !== 0) {                                                       // prereg A5(6): a crash before the verdicts spends no new look (same ref on rerun); record it, never hide it
  console.error('test script failed');
  console.log(await recordClaim({ slug: 'vacuum_context_exit_tests_crash_20261109', sourceFile: 'scratch/vacuum_sim_20261108/context_exit_tests_result_output.txt', sourceDate: etToday(), rigorStatus: 'not_checked', status: 'PROVISIONAL', unblockCondition: null,
    claimText: `RUN CRASHED (exit ${r.status}) before the verdicts of the rows 28/29 counted tests: no verdict exists. The ledger look ${id ?? 'existing'} is kept and a rerun reuses it (same ref). Event simulations are cached in scratch/vacuum_sim_20261108/context_exit_event_sims_20261109.csv when the crash happened after the simulation. Only a mechanical bug fix is allowed (prereg A5).` }));
  process.exit(1);
}
const J = JSON.parse(String(fs.readFileSync(new URL('../scratch/vacuum_sim_20261108/context_exit_tests_result.json', import.meta.url))).replace(/\bNaN\b/g, 'null')); const V = J.verdicts, R = J.results.replication;
const txt = Object.keys(V).map((k) => `${k}: ${V[k].verdict} (N ${R[k].n}, mean ${R[k].mean.toFixed(2)} pt per trade, p ${R[k].p.toFixed(4)}, Holm alpha ${R[k].holm_alpha.toFixed(3)}, MDE ${R[k].mde.toFixed(2)})`).join('; ');
console.log(await recordClaim({ slug: 'vacuum_context_exit_tests_20261109', sourceFile: 'scratch/vacuum_sim_20261108/context_exit_tests_result_output.txt', sourceDate: etToday(), sampleSize: Object.values(R).reduce((s, x) => s + x.n, 0), rigorStatus: 'day_block_bootstrap', status: 'PROVISIONAL', unblockCondition: null,
  claimText: `Rows 28/29 counted tests on the 513-session corpus (frozen rules A1-A4, Holm 0.10, 2026 sign gate uncounted): ${txt}. A not-shown result PARKS the idea (co-025).`, extra: J }));
process.exit(0);
