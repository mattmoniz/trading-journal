# OPUS STRATEGIC AUDIT (AUDIT #13): is the "one futures contract per calendar day" data model worth rebuilding?

You are being asked for a strategic architecture verdict, not a bug fix — the bug is already fixed. Give a real answer (rebuild / don't rebuild / rebuild-but-later-because-X), not both-sides-ism, and if you recommend rebuilding, give a concrete build plan specific enough that another engineer could execute it, not just "consider a per-bar model." You do not have access to the live codebase or database for this audit — everything you need to reason about is inlined below. Do not assume anything beyond what's given; flag explicitly if you'd want to verify something you can't check from this prompt alone.

## The system, briefly

A trading-journal app trades MNQ futures (Micro E-mini Nasdaq), fed by 1-minute price bars ingested from Sierra Chart export files into a Postgres table `price_bars`. NQ futures trade under a new contract symbol every quarter (e.g. `NQU26` for September, `NQZ26` for December) — the underlying instrument "rolls" from one contract to the next roughly every 3 months, and during the transition both the expiring and the new contract trade simultaneously for a period.

## The current data model

```sql
-- Raw ingested bars. PK (contract, ts) -- both old and new contracts' bars for the
-- same timestamp are kept side by side, nothing is discarded here.
CREATE TABLE price_bars (
  id, symbol, contract, ts timestamp without time zone,
  open, high, low, close, volume, num_trades, bid_volume, ask_volume
);

-- One row per (symbol, trade_date) -- PK (symbol, trade_date). This table's whole job
-- is to answer "which single contract is the real one for this date."
CREATE TABLE price_bars_contract_calendar (
  symbol, trade_date, contract, bar_count
);

-- The historical half (frozen, refreshed nightly by a system cron): only ever includes
-- days strictly before today, INNER JOINs against the calendar above (on symbol+date+
-- contract) so a date's bars are INVISIBLE unless they match the calendar's chosen contract.
CREATE MATERIALIZED VIEW price_bars_dedup_hist AS
 SELECT symbol, contract, date_trunc('minute', ts) as ts,
   (array_agg(open ORDER BY ts))[1] as open, max(high) as high, min(low) as low,
   (array_agg(close ORDER BY ts DESC))[1] as close, sum(volume) as volume, ...
 FROM price_bars pb JOIN price_bars_contract_calendar cc
   ON cc.symbol=pb.symbol AND cc.trade_date=pb.ts::date AND cc.contract=pb.contract
 WHERE pb.ts::date < CURRENT_DATE
 GROUP BY symbol, contract, date_trunc('minute', ts);

-- The "live" half -- same INNER JOIN against the same calendar, for today's still-forming
-- data (anything after the matview's own latest timestamp).
CREATE VIEW price_bars_primary AS
 SELECT * FROM price_bars_dedup_hist
 UNION ALL
 SELECT symbol, contract, date_trunc('minute', ts) as ts, ... (same aggregation)
 FROM price_bars pb JOIN price_bars_contract_calendar cc ON (same join condition)
 WHERE pb.ts > (SELECT COALESCE(MAX(ts), '1970-01-01') FROM price_bars_dedup_hist)
 GROUP BY symbol, contract, date_trunc('minute', ts);
```

**Every live trading decision in the app** — "what is the current price," every level/indicator computation — reads from `price_bars_primary`, which means it only ever sees whichever ONE contract `price_bars_contract_calendar` has decided is "the" contract for a given date. If the calendar picks the wrong contract for a date, that date's real price data doesn't get mislabeled — it **disappears entirely** from every query, because the calendar is used as a JOIN filter, not a display label.

`price_bars_contract_calendar` itself is maintained by this upsert, run every ~60 seconds whenever a new bar-data file is ingested:

```sql
INSERT INTO price_bars_contract_calendar (symbol, trade_date, contract, bar_count)
SELECT symbol, trade_date, contract, bar_count FROM (
  SELECT symbol, ts::date AS trade_date, contract, COUNT(*) AS bar_count,
    ROW_NUMBER() OVER (PARTITION BY symbol, ts::date ORDER BY COUNT(*) DESC, contract ASC) AS rn
  FROM price_bars
  WHERE symbol = $1 AND ts::date >= $2::date AND ts::date <= $3::date  -- the just-ingested
  GROUP BY symbol, ts::date, contract                                  -- file's own date range
) ranked WHERE rn = 1
ON CONFLICT (symbol, trade_date) DO UPDATE
  SET contract = EXCLUDED.contract, bar_count = EXCLUDED.bar_count
  WHERE price_bars_contract_calendar.contract IS DISTINCT FROM EXCLUDED.contract
     OR price_bars_contract_calendar.bar_count IS DISTINCT FROM EXCLUDED.bar_count
```

In plain terms: for each date, count how many bars each contract has (across ALL of `price_bars`, not just the file that triggered this re-scan), and declare whichever contract has more bars "the" contract for that date.

## What just happened (already fixed, don't re-solve this part)

During the real September 2026 quarterly roll, both `NQU26` and `NQZ26` had genuine bars on the same dates for **at least 12 days** (confirmed: dual-contract data existed from `2026-08-27` onward, well before the roll "should" start by any calendar-based estimate). At some point during that overlap, `price_bars_contract_calendar` picked `NQU26` for a date when `NQZ26` was about to become — or already was — the true dominant contract, and an earlier, now-removed version of the upsert had a bug (`WHERE new_bar_count > existing_bar_count`, a "must strictly increase" guard) that could freeze the calendar on the wrong contract and never let it self-correct. Because the calendar is a join filter, this made the live "get current price" query silently fall back to a stale price from days earlier — which caused several real trades to fire against a fictitious entry price, including two real stop-losses.

The immediate fix (already shipped, working, verified): removed the "must strictly increase" guard (the count-based re-rank is already correct and self-converges once it isn't blocked from moving), and added a deterministic tie-break. This is the query shown above — it is already fixed and confirmed working. **Do not re-diagnose or re-fix this specific bug.** Also already shipped: every place that reads "the current price" now refuses to return a bar older than 15 minutes rather than silently using a stale one.

## The actual question for you

The fix above patches the *symptom* (the calendar could get stuck wrong). It does not change the underlying *model*: still exactly one contract per calendar day, decided by majority bar count, used as a hard filter that makes the losing contract's data invisible for that day.

This model is fundamentally strained during every roll (4x/year, and empirically the real overlap window is wider — 12+ days — than any calendar heuristic would predict), because there genuinely isn't one right answer for "which contract owns this day" during an overlap — both are real, both are trading, and picking one necessarily discards real data.

**A structurally different model exists**: instead of picking one contract per whole day, pick the dominant contract **per bar** (or per minute) — i.e., for each individual 1-minute timestamp, independently decide which contract's bar to use, rather than deciding once for the whole day. This would make the current bug class structurally impossible (there's no "day" arbitration to get wrong), at the cost of:
- A different dedup key/shape for the historical materialized view (per-bar decisions instead of one calendar row per day) — bigger migration, needs backfilling the full history.
- The materialized view was originally built BECAUSE a naive unbounded per-bar aggregation over the full raw `price_bars` history was too slow for live queries — a per-bar-decision model risks reintroducing that exact performance problem unless carefully re-designed (e.g. a differently-shaped precomputed table rather than a live per-query aggregation).
- Every consumer of `price_bars_primary` (which is nearly the entire live trading-decision codebase) would need to be re-verified against the new semantics, even though the view's own column shape wouldn't need to change.
- A real risk of silently changing which prices historical backtests were computed against, if the per-bar selection ever disagrees with the historical per-day selection for any already-analyzed date.

## What I want from you

1. **A real verdict**: given the actual cost/risk profile above, is rebuilding to a per-bar model worth it, worth it later, or not worth it at all (i.e., is "patch the day-level model correctly every time it breaks" actually the more sensible long-term strategy, given rolls are quarterly and rare)? Argue for your position, don't hedge.
2. **If you recommend rebuilding**: a concrete phased plan — what gets built first, how it gets validated against the existing day-level history before cutover (a real reconciliation check, not "spot check a few dates"), how the cutover itself happens without a live-trading blackout window, and a rollback plan if the new model produces a different answer than the old one for some date.
3. **If you recommend NOT rebuilding (or rebuilding later)**: what, if anything, should be hardened about the current day-level model in the meantime so the next roll (roughly 3 months from now) is a non-event rather than a repeat investigation? Be concrete — e.g. is there a cheap monitoring/alerting addition (something that would have caught this bug on day 1 of the overlap instead of during live trading) that's worth building regardless of the bigger architectural question?
4. **Anything about the framing above you think is wrong or missing** — this prompt was written by another Claude session working from a same-day live-incident investigation, not by a database architect; push back if the tradeoffs above are incomplete or if there's an option not considered (e.g. a middle-ground design neither "one contract per day" nor "one contract per bar").

Answer plainly. This is going straight to the user who owns this codebase, not through another review layer — be direct about your confidence level in each recommendation, and say explicitly if something here would need to be verified against the live database before acting on it.
