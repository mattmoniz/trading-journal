# Candidate queue protocol: how the system "continuously finds edge" without fooling itself (adopted 2026-11-08 from the Opus architecture review; user: 'Can we implement to fix all your bullets first')

STATUS: ADOPTED as the working rule for machine-driven search. User-originated ideas keep the existing path (a pre-registered test of the user's own hypothesis, charged to the look ledger) and are NOT capped by this queue; what is capped is search that nobody proposed.

## Why
130 looks were charged to the ledger in 11 days on the same explore era (2023-03 to 2025-05-16, about 520 sessions); at p < 0.05 about six apparent leads are expected by chance alone. At this N (one test, 80 percent power) a daily Sharpe of about 2.8 / sqrt(N days) is the smallest effect that can be seen: about 0.18 per day (annualised Sharpe 2.8) at 250 forward days, about 2.0 annualised at 500. A continuous search cannot out-run that, so the realistic yield is 0-1 confirmed edges a year and the goal is reframed: keep the forecasts and gates calibrated, and run a small fixed queue of candidates through FORWARD tests.

## The queue
1. **Quarter windows** (Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec). At most **K = 8** unsolicited candidates per quarter. A candidate is a written spec: the feature or bucket, the sign, the target, the exit (frozen, never derived from the population being tested, cv-022), the data window it will be judged on, and its kill rule (co-022).
2. **Charged at registration**, not at run time: `logLook()` the day the spec is written (hr-023), so a candidate that is registered and never run still counts against the budget.
3. **Alpha spending**: Holm at a family-wise 0.10 across the quarter's candidates; a candidate's own test is a day-block bootstrap on the dollars of the frozen rule.
4. **Stages**: REGISTERED -> SHADOW (rows logged forward, no orders) -> one look at 60 forward days, one at 120, one at 250, no peeking between (cv-006; the forward statistic stays hidden until the look, as in `build_payload.py`). Explore-era work can only ever produce a LEAD, which moves a candidate to SHADOW; it never promotes.
5. **Promotion to a trade** needs: a forward day-block lower bound above 0 at the Holm-corrected level, both halves positive, a beat over its own placebo AND an entry-price-only control (hr-042), and a pass-race check that the rule does not lower P(pass) (see the pass-race simulator on the Monitor page once built).
6. **Learned outputs touch orders only as a VETO or a force-SHADOW** until a candidate has 250 forward days and one confirming sealed look; never an add or an upsize (the account trades 1 MNQ, cv-064).
7. **Champion / challenger on a fixed calendar**: refits are monthly and frozen (the range model's artifact pattern); a challenger replaces the champion only at a scheduled look.

## What this deliberately does not do
It does not stop the user from testing their own ideas (that would conflict with 'test the idea, don't interrogate'); deviation from the Opus recommendation (freeze all new explore-era studies) recorded here (hr-035): the diagnosis (explore is mined out, so explore results are leads only) is taken, the remedy is applied to unsolicited search, not to the user's hypotheses. Every explore-era result stays 'LEAD at most' in its claim text.

## The queue file
`docs/CANDIDATE_QUEUE.md` (one row per candidate: id, quarter, spec, ledger look id, stage, next look date, kill rule, outcome). Rows are added only with a ledger look. `scripts/check_research_organized.mjs` should flag a queue row without a look id (not yet wired; listed in OPEN_THREADS).
