# NQ raw minute-bar contamination: diagnosis and proposed repair (2026-11-10 night)

Task 2, Phase A of docs/SONNET_SPEC_FABLE_FOLLOWUPS_20261110.md. **Read-only. Nothing in the database was changed.** Phase B (the delete) was NOT run, for two reasons stated at the end: the diagnosis shows the delete in the work order would not repair the bars, and the broker had an open position (the work order's stop condition).

Decision slug: `nq_raw_volume_rows_repair_20261110` (still pending; its text is updated to point here).

## What the work order said, and what is actually wrong
The work order assumed one defect: 500-volume-bar rows with off-minute timestamps sitting next to the real 1-minute rows. That defect is real and its counts are exact. **There is a second, larger defect it did not know about: the ON-the-minute rows are wrong too.**

### Defect 1: off-minute rows (confirmed, exact)
- Raw `price_bars`, symbol NQ, rows under the calendar contract whose `ts` is not on a whole minute:
  - 2025-06: 17,100 (17,079 with volume exactly 500, 21 other); 2025-07: 20,410 (20,385 / 25); 2025-08: 17,750 (17,730 / 20). Total 55,260 on 74 dates (26 + 27 + 21).
  - 2026-04: 832 (all with volume other than 500) on 2026-04-28 and 2026-04-29.
  - Total 56,092 = the work order's 55,260 + 832. No month 2025-05 or 2025-09 has any. No off-minute row exists under a non-calendar contract label.
- 76 dates in all. The stitch JSON listed 74 of them as MIXED_BARS: **a bug in my helper dropped the other two (2025-06-30 and 2025-07-31)**; it overwrote a month's last date. Fixed in `scripts/lib/nqRollStitch.mjs` and the JSON rebuilt tonight: now 76 MIXED_BARS dates, still 85 bad-bar dates.
- Safe to delete as far as holes go: on all 76 dates, **no minute exists whose only row is an off-minute row** (0 of 86,587 minutes), and no minute has two on-minute rows. So deleting them cannot leave a hole.

### Defect 2: every fifth minute is overwritten by a 5-minute bar (new, confirmed against ticks)
- Compared the on-the-minute rows with 1-minute bars rebuilt from the Sierra tick files (`scripts/tick_microstructure/build_1m_bars_from_scid.py`, same code that rebuilt Sep-Nov 2025). Tick files exist for all of it: NQM5.CME.scid (NQM25), NQU25.scid (price_scale 1), NQM6.CME.scid (NQM26).
- **Every row whose minute is a multiple of 5 (:00, :05, :10 ...) is not the 1-minute bar but the 5-minute bar that STARTS there**: open of the first minute, high/low/volume of all five. Test on 2025-07-15 and 2025-08-12: 276 of 276 such rows equal the five tick minutes starting at that minute on open, high, low, close AND volume; 0 equal the five ending there. The other four minutes of each block are exact 1-minute bars.
- Effect: 20 percent of minutes are wrong (OHLC-equal 80.0 to 85.9 percent per date) and on-minute volume is **1.73 to 1.79 times the tick volume** (4 normal minutes plus one minute carrying five minutes of volume = 1.8x), before any off-minute row is added; with the off-minute rows the earlier 2.7x of hr-070 results.
- Mechanism (likely, not traced to the loader): a 5-minute bar export was upserted on `(contract, ts)` and overwrote the 1-minute row at each aligned minute. The 500-volume bars are a separate export loaded under off-second timestamps.

### Dates by regime
| regime | dates | on-minute rows | off-minute rows | what a view built on them looks like |
|---|---|---|---|---|
| clean | 2025-05-27..28 and 2025-08-26..29 (and everything else outside the table) | exact | none | correct |
| A | 2025-08-21..25 (4 dates with off-minute rows) and 2026-04-28..29 (2 dates) | exact (100.0 percent OHLC-equal, volume ratio 1.000 on 2025-08-21..29; 2026-04-27..29 vs NQM26 ticks) | yes | wrong only because of the off-minute rows |
| B | 2025-06-15..2025-08-20 (58 dates with off-minute rows) | **80 to 86 percent exact, volume 1.73-1.79x** | yes | wrong at 20 percent of minutes even after the off-minute rows are removed |
| C | 2025-05-29..2025-06-13 (14 dates; 12 of them with off-minute rows) | rows labelled NQU25 carry **NQM25 prices** with the same 5-minute overwrite (79.9-80.1 percent exact); rows labelled NQM25 are exact (390 of 390 RTH minutes OHLC-equal on every date tested; on 2025-05-28 both labels exist) | yes (NQU25 label) | calendar picks NQU25, so the view serves the corrupted copy |

- Regime C cause: `reconcileContractCalendar` (server/services/priceBarService.js:159) picks the contract per date by DAY VOLUME. The NQU25-labelled copy has about 1.8x the NQM25 volume, so it wins from 2025-05-29. The real front month was NQM25 until Friday 2025-06-13 (tick RTH volume 2025-06-13: NQM25 338,324 vs NQU25 43,530; 2025-06-16: NQM25 121,008 vs NQU25 201,416), so the calendar switched **18 days early** (2025-05-29 instead of 2025-06-15 evening / 06-16).
- 2025-05-29/30 adjacent-minute steps of 40 to 90 points (what the stitch helper flags as STEP_RATIO) are the same defect: the :x0 minutes are 5-minute bars from a different moment.
- Consequence for the stitch list: the real NQM25 to NQU25 price stitch (+222 points) sits on 2025-06-15 evening / 06-16 **inside the label NQU25**, so `crossesStitch` (which looks at label changes) cannot see it; only `touchesBadDate` covers it, because 2025-05-29..2025-08-25 are all bad dates. Every script using `crossesStitch` alone for a study that spans 2025-06-13 to 06-16 misses it. This should be fixed by the repair (the label change becomes real) or by adding a synthetic stitch entry until then.
- Not examined: 2025-09-17/18 and 2025-11-27 (flagged STEP_RATIO only; no off-minute rows there, so a different cause).

### How `price_bars_dedup_hist` is built
Materialized view over raw `price_bars` joined to `price_bars_contract_calendar` (calendar contract only), grouped by `(symbol, contract, date_trunc('minute', ts))`: open of the first row, high/low extremes, **close of the last row by ts**, volume SUMMED (server/schema.sql:8990). It is therefore already contaminated (it groups the off-minute rows into their minute). Refresh: `REFRESH MATERIALIZED VIEW CONCURRENTLY price_bars_dedup_hist` (also `_v2`), nightly via scripts/refresh_price_bars_dedup_hist.mjs. "Rebuild for the affected dates" means a full refresh after the raw tables are fixed; the nightly job also does it.

## Why Phase B was not run
1. **The work order's Part 1 (delete the off-minute rows) cannot meet its own acceptance test.** After it, regime B and C dates would still have 20 percent wrong minutes and volume 1.73-1.79x the tick totals (its own check: RTH volume within 3 percent of 317,545 for 2025-06-10 and 577,034 for 2025-08-01; those two dates would read about 1.77x). Only regimes A (6 dates) would be fully repaired. The stop condition's own advice, "propose a tick rebuild instead", applies.
2. **An open broker position.** `/api/sierra-chart/status` showed `brokerPositionCount: 2` (the same one MNQZ26 long, quantity 1, entry 27,951.25, open P&L about +$55) at 00:43 UTC; the work order says wait or stop. The repair ends in a materialized-view refresh and a calendar edit that live price reads depend on (hr-014).
3. The corrected plan changes about 20,000 bar rows by upsert and a calendar edit: more than "delete stray rows". It should have the user's go as such.

## Proposed repair (not run)
Follow docs/DB_MIGRATION_PROTOCOL.md. All steps outside RTH and outside the nightly job window, flat broker, restart not needed.
1. Backup first: `price_bars_offminute_backup_20261110` = the 56,092 off-minute rows; `price_bars_fiveminute_overwrite_backup_20261110` = every NQ row of the NQU25 label on 2025-05-29..2025-08-20 whose minute is a multiple of 5 (about 72 dates x 276 = 19.9k rows) plus every NQU25-labelled row on 2025-05-29..2025-06-13 (regime C). Catalog entries in docs/DB_BACKUP_CATALOG.md in the same commit.
2. Delete the 56,092 off-minute rows (count must equal the backup).
3. Regime B: replace the 5-minute rows with the 1-minute bars built from the NQU25.scid ticks for 2025-06-15..2025-08-20 (CSV via build_1m_bars_from_scid.py with price_scale 1; a ready CSV for 2025-06-15..08-29 already sits in scratch/nq_raw_bar_repair_20261110/NQU25_0615_0829.csv). `scripts/load_nq_bars_from_scid_csv.mjs` would REFUSE (it stops when more than 1 percent of overlapping minutes differ and these differ at 20 percent); either pass a reviewed override or write a small dated script that upserts only the minutes whose existing row differs, and prove afterwards that every minute equals the tick bar.
4. Regime C: delete the NQU25-labelled rows 2025-05-29..2025-06-13 (copies of NQM25 prices; the NQM25-labelled rows are exact), then `reconcileContractCalendar('NQ','2025-05-29','2025-06-13')` and check it returns NQM25 for every date in 05-29..06-13 and NQU25 from 06-15 evening; then the real stitch becomes a label change and the stitch list sees it.
5. `REFRESH MATERIALIZED VIEW CONCURRENTLY` on both `price_bars_dedup_hist` and `_v2`; rebuild the stitch list (`node scripts/build_nq_roll_stitches.mjs`): the MIXED_BARS and STEP_RATIO flags on the repaired dates must disappear and one stitch must appear at 2025-06-15/16.
6. Verify against ticks, not against the DB: for 2025-06-10, 2025-07-15, 2025-08-01 and 2026-04-28 every view minute equals the tick minute on OHLC and volume; RTH volume within 3 percent of tick totals.
7. Downstream (hr-054, cv-041): re-derive `level_prices`, `developing_value_log`, `acd_daily_log` for the affected dates, run `node scripts/data_sanity_audit.mjs`, and flag (not delete) the `active_setups` rows fired on those dates `bad_bars_basis = TRUE`. Expected about 2,199 BACKFILL and 237 UNKNOWN rows and zero ACTIVE or SHADOW (checked 2026-11-10 during the helper build); stop if any ACTIVE/SHADOW row would be touched. Note regime C dates (05-29..06-13) were not in the earlier count if they were counted against the MIXED_BARS list only; recount.
8. Update docs/KNOWN_ISSUES.md item 8 and the hr-070 archive text.

If the user prefers the minimum: Part 1 on regime A only (6 dates: 2025-08-21, 08-22, 08-24, 08-25, 2026-04-28, 2026-04-29) is safe and complete by itself (3,569 + 832 = 4,401 off-minute rows); the other 70 dates stay flagged as bad dates (they already are).

## What I did not verify
- That the 5-minute overwrite stops at 2025-08-20 for every contract and time (checked by date only: 2025-08-21..29 exact on the on-minute rows).
- Dates before 2025-05-27 and after 2025-08-29 beyond the monthly off-minute counts (the ticks were compared only for 2025-05-26..08-29 and 2026-04-26..30).
- The loader mechanism (which script wrote the 5-minute bars). The NQU5.CME.scid_BarData-5m.txt export in the Sierra folder (dated 2025-08-25) is a likely source; not opened.
- The volume ratio of NQM25-labelled rows against the NQM25 ticks beyond RTH.

## PHASE B DONE 2026-11-10 night (user go: "i defer to you"; run by `scripts/repair_nq_raw_bars_20261110.mjs --write` at 21:32 ET after the nightly window, broker flat, switch armed, server untouched)
- Backup `price_bars_nq_rawfix_backup_20261110`: 85,390 rows = 56,092 OFFMINUTE (deleted) + 16,200 MISLABELLED (NQU25-labelled rows 2025-05-29..06-13 holding NQM25 prices, deleted) + 13,098 FIVEMIN (on-the-minute rows holding the 5-minute bar, updated to the tick-built 1-minute bar). All dry-run assertions held (0 minutes left without a row; NQM25 rows equal to their tick bar 16,192 of 16,200; 8,279 post-08-20 NQU25 rows 0 differing).
- Calendar: the contract changed on 15 trade dates (2025-05-29..06-13 and 06-15, NQU25 -> NQM25); trade date 2025-06-16 stays NQU25, so the stitch sits at the midnight of 06-15/16 (Sunday evening date 06-15 had more NQM25 volume). Both `price_bars_dedup_hist` and `_v2` refreshed.
- Verified against ticks, not the DB: 2025-06-10, 2025-07-15, 2025-08-01, 2026-04-28: 390 of 390 RTH minutes OHLC-equal each, RTH volume ratio 1.000 (317,545 / 380,891 / 577,034 / 411,369).
- Derived tables: `rebuild_nq_window_derived_levels_20261005.mjs` for 2026-04-28..05-13 (12 dates; backups `*_barfix2_backup_20261110`) and 2025-05-29..09-12 (77 dates; `*_barfix1_backup_20261110`): 0 failures, PD_HIGH / PD_CLOSE and developing-value session high re-verified against the corrected bars (0 bad of 12 and of 77). LIMIT: levels that look back a year (yearly, 3-month value areas) are not rebuilt beyond about 10 days after each window.
- Setup rows: `scripts/flag_rawfix_rows_20261110.mjs --write` flagged 2,339 rows `bad_bars_basis` (2,114 BACKFILL + 225 UNKNOWN; 0 ACTIVE or SHADOW; backup `active_setups_rawfix_flag_backup_20261110`).
- Stitch list rebuilt (`scripts/build_nq_roll_stitches.mjs`): 15 stitches, now including NQM25 > NQU25 at 2025-06-15 23:59 -> 06-16 00:00 (step 216.75), bad-bar dates 85 -> 8 (all STEP_RATIO: 2023-03-06..09, 2025-06-15, 2025-09-17/18, 2025-11-27; the last two groups were never examined). MIXED_BARS flags: 0.
- Audits after: `data_sanity_audit.mjs` shows only its 6 pre-existing groups (POC join and overnight order-flow MAE/MFE outliers, tell implied $/pt 2.33, ES rows in 2023-11..12), none on repaired dates; section [6] contract-roll health clean; `check_derived_tables_vs_bars.mjs`: last 25 trade dates agree.
- NOT done / limits: levels beyond the 10-day tail above; setup rows resolved on these bars were flagged, not re-scored (the 2,339 stay out of REAL_TRADE_FILTER stats); research scripts that ran BEFORE the repair on 2025-05-29..08-20 or 2026-04-28/29 used wrong bars (their results are suspect; the guard inventory lists them); a loader mechanism that wrote the 5-minute bars is still unknown, so a new import could reintroduce it (`scripts/tick_microstructure/build_1m_bars_from_scid.py` + the equality check is the template).
