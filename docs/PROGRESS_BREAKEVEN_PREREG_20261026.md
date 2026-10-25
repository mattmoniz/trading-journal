# Progress-triggered breakeven — pre-registration (2026-10-25, run 2026-10-26)

Question (user: winners given back, wants larger gains; exit audit open item b): on ordinary stop-and-target trades, does moving the stop to breakeven once the trade has gone a set share of the way to target beat leaving the stop alone, **with realistic fills**? 30.5% of plain stop-outs reached at least half of the way to target before losing (~$70k of the ~$230k loss total since 07-09), so this is the most direct test of the intuition. Related, already negative: the order-flow-triggered breakeven stop (disabled 2026-10-25), tightening grid (`exit_tightening_plain_trades_null_20261005`), slow-deep early exit. Unlike the order-flow trigger, the market is IN PROFIT at arming here (price is at least X of the way to target), so the underwater-at-arm artifact does not apply; the same-bar information rule and gap fills still do.

## Population
Primary rows, `origin_status IN (ACTIVE,SHADOW)`, `trade_date >= 2026-07-09`, plain stop/target path only (`wider_target_mult`, `runner_trail_width`, `extend_target_level` all null), `stop_level`, `t1_level`, `expires_at` present, not `POC_ROTATION_JOIN%`, not NOT_FILLED, no `*_basis` flags, not fired 16:00-18:00 ET, outside NQ roll weeks. Entry = `entry_zone_high ?? entry_zone_low`; direction `resolveDirection()`. Bars: `price_bars_primary`, `symbol='NQ'`, `ts > fired_at`, `ts <= expires_at`. Setup types whose stop and target are independent structural levels (`usesLevelAnchoredExit()`, 12 types) are reported separately (progress-to-target means little when entry sits next to the target).

## Arms (same rows, same bars, one simulator)
- **PLAIN**: stop fills at `min(stop, open)` (long) / `max(stop, open)` (short), target at `t1`, stop first on a same-bar conflict, mark-to-market at the last bar before `expires_at`.
- **BE_X** for X in {0.50, 0.75, 0.90} (share of the entry-to-target distance; scale-free, not tuned, all three reported): the first bar whose favorable extreme reaches `entry ± X × dist` arms the stop at entry. On the arming bar only the ORIGINAL stop/target apply. The breakeven stop is effective from the NEXT bar; if the arming bar closes beyond entry, exit at the next open; otherwise a stop hit fills at `min(entry, open)` / `max(entry, open)`, target at `t1`.
Cost and P&L as the other audits (`LIVE_INSTRUMENT`: $2/pt, $2 round trip).

## Checks and rule (frozen)
1. **Baseline parity:** PLAIN replay vs stored `actual_pnl` for rows that resolved `PRICE_CLEAN`/`SAME_BAR_STOP_FIRST` (share within $1, median gap).
2. **Headline per X:** mean per trade (sum/N) of `BE_X − PLAIN`, day-blocked bootstrap 95% CI, chronological halves, RTH vs Globex, level-anchored vs calibrated types. Tail breakdown per X: trades saved from a stop-out (count, $), winners scratched (count, $), net.
3. **Placebo (geometry):** the same simulation with each trade's direction randomly flipped (stop and target mirrored about entry), 10 independent draws with fixed seeds; report real delta vs the placebo distribution.
4. **Verdict per X:** HELPS only if the CI lower bound > 0, both halves > 0, and the real delta exceeds the largest of the 10 placebo draws. HURTS if the CI upper bound < 0 and both halves < 0. Otherwise NOT SHOWN. Three values of X are tested, so a lone HELPS is a 1-of-3 result that needs forward replication (new days only, scoreboard-style) before any live change.
5. **Pooled verdict is a question:** the by-family split (level-anchored vs calibrated) and by-setup-type (N >= 20) tables are part of the output; opposite-signed subgroups are reported even if pooled is flat.

## What happens with the result
Nothing live changes. A HELPS (or a subgroup HELPS) opens an `OPEN_DECISION` proposing a SHADOW-only forward track with realistic booking first; a HURTS or NOT SHOWN is recorded as a `RESEARCH_CLAIM` that closes this idea family (a stop-snap on the plain path) for the roster, with what could not be shown stated.
