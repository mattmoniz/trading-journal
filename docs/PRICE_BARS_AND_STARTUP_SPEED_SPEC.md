# Price-bar read speed + restart/recurring lookup cost — scoping spec (2026-10-19, DESIGN ONLY, nothing built)

Status: for independent design review (DeepSeek, per the higher-stakes-work rule) BEFORE any code. Related: `OPEN_DECISION contract_calendar_failsoft_join_20260915` (the prepared `price_bars_dedup_hist_v2` cutover), `docs/KNOWN_ISSUES.md`.

## Why now

The in-process query profiler (`GET /api/diag/query-profile`, local only), 18 min after the 2026-10-19 14:03 restart: DB busy = 339 s of 1,084 s wall (31%). The top shapes:

| rank | shape | calls | avg | total | nature |
|---|---|---|---|---|---|
| 1 | `SELECT AVG(range) … FROM price_bars_primary WHERE ts::date < $1 …` (`getRollingATR`, levelProximityService.js:54) | 173 (stopped growing after ~5 min) | 329 ms | 57 s | ONE-TIME warm-up per restart (cached 6 h, 280 pivot dates) |
| 2 | `SELECT d, rth_low, rth_high FROM (…MIN(low)…MAX(high)… ts::date)` (caseEngine.js:650, acd.js:1471) | 64 (was 16 at 5 min) | 490 ms (max 3.3 s) | 31 s | RECURRING (still growing) |
| 3 | `SELECT mod5, AVG(vol5m), STDDEV(vol5m)` (stallDefendedLevelDetector.js:152) | 45 (was 18) | 330 ms | 15 s | RECURRING |
| 4-6 | three `price_bars_primary` bar reads (`ts::text, close…`, `AVG(volume)…`, OHLC) | 64-128 | 100-190 ms | 12-13 s each | RECURRING |

Everything above reads `price_bars_primary`. `pg_stat_user_tables` (cumulative since stats reset): `price_bars_dedup_hist` (683,416 rows, 130 MB) has **501,715 sequential scans reading 178 billion rows**, vs 43,717 index scans — the largest read load in the database by two orders of magnitude.

## Part A — why every price_bars_primary read scans the whole historical store

`price_bars_primary` = `SELECT … FROM price_bars_dedup_hist` (matview, history before CURRENT_DATE) `UNION ALL` a live aggregate of `price_bars` (today) whose WHERE is
`pb.ts > (SELECT COALESCE(max(ts),'1970-01-01') FROM price_bars_dedup_hist)`.

`price_bars_dedup_hist` indexes: `UNIQUE (symbol, contract, ts)`, `(symbol, ts)`. **Every index leads with `symbol`**, so the planner cannot answer `max(ts)` (across all symbols) from an index — it sequentially scans all 683k rows, once per query that touches the view. Measured with EXPLAIN ANALYZE inside a rolled-back transaction (jit off):

| query | before | after `CREATE INDEX … ON price_bars_dedup_hist (ts)` |
|---|---|---|
| `SELECT max(ts) FROM price_bars_dedup_hist` | 23.7 ms, seq scan | **0.029 ms**, no seq scan |
| `price_bars_primary WHERE symbol='NQ' AND ts >= d AND ts < d+1` | 41.4 ms, 1 seq scan of hist | **14.5 ms, 0 seq scans** |
| same, written `ts::date = d` | 86.6 ms, 2 seq scans | 67.4 ms, 1 seq scan (the cast still blocks the index on the data scan) |

(Index was rolled back; production is unchanged. Idle-machine times; under the live load the profiler shows 100-490 ms per shape.)

