import { recordClaim } from '../record_claim.mjs';
await recordClaim({
  slug: 'tell_direction_hit_rate_by_definition_20261102',
  claimText: 'Why a 74-76 percent first-break agreement is not an edge (descriptive, explore 516 sessions, scripts/amt_context/hit_rate_definitions_20261102.py): V1 tell fires 1,752 vs matched no-tell moving bars 25,700. The tell direction equals the prior-10-bar move direction in 84% of fires. The first break of the 10-bar range goes in the pre-move direction 76.4% for tells and 76.0% for controls: it is geometry (price already sits at that edge), not tell skill. Share of fires where the price at +5/15/30/60 minutes is on the fire side: tell 50.6 / 49.5 / 49.5 / 49.9 percent, control 49.4 / 50.0 / 50.0 / 50.8. First to reach +k before -k points within 60 minutes (fire direction): tell k=10 48.8% (N 1,735), k=25 48.9%, k=50 50.3%; control 50.7 / 50.4 / 49.8. READING: the tell direction is right about half the time at every horizon and target size, the same as any moving bar; the 75% figure measures which tiny edge breaks first. NOT SHOWN: the trader own discretionary side calls, which the artifacts Tell Side Calls and My Calls would measure.',
  sourceFile: 'scripts/amt_context/hit_rate_definitions_20261102_output.txt', sourceDate: '2026-11-02', sampleSize: 1752, rigorStatus: 'descriptive_explore', status: 'PROVISIONAL',
});
process.exit(0);
