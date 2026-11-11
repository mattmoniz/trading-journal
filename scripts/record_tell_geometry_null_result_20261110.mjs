// Result of Q4-6 / improvement register row 51 (look 271) and the closing of the candidate-choice decision.
import { query } from '../server/db.js';
import { recordClaim } from './record_claim.mjs';
import { resolveDecision } from './flag_decision.mjs';
async function main() {
  const c = await recordClaim({ slug: 'tell_geometry_null_20261110',
    claimText: 'NOT SHOWN on explore (2026-11-10 night, look 271, 1,757 V1 tells on 488 sessions, 3 excluded): the tell touches the range edge before its stop 20.66 percent of the time against 20.57 percent for a direction-blind placebo with the same stop and edge distances, session and time of day; difference +0.09 points [-1.28, +1.53], two-sided p 0.897 (null gate passed: long minus short placebo -0.46 [-2.82, +1.90]). Stop-first 66.3 vs 66.7 percent. Flat in every decile of the implied rate, for longs and shorts and in 2023 / 2024 / 2025; unchanged without stitch sessions. So no directional knowledge larger than about 1.5 points of touch rate could be shown. UNCOUNTED lean in dollars: with the stop distance, a 120-minute time exit and the flatten, the tell makes +2.61 per trade against -3.17 for the direction-blind placebo, difference +5.79 [+0.76, +11.25] p 0.022; it comes from trades that touch neither level. The tell entry is 8.17 [4.64, 11.39] worse than nearby bars taken the same way (nearby bars before the signal are included, so that is partly hindsight). Explore result is a lead; forward read at 150 and 300 live fires decides.',
    sourceFile: 'docs/TELL_GEOMETRY_NULL_PREREG_20261110.md', sourceDate: '2026-11-10', sampleSize: 1757, rigorStatus: 'day_blocked_bootstrap', status: 'PROVISIONAL', unblockCondition: 'forward read at 150 and 300 live fires; second pre-registered test in dollars with the full exits',
    extra: { look: 271, counted_tests: 1, t1_diff: 0.0009, t1_lo: -0.0128, t1_hi: 0.0153, t1_p: 0.8968, strip_diff_dollars: 5.79, strip_lo: 0.76, strip_hi: 11.25, candidate_queue: 'Q4-6' } });
  console.log('claim', c.slug);
  const u = await query(`UPDATE research_looks SET outcome = 'NOT_SHOWN' WHERE id = 271 AND family = 'tell_geometry_null_20261110' RETURNING id`);
  console.log('look updated', u.rowCount);
  const r = await resolveDecision('fable_review_candidates_register_20261110', 'DECIDED 2026-11-10 night under the user delegation ("make the most prudent decisions"): A registered and run as Q4-6 (look 271, NOT SHOWN on touch rate, uncounted +5.79 dollar lean; claim tell_geometry_null_20261110). D (risk rules judged by pass probability) next: the simulator is task 3 of docs/SONNET_SPEC_FABLE_FOLLOWUPS_20261110.md, the study itself is designed after it and overlaps entry_level_risk_cap_20261109. B (thin vs crowded vacuum onsets) is the user own idea, not capped, waits for the user definitions. C (turn ladder) deferred: the turn signal is already in a forward test.');
  console.log('resolved', r.slug);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
