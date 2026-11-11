// Records the claim for row 31 T2 from the result file the run wrote (used when the runner could not read it; mechanical, no rerun: prereg A5(6)). Every call awaited (hr-060).
import fs from 'fs';
import { recordClaim } from './record_claim.mjs';
const J = JSON.parse(String(fs.readFileSync(new URL('../scratch/vacuum_sim_20261108/tell_roc_t2_result.json', import.meta.url))).replace(/\bNaN\b/g, 'null')); const d = J.dollars, r = J.R;
console.log(await recordClaim({ slug: 'tell_roc_coincidence_t2_20261109', sourceFile: 'scratch/vacuum_sim_20261108/tell_roc_t2_result_output.txt', sourceDate: '2026-11-09', sampleSize: d.n, rigorStatus: 'day_block_bootstrap', status: 'PROVISIONAL', unblockCondition: null,
  claimText: `Row 31 T2 (look 218): V1 net dollars per tell entry with vs without a causal same-direction ROC10 onset in the prior W seconds: difference ${d.diff.toFixed(2)} dollars per entry (N ${d.n}), day-blocked one-sided 90 percent lower bound ${d.lo90.toFixed(2)}, 95 percent CI [${d.ci95[0].toFixed(2)}, ${d.ci95[1].toFixed(2)}], one-sided p ${d.p.toFixed(4)}, within-hour permutation placebo ${d.exceeds ? 'exceeded' : 'not exceeded'}, halves ${d.halves.map((x) => x.toFixed(1)).join(' / ')}${d.inconclusive ? ', INCONCLUSIVE (long and short disagree)' : ''}; verdict ${J.verdict}. In R-multiples: difference ${r ? r.diff.toFixed(3) : 'n/a'}.`, extra: J }));
process.exit(0);
