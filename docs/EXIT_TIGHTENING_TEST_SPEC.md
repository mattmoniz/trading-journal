# Exit tightening test: is a tighter stop or a target at a fraction of MFE better?

Status: scoped 2026-10-05, not started. Written for the engineer or analyst who runs it.

## Question

For each live setup type, would a tighter stop, or a target set at a fraction of its typical MFE,
have produced a better expected value than the current calibrated exit, on the real trades?

## Why it isn't just read off the existing stats

- MFE capture (`scripts/analyze_execution_efficiency.mjs`) is hindsight. Nobody can exit at the
  peak, so "left on the table" is not a benchmark.
- Setting a stop at winners' MAE cuts winners that dip past it and recover (survivorship).
  Only a bar-by-bar replay can show the net effect.

## Population

- Real trades only: `REAL_TRADE_FILTER` (`scripts/backtest_setup_status.mjs`), which already
  excludes BACKFILL, MTM, and the `bad_bars_basis` window rows.
- Cluster siblings: `is_cluster_primary` filter, one touch counted once.
- Exclude `late_fill_past_expiry_basis` and `stale_entry_price_basis` rows.

## Method

1. For each setup type with N >= 20 real trades (effective N, see the recency note below),
   replay each trade's real bars from fired_at with a candidate stop and target grid.
   Use the trade's own entry, not the touch price.
2. Compare EV per trade against the current `OPTIMAL_STOP` exit on the same trades.
3. Stop vs target: test them separately first, then together.
4. Gate on the day-clustered bootstrap CI (`dayBlockedBootstrapCI()`, `rigorDiagnostics.js`),
   collapsing cluster siblings first. A result counts only if the CI excludes zero.
5. Run a placebo: randomize trade direction, re-simulate the same structure, compare.
   A geometric edge from asymmetric stop and target distances shows up here.
6. Check chronologically: split by time, and confirm the sign holds in both halves.

## Recency note

If recency weighting is later tested (see the discussion of calibration weighting), the same
exit grid should be run under both schemes, not just the current one.

## Known data limits

- The Sep 28 to Nov 19 2025 window's rows are flagged (`bad_bars_basis`). Their MFE/MAE values
  rest on the contaminated NQH26 bars, so they must stay excluded.
- Rows before 2026-07-09 are `UNKNOWN` origin and stay out of any real-trade result.

## Pre-registered kill criteria

A tighter exit is only promoted if all of these hold:
- EV improves over the current exit by more than the placebo range.
- Day-clustered 95% CI on the improvement excludes zero.
- Sign holds in both chronological halves.
- Effective N >= 20 for the setup type.

Anything less is recorded as a RESEARCH_CLAIM and not wired live.
