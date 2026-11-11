// Records the claim for the rows 28/29 counted tests from the result file the run already wrote (the runner crashed on `NaN` in the JSON AFTER the statistics finished; mechanical fix, no rerun: prereg A5(6)). Every call awaited (hr-060).
import fs from 'fs';
import { recordClaim } from './record_claim.mjs';
const J = JSON.parse(String(fs.readFileSync(new URL('../scratch/vacuum_sim_20261108/context_exit_tests_result.json', import.meta.url))).replace(/\bNaN\b/g, 'null')); const V = J.verdicts, R = J.results.replication;
const txt = Object.keys(V).map((k) => `${k}: ${V[k].verdict} (N ${R[k].n}, ${k[0] === 'A' ? 'contrast extended minus non-extended' : 'ratchet minus hold'} ${R[k].mean.toFixed(2)} pt per trade, p ${R[k].p.toFixed(4)}, Holm alpha ${R[k].holm_alpha.toFixed(3)}, MDE ${R[k].mde.toFixed(2)})`).join('; ');
console.log(await recordClaim({ slug: 'vacuum_context_exit_tests_20261109', sourceFile: 'scratch/vacuum_sim_20261108/context_exit_tests_result_output.txt', sourceDate: '2026-11-09', sampleSize: Object.values(R).reduce((s, x) => s + x.n, 0), rigorStatus: 'day_block_bootstrap', status: 'PROVISIONAL', unblockCondition: null,
  claimText: `Rows 28/29 counted tests on the 513-session corpus (frozen rules A1-A9, Holm 0.10 step-down, 2026 sign gate uncounted, look 217): ${txt}. ALL FOUR NOT SHOWN (A-GBX INCONCLUSIVE: long and short contrasts disagree). Ratchet trades lasting 55+ minutes: RTH 0.3 percent (median 3.9 min), Globex 27.7 percent (median 29.7 min). Parked per co-025, autopsy pending.`, extra: J }));
process.exit(0);
