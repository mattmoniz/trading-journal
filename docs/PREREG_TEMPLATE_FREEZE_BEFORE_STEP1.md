# Pre-registration template: what must be FROZEN before ANY step-1 number is printed (adopted 2026-11-09 from Argon's follow-up; paste into every new prereg)

Why: on rows 28 to 31 two controls (Base 3, Base 4) were added after step 1 had been seen. They were declared and conservative, but they are forking paths. Everything below is written into the prereg BEFORE the first step-1 script runs; anything added afterwards is labelled "post-hoc, declared" and is never counted.

1. POPULATION AND EXCLUSIONS: the exact SQL or bar filter, the session hours per track, the data window, and the excluded design dates (sessions that shaped the idea: 2026-11-05, 11-06, 11-09 and any later ones).
2. CAUSAL FEATURE FORMULA: exact numerator, denominator, lookback window, expanding or rolling warm-up floor, and the point in time at which each input is known (hr-020).
3. FROZEN MATCHED CONTROL POOL: the matching keys, all of them, in advance (session-time bucket, bar-duration / pace tercile, signed prior-2-bar displacement tercile, 10-bar elapsed-duration tercile, date and hour), and the fallback rule when a key has no match (share reported).
4. OUTCOME-BLIND POWER GATE: minimum N events, N independent days (events sharing one signal collapsed), and the minimum detectable effect in ADR20 or points; the cell is auto-PARKED if the gate is missed.
5. COUNTED CONTRAST EQUATION: the exact (signal minus control) estimator with the 2.0 pt cost deducted equally from both arms, the unit (per trade or per day), the bootstrap (day-blocked, draws, seed) and the p-value convention (1 + count) / (draws + 1).
6. THE COUNTED FAMILY AND HOLM: the list of counted tests (a hard assertion on the count in code), alpha, and what is descriptive and never counted.
7. NULL-GATE RESULT: the outcome-blind Monte Carlo of the whole pipeline (family-wise false-pass rate at or below about 0.10) recorded as a claim before any real run.
8. LEDGER AND CRASH POLICY: the look is logged first with an idempotent ref; a crash before any statistic spends nothing extra; no rule changes after a statistic has been printed.
9. STORE WITH EVERY COUNTED TEST (from 2026-11-10): raw p-value, t statistic and the number of independent days, so a weekly Benjamini-Hochberg pass over the ledger is possible (the past is treated as exploratory hints).
