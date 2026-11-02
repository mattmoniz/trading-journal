# AMT tell Stage 2: the review rule, written BEFORE the numbers exist (2026-11-01)

Stage 2 (simulated-account orders on the V1 book, split bars, RTH 10:00-14:30, 1 MNQ) has run unchanged since the 2026-10-28 evening restart; user decision 2026-11-01: "Lets just leave and watch it" (`amt_tell_stage2_leave_running_review_at_floor_20261101`). Pre-registered floor: about 150 trades (`docs/AMT_TELL_LIVE_PROJECT_SPEC_20261028.md` section 8 item 10). Pace so far: 16 trades in 2 sessions (about 8 per session), so the floor falls around 2026-11-24 to 11-26 (Thanksgiving week may shift it).

## What this run can and cannot show (computed 2026-11-01 from the live record)
Per-trade model P&L so far: mean -28.41, standard deviation about 116 (N=16, 14 stop-outs). At N=150 the standard error is about 9.5, so a 95 percent interval is roughly +/-19 per trade before any day-clustering widening. The research expectation is +1.93 per trade (research CI -3.44..+7.62). To confirm an edge of that size one would need on the order of (1.96 x 116 / 2)^2, about 13,000 trades. THEREFORE the forward sim run CANNOT validate this trade; its value is (a) operational: does the live pipeline reproduce the research rule and trade cleanly, and (b) a detector of gross failure or a large effect. The review is not a verdict on whether the tell has an edge.

## Primary (operational) checks, all must be reported
1. Live-vs-replay parity: every live AMT_TELL row since 2026-10-29 is re-derived by the research code on the stored session (`scripts/amt_tell_live/parity_day.py` style, split rule); report the share of live fires found in the replay (same bar, same direction, same stop) and the share of replay fires missing live, with causes (late start, outage, NO_TICK_FILE evenings, restarts). Target: no unexplained divergence.
2. Execution vs model: model P&L (`actual_pnl`, from the real entry fill per the resolver convention) against the broker result (`broker_pnl`) per trade; report the mean gap (slippage, stop fills, flatten fills) and any row where the stop was not honoured at its level.
3. Safety record: count of self-pauses, reconciliation misfires, rows stuck open past the simulated close, rows resolved without a fill, duplicate entries, account-label mismatches (`ACCOUNT_LABEL_MISMATCH`), and kill-switch events. Any unexplained item is a finding.
4. Coverage: sessions with the sidecar and the orders service up for the whole window versus total RTH sessions (the evening NO_TICK_FILE fix, commit c23a306, is checked here).

## Secondary (P&L) read, descriptive with intervals
Per-trade mean with a day-blocked bootstrap CI; stop-out share against the research 66-70 percent; the 120-minute and tell-fade exit shares; per-direction results; long-versus-short on trend days (the 2026-10-30 pattern, 8 longs into a 400-point decline); stop distance bands; compare the live distribution with the research V1 explore distribution (a distribution check, not a mean test).

## Decision rule (data-derived, no fixed dollar thresholds)
At N >= 150 with the day-blocked 95 percent CI of the per-trade mean:
- CI entirely below zero (upper bound < 0): PAUSE Stage 2 and review the rule (the live record is inconsistent with the research expectation); the user decides.
- CI entirely above zero (lower bound > 0): report as a lead for a larger look, not as validation; the user decides any next stage; nothing goes to real money on this alone.
- CI spans zero (the expected case): CONTINUE unchanged to N = 300 and repeat; the review's main output is the operational findings above.
Independent of P&L: any unexplained operational finding (checks 1-4) pauses further evidence counting until explained. A rule, book, window or stop change by anyone restarts the count (a new written decision).

## Not part of the review
Improvements to the rule (far-edge filter, with-trend context, flip or absorption cues) are researched separately on explore data and only adopted by a new written decision. The 2026-11-01 explore work found the tell is an expansion detector with a coin-flip side and no direction or exit variant that improves the average (claims listed in `docs/SCOPE_HARD_TODOS_20261101.md`), so there is no pending change to Stage 2.
