# Pre-registration: does a real stop run leave a measurable signature (volume spike, forced aggression, fast reversal), and do sweeps that show it pay more — 2026-10-21

Written and committed BEFORE any feature or outcome of this test is computed. Origin: user (2026-10-21): the stop sweep is "an actual mechanism" that "usually happens around 10am"; the geometry-only replays (`STOP_SWEEP_REPLAY_PREREG_20261021.md`, `FSR_REEVAL_AND_TIGHTENING_PREREG_20261021.md`) did not show the sweep rule beats a flipped-direction placebo, but they never looked at what a stop run actually looks like in the tape. The user agreed to this as the next test ("sure preregister it"). Research only, bar data only (1-minute volume, bid-hit volume, ask-lift volume); nothing live changes; the setups keep their current status.

## Hypothesis from the mechanism
Stops resting beyond a level are market orders that trigger when price trades through it. A run therefore looks like: heavy volume as price pushes through (stops firing), aggression in the direction of the push at the extreme (for a sweep below a level, bid-hit/sell volume dominates at the low), then exhaustion and a quick reversal with aggression the other way. A sweep that is only a drift through the level, with ordinary volume and slow retracement, should pay less. If the mechanism is what makes the setups work, sweeps showing the signature should do better than those that do not, in both setups.

## Populations (already built, outcomes already seen in aggregate, not re-tuned)
- P1: the 862 corrected StopSweep replay events (`scratch/stop_sweep_replay_events_20261021.json`, from `scripts/study_stop_sweep_replay_20261021.mjs` after its addendum): live exit V1 dollars, structural-stop-hold V2 mean R, R-race expectancy at k = 3.
- P2: the 3,084 FAILED_SWEEP_REVERSAL replay events (`scratch/fsr_replay_events_20261021.json`, from `scripts/study_fsr_replay_20261021.mjs`): dollars with the 68-point stop and 250-point target, and the target-hit share.
Explore = events to 2025-05-31, hold-out = 2025-06-01 on (same split as before). The signature is a replication test across two overlapping but differently defined event sets, not two independent samples (many sweeps appear in both).

## Features (point-in-time at the event bar t, information through t's close; no future bars)
Extreme bar = the bar with the lowest low (long) or highest high (short) among the 10 bars ending at t (first one if tied).
- V volume spike: z-score of the extreme bar's volume against that same clock minute's volume over the previous 60 sessions (needs at least 40 prior sessions; otherwise the event is dropped from that hypothesis).
- A adverse aggression at the extreme: for a long, (bid-hit volume minus ask-lift volume) / (their sum) on the extreme bar (positive = selling dominated the low); for a short the mirror (positive = buying dominated the high).
- B favourable aggression after the extreme: over the bars after the extreme bar through t, for a long (ask-lift minus bid-hit) / (sum), for a short the mirror.
- T reversal speed: bars from the extreme bar to t (smaller = faster). If the extreme bar is t itself, T = 0.
No numeric cutoffs are chosen by hand: V, A and B are "tight" at or above the explore-period median of that feature, T is "tight" at or below the explore-period median; cutoffs frozen and applied unchanged to hold-out.

## Tests (frozen)
- **H1..H4:** for each of V, A, B, T and each population: mean outcome tight minus loose, day-blocked bootstrap 95 percent interval of the DIFFERENCE (days resampled, trades pooled per arm), explore and hold-out separately. Outcome: P1 V2 mean R (primary) and R-race k = 3 expectancy; P2 dollars (primary) and target-hit share. KEPT (strong) if the explore interval excludes zero on the favourable side AND the hold-out interval does too; KEPT (weak) if explore excludes zero and the hold-out point estimate has the same sign; else NOT SHOWN.
- **Mechanism check:** the subset that is tight on every KEPT hypothesis, in hold-out only, compared with the same events with the direction flipped (the flipped-direction placebo already built into both event files): real minus flipped, same day-blocked interval. SUPPORTED only if at least one hypothesis is KEPT in BOTH populations and this subset beats its flipped version with the interval above zero; otherwise NOT SHOWN, stated as what could not be shown. A subset with fewer than 20 hold-out events or 20 distinct days is underpowered, not a verdict.
- **Timing (descriptive):** for the P1 events with the signature (the kept hypotheses, or all four if none kept), the share entered 10:00-10:30 versus later and the same outcome comparison, no verdict.
- Comparisons: 4 hypotheses x 2 populations x 2 periods = 16 intervals plus the subset checks, so about one spurious favourable interval is expected by chance; the replication requirement (both populations and both periods) is the guard, and a single favourable cell is not a finding.

## Known limits (stated in advance)
Bar-level volume only (no tick data, no depth): aggression is the 1-minute bid-hit/ask-lift split, which cannot see sequencing inside the minute; the extreme bar can be the same bar as the reclaim at fast reversals; V uses the same clock-minute baseline as the earlier 2026-10-20 flow work (the 10:00 bar has its own large normal volume); the replay events are an approximation of the live pollers (13 and 42 percent fidelity) so a result is about the replayed rules; the user's mechanism may rely on features not in the bar data.
