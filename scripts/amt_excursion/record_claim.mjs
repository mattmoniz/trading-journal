import { recordClaim } from '../record_claim.mjs';
import { flagDecision } from '../flag_decision.mjs';
await recordClaim({
  slug: 'amt_first_excursion_accept_reject_not_shown_20261028',
  claimText: 'AMT option 3 (scripts/amt_excursion, PREREG.md committed ab7f8bf before any outcome; run without a prior DeepSeek review at user request; RTH only): after the first excursion beyond a reference (PRIOR_VALUE: days opening inside prior value, first trade beyond VAH/VAL; IB: first break of the IB high/low from 10:30), state at 30 bars = ACCEPTED (still beyond the level) vs REJECTED (back at/inside); outcome = next 60 bars signed along the excursion direction in ATR20. EXPLORE (to 2025-05-16): PRIOR_VALUE 182 events (92 acc / 90 rej) primary D (accepted minus matched rejected) +0.003 ATR20 (95% CI -0.076..+0.081, 64% retained); IB 483 events (264/219) D -0.023 (CI -0.055..+0.009, 83% retained; K=1 -0.040, CI -0.080..+0.001; UP +0.020, DOWN -0.079). No explore signal in either family, so CLOSED at explore, hold-out (PRIOR_VALUE 100, IB 316 events) NOT opened. Resolution about +/-0.08 ATR20 (PRIOR_VALUE) and +/-0.03 (IB). 553 days that opened outside prior value are not in the PRIOR_VALUE family by design. The IB estimate leans slightly negative (accepted continues less than rejected), not significant; an observation, not a hypothesis to chase on this data. Globex arm NOT tested (see decision amt_option3_globex_arm_untested_20261028). Not shown does not mean no effect.',
  sourceFile: 'scripts/amt_excursion/explore_output.txt', sourceDate: '2026-10-28', sampleSize: 665,
  rigorStatus: 'explore_only_day_blocked_matched_control_holdout_unopened', status: 'PROVISIONAL',
});
await flagDecision({
  slug: 'amt_option3_globex_arm_untested_20261028',
  decisionText: 'AMT option 3 (accepted vs rejected first excursion) was run RTH only; the repo rule requires RTH and Globex for any new signal, so the Globex arm is an untested gap, recorded here instead of silently skipped. A Globex version would use the 18:00-09:29 bars (the loader only reads RTH; overnight_ranges() reads only hi/lo) with prior RTH value area as the reference (no IB exists overnight; the overnight analogue would be the first hour range). Since the RTH result is flat in both families, the value of the Globex arm is uncertain; decide after the DeepSeek critique of options 1 and 3 whether to build it. Needs the user (or the critique) to say whether it is worth doing.',
  sourceFile: 'scripts/amt_excursion/PREREG.md', sourceDate: '2026-10-28',
});
process.exit(0);
