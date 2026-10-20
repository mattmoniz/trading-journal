# Pre-registration: location, regime and pace conditioning of the big-order "stuffed" idea — 2026-10-20

Written and committed BEFORE any outcome of this test. Origin: the DeepSeek critique of the whole order-flow program (`reports/deepseek_orderflow_program_review_2026-10-20.md`) said the big-order tests ignored WHERE the order printed relative to the level being faded, ignored the day's regime, and the user added that pace (how much volume came through and how quickly) was never really a factor. Earlier "pace" in this project meant trades per 1-minute bar ranked against the same clock time, plus price speed; it was not volume speed in seconds and not the speed of a big order.

## Plain-English question
When a big order on OUR side has just been stuffed (price came back against it) AND it printed right at the price where we are about to fade AND the tape was running fast at that moment, do the roster's level-fade trades do worse? And does it depend on whether the day is balance-like or expansion-like?

## Data
- Big orders with their price paths: `scratch/stuffed_20261020/*.tsv` (side, start/end second, size, prints, first/last price, vwap, price 60 s after the end, ... ), merged same-side prints at most 1 ms apart, size >= 70, prices corrected for the DTC file's 1/100 scale.
- Per-second aggressor volume per RTH session: `scratch/persec_20261020/*.tsv` (second of day, buy-aggressor volume, sell-aggressor volume), built by `scripts/tick_microstructure/extract_persec_20261020.py` from the same ticks (session totals validated against the database RTH volume).
- Trades: the 3.5-year RTH level-fade replay with touch times (`scratch/rotation_gate_replay_rows_ts_20261020.json`), the sessions with data (about 19,600 trades). Bars/ATR20 from `scripts/lib/pocJoinLoader.mjs`. Split: explore 2023-03-06..2025-05-31, hold-out 2025-06-01..2026-10-19.

## Definitions (fixed here)
All features use only data before the decision time T = start of the trade's fire minute. P_T = close of the minute before T (the price at T). ATR20 = the loader's 20-session RTH range.
- LOCATION (near): a big order is NEAR the trade if |order VWAP - P_T| <= 0.05 x ATR20 (about the system's 15-point confluence radius at a typical ATR). Sensitivity only: 0.025 and 0.10.
- STUFFED: definition A of the stuffed test (60 s after the order ends, price is at least 2 ticks back against its last print), label known at end + 60 s, which must be <= T and within the previous 15 minutes. OWN side = the order's side equals the trade direction (stuffed buys before a long, stuffed sells before a short: our side was run over). OPPOSITE side = the other way.
- PACE: V30 = total contracts traded in the 30 seconds ending at T, ranked (mid-rank) against the same 30-second clock window in the previous 60 sessions (at least 30 sessions). FAST = rank >= 0.75, SLOW = rank <= 0.25. Sensitivity only: 10 and 60 second windows. A second, descriptive pace measure is the speed of the near big order itself (contracts per second of its own span); it is reported, never used for a verdict.
- REGIME: developing-range rank at T (the range so far in the session divided by ATR20, ranked against the previous 60 sessions at the same clock), terciles with the cut points already frozen for the forward monitor rule R4 (0.30 and 0.65): LOW = balance-like, MID, HIGH = expansion-like.

## Flags and what is tested
- PRIMARY flag (step-aside, predicted worse): a NEAR, OWN-side, STUFFED big order in the previous 15 minutes AND FAST pace at T. Fallback rule fixed in advance: if the primary flag has fewer than 150 trades on 60 sessions, the primary becomes "NEAR, OWN-side, STUFFED" (any pace); if that also has fewer, the verdict is NOT ENOUGH EVENTS.
- Reported but never used for the verdict (descriptive cells, matched difference with day-blocked CI): NEAR own-side stuffed alone; FAST alone; SLOW alone; NEAR opposite-side stuffed (step-in, predicted better) alone and with FAST; every cell split by regime tercile with the interaction (expansion minus middle).
- Metrics exactly as the earlier tests: per-trade mean pnl (sum/N); matched difference of unflagged minus flagged within 30-minute clock buckets (positive = flagged trades worse); day-blocked bootstrap 97.5 percent interval (this is the fourth big-order family tested; the stricter interval is kept); shuffled-label placebo within month x bucket, 97.5th percentile; explore and hold-out; five families; inside the AGREE roster; incremental over the rotation gate.

## Verdict rules
USEFUL only if (i) at least 150 flagged trades on at least 60 sessions (else NOT ENOUGH EVENTS), (ii) CI lower bound above zero, (iii) above the placebo 97.5th percentile, (iv) hold-out same sign and at least half the explore size, (v) at least 3 of 5 families positive, (vi) the effect is not carried by one regime tercile alone unless that tercile was named in advance (none was). If it passes: a live SHADOW tag only, after DeepSeek review and a live feed. Otherwise say exactly what could not be shown.

## Deviations stated in advance
- No bars-first (price) version: location needs a named level, which exists only for the roster trades, so this is a roster test only.
- The regime terciles reuse R4's frozen cuts; no new cut is fitted. All sensitivities are labelled and never rescue a failed primary. The scripts are not DeepSeek-reviewed. Not wired to anything live; no live feed is involved (the live watcher stays deferred by the user).
