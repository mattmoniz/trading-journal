# Globex version of the vacuum: ROC3 against ROC10 on the user's ORIGINAL expansion rule (row 36). PRE-REGISTRATION, FROZEN 2026-11-10 before any outcome is read

Origin: the user (2026-11-10): "the vacuum setup struggled during Globex and probably will; we need a Globex version with its own settings", with Argon's v2.2 spec pasted (the user implements the Sierra side). Audit of the spec's premises: OPEN_THREADS 2026-11-10 midday. Verified outcome-blind: Globex 500-contract bars take a median 173-565 s by ET hour (RTH 12-31 s), so ROC10 spans roughly 30-90 minutes overnight. The Argon "Nov 5/6" narrative does NOT match our bars and is not used. The spec's clock windows, 0.65x / 120 s / 2.5x EMA_TR clip / 1.5 / 1.75 cutoffs and the M4 dead-zone fade are NOT adopted here (hr-003, hr-039); they are a later, separate registration (M4 only after this row).

## What is tested (one hypothesis variable, cv-026)
The live shadow rule (scripts/vacuum_live/shadow.py `analyse`) on the Globex track, with ONE change: the rate-of-change length. Arm A = ROC10 (the live rule). Arm B = ROC3. Everything else is the same code path: `v2.continuous` + `v2.feats` (real functions, hr-022) with `features.L_ROC` set to 10 or 3, Bollinger SMA50 +- 2 population SD of the ROC, onset of (|Z_ROC| > 2 and sign(Z) == sign(ROC)), direction = sign of ROC, enter at Open of the next bar, hold 30 bars, clamp at the Globex hard flat (09:29:50 ET), one position at a time per arm (30-bar lock), cost 2.0 points all-in per round trip, outcome from `shadow.calc_outcome` (imported, not re-implemented). Primary outcome = `net_nostop` (signed 30-bar change minus 2.0). `net_stop25` (the V0 2.5 x EMA10(TR) stop) is descriptive.

## 1. Population and exclusions
- Data: the Explore 500V bars in `scratch/volbars500_full_20261028`, sessions 2023-03-07 to 2025-05-16 (`LAST_EXPLORE`). Each session needs 20 prior sessions of its track for the priors (first 20 sessions skipped, as the live code). Sealed (> 2025-05-16, spent only via `spendSealedLook()`), the live era (>= 2026-10-12) and the design sessions 2026-11-05, 11-06, 11-09, 11-10 are NOT read.
- Globex entry window = the LIVE one: signal bar END <= 55500 s after 18:00 (09:25 ET) and the bar is in the current session with a valid Z (the 18:00 reopen bars are in, because the live rule fires there). A descriptive variant excludes the first 30 minutes (live cv-056 style) and is never counted.
- Contract rolls: entries, holds and exits are inside one session; the displacement series is gap-masked at the session reset, so the stitch cannot enter an outcome. A DESCRIPTIVE sensitivity drops roll weeks (repo `roll_week_dates.json` plus any date whose first Globex open is > 150 points from the previous session close, that date -5/+1 days).
- RTH is not tested here: this row is the Globex version (hr-002 is met for RTH by the existing RTH track in the live shadow, which is unchanged).

## 2. Causal formula (hr-020)
ROC_L[t] = X[t] - X[t-L] with X the gap-masked cumulative close displacement; Z = (ROC - SMA50(ROC)) / SD50(ROC) on bars up to and including t; all known at the close of bar t; entry is Open[t+1].

## 3. Matched control
Both arms use the same sessions, window, bars, hold, cost, lock and outcome function (the only difference is L). Descriptive baseline in the SAME pass for each arm: the unconditional continuation drift of every in-window bar signed by that arm's own ROC sign at the 30-bar horizon (hr-041). The event-minus-baseline value is printed next to T1/T2, never counted.

