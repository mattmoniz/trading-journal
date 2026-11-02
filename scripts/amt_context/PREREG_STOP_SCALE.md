# Pre-registration: does widening the tell's stop when the forecast says "busy" improve the tell trades? (written 2026-11-02 BEFORE any simulated dollar was read; user: "Yes try it, i tasked you. Please proceed")

Origin: `PREREG_TELL_TARGET.md` result (claim `tell_target_forecast_scales_both_sides_20261102`): favorable and adverse 30-minute travel scale together with the forecast (reward-to-risk about 1.0 in every regime), and the descriptive V1 net by forecast third was +7.16 / +8.44 / -2.48 (uncounted, no interval). Hypothesis to test: the V1 stop is structural (an LVN behind the node ladder) and does not scale with how busy the market is, so in busy conditions it is hit by ordinary travel. A TARGET stretched alone is NOT supported by T2 and is not tested here. Explore only (<= 2025-05-16); sealed window not read; Stage 2 not touched; simulated dollars from the research V1 simulation, never a live claim.

## Design (frozen)
- Trades: the same 1,379 evaluated V1 tell trades of the tell-target test (walk-forward no-tell forecast `notell2` at the signal bar, blocks of 20 dates, first 120 dates train-only). Entries are identical in both arms; only the stop differs.
- Reuse of the real code: every arm is `trade.run_position(ctx, prof, ei, d, stop, 'V1', end[ei-1])`, the function the simulation and the live sidecar replay use, with a different `stop` price. Harness check BEFORE any arm: re-running every trade with its own stop must reproduce `net` exactly; otherwise the run stops.
- Scale factor: s = exp(forecast_log - mean log E_30 of the training dates before the block) (about 1 when the forecast is typical). ARM W (the one counted arm, widen-only): stop distance = original risk x clip(s, 1, 2); the stop is never tighter than the structural stop. For a lookup-only placebo, s is quantized to steps of 0.1 for the arm and the placebo alike.
- Costs and fills are those of the research simulation: 1-tick slippage on entry and stop fills, $2 round trip per MNQ contract, gap-through stops fill at the open.
- Pairing: each trade is evaluated independently, arm minus baseline. Longer holds could block later entries in a live one-position-at-a-time system; the number of trades whose arm exit falls after the next baseline entry on the same date is reported as a caveat.

## Hypothesis and pass rule (one counted test)
H_S: mean(net_arm - net_base) per trade is above zero. PASS requires ALL of: (i) day-blocked 95% CI (3000 resamples, seed 20261102) lower bound above 0; (ii) beats a SHUFFLED-SCALE PLACEBO (the same set of scale factors reassigned at random among trades within each chronological half, 1000 draws): p(placebo mean >= arm mean) below 0.05, which separates "the forecast carries information" from "wider stops pay on this sample"; (iii) the paired difference is positive in both chronological halves. A pass is a hypothesis for the forward tags and a pre-registered live-shadow comparison, never a dollar claim.

## Reported, uncounted
Symmetric arm (scale clipped to [0.5, 2], tighter in quiet conditions too), same machinery; baseline and arm mean net by forecast third; stop-out share (reasons STOP and STOP_GAP) baseline vs arm; mean risk in points; overlap count; trade count and dates. Ledger: one look, tests = 3.

## Reading rules (fixed now)
Fail -> the stop does not scale usefully with the forecast on these trades; recorded with the resolution (about half the CI width). Pass without the placebo -> "wider stops pay here, the forecast not shown to matter". Pass on all -> a live-shadow comparison on the forward tags is pre-registered next, and nothing changes in Stage 2 before its own review. No other scale rule, clip, horizon or target is tried after seeing a result.
