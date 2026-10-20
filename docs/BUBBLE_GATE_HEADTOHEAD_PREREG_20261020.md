# Pre-registration: bubble (trapped-buyer) gate vs the POC rotation-direction gate, same trades, dollars — 2026-10-20

Written and committed BEFORE any outcome of this test. Origin: the user asked whether the trapped-buyer finding ("modest") is better than the POC rotation gate, and how a gate would work. The finding so far (`bubble_trapped_buyers_step_aside_cells_20261020`) is a small association (Spearman about -0.06 to -0.11) between large aggressive-buy volume trapped above price on the way into a level and the long race score, strongest after large falls; it was measured on first-penetration events with a race outcome, not on dollars of the actual setups. The rotation gate (65pt leg direction, AGREE/DISAGREE) showed +1 dollar per trade AGREE-minus-DISAGREE on the 3.5-year replay, CI crossing zero, era-flipping. This test puts both on the SAME trades.

## Population
The 3.5-year RTH level-fade replay (`scripts/study_rotation_gate_roster_replay_20261020.mjs` logic, realistic fills: a stop beyond the market fills at the bar open, targets fill at the open when gapped), re-run with the touch time saved (`scripts/study_replay_with_times_20261020.mjs`), restricted to sessions that have tick-derived cell data (about 831 sessions) so both gates see the same trades. Trade direction is the replay's own (long/short). Each trade is tagged AGREE/DISAGREE exactly as before.

## The bubble gate (how it would work)
At the touch bar e (known at its close), in the trade's own direction (long frame for a long trade, mirrored for a short): OURS30 = rank, against the previous 60 sessions at the same clock time, of the size-weighted (volume^2) aggressive volume trapped on our side over the last 30 minutes (long: ask-dominant cells above the close; short: bid-dominant cells below the close). FALL = how far price fell against our direction over the same 30 minutes, in ATR20 (signed so a long trade's fall is a drop).
- G1 (reported): OURS30 in the top third of its explore-half distribution.
- G2 (primary): G1 AND FALL in the top third of its explore-half distribution. Both cut points are computed on the explore half (2023-03-06..2025-05-31) only and frozen for the hold-out half (2025-06-01..2026-10-13). A flagged trade is "stepped aside" (removed).
- G_rot (the existing gate): the trade is DISAGREE (its direction is opposite to the in-progress 65pt leg); a trade with no leg yet is not flagged.
- G_or: flagged by either.

## Metrics (each gate separately, on the same trades)
- Flag rate; mean pnl of flagged vs unflagged trades (per-trade mean = sum/N, never day-weighted); marginal difference (unflagged minus flagged) with a day-blocked bootstrap CI (resample sessions); net dollars saved per trade if honored (minus the mean of flagged x flag rate); explore and hold-out separately.
- Placebo: 1000 random gates with the same flag rate (random subsets within each session), real marginal difference must exceed the 95th percentile.
- Per setup family (level group: OR/IB, PD, PW/PM, VWAP, other; pooled hides opposite signs): sign of the marginal difference.
- Overlap: share of G2-flagged trades that are also DISAGREE; and INCREMENTAL value: the bubble gate's marginal difference among trades NOT flagged by the rotation gate, and the rotation gate's among trades not flagged by the bubble gate.
- Head-to-head: paired difference (bubble gate saving per trade minus rotation gate saving per trade) with a day-blocked CI.

## Verdict rules
The bubble gate is judged USEFUL only if (i) its marginal-difference CI excludes zero in the helpful direction, (ii) it beats its placebo 95th percentile, (iii) the hold-out marginal difference has the same sign and at least half the explore size, (iv) at least 3 of the 5 families agree in sign. It is judged BETTER than the rotation gate only if USEFUL and the paired head-to-head CI excludes zero in its favor. Otherwise: "not shown", stated as what was and was not shown. A combined or incremental result is reported either way. No live change from this test; any gate that passes goes next to a DeepSeek review and then a force-SHADOW tag (observation first), and a live feed for the cell data would have to be confirmed first (tick files on disk end 2026-10-13).

## Rules
Claude builds, DeepSeek reviews the code before the verdict is final. Record via `recordClaim()` whatever the result. Globex is not covered (no overnight cells extracted yet); flagged.
