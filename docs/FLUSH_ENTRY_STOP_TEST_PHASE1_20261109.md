# Flush entry/stop test: phase 1 (outcome-blind count) and DRAFT pre-registration (NOT FROZEN)

Tracker item E in `docs/WORKPLAN_20261109.md`. Script: `scripts/flush_phase1_blind_counts_20261109.mjs` (event finders now shared in `scripts/lib/flushStudyLib.mjs`). No outcome was read (no P&L, MFE, MAE, hit/miss), so no ledger look was needed. Windows: explore <= 2025-05-16; 2025-05-17..2025-11-19 volume-inflated (hr-070), not used; >= 2025-11-20 SEALED (counted only, geometry never printed).

## Parity (hr-022)
This script's all-dates event counts equal the last backtest run's sample sizes (performance_audit OPTIMAL_STOP, run 2026-11-09): RTH_FLUSH L 364 / S 338; GLOBEX_FLUSH L 197 / S 132; REVERSAL L 153 / S 160. All six MATCH.

## Events (one event per day in every cell: events = days)
| cell | explore | inflated | sealed |
|---|---|---|---|
| RTH_FLUSH_LONG | 217 | 42 | 105 |
| RTH_FLUSH_SHORT | 195 | 51 | 92 |
| GLOBEX_FLUSH_LONG (continuation) | 111 | 35 | 51 |
| GLOBEX_FLUSH_SHORT (continuation) | 69 | 16 | 47 |
| GLOBEX_FLUSH_REVERSAL_LONG | 82 | 26 | 45 |
| GLOBEX_FLUSH_REVERSAL_SHORT | 90 | 15 | 55 |

## Geometry at the entry bar, explore only (points; stop = |entry - structural stop|)
| cell | box p50 | stop p10 / p50 / p90 / max | stop / ADR20 p50, p90 | stops > 500 pt |
|---|---|---|---|---|
| GLOBEX_FLUSH_LONG | 31.5 | 67.5 / 88.3 / 216.3 / 335.5 | 42%, 82% | 0 |
| GLOBEX_FLUSH_REVERSAL_LONG | 34.8 | 69.5 / 88.3 / 176.4 / 321.5 | 41%, 64% | 0 |
| GLOBEX_FLUSH_REVERSAL_SHORT | 30.0 | 67.1 / 84.3 / 125.1 / 777.0 | 35%, 54% | 1 |
| GLOBEX_FLUSH_SHORT | 31.8 | 67.2 / 93.3 / 187.1 / 863.5 | 40%, 70% | 1 |
| RTH_FLUSH_LONG | 80.0 | 96.5 / 133.8 / 210.3 / 400.0 | 60%, 81% | 0 |
| RTH_FLUSH_SHORT | 80.3 | 98.8 / 135.8 / 239.5 / 356.0 | 63%, 87% | 0 |

Reading (geometry only): Sunday 2026-11-08's REVERSAL_LONG had a 392-pt box (explore median box 34.8) and a 442-pt stop (explore max 321.5). The live stops since 9/1 reach 780 pts, above any explore RTH stop (max 400): the recent regime is wider than the explore window, so a skip rule in POINTS would not transfer; it must be in ADR20 units.

## Fire-time terciles (explore, cut points derived from the data)
Globex continuation 337.7 | 705.3 min after 16:00; Globex reversal 336.0 | 708.0; RTH 104 | 206 min after 09:30. Events per tercile (early/mid/late): Globex CONT LONG 32/40/39, SHORT 28/20/21; Globex REV LONG 32/26/24, SHORT 26/31/33; RTH LONG 66/75/76, SHORT 72/63/60.

## What S1 (skip if stop/ADR20 > expanding prior p80 of the same cell, needs 20 earlier events) would change
Eligible / skipped: GLOBEX_FLUSH_LONG 87/15; REVERSAL_LONG 58/13; REVERSAL_SHORT 68/9; GLOBEX_FLUSH_SHORT 48/15; RTH LONG 186/41; RTH SHORT 172/32. About 15-22 percent of eligible events, as designed.

## Power (assumption-based; per-trade outcome SD is NOT measured here)
Day-blocked test of a paired per-trade difference: MDE (80 percent power, two-sided 5 percent) = 2.8 x SD_paired / sqrt(N). A skip rule removes ~20 percent of events, so SD_paired is roughly sqrt(0.2) x SD of the skipped trades' P&L; with a GUESSED skipped-trade SD of $200 that is ~$90. N = 172-186 (one RTH or Globex-REV cell) gives MDE ~ $19 per trade; N = 412 (RTH pooled) ~ $12; pooling is needed. A $4 floor (Argon round 11) would need ~4,000 events: UNREACHABLE. Only large effects are testable; the honest result of a thin test is "not shown", PARKED with a forward-day trigger, not retired.

