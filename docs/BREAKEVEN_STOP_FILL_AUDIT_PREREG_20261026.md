# Breakeven-stop realistic-fill audit — pre-registration (2026-10-25, run 2026-10-26)

Part of the exit audit (user 2026-10-25: "do the exit audit"). Not a new exit variant: an audit of a mechanism that is already live (`breakeven_stop_live`, `server/services/breakevenStopWalker.js`) and of the claim that justified it (`RESEARCH_CLAIM orderflow_rewarded_breakeven_stop_positive_20260916`, +$7,325 vs doing nothing on N=416). The 2026-10-20 / CLAUDE.md "arm-a-stop" convention says every mechanism that moves a stop at a time or on a rule must be replayed with the market-fill rule, and that audit of the other arm-a-stop mechanisms is still open.

## What looks wrong (read from the code before any run)
`stepBreakevenStop()` decides REWARDED on a bar's final order flow, sets `breakevenStop = entry` on that same bar (`armedAtTs = bar.ts`), then applies the stop check to that same bar (`bar.low <= entry` for a long) and books `priceAtRes = entry` (-$2 after commission). Two problems:
1. **Same-bar lookahead.** The bar's order flow is only known at its close, so a stop touch inside that bar uses information that was not available when the stop would have been placed.
2. **Fill price.** A trade under adverse order-flow pressure is often already beyond entry at the moment the stop snaps to entry; a real stop there fills at market, not at entry.
Live evidence: the 17 `BE_STOP_HIT` rows since 2026-09-21 average exactly -$2.00, and the sample rows resolve on the arming bar or within minutes.

## Population
Armed trades only (`breakeven_stop_shadow` or `breakeven_stop_live` classification REWARDED with an `armed_at`): 427 shadow-period (2026-07-09..09-21) + 18 live (09-25..10-21) before filters. Filters: primary rows, `origin_status IN (ACTIVE,SHADOW)`, `actual_pnl` not null, not NOT_FILLED, no `*_basis` flags, not fired 16:00-18:00 ET, not `POC_ROTATION_JOIN%`, trade_date outside NQ roll weeks (`isInsideNqRollWeek`). Bars: `price_bars_primary`, `symbol='NQ'`, strictly after `fired_at`'s minute, upper bound `expires_at`.

## Arms (same rows, same bars, same simulator)
- **PLAIN** — replay of the row's own stop and `t1_level`, no breakeven mechanism. Stop fills at the stop price, or at the bar open if the bar opens beyond it; target fills at `t1`. Stop first on a same-bar conflict. Mark-to-market at the last bar before `expires_at` if neither hits.
- **BOOKED** — what the mechanism recorded (shadow `hypothetical_pnl`, live `actual_pnl`). Reported, not used as a baseline.
- **REALISTIC_BE** — identical to PLAIN until the arming bar. On the arming bar only the ORIGINAL stop/target apply. The breakeven stop (= entry) becomes effective from the NEXT bar. If the arming bar's close is already beyond entry (underwater), exit at the next bar's open (market); otherwise walk forward with stop fills at `min(entry, open)` (long) / `max(entry, open)` (short) and target at `t1`.
- Sensitivity **REALISTIC_BE_CLOSE** — same but the underwater exit happens at the arming bar's close.

P&L = (exit − entry) × direction × $2/pt − $2 commission (`LIVE_INSTRUMENT`).

## Checks and rule (frozen)
1. **Baseline parity:** PLAIN replay vs the stored plain outcome (shadow `real_pnl` where no wider-target/trail/extend mechanism was active; live `counterfactual_pnl`); report the share within $1 and the median absolute gap. A large mismatch is reported and the parity-clean subset is used as a second view.
2. **Headline:** mean per trade (sum/N, not day-weighted) of REALISTIC_BE − PLAIN over all armed rows, day-blocked bootstrap 95% CI (resample days, pooled trades). Also BOOKED − PLAIN to show what the original claim implied.
3. **Splits (a pooled verdict is a question):** shadow vs live; RTH vs Globex; underwater-at-arm-bar vs in-profit-at-arm-bar; by setup family if N >= 20.
4. **Verdict:** HELPS if the headline CI lower bound > 0 and both chronological halves are positive. HURTS if the CI upper bound < 0 and both halves are negative. Otherwise NOT SHOWN (state what could not be shown). Top-5-day share and `computeRigor().clustered` are reported.
5. **Placebo for geometry:** the BE stop at entry changes the stop distance on a trade that has not moved; run the same REALISTIC_BE simulation after randomizing which trades count as "armed" (draw the same number of rows at random bars from non-armed trades with a matched time-in-trade) and report whether the real armed set differs from the random draws.

## What happens with the result
Nothing live changes from this audit. A HURTS or NOT SHOWN on the live mechanism is flagged as an `OPEN_DECISION` for the user (disable, fix the walker to arm for the next bar with market fills, or leave). The same replay shape is then applied to the other arm-a-stop mechanisms (step-trail, T1-floor runner) as separate pre-registered steps.
