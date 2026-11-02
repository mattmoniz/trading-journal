# Pre-registration: the tell with absorption, exhaustion and the delta flip together, before or after the fire (written 2026-11-01 BEFORE any outcome)

Origin: the trader (2026-11-01): "What if you tested the tell, absorption/exhaustion (any amount) and a delta flip before or after? Or any variety of these". Instead of hand-picking combinations (every conjunction leaves only a handful of events and each is a new look; the direction family stands at 10 tests with no pass, `node scripts/look_ledger.mjs --report`), ONE pre-registered model weighs all the cues together and is scored only out of sample, in time order, with a day-block placebo. Two timings = two tests (PRE, POST). Explore only (1,760 research V1 tell fires, 516 sessions to 2025-05-16; the marks files and the approximate flip exist for explore only; the sealed AMT-tell hold-out is not extracted). Script `run_cue_confluence.py`, one run. Research only; Stage 2 unchanged. The mark detectors were tuned by eye on explore sessions (in-sample), carried as a caveat.

## Cues (all existing definitions, any strength counts)
- ABSORPTION marks `scripts/amt_absorb/events_explore.csv` (dir = the direction price is expected to go: +1 bullish / -1 bearish; known at the close of 1-minute bar u, i.e. at minute u+1 after the 09:30 open; strong and weak both).
- EXHAUSTION spike marks `scripts/amt_exhaust/spikes_explore.csv` (dir = the fade direction; known at the close of bar u; strong and weak both).
- DDY flip (APPROXIMATE, 10-bar WMA of delta, state change after at least 10 bars; precision 0.71 / recall 0.72 against the trader's real flips): up = +1, down = -1, known at the close of the flip bar.
- Geometry and context: tell direction; NEAR = the tell points at the nearer range edge (the first-break count's definition); DRIFT = sign(close at the signal bar - the 09:30 open).

## PRE test (cues known AT the fire)
One event per fire at the signal-bar close. Features: tell_dir, near, tell_dir x near, drift, abs_bull_60, abs_bear_60 (any absorption mark of that direction confirmed in the last 60 minutes), spk_bull_60, spk_bear_60, flip_up_10, flip_down_10 (a flip in the last 10 bars). BASELINE features: tell_dir, near, tell_dir x near, drift only (geometry, no cues).
## POST test (wait for the first cue AFTER the fire, then enter)
Event = the first cue (absorption, exhaustion or flip, whichever is confirmed first) in the 60 minutes after the fire; decision at its confirmation; entry at the next 500-volume bar open after that. Fires with no cue in 60 minutes: no trade, counted. Features: cue type (absorption / exhaustion / flip), cue_dir, agree = cue_dir equals tell_dir, minutes since the fire, tell_dir, near, drift. BASELINE: tell_dir, near, tell_dir x near, drift, minutes since the fire (no cue information).

## Outcome and policy (like-for-like with the earlier direction tests)
For every event both sides are scored with `trade.stripped` geometry: market entry at the next open plus one tick, the tell's own structural stop distance for either side, 120-minute time exit, 15:55 flatten, $2 per point and $2 round trip, so net_long and net_short exist for each event. Label y = 1 if net_long > net_short. Policy: trade LONG if the predicted probability exceeds 0.5, else SHORT (always trade). Compared on the same OOS events: FULL model, BASELINE model, the TELL direction policy, a random-side placebo (200 draws).
## Model and validation (frozen, nothing tuned)
L2 logistic regression, C = 1.0, features standardised with training statistics, no search over anything. Chronological 5 folds by date count; for k = 2..5 train on folds before k and test on fold k (expanding window, so 80 percent of events are out-of-sample). Day-block null: for each of 100 permutations, the long and short outcomes are swapped for a random half of the dates (this breaks any link between cues and which side wins while keeping each day's outcome structure), then the whole walk-forward is refit; p = share of null OOS means at or above the observed. Day-blocked bootstrap (2000 draws, seeded) for the OOS mean and the paired differences.

## Reading rule (stated before the run; absolute dollars; 2 tests so alpha = 0.025 each)
A timing "shows cue-confluence skill" only if ALL hold: >= 600 OOS events; FULL OOS mean > 0 with the day-blocked CI lower bound > 0; FULL minus BASELINE paired > 0 with the CI excluding zero (the cues add something beyond geometry); day-block permutation p < 0.025; FULL beats the TELL policy and the placebo p95; FULL positive in at least 3 of the 4 OOS folds. A pass is a LEAD for one frozen sealed look (not extracted), never a result; a positive paired difference with a negative absolute mean is NOT a rule. Resolution (CI half-widths) reported either way: about +/-6 dollars per trade on about 1,400 OOS events, +/-5 on the paired difference.
## Logging
Two tests are logged in the look ledger (`AMT_TELL_DIRECTION`, `AMT_TELL_EXPLORE_2023-03_to_2025-05-16`) before the numbers are reported.
## Not tested
Shelf cues, strong-only marks, other windows (60 / 10 are fixed), gradient-boosted or other models, Globex, the true flips (history unavailable), any change to Stage 2.