### Proposal A
- **A1 (the fix with the best ratio):** one index `CREATE INDEX CONCURRENTLY`-style on `price_bars_dedup_hist (ts)` — cannot be CONCURRENTLY on a matview? (reviewer to confirm; plain `CREATE INDEX` takes a SHARE lock that blocks only the nightly REFRESH, not reads). Size est. ~15 MB. The nightly `REFRESH MATERIALIZED VIEW CONCURRENTLY` (scripts/refresh_price_bars_dedup_hist.mjs) keeps working (it needs the existing UNIQUE index, which stays) and maintains the new index. Same index needed on `price_bars_dedup_hist_v2` at its cutover (v2 has only `UNIQUE (symbol, ts)`; its live branch uses the same MAX(ts) pattern).
- **A2:** convert the hot-path callers from `ts::date = X` / `ts::date < X` to half-open raw-column ranges (`ts >= X AND ts < X+1`). 431 `ts::date` occurrences across ~20 server files; only the callers visible in the profile (ranks 1-6, ~10 sites) are in scope — NOT a blanket rewrite. The `symbol,ts` index then serves the data scan.
- **A3:** NOT proposed: restructuring the view or cutting over v2 for speed reasons. A1 removes the dominant cost without touching view semantics (contract-ranking correctness is what the v2 cutover is about; keep it a separate decision).
- Rollback: `DROP INDEX`. Verification: `scripts/explain_check.mjs` on the 6 shapes before/after; the post-deploy watch (`perf_expect.mjs db_time_pct down`, `detect_avg_ms down`) gives the live before/after.

## Part B — restart warm-up and recurring per-pass lookups

B-fact 1: `getRollingATR(d)` (strictly-prior-day value, cached 6 h in `lib/cache.js`, process memory) is called once per unique pivot date by 3 detectors + pivotConfluenceAnalysis: ~173-280 dates × ~330 ms = **~57 s of DB time after every restart**, repeated every 6 h when the TTL lapses, and lost on each restart. The value for a given date can never change once that date has passed.
B-fact 2: ranks 2-3 are recurring (growing counts), probably keyed by something that changes (date + minute-of-day / per-poll), not day-stable; not yet traced to their cache keys.

### Proposal B
- **B1 (persist, don't recompute):** a table `daily_rth_stats(trade_date PK, rth_high, rth_low, rth_range, n_bars)` — one row per completed RTH session (570-959 ET minute-of-day, same window as today's queries), filled nightly in `run_daily_calibration.sh` right after `refresh_price_bars_dedup_hist.mjs`, plus an idempotent one-time backfill (~1.5 years). `getRollingATR(d)` becomes: the 20 most recent rows with `trade_date < d AND trade_date >= d - 90 days`, requiring n = 20 exactly as today (same semantics, one indexed read of 20 rows). The prior-day RTH range / rth_low-rth_high lookups (ranks 2, `getPriorDayRthRange`) read the same table. Falls back to the current view query ONLY when a needed date is missing from the table (fail-soft; never returns null/stale silently — the repo's standing `getCached` null-vs-miss lesson) and logs that it did.
- Persisted somewhere queryable ✔ (the table); recheck path ✔ (nightly refresh + `test_invariants.mjs` check comparing the table against a fresh view computation over the last 60 days); consumer ✔ (the three lookups above); discoverable ✔ (ARCHITECTURE.md). Nothing new in `acd.js`.
- **B2 (alternative, smaller):** at boot, one batched query computing daily RTH ranges for the last ~400 days, then ATR for all 280 dates in JS, filling the existing cache. No new table; still ~1 query (~300 ms) instead of 173; still recomputed every restart and every 6 h.
- **B3:** trace the cache keys of ranks 2-3 (and 4-6) before deciding anything: if a key includes a per-poll value, the lookup is recomputed needlessly and should be keyed by date or moved to B1's table.

## Open questions for the reviewer
1. Is A1 (a plain `ts` index on the matview) safe with `REFRESH MATERIALIZED VIEW CONCURRENTLY`, and is `CREATE INDEX` on the matview during market hours acceptable (lock behaviour, duration for 683k rows), or must it wait for the weekend?
2. Does the `max(ts)` subquery have any semantic role that an index-only lookup could change (e.g. the planner now choosing a different plan for the live branch, or dual-contract overlap days)?
3. A2: is converting only the profiled callers right, or is there a reason to prefer fixing it in one shared helper? Any way a `ts >= d AND ts < d+1` range differs from `ts::date = d` for this table's `timestamp without time zone` ET-digit convention (DST edges, the 5-6PM gap)?
4. B1 vs B2: is a persisted `daily_rth_stats` over-engineering for a value derivable in one query? Failure modes of B1 (stale row, partial day written, the quarterly contract-roll weeks where `price_bars_primary` has known degraded days — KNOWN_ISSUES 16/17)?
5. Anything in B-fact 2 or the table in "Why now" that suggests a different dominant cause than the one assumed here?
6. Test plan: what would you require before enabling each of A1, A2, B1, and how should rollback be ordered?
