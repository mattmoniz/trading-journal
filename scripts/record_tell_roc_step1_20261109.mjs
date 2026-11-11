import fs from 'fs';
import { recordClaim } from './record_claim.mjs';
const J = JSON.parse(fs.readFileSync(new URL('../scratch/vacuum_sim_20261108/tell_roc_step1.json', import.meta.url))); const b2 = J.res['Base 2 (date + hour + pace tercile)'], b1 = J.res['Base 1 (date + hour)'];
console.log(await recordClaim({ slug: 'tell_roc_coincidence_step1_20261109', sourceFile: 'scratch/vacuum_sim_20261108/tell_roc_step1_output.txt', sourceDate: '2026-11-09', sampleSize: J.n,
  claimText: `Row 31 step 1 (outcome-blind, T1): ${J.n} explore tell entries on ${J.dates} dates; a causal same-direction ROC10 onset within W (10 x same-hour median bar duration, about 219 s) before the decision bar is present at ${(b2.flagged * 100).toFixed(1)} percent of entries vs ${(b1.base * 100).toFixed(1)} percent of date-and-hour matched bars (lift ${b1.lift.toFixed(2)}) and ${(b2.base * 100).toFixed(1)} percent of pace-matched bars (lift ${b2.lift.toFixed(2)}, day-blocked 95 percent CI ${b2.ci95[0].toFixed(2)}-${b2.ci95[1].toFixed(2)}). Verdict ${J.verdict}. The control does not match the tell's price-move ingredient, so this is coincidence beyond pace, not independent confirmation, and no outcome was read.`,
  rigorStatus: 'day_block_bootstrap', status: 'PROVISIONAL', unblockCondition: null, extra: J }));
process.exit(0);