## 4. Outcome-blind power gate
A counted cell needs >= 100 taken events AND >= 60 event days. A cell below the gate is auto-PARKED, is not in the Holm family (m shrinks) and is reported as PARKED. The MDE (2.93 x bootstrap SE / mean ADR20, ADR20 = mean RTH range of the previous 20 sessions) is printed for every cell, descriptive. Co-025: this is the FIRST registered null for this question; no retirement can follow from this row alone.

## 5. Counted contrast
Unit = per taken event; estimator = sum(net)/N (hr-062); CI and p by day-blocked bootstrap over event days (3000 draws, `numpy.random.default_rng(seed)`, p = (1 + count)/(draws + 1), one-sided). Seeds frozen: T1 201, T2 202, T3 203, T4 204, T5 205.

## 6. Counted family (hard assertion in code: exactly 5 tests nominal) and Holm
- T1: ROC3 Globex continuation (with the expansion direction) net_nostop mean > 0.
- T2: ROC3 Globex reversion (fade of the expansion) net mean (-signed change - 2.0) > 0.
- T3: ROC3 minus ROC10 mean signed 30-bar change (before cost) > 0 (each arm's own taken events; difference of ratios by day-block over the union of days).
- T4: ROC3 continuation net > 0 in the SLOW-hours tercile.
- T5: ROC3 continuation net > 0 in the FAST-hours tercile.
Hour terciles: the 15 Globex ET hours (18..08) ranked by the median bar duration of the explore Globex bars (outcome-blind, causal enough: it is a property of the clock, fixed for the whole run); 5 slowest = SLOW, 5 fastest = FAST, the rest MID (descriptive). Group of an event = the ET hour of its signal bar END.
Holm alpha 0.10 over the cells that pass the gate. Descriptive and never counted: ROC10 alone (the live rule's own explore result), mid hours, 10- and 60-bar holds, net_stop25, first-30-minutes variant, roll-week sensitivity, thirds, by-year, top-5-days share, event-minus-baseline.

## 7. Null gate (recorded as a claim before the real run)
Outcome-blind Monte Carlo of the WHOLE statistics pipeline: 200 iterations, each multiplies every event's signed change by +1 or -1 chosen per DAY (preserves day clustering, kills any signal), cost set to 0 (more permissive than the real run), same bootstrap and Holm. Required family-wise false-pass rate <= 0.10, else the run does not start. Claim `globex_roc3_null_mc_20261110`.

## 8. Ledger and crash policy
The registration look is logged first (tests 0). The run script logs its look (tests = 5) BEFORE reading any outcome, with an idempotent ref; a crash before a statistic spends nothing extra; no rule changes after a statistic is printed; anything added later is labelled post-hoc and not counted. The raw p, the t statistic and the number of independent days are stored with every counted test (item 9 of the template) in `scratch/globex_roc3_20261110/summary.json`.

## 9. Forward arm (second half of the user's go)
A forward SHADOW track `GBX3` (Globex ROC3, same rule as arm B) is added to the live detector `scripts/vacuum_live/shadow.py`: log only, NO orders (the order service must ignore it), restart of the vacuum daemon only, never `server/`. Judged forward after >= 30 taken events, next to the live GBX (ROC10) track over the same nights. Rows fired before the restart do not exist for it.

## 10. Next-step tree (co-022)
- T1 or T3 survives Holm AND thirds agree in sign: forward arm is the live test; the user may then choose the Sierra ROC3 setting; a ROC3 order track needs its own go.
- T2 survives: the Globex fade-equivalent of the expansion is the lead (a reversion, not a "Globex version" of the entry); register a fade-only prereg before anything is wired.
- Nothing survives and the gate was met: report what could not be shown (MDE), keep the forward arm running, M4 climax-fade prereg is the next registration (the spec's other half).
- Gate missed on a cell: forward-only for that cell.
- Failure autopsy (required if nothing survives): split by hour group, by year, by the first 30 minutes after the reopen, by the bar-duration tercile of the signal bar.

## RESULT (2026-11-10 midday, user go "register and run it"; look 241; output `scratch/globex_roc3_20261110/run_output.txt`, events `events.csv`): NOT SHOWN, nothing survives Holm
Null gate passed first (200 iterations, family-wise false-pass 0.055, claim `globex_roc3_null_mc_20261110`). Arm A parity with the live detector on 2026-11-09 Globex: 14 of 14 event keys identical. Independent re-derivation (own ROC3 / Z / onset code, 8 random sessions): event sets identical in 8 of 8. 1,998 ROC10 and 2,046 ROC3 taken events on about 513 days (2023-03 to 2025-05), 3.9-4.0 events per session, top-5-days share 2.5-2.6 percent.
- T1 ROC3 continuation net -1.59 pt [-3.36, +0.10], p 0.968. T2 ROC3 reversion net -2.41 [-4.11, -0.69], p 0.996. T3 ROC3 minus ROC10 signed 30-bar change +0.43 [-1.46, +2.41], p 0.330. T4 SLOW hours +0.14 [-4.71, +5.01], N 284, p 0.474. T5 FAST hours -1.96 [-4.62, +0.86], p 0.916. Holm survivors: none (m = 5, all cells passed the gate).
- What it says: before cost, ROC10 Globex events average -0.02 pt and ROC3 +0.41 pt per trade over 30 bars; the 2.0 pt cost is the whole gap. ROC3 is not distinguishable from ROC10 (T3), and neither side of the expansion (continue or fade) pays after cost. The unconditional baseline drift of the same sign rule is +0.45 (A10) and +0.10 (B3): event minus baseline -0.47 and +0.31, i.e. no information in the onset beyond drift.
- Power: MDE 0.0099 (T1), 0.0098 (T2), 0.0112 (T3) ADR20, all <= 0.015, so T1-T3 are adequately powered nulls: this is the FIRST registered null for the question (co-025 needs a second before any retirement). T4 MDE 0.028 (SLOW hours: only 284 events, underpowered, forward-only), T5 0.016.
- Descriptive (not counted): ROC3 by year -1.59 (2023), -3.43 (2024), +2.11 (2025, N 427); thirds -1.44 / -2.79 / -0.54; V0 stop makes ROC3 worse (-2.54); excluding the first 30 min after 18:00 or roll weeks changes nothing material (-1.76, -1.79). ROC10 by hour: SLOW -4.39, MID -2.25, FAST -0.75 (no cell significant). Not produced (declared descriptive, skipped): 10- and 60-bar holds.
- Live context: the live Globex ROC10 track is -$461 on 11 taken fires (not decisive); the explore ROC10 result above (-2.02 pt per trade, CI -3.83 to -0.23) agrees in sign: the idea does not clear the 2.0 pt cost on Globex in 2023-25 either with ROC10 or ROC3.
- Not shown, NOT "wrong": the entry rule as written (Z > 2 on a 50-bar band, 30-bar hold) has no gross edge on Globex in this sample at either ROC length; a different exit, a different trigger, or the Argon M4 climax fade are separate questions. Next per the tree: forward arm keeps running (section 9), then register M4 (needs a data-derived definition of "stretched from ETH VWAP", not 2.0 x EMA_TR as typed in the spec).

## Forward arm (built 2026-11-10 09:39 ET)
`vacuum_roc3_events` + `evaluate_roc3` in `scripts/vacuum_live/shadow.py` (backup `shadow.py.bak_roc3_20261110`), log only, Globex window only. The outcome-fill code was moved into `fill_outcomes(table, ...)` shared by both tables (unit tests pass; the ROC10 insert path is untouched). The vacuum daemon only was restarted (one process, 0 errors, ROC10 stored events unchanged at 9, all 9 of the day's ROC10 rows have outcomes). Rows with `late_min` >= 3 (the 10 events of the night of 11-09/10 replayed at the 09:39 restart) are backfill and are EXCLUDED from the forward count; judge after >= 30 taken events with `late_min` < 3, next to the live GBX track.
