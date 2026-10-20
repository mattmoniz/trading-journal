# Pre-registration: "breaks the overnight / IB high or low and HOLDS" breakout test (written 2026-10-20 BEFORE any outcome)

Origin: user 2026-10-20: "if price breaks overnight high or overnight low and holds then the market is breaking out; also test IB high and IB low when broken and held." Market-behavior hypothesis, so it goes through raw bar history first (CLAUDE.md), not through setups. The standing rule is that a new signal be evaluated for both RTH and Globex, so each RTH arm has a Globex analogue.

## Arms (each judged on its own)
- RTH-1 ONH/ONL: levels ONH and ONL of trade date d (`level_prices`; overnight high/low 18:00 prior..09:29, known at 09:30); breaks counted from the first RTH bar 09:30 to 15:29.
- RTH-2 IB: IB_HIGH / IB_LOW of trade date d (`level_prices`; first 60 RTH minutes 09:30-10:29, known from 10:30); breaks counted from 10:30 to 15:29.
- GLOBEX-1 PD high/low: PD_HIGH / PD_LOW of trade date d (prior RTH session range, known at 18:00 prior evening); breaks counted 18:00 prior evening to 09:29 of d.
- GLOBEX-2 Globex-IB: high/low of the first 60 minutes of the Globex session (18:00-18:59 prior evening), known from 19:00; breaks counted 19:00 to 09:29.

## Definitions
- BREAK (up): the first 1-minute close above the level at bar b0 (down: below), after the counting start; one event per level per day (an up-break of the high and a down-break of the low are separate events).
- HOLD: every 1-minute close from b0 through b0 + 15 bars stays beyond the level (no close back on the inside). H = 15 minutes (30 minutes is sensitivity only). A confirmed hold is the EVENT at bar b0 + 15; entry = the open of the next bar. If a close back inside happens first, the break is a FAILED break (descriptive population only).
- Outcome: signed (in the break direction) close-to-close move from the entry bar open to the close at +30, +60, +120, +240 minutes and to the session end (15:59 for RTH arms, 09:29 for Globex arms), in units of ATR20 (mean RTH range of the previous 20 sessions); horizons that run past the session end are dropped.
- Placebo 1 (shifted levels): repeat the identical procedure with each level shifted by -0.6, -0.3, +0.3, +0.6 x ATR20 (same counting window, same hold rule), pool them. A real breakout effect must beat the shifted-level held-break average (it absorbs drift and the generic effect of any held price break).
- Placebo 2 (sign flip): random sign flips of the signed moves among held events (2000), one-sided p for the observed mean.
- Descriptive: failed breaks (signed in the original break direction); held-break counts per arm, per year, per level (high vs low).

## Pass criteria (an arm "shows a breakout effect" only if ALL hold; judged per arm)
1. N held events >= 60 on >= 40 distinct days.
2. Mean signed move at +60 and at +120 > 0 with the day-blocked 95% CI excluding zero, and the real-minus-shifted-placebo difference at +60 and +120 > 0 with its CI excluding zero.
3. Same sign in PRE (< 2025-06-01) and POST at +60 and +120.
4. Sign-flip permutation p <= 0.05 at +60.
5. Not carried by a few days: top-5 days' share of the summed signed move < 50 percent of a positive total.
If an RTH arm passes and its Globex analogue does not (or vice versa) the conclusion is "session-specific", not "a breakout rule". If any arm passes, the SEPARATE follow-up (not part of this test) is whether a held-breakout state gates POC joins; if none passes, the idea is closed for these levels and this definition of hold.
