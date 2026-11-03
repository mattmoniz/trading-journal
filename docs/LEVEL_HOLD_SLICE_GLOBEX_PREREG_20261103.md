# Pre-registration: hold-or-slice tape study, GLOBEX arm (2026-11-03, written BEFORE any Globex label was computed; user: "include Globex because we need to learn how it behaves vs RTH and tailor trades to it")

Parent: `docs/LEVEL_HOLD_SLICE_PREREG_20261103.md` (RTH result: STATISTICAL ONLY, claim `level_hold_slice_tape_statistical_only_20261103`). EVERY definition, constant and test below is identical to the parent except the items listed under "Differences". Explore only (through 2025-05-16); the later window stays sealed. Not committed at write time; the sha256 of this file is logged in the ledger look before the run. User is away; run unattended.

## Data
Per-second overnight tape `scratch/persec_globex_20261103/DATE.tsv` (seconds since 18:00 ET of the previous calendar day, 0..55799 = 18:00 to 09:29:59; buy and sell aggressor volume, low, high, last), extracted by `scripts/tape_companion/extract_persec_globex.py` with the same contract-file choice and RTH-volume validation (within 3 percent of price_bars_primary) as the volume-bar extractor. The Globex session of trade date D is the night BEFORE D's RTH. Library `lib.py` session object `GLOBEX`, hand-traced tests in `test_lib.py` (RTH unchanged: 30,425 episodes and 14,169 evaluable events reproduced exactly after the refactor).

## Differences from the RTH pre-registration (all fixed now)
- Contacts from 18:30:00 (the first 30 minutes after the 18:00 open are a no-trade window, cv-056) to 08:30:00 ET (30 minutes before the RTH open, before the 08:30 macro releases can matter); decision at contact + 60 s, cap 900 s, as before.
- Levels: only levels that exist at the 18:00 open: PRIOR_DAY, VALUE_AREA, WM_PIVOTS, PERIOD_HLP, plus PD_OR_MID, PD_IB_MID, PW_MID, WEEKLY_OPEN, MONTHLY_OPEN, WEEKLY_VWAP, MONTHLY_VWAP. EXCLUDED as same-day-future (lookahead): OR and IB levels, the final ONH/ONL (they are the overnight range itself), DAILY_OPEN and the RTH mids. Stored levels are those of trade date D (they were built from D-1's session and earlier); the stale-level check compares PD_HIGH and PD_LOW to the previous RTH session's extremes exactly as before.
- Baselines (scale and volume rate by clock hour) come from the previous 20 GLOBEX sessions; hour dummies are one per observed clock hour except the first.
- Pseudo-level placebo built from the Globex level set only.

## The ONE counted test (C1-G)
Same as C1: mean out-of-sample log-loss of B1 minus F (tape over price behaviour), same walk-forward (first 100 dates train only, refit every 20), same L2 logistic (C = 0.1), day-blocked bootstrap 95% CI (3000, seed 20261103), within-date label permutation p (100 draws), both chronological halves. Same verdict ladder (UNINFORMATIVE / NOT SHOWN / STATISTICAL ONLY / LEAD with the same 0.034 economic floor). Globex is judged ON ITS OWN, not pooled with RTH (hr-039: RTH momentum/flow signals have reversed in Globex).

## Reported, uncounted (the user's question: how does Globex behave versus RTH)
Side by side table from `compare_sessions.py` on the saved labeled events: evaluable events and per-date counts, scale in points, HOLD / SLICE / NEITHER shares, volume-rate and tussle levels, ALREADY_HELD and THROUGH shares; standardised logistic coefficients of the price and tape features per session (descriptive, full sample) with any sign flip flagged; increment by overnight time block (18:30-22:00, 22:00-02:00, 02:00-08:30); leaving the 10 largest dates out; pseudo-level placebo; the 15-minute scale sensitivity is NOT run for Globex (multiplicity).

## Reading rules (fixed now)
Same as the parent. Additionally: if the aligned-delta coefficient has the OPPOSITE sign in Globex versus RTH, report it as a session reversal (hr-039) with the caveat that coefficients are descriptive. No rule, no trading change, no live wiring from this study. Dollars are out of scope.

## Known gaps (recorded)
Overnight "trades per second" is not available (volume only). Developing overnight high/low as live levels (known only as the night unfolds) are NOT included; they would need an as-of construction. Sunday-evening and holiday-shortened sessions are included if the extractor produced a file; their share is reported. The user's actual overnight trading windows are not separated beyond the three time blocks above.
