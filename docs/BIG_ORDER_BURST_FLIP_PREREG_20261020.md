# Pre-registration: big-order burst-then-flip ("the 10:15 pattern") — 2026-10-20

Written and committed BEFORE any outcome of this test. Origin: on 2026-10-20 the POC-gated (AGREE) roster peaked around 10:22 and then gave back to about -1,100. The tick view (`scripts/study_giveback_ticks_20261020.py`, descriptive, one day) showed that at 10:15-10:30 big buy orders (merged same-side prints at most 1 ms apart, 70 contracts or more) outnumbered big sells 18 to 6 (the day's largest total delta), and in the next 15 minutes it flipped to 2 big buys against 9 big sells while price stalled. The user asked to test that pattern. One day cannot show anything, so this is the test across the archive.

## Plain-English question
When big orders pile up on one side and then, within the next quarter hour, the big orders turn to the other side: (1) does price tend to turn too (market behavior), and (2) do level-fade trades taken on the burst side right after the flip do worse than the same-time trades without the pattern (would "stand down" have helped)?

## Data
- Big orders: `scratch/orders_20261020/*.tsv` (side, ET seconds of day of the first print, size, vwap, number of prints), built by `scripts/tick_microstructure/extract_cells_20261020.py` from the Sierra tick files (836 sessions through 2026-10-19; validated against the database volume). A big order is a merged same-side order of SIZE >= 70 contracts (the user's Delta Dynamics "Big Trades" minimum). Sensitivity only (never used for the verdict): 40 and 100.
- Bars and ATR20: `scripts/lib/pocJoinLoader.mjs` (`price_bars_primary`).
- Trades: the 3.5-year RTH level-fade replay with touch times, `scratch/rotation_gate_replay_rows_ts_20261020.json` (21,480 trades; realistic fills; the replay logic of `scripts/study_rotation_gate_roster_replay_20261020.mjs`), restricted to sessions that have a big-order file.
- Split: explore 2023-03-06..2025-05-31, hold-out 2025-06-01..2026-10-19. Everything below has no fitted cut point (ranks against past sessions, cut ranks fixed here), so the split is used only to check stability.

## The pattern (defined once, no free parameters)
At decision time t (the start of a minute; only orders whose first print is before t are used):
- NET(a, b) = sum of signed big-order size in the window (a, b], buys positive, sells negative.
- P = NET(t-30 min, t-15 min) (the earlier leg), R = NET(t-15 min, t] (the recent leg).
- Each is ranked against the previous 60 sessions at the same clock time and the same window (mid-rank for ties, so a window with no big orders ranks near the middle). At least 30 past sessions are required.
- Pattern UP-THEN-DOWN: rank(P) >= 0.90 and rank(R) <= 0.25. Pattern DOWN-THEN-UP: rank(P) <= 0.10 and rank(R) >= 0.75. The decision time cannot be earlier than 10:00 ET (both legs inside the session).
- Sensitivity only (reported, never used for the verdict): rank cuts 0.80/0.33 and 0.95/0.15.

## Test 1 — market behavior (bars first)
Events: every session minute from 10:00 to 15:00 ET where the pattern is true, de-clustered to the first minute of each run with at least 30 minutes between events within a session. Outcome: forward price change over the next 30 and 60 minutes divided by ATR20, signed so that positive means price turned AGAINST the burst (for UP-THEN-DOWN the outcome is the negative of the forward change, for DOWN-THEN-UP the forward change). Compare with the same signed outcome at every other eligible minute of the same burst-direction class, matched on 30-minute clock bucket. Report mean event outcome, mean control outcome, difference, day-blocked bootstrap CI, a permutation null (event labels shuffled within month x 30-minute bucket, 1000 draws, 95th percentile), explore and hold-out separately, and the time-of-day split (before 11:00 vs 11:00 or later; the user's pattern was seen at 10:15).

## Test 2 — does it help the roster (dollars)
For each replay trade, at its fire minute the trade direction defines the frame: aligned rank of P and R (for a short trade the ranks are mirrored). Flagged = the trade is on the BURST side after the flip (long with UP-THEN-DOWN, short with DOWN-THEN-UP, i.e. aligned rank(P) >= 0.90 and aligned rank(R) <= 0.25). Mirror group (secondary): trades on the FLIP side (aligned rank(P) <= 0.10 and aligned rank(R) >= 0.75), predicted better.
- Metric: per-trade mean pnl (sum/N, never day-weighted) of flagged trades vs unflagged trades in the same 30-minute clock bucket, combined with the flagged share of each bucket as weights (time-of-day matched). Marginal difference = matched unflagged mean minus flagged mean (positive = flagged trades are worse). Saving = dollars per trade of the whole population if flagged trades are skipped.
- Day-blocked bootstrap CI (1500 resamples of sessions); placebo: flag labels shuffled within month x 30-minute bucket keeping the flagged counts (1000 draws), real marginal difference must exceed the 95th percentile; explore and hold-out separately; per family (OR/IB, PD, PW/PM, VWAP, other); inside the AGREE (rotation-gated) roster separately, because that is where the 10-20 give-back happened; incremental value over the rotation gate (the pattern among trades the rotation gate does not flag).

## Verdict rules
- Test 2 is USEFUL only if (i) there are at least 150 flagged trades on at least 60 distinct sessions (otherwise the verdict is NOT ENOUGH EVENTS, which is not a failure), (ii) the marginal-difference CI lower bound is above zero, (iii) it exceeds the placebo 95th percentile, (iv) the hold-out difference has the same sign and at least half the explore size, (v) at least 3 of 5 families are positive.
- Test 1 is a SIGNAL only if the CI excludes zero, it exceeds the permutation null, and the hold-out has the same sign.
- If both pass, the next step is a live SHADOW tag only (never a gate), after DeepSeek review. If Test 2 passes and Test 1 does not, the pattern is not a market turn signal and any benefit is roster-specific, which needs a second look before use. If neither passes, say exactly what could not be shown (event count, interval, hold-out) rather than that the idea is wrong.

## Rules
- Features use only orders that began before the decision minute (no look-ahead at the decision bar); the replay's realistic fills are used as-is; trades and events inside NQ roll weeks are kept (the tick archive was reconciled to the database per session).
- Per-trade means are sum/N. Day-blocking is used for the delta's confidence interval only.
- Any deviation from this document, and every sensitivity result, is labelled as such. The result is recorded as a RESEARCH_CLAIM either way.
- Not wired to anything live. A live version needs a live tick/big-order feed first (the DTC install's `NQZ26.scid` is being written continuously, so a SHADOW tag is feasible later).
