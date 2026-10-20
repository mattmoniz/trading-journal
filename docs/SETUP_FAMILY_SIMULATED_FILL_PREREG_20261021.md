# Pre-registration: which setup families are net drags, using simulated fills with an out-of-time check — 2026-10-21

Written and committed BEFORE the script is run. Origin: the 2026-10-20 ML work showed the roster itself averages about -4.5 dollars per trade if everything is taken, and the gate's value is mostly skipping trades. The user asked to look at the roster at the setup-family level, noting that not everything has real fills, and asked about simulated ("fake") fills.

## What "fills" the data really has (checked 2026-10-21 against the database, not assumed)
- `active_setups.actual_pnl` is ALWAYS a simulation: price bars walked forward from the signal against the recorded entry, stop and target (`resolveSetupsByPrice()`), never a broker fill. The ML work and this study use it the same way.
- Populations: BACKFILL 15,877 rows (2023-11-16 to 2026-07-28, historical simulation), SHADOW 8,537 and ACTIVE 1,509 (2026-07-09 on, detected live, resolved by the same bar walk), UNKNOWN 1,483 (pre-2026-07-09, unrecoverable provenance; not used).
- Real broker fills exist only for about 170 trades over 9 days (`broker_pnl`, since 2026-09-29). Against those, simulated P&L has mean -9.77 vs broker -13.69 per trade (gap -3.92), median gap +0.25, correlation 0.32.
- Entry slippage from the 175 real entry fills: LIMIT entries filled on average 4.34 points better than the recorded entry (median 1.75; no credit is taken for this); MARKET entries (price-triggered setups, `wantsMarketEntry()` in `orderSweep.js`) filled 3.79 points worse on average (median 3.63, N=48). The simulation ignores this market-order cost.

## Design
- **Populations:** B (simulated history) = BACKFILL rows with `trade_date` before 2026-07-09. L (live-detected, bar-walk) = ACTIVE and SHADOW rows from 2026-07-09 to the latest resolved. Both: `actual_pnl` not null, the house real-trade exclusions (no MARK_TO_MARKET/RECOVERY_MTM resolution, no stale-basis flags, no NOT_FILLED). B and L do not overlap in dates, so B can select and L can test.
- **Simulated-fill adjustment (primary):** for rows whose setup passes `wantsMarketEntry()`, subtract the median real market-entry adverse slippage (points, from the real ENTRY fills of those setups) x 2 dollars per point from each trade's P&L. Limit-entry rows get no adjustment (no credit for the favorable real fills). The unadjusted figures are printed alongside.
- **Unit:** one event per confluence-cluster touch (`collapseClusterSiblings()`: siblings of one `cluster_touch_id` averaged into one event; rows without a cluster id stand alone). Family = `setup_type` with a trailing `_LONG`/`_SHORT` and anything after removed.
- **Exclusions from the lists:** `POC_ROTATION_JOIN` (its exit was replaced 2026-10-11/12 and is reported separately; the standing confound-boundary rule). Families with fewer than 20 collapsed events or fewer than 20 distinct days in B are shown but not classified.
- **Selection (uses B only, frozen):** DRAG = adjusted mean < 0 and day-blocked 95 percent interval (`dayBlockedBootstrapCI()`) upper bound < 0. EDGE = adjusted mean > 0 and interval lower bound > 0. Everything else = UNDETERMINED.
- **Out-of-time tests on L (selection never sees L):**
  - T1 DRAG families in L: events, mean per trade, per-day total. CONFIRMED FORWARD if the L mean is < 0 and the day-blocked 95 percent interval upper bound < 0; otherwise NOT CONFIRMED (sign reported).
  - T2 EDGE families in L: same, CONFIRMED FORWARD if mean > 0 and interval lower bound > 0.
  - T3 Spearman rank correlation of B mean vs L mean over families with at least 20 events in both, with a permutation p-value (2000 shuffles of the L means).
  - T4 placebo for T1: the L total P&L of 2000 random sets of families of the same size drawn from the eligible families; report where the DRAG set's L total ranks (the L period is net negative, so removing almost any set can look like a gain).
  - Account-level effect of removing the DRAG families from L (primary rows only, `is_cluster_primary` true or null, one position per row as simulated): change in P&L per active day with a day-blocked interval.
- 4 tests, 95 percent intervals. Context columns (not used for selection): current latest `SETUP_STATUS` recommendation per setup_type (latest row per `signal_name`, ordered by `run_date DESC, id DESC`).

## Known limits (stated in advance)
Simulated, not broker, results; the simulation shares its weaknesses with the live bar walk. Backfill detection may differ from what the live poller fires (standing caveat; the VWAP_MAGNET backfill timestamp issue is known and its P&L fields are reported as correct). L is only about 3.5 months and its roster mix changed under PROMOTE_ALL_MODE and from the 2026-10-11/12 changes, so a family that is not confirmed forward is not shown to be fine. Market slippage is applied as one median to all market-entry families (their real N is small). Nothing is changed live by this study; any roster change is the user's decision.
