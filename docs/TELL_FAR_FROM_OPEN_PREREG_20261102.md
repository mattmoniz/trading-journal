# Pre-registration: first-hour tell far from the open, pointing back toward it (written 2026-11-02 BEFORE any outcome was read; user: "scope it out and see what you find")

STATUS: EXPLORE ONLY, NOT CONFIRMATORY. The idea came from a descriptive split of these same 1,760 explore fires (docs: claim tell_profile_when_where_follow_or_flip_20261102: far-from-open fires point back toward the open 77% of the time; early-session tell presence is strongest). Re-reading the same fires cannot confirm it. Any support is a hypothesis for the forward tracker, not a rule. The sealed hold-out (after 2025-05-16) is not touched. Not committed at write time; the file sha256 is logged in the ledger look before the script runs.

## Question
In the first hour (signal bar ends 10:00-11:00 ET), when the tell fires FAR from the 09:30 open and points TOWARD it, does price travel toward the open more over the next 30 minutes than after a matched NO-tell moving bar in the same situation? The control is what makes this a tell question: far-from-open reversion may be a property of any moving bar (cv-094 same-side control), and 84% of tell fires just copy the last-10-bar direction.

## Definitions (frozen)
- Events: the V1 tell fires (T.simulate 'V1', the 1,760) and the existing matched CONTROL bars (every 10th decision bar, complete, moving, no tell at any component count in either direction; direction = prior-10-bar move), exactly as in `hit_rate_definitions_20261102.py`. Explore sessions with a usable 20-session baseline, through 2025-05-16.
- First hour: signal bar end time 10:00:00 to 11:00:00 ET (57,600 to 61,200 s after the 18:00 open).
- Open reference P0: close of the last completed 500-volume bar ending at or before 09:30 ET (55,800 s). No such bar -> event dropped.
- Distance D = |close[signal bar] - P0| / ATR20 (the session's own ATR20 in points). FAR = D at or above a CAUSAL expanding 2/3 quantile of D over all EARLIER dates' first-hour events (both arms pooled); the first 100 events seed the cutoff and are not evaluated.
- Toward-open direction dr = -sign(close - P0). An event is TOWARD when its own direction (tell: the tell direction; control: prior-10-bar direction) equals dr.
- Outcome y30 = dr x (close of the last completed bar at or before signal end + 30 min - close[signal bar]) / ATR20 (ATR20 units, market behaviour, no costs, no stop). Events whose window runs past the data are dropped from that horizon.

## Statistics (ONE counted test)
- C1: mean y30 (FAR and TOWARD) TELL minus CONTROL, day-blocked bootstrap 95% CI (3000 resamples of dates, seed 20261102) and a permutation p (1000 label shuffles within dates). Supported (weakly) only if the CI lower bound is above 0 AND the difference has the same positive sign in both chronological halves of the evaluated dates.
- Reported, uncounted: the same at 60 min; first-to-reach +/-0.15 ATR20 toward-first share; N per arm per half; leave-top-10-events-out difference; the same contrast for ALL distances and for FAR-but-AWAY (to show whether any gap is about the tell or about direction); CONTROL FAR-TOWARD mean y30 vs 0 (does plain reversion exist).

## Reading rules (fixed now)
CI includes 0, or the sign differs between halves -> the tell adds nothing to far-from-open reversion on explore data; the 77% is the last-10-bar direction. Idea closed as NOT SHOWN with that resolution stated. CI above 0 in both halves -> a lead on explore only; it moves to a forward tag (read-only, like the flip-disagree tagger) and would need its own pre-registered trade simulation (stop, fills, costs) before any dollar claim. No rule, no change to Stage 2, no live wiring from this study.

## Known gaps (recorded, not skipped)
- GLOBEX: "distance from the open" is defined here from the 09:30 RTH open. A Globex analogue (distance from the 18:00 open, or from the prior close) is NOT tested; RTH-validated flow/momentum signals have reversed in Globex in this repo, so it needs a from-scratch test if this survives. Flagged as an OPEN_DECISION if the RTH result is a lead.
- Cutoffs: the 2/3 quantile and the first-hour window were chosen from the descriptive table (forking path, disclosed).
- Control bars are every 10th decision bar, so the control N is smaller than the set of all moving bars; the permutation test is within dates.
