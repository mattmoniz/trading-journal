# Pre-registration: does "the market has been driven hard into the level first" pick out the real stop sweeps — 2026-10-21

Written and committed BEFORE any prior-move feature or outcome is computed. Origin: user (2026-10-21), on merging the reversal sweep and the stop sweep: "there aren't 6+ stopsweeps; if it happens it only happens 1-2 times in a day if that, usually after the market has been moving down pretty hard." The loose joined rule fires about 25 times a day (thinned) and the live reversal sweep about 4-6, so the missing piece is selectivity; the user names the selector (a hard move into the level beforehand) and the target frequency (1-2 a day). Research only; nothing live changes.

## Population and outcomes (already built, not re-tuned)
The joined sweep replay events `scratch/unified_sweep_events_20261021.json` (14 levels, FSR-form trigger, 2023-03-06 to 2026-10-20, 43,021 events), thinned to one event per direction per 10 minutes (20,662 events), each with the outcomes at b = 1.0 (stop 1.0 x the typical 10-minute range beyond the sweep extreme, hold to 15:58; dollars = points x 2 - 2; k = 3 R-race) and its flipped-direction placebo. Explore = to 2025-05-31, hold-out = 2025-06-01 on.

## Features (point-in-time, minute bars only, ATR20 = mean RTH range of the previous 20 sessions so the same number is available live)
Extreme bar = the bar with the lowest low (long) or highest high (short) among the 10 bars ending at the event bar.
- **M60 hour-long drive:** for a long, (highest high in the 60 bars before the extreme bar minus the extreme) / ATR20; a short mirrors (extreme minus the lowest low of the previous 60 bars) / ATR20. "How far was price driven in the sweep direction in the hour before the sweep."
- **DD day drive:** for a long, (RTH session high so far minus the extreme) / ATR20; a short mirrors with the session low. "How far down has the day gone" (the user's wording); needs at least 30 RTH bars, which the rule already requires.
Both are signed so that a bigger number = a harder drive into the level.

## Frequency calibration (from the user's stated frequency, not tuned on outcomes)
The user says 1-2 sweeps a day at most. Thinned, the loose rule gives about 26 events per day, so the tight set must be about 6-8 percent of events: the cutoff is the explore-period 93rd percentile of each feature (pooled over directions, signed as above), frozen for hold-out. Sensitivity at the 80th and 67th percentile is printed. Events per day for the tight set, and the count of days with at least one, are reported; and a "first tight event of the day per direction" version.

## Tests (frozen)
H1 M60 and H2 DD, outcome hold dollars at b = 1.0 and the k = 3 R-race: tight minus loose, day-blocked bootstrap 95 percent interval of the difference, explore and hold-out separately; ALSO tight minus the flipped-direction version of the tight events (the placebo), hold-out. Rule: KEPT (strong) if both periods' intervals of tight minus loose are above zero; KEPT (weak) if explore is above zero and the hold-out point estimate is positive; AND, for either, the hold-out tight subset must beat its flipped version with the interval above zero and have at least 20 events on 20 distinct days; otherwise NOT SHOWN, stated as what could not be shown. Direction is reported separately because the user described the DOWN case (long after a hard drop): long-only and short-only are printed, with the long-only result the one the user's description predicts, and no pooled verdict is allowed to hide opposite signs. 2 hypotheses x 2 outcomes x 2 periods x pooled/long/short = comparisons are many; the replication requirement across periods and the placebo are the guard; a single favourable cell is not a finding.

## What a KEPT result licenses
Only a shadow-only merged setup in `acd.js` (reversal sweep + the six market levels + the kept condition) as its own pre-registered next step, with the new-setup checklist; nothing live in this test. If nothing is kept, the merge does not make the rule looser and the decision `reversal_sweep_stopsweep_merge_into_one_setup_20261021` goes back to the user.

## Known limits (stated in advance)
Replay events, not the live pollers; the frequency target is the user's description, not a measured count of real stop sweeps (the real StopSweep rows fire about 3 a day, the real reversal sweep 4-6); "hard move" is defined by ATR-scaled distance over fixed look-backs of 60 bars and the session so far, and other definitions (speed, volume) are not tested here; thin cells after the 93rd-percentile cut (about 1,300 events in total, fewer per direction) give wide intervals.
