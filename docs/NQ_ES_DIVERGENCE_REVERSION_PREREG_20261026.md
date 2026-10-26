# Pre-registration: trading the NQ-ES divergence (one of the two catches up) — 2026-10-26

Written BEFORE running anything. Origin: user, 2026-10-26: "Can we trade a divergent reversion to the mean where one of the assets catches up to the other?" and "What do you think of playing the divergence?" My stated prior: low (no 1-minute lead-lag, ES at a level touch earlier showed NQ's stretch tended to persist, the edge is a few points against 1 point of commission plus slippage on one micro contract). This is a market-behaviour question, so it goes through raw 1-minute bars first (CLAUDE.md). Related: `es_corroboration_*` claims (approach divergence at level touches, exploratory dollar lead that NQ stretched beyond ES did worse for fades), NQ-vs-ES 1-minute return correlation 0.916 at lag 0 and about +/-0.017 at lag +/-1 (`docs/SIERRA_CHART_NOTES.md`).

## Data (frozen)
NQ 1-minute `price_bars_primary` (`symbol='NQ'`) and ES 1-minute `price_bars_es_front` (front contract by `es_front_calendar`), aligned on the minute, 2023-03-06 to the last complete date (printed, reused). Excluded and counted: NQ roll weeks and the 2025-09-28..2025-11-19 sparse window; ES days with `rth_minutes < 371` (thin back-month); any minute where either bar is missing. Sessions: RTH 09:30-15:59 and Globex (18:00-09:29), reported separately; the 16:00-18:00 dead zone excluded.

## Divergence (no lookahead; every scale derived from prior data)
For lookback L minutes: `d_t(L) = r_NQ(t-L, t) - beta * r_ES(t-L, t)` with log returns and `beta` = the OLS slope of NQ on ES 1-minute log returns over the 20 trade days BEFORE the current day (so beta uses no information from the current day). `z_t = d_t / s`, where `s` is the standard deviation of `d(L)` over the same 20 prior days within the same session type. An EVENT is the first minute where `|z| >= c`, where `c` is the 95th percentile of `|z|` over those same prior 20 days and session type (so the cutoff is data-derived, never a fixed number), with a 30-minute refractory period per direction. Direction of the convergence trade: `z > 0` means NQ is rich versus ES, so SHORT NQ; `z < 0` means NQ is cheap, so LONG NQ. A 1-contract MNQ trade at the open of the minute after the event, held for H minutes, exit at the close of the bar H-1 minutes after entry.

## Outcomes
Net result in NQ points per trade = direction x (exit - entry) minus costs: commission 1.0 point ($2 round trip at $2 per point, `LIVE_INSTRUMENT.commissionPerRoundTrip`) plus slippage of 0.25 point per side (one tick), i.e. 1.5 points total. Also reported: gross points, and the decomposition of the convergence into **who catches up**: the NQ part `-sign(z) x r_NQ(forward)` and the ES part `+sign(z) x beta x r_ES(forward)`, both in NQ points, summing to the change in the divergence. Per-trade mean = sum/N (never day-weighted).

## Primary tests (two, one per session) and the grid
Primary = **L = 15, c = p95, H = 10 minutes**, once for RTH and once for Globex: net mean points per trade with a day-blocked bootstrap CI at 98.75 percent coverage-adjusted percentiles (Bonferroni for two), explore (earlier 60 percent of dates) and hold-out (later 40 percent) both positive, and the real net mean above the 97.5th percentile of a **200-trial random-direction placebo** on the same events and the same costs. Robustness grid (printed, not gating, no multiplicity claim): L in {5, 15, 30, 60}, c in {p95, p99}, H in {1, 3, 5, 10, 15, 30, 60}. A real effect must show the same sign across neighbouring L and H (the plateau rule), else it is read as a lone cell.

## Wording
SHOWN only if both session primaries or one with the other not contradicting, all conditions above hold, and the net mean is positive after costs. Otherwise NOT SHOWN, stated with the smallest detectable effect (CI half-width) and, from the decomposition, which leg moved. A gross-positive, net-negative result is reported as such (costs eat it). Nothing here changes live behaviour; a SHOWN licenses a forward test on the nightly ES refresh and a real fill study, never wiring.

## Limits stated in advance
Bar-close alignment of two instruments can create apparent divergence from non-synchronous sampling noise that disappears within a minute or two and cannot be traded at a one-minute-delayed fill; the placebo and the H = 1-3 minute cells expose that. NQ-ES relative moves are partly genuine sector rotation (tech versus broad market) that trends instead of reverting. The edge, if any, is likely a few points; ES and NQ are arbitraged by faster participants than this system. A one-leg MNQ trade is directional market risk, not a hedged spread (MES is not part of this test).

## Records
`recordClaim()` for each primary (positive or negative); `flagDecision()` only for a real fork.
