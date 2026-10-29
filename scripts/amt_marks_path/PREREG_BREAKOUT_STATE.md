# Breakout state: acceptance beyond the overnight high/low, a push, and recent balance (frozen 2026-10-29 BEFORE any outcome)

User (2026-10-29): "in the event that it's building above overnight high or overnight low and pushing, we know it's going to break out, especially if it's been in balance recently." A market-behavior hypothesis, so it is tested on raw bars first (CLAUDE.md), not through setups. Prior evidence in this repo, stated honestly: day-level tests of "holds above the overnight high so the day continues" (ONH_HOLD_PLUS_DEFENDED_ZONE: strict ONH-HELD +0.038 ATR20, CI -0.12..+0.20), open vs the overnight range (BAR_CONTEXT Part A, nothing beyond +/-0.05 ATR), and the heavy-night range playbook (clean breaks rare) came back NOT SHOWN; none conditioned on a push and on recent balance together. EXPLORE only (sessions to 2025-05-16), RTH, 1-minute bars; the hold-out is untouched.

## Definitions (all causal; every cutoff a rolling quantile of prior sessions except the one structural convention stated)
- LEVELS: ONH / ONL = highest high / lowest low of the 18:00-09:29 bars (known at the open).
- ACCEPTANCE (structural convention, 30 minutes = one TPO; sensitivity 15 and 60): the first bar t_a at which the last A=30 one-minute CLOSES are all beyond the level (above ONH / below ONL). One event per direction per session.
- PUSH at t_a: the signed 30-bar move in the breakout direction, close[t_a] - close[t_a - 30], is at least the median of |30-bar move| at the same bar over the prior 20 sessions.
- RECENT BALANCE (known at the open): BAL_RATIO = mean RTH range of the last 5 sessions / mean RTH range of the last 60 sessions; BALANCED if its percentile among the prior up-to-250 sessions' ratios (at least 40) is in the lowest third. (Needs >= 60 prior sessions, so events start about 3 months in.)
- ENTRY reference = open of bar t_a + 1 (entry bar <= 345). Outcomes are MARKET BEHAVIOR, not a trade: signed move (breakout direction) from that open to the close at +60 and +120 bars and to the close of the session, in ATR20 units (ATR20 = mean RTH range of the prior 20 sessions); LARGE-CAPTURE = the maximum favourable excursion before the first close back inside the overnight range (a failure) or the session close is at least L = 50 points x ATR20 / median ATR20 (the dial: 0.5x and 2x reported); FAILURE = a close back inside the overnight range within 60 bars.

## Groups and controls
Cells: A&P&BAL (the counted cell), A&P&NOT-BAL, A&NO-PUSH (accepted but not pushing). SHIFTED-LEVEL PLACEBO: the identical procedure with each level shifted by -0.6, -0.3, +0.3, +0.6 x ATR20 (same acceptance and push rules), pooled; it absorbs drift and the generic effect of any held break. Up and down reported separately (pooled for the counted cell).

## Counted test (the one cell A&P&BAL; everything else descriptive)
A breakout-state effect is shown only if ALL hold: (1) N >= 60 events on >= 40 distinct days; (2) the +120-bar signed move minus the shifted-level placebo's mean is > 0 with the day-blocked 95 percent CI excluding zero; (3) A&P&BAL minus A&P&NOT-BAL at +120 is > 0 with the CI excluding zero (recent balance adds something); (4) the same sign in PRE (< 2025-01-01) and POST for (2); (5) top-5 days' share of the summed move < 50 percent of a positive total. A null states the CI half-width and what could not be shown; Globex is untested.

## Not in this stage
Trades, stops, targets; the spike and absorption marks as a context for this state (a later step if the state shows anything); Globex.
