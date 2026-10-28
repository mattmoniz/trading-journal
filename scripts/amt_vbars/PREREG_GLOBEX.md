# PREREG_GLOBEX: the node-ladder tell in the Globex window (2026-10-28, DRAFT, committed BEFORE any Globex trade result)

Status: definitions frozen by this commit. Nothing has been run. EXPLORE sessions only (2023-03..2025-05-16, full-session 500-contract bars already extracted); the hold-out after 2025-05-16 stays sealed. Orders in Globex are a separate decision after this result.

## Why a new definition is needed (not a switch)
The research tell fires only while price is still inside the "combined prior range" (overnight high/low, plus the Initial Balance after 10:30). `trade.prep` computes the overnight high/low over the WHOLE night, so any decision before 09:30 would use information from the future. In the Globex window there is also no overnight range yet. A causal boundary is therefore part of the hypothesis.

## Frozen definitions
- **Window:** signal bars ending 18:30 through 09:29 ET (the first 30 minutes after the 18:00 open are excluded: the repo already finds the first 30 Globex minutes harmful for other setups). Reported sub-windows, descriptive only: evening 18:30-23:59, overnight 00:00-09:29.
- **Boundary (causal):** long side = the prior RTH session's high, short side = the prior RTH session's low (both known by 17:00). "Inside" = no COMPLETED Globex bar has closed beyond the boundary in direction d so far. Distance and `broke` use the same boundary exactly as the RTH test uses its boundary. Prior RTH high/low = the 09:30-16:00 session range of the previous trade date from the same extracted bars.
- **Tell, stop, management:** unchanged from PREREG.md / PREREG_TRADE.md (five components, the user's LVN stop behind node 2, V1 = tell-fade exit after the break + 120-minute no-break exit + 15:55 flatten of the session; V3 = hold to the 15:55 flatten after the break). One position at a time, 1 MNQ, $2/pt, $2 round trip, 1-tick slippage. A trade open at 09:30 is carried into the RTH session by the same rules.
- **Implementation:** the research `trade.simulate` is reused unchanged; only `boundary()`/`inside_range()` are replaced by the causal versions for this test (parity-tested against a hand-written reference). Both bar readings (split, whole) are run; the split reading is primary.

## Counted question (one primary cell)
V1, split reading, pooled Globex window: day-blocked 95 percent CI of the per-trade mean (sum/N, not day-weighted) NET of costs. **Lead** = lower bound above zero AND the per-trade mean beats the random-entry placebo p95 (same window, random direction, the same stop distance, 100 trials, stripped geometry) AND beats the moving-only control. Under 150 trades or under 60 dates = underpowered, no lead.
Everything else (V3, whole reading, sub-windows, long/short split) is descriptive.

## Pooled verdicts are questions
Before any conclusion the result is split by long/short and by the two sub-windows; opposite-signed subgroups are reported, not averaged away. RTH-validated momentum/flow signals have reversed in Globex repeatedly in this repo (CLAUDE.md Conventions): a NEGATIVE here is an expected, informative outcome, and a flipped sign is reported as such.

## What happens next
Lead: Globex goes to watch-only live logging (own tagged book), then a single sealed hold-out look and the user's decision on orders. No lead: Globex stays off (recorded as tested-and-no for the hard rule), RTH only. Either way the result is recorded via `record_claim.mjs`, and `amt_tell_globex_arm_untested_20261028` is resolved with it.