## DRAFT pre-registration (to be critiqued, then frozen BEFORE any outcome is read)
- Population: explore window only, events as above, exits and fills exactly the study library's `realistic()` arm (entry = next bar's open, gap-aware fills, structural stop), targets from strictly prior events (Globex walk-forward prereg method).
- Primary counted tests (4, Holm 0.10): S1 on RTH (L+S pooled, N 412), S1 on Globex CONTINUATION (L+S, N 180), S1 on Globex REVERSAL (L+S, N 172), E1 pullback limit on RTH. Direction split (cv-033) is reported descriptively and declared in advance as NOT a counted test; opposite-signed directions are a finding about the pooling, not a pass.
- Contrasts: paired per-event P&L difference, arm minus baseline B0, day-blocked bootstrap (`dayBlockedBootstrapCI`), collapse cluster siblings first.
- Controls: fixed-count day-matched random skip (same number of skips per time tercile, drawn on non-flagged days, 1,000 draws) so a gate cannot win by trading less; placebo = `realistic(setup, target, mirror=true)` geometry-matched mirror; E1 also needs the entry-price-only control (limit at the same price with no pullback logic) per hr-042.
- PASS only if all hold: flagged days >= 150 for the pooled cell; paired CI lower bound at the Holm-adjusted level > 0; arm minus fixed-count control lower bound > 0; arm minus placebo lower bound > 0; both chronological halves positive; worst single loss not larger than the baseline's.
- PARKED, not tested: E2 sweep-reclaim (needs a defined sweep depth distribution first), S1b stop cap (its premise, wide stops do the work, was shown on the order-flow setup only), per-direction tests (underpowered). Reopen trigger: forward SHADOW days from 2026-11-10 reaching 30 events per pooled cell.
- Sealed window and the live 2026-09-01..11-08 rows are NOT used for selection. One sealed look at most, only for an arm that passes, via `spendSealedLook()`.
- Sunday 2026-11-08 is an anecdote that motivated the test; it is not data for it.

## ADDENDUM 2026-11-09 (after Argon's web critique; audited by me)
**Population mismatch found (changes the test).** Backtest and the phase-1 count use Globex departures only in the 15:59-16:29 ET window on RTH dates. The LIVE detector (`globexFlushDetector.js` findDeparture, `DEPARTURE_CHECK_START_MOD=959`, `WATCH_END_ET_MIN=570`) takes the first close outside PD value ANYWHERE from 15:59 to 09:29 next day, per calendar departure day (Sundays included), levels from the nearest FOLLOWING checkpoint, and watches bars across days with RTH bars excluded. 7 of the 44 live Globex rows since 9/1 have trade_date = Sunday (9/13, 9/20, 9/27, 10/4, 10/11, 10/25, 11/08, including the $887 loser); the backtest has no Sunday-session events at all. So the explore events above are NOT the population that fires live; the calibration (targets, tiers) was built on the narrower one (OPEN_DECISION `globex_flush_live_window_replay_not_done_20261026` is this gap). Next: a live-faithful enumerator, validated by matching the 44 live rows' fired_at, then re-run the counts and the diagnostics below on THAT population.

**Argon's ADR20 guess checked:** median ADR20 (mean RTH range of the prior 20 sessions) 2023 190, 2024 222, 2025 290, 2026 371, latest 483 (Argon guessed 250-350 pre-May-2025 and 450-600 now: direction right, magnitude overstated). The fixed 50-pt buffer is 26.3 percent of ADR20 in 2023, 22.6 percent 2024, 17.3 percent 2025, 13.5 percent 2026: a real regime leak, so scale-free rules are required.

**My errors found:** the brief said "59 live paper trades"; the live Globex family alone is 44 rows and RTH flush adds more (about 76-80 depending on filters). The draft "flagged days >= 150" criterion is unreachable for the Globex cells (S1 would skip 22-30 events there) and was worded as flagged days; replace with an MDE statement and park or descriptive-only for thin cells.

**Adopted from Argon (to go into the prereg):** direction-stratified percentiles; pre-declared sign-concordance and an INCONCLUSIVE (regime-confounded) bucket; E1 scored intent-to-treat (unfilled = $0, all triggers in the denominator); prop-truncated P&L and median/Wilcoxon alongside the raw mean; the five outcome-blind diagnostics (tail variance share of box vs overshoot, Jaccard of stop-vs-box skip sets, Spearman with ADR20, expanding vs rolling-50 skip-rate drift, Sunday enrichment). Not adopted yet: a rolling-50 window (decide after the drift diagnostic), ex-ante R:R gate (needs prior-event outcomes; park to prereg stage), 50-pt entry buffer normalization (a separate entry-rule test, not this one).
**Operational point (not a test):** the existing daily-loss gate (`dllGate.js`) blocks NEW entries once realized broker loss reaches the limit; it does not cap a single entry's stop risk or combined open risk, so two concurrent wide-stop entries (Sunday: $887 + $802 = $1,689 on one bar) could exceed the $1,000 daily limit before the gate sees a realized loss. Order-flow caps its own stop at the limit (`capStopToDailyLimit`) but flush and tell do not. Tracker item J.
