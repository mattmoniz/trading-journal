# Work order: follow-ups from the 2026-11-10 outside review (for a fresh Claude Sonnet session in this repo)

You are picking up engineering work that a previous session scoped but did not do. Everything you need is in this file and the files it names. Read this whole file before touching anything.

## 0. Ground rules for this work order

1. Read `CLAUDE.md` first (it loads automatically), then `docs/OPEN_THREADS.md` section "2026-11-10 night — Fable strategy-review reply AUDITED", then `docs/FABLE_REVIEW_AUDIT_20261110.md`.
2. **Do not restart the server, do not arm the Sierra switch, do not re-enable tell orders, do not commit.** The tell orders are paused on purpose. If a task seems to need a restart, stop and say so in your report.
3. **Do not run any new statistical test and do not read outcome labels (P&L, win/loss) for any new question.** This work order is engineering and data repair only. The tests it prepares for are designed and judged in a later session.
4. **Do not edit** `server/services/acdShared.js` `getNqRollWeekDates()` / `isInsideNqRollWeek()`, `scripts/tick_microstructure/roll_calendar.py`, or anything under `server/` except where a task says so. Live code keeps the calendar roll rule.
5. Memory is tight (WSL, about 7 GB). Stream large tables month by month, one heavy job at a time, prefix Python jobs with `ulimit -v 4000000`. Every `price_bars_primary` query needs both a lower and an upper `ts` bound.
6. Database access: `psql` needs a password you do not have. Use a node script that imports `query` from `server/db.js`. Never put SQL containing `$1` inside `node -e "..."`; write a file and run it. In `main().then(() => process.exit(0))` scripts, `await` every call.
7. Do the tasks in order. After each task, write its result into `docs/OPEN_THREADS.md` under the section named in rule 1 (one bullet per task: what was done, the numbers, what is left). If a task's stop condition triggers, stop that task, write down what you found, and go on to the next task.
8. Final report: a numbered list matching tasks 1 to 5 below, each marked DONE / PARTLY / STOPPED with the key numbers and the files changed. Say plainly what you did not verify.

## What already exists (do not rebuild)

- `scripts/lib/nqRollStitch.mjs`: `scanNqStitches`, `loadNqStitches`, `crossesStitch(data, t0, t1)`, `touchesBadDate(data, t0, t1)`, `unsafeDates(data, {daysBefore, daysAfter, includeBadDates})`. Read its header comment.
- `scripts/build_nq_roll_stitches.mjs`: rebuilds `scripts/lib/data/nq_roll_stitches.json` from the bars (about 10 seconds, already in `scripts/run_weekly_backtests.sh`).
- `scripts/lib/nq_roll_stitch.py`: Python reader (`load`, `crosses_stitch`, `touches_bad_date`, `unsafe_dates`).
- Current content of the JSON: 15 contract stitches (steps of 165 to 513 points; 8 of them fall outside the calendar helper's window) and 85 bad-bar dates (2023-03-06..09, 2025-05-29..2025-08-25, 2025-09-17..18, 2025-11-27, 2026-04-28..29).
- Claim `nq_minute_bars_mixed_volume_rows_20261110`; pending decision `nq_raw_volume_rows_repair_20261110` (`node scripts/flag_decision.mjs --list`).

## Task 1. Inventory of minute-bar readers and where the stitch guard is missing (read-only, then small edits)

Why: a study that takes a price difference across a contract stitch books a jump of 165 to 513 points that never traded. 636 files read minute bars; 44 carry some roll guard. Nobody has checked which of the rest can actually cross a stitch.

Steps:
1. Build the file list: `grep -rlE "price_bars_primary|price_bars_dedup_hist|FROM price_bars\b" scripts server --include=*.mjs --include=*.js --include=*.py` (exclude `scripts/archive/`, `node_modules`, `venv`).
2. Narrow to files that are run on a schedule: every script invoked from `scripts/run_weekly_backtests.sh`, `scripts/run_daily_calibration.sh` and the cron entries those name. Classify each scheduled file into exactly one of:
   - **SAFE-BY-CONSTRUCTION**: reads bars of a single RTH session only (09:30 to 16:00 of one date), or reads only dates after 2026-09-14 by a rolling window that is shorter than the distance to the next stitch. State the reason.
   - **CAN-CROSS**: holds a position, takes a return, or computes a level (prior-day value, overnight high/low, weekly/monthly VWAP, gap) from bars on both sides of a possible stitch instant (Sunday 18:00 or 00:00 on a roll-week Monday or Tuesday).
   - **READS-BAD-WINDOW**: its date range includes 2025-05-29..2025-08-25 or 2026-04-28..29.
3. Write the table to `docs/NQ_STITCH_GUARD_INVENTORY_20261110.md`: file, schedule, class, reason, guard present (yes/no, which one), action taken.
4. Edits allowed in this task: ONLY in files that are (a) research or diagnostic scripts and (b) do NOT write `performance_audit` rows with `signal_type` in (`SETUP_STATUS`, `OPTIMAL_STOP`, `LIVE_ROSTER`, `DAY_TYPE_ALPHA`) and are not imported by anything under `server/`. In those, import the helper and skip events where `crossesStitch(data, earliestBarRead, lastBarRead)` or `touchesBadDate(...)` is true; print how many events were skipped. For every file that feeds the live pipeline, do NOT edit: instead count (outcome-blind: count rows only) how many of its events would be skipped, and list it in the inventory as "needs a decision".
5. For the unscheduled remainder (the several hundred one-off research scripts), do not classify one by one. List the ones dated 2026-10-20 or later whose date range includes the bad window or which hold across midnight, as "re-check before citing".

Acceptance: the inventory file exists; every scheduled minute-bar reader has a class and a reason; `node --check` (or `python -m py_compile`) passes on every edited file; each edited script was run once and its skipped-event count is in the inventory.
Stop condition: none. This task is safe.

## Task 2. Repair the mixed raw bars (DATA CHANGE: follow the protocol exactly)

Read `docs/DB_MIGRATION_PROTOCOL.md` and `docs/DB_BACKUP_CATALOG.md` before anything else in this task. Read `ARCHITECTURE.md` sections on `price_bars`, `price_bars_primary`, `price_bars_dedup_hist` and "Long NQ 1-minute history". Read `docs/KNOWN_ISSUES.md` item 8.

What is wrong: raw `price_bars` holds 500-volume-bar rows (timestamps not on the minute, volume exactly 500, sometimes other sub-minute rows) under the calendar contract label, next to the real 1-minute rows, on 74 dates 2025-06-01..2025-08-25 (about 55,260 extra rows) and on 2026-04-28 and 2026-04-29 (about 832 extra rows). The view `price_bars_primary` groups them into the minute, so the minute's close comes from a volume bar that ends after the minute, the high/low can be wider and the volume is about 2.7 times too large. Checked on 2025-07-15: close differs from the true minute row on 575 of 1,380 minutes. Separately, 2025-05-29 and 2025-05-30 carry prices of two contracts mixed (adjacent-minute steps of 40 to 90 points), and the contract calendar switches NQM25 to NQU25 on 2025-05-29, about two weeks before the real roll, with NQU25 minute rows in June that appear to be copies of NQM25 prices.

Phase A, read-only diagnosis (do this fully before Phase B):
1. For symbol NQ and each month from 2025-05 through 2025-09 and for 2026-04, count per date and contract: rows on the minute (`ts = date_trunc('minute', ts)`), rows off the minute, and off-minute rows with volume exactly 500. Confirm the totals above within 1 percent. Check whether any date OUTSIDE the 76 MIXED_BARS dates in the JSON has off-minute rows for the calendar contract; list them.
2. Find how `price_bars_dedup_hist` is built and refreshed (grep the name across `scripts/`, `server/`, `server/schema.sql`), and whether it already contains the contaminated minutes.
3. Find the tick-file rebuild path (`scripts/load_nq_bars_from_scid_csv.mjs`, `scripts/check_nq_history_coverage.mjs`, `scripts/tick_microstructure/`) and establish whether tick data exists for 2025-05-29..2025-08-25 and 2026-04-28..29 and for which contract.
4. For 2025-05-29..2025-06-13, establish from the ticks (or from volume by contract) which contract was really the front month on each date, and whether the on-the-minute rows labelled NQU25 hold NQU25 prices or NQM25 prices (compare against tick-built minute closes; RTH high/low is the reliable comparison, never volume).
5. Write the findings to `docs/NQ_RAW_BAR_REPAIR_20261110.md`.

Phase B, the repair, only the part that Phase A proved:
1. Part 1 (safe, do it): back up, then delete the off-minute rows of symbol NQ on the confirmed dates. `CREATE TABLE price_bars_offminute_backup_20261110 AS SELECT * FROM price_bars WHERE <exactly the rows to delete>`; verify the backup row count equals the count to delete; add the entry to `docs/DB_BACKUP_CATALOG.md`; delete inside a transaction and check the deleted count equals the backup count before commit.
2. Rebuild `price_bars_dedup_hist` for the affected dates by its own documented method.
3. Verify: re-run `node scripts/build_nq_roll_stitches.mjs`; the MIXED_BARS dates must be gone. For three dates (2025-06-10, 2025-07-15, 2025-08-01) the view's close must now equal the on-the-minute raw row on every minute, and RTH volume must be within 3 percent of the tick totals in hr-070's archive text (`docs/CLAUDE_MD_ARCHIVE/hard_rules.md`, anchor `hr-070`: 317,545 for 2025-06-10, 577,034 for 2025-08-01).
4. Part 2 (2025-05-29/30 mixed prices and the early calendar switch): do NOT repair. Write what Phase A found and a proposed fix into the repair doc and leave it for the user.
5. Downstream (CLAUDE.md hr-054, cv-041): after Part 1, re-derive `level_prices`, `developing_value_log` and `acd_daily_log` for the affected dates using the existing rebuild scripts named in `ARCHITECTURE.md`, then run `node scripts/data_sanity_audit.mjs`. Flag, do not delete, the `active_setups` rows fired on the affected dates: back up their ids and current flag to a `*_backup_20261110` table (catalog entry), then `UPDATE active_setups SET bad_bars_basis = TRUE WHERE fired_at::date IN (<affected dates>) AND bad_bars_basis IS DISTINCT FROM TRUE`. Expected: about 2,199 BACKFILL and 237 UNKNOWN rows, zero rows with `origin_status` in (ACTIVE, SHADOW). If any ACTIVE or SHADOW row would be touched, stop and report instead.
6. Update `docs/KNOWN_ISSUES.md` item 8, regenerate `server/schema.sql` if a table was created (command in `ARCHITECTURE.md`), resolve the decision: `node scripts/flag_decision.mjs --resolve nq_raw_volume_rows_repair_20261110 '<what was done, what remains>'` (only if Part 1 and step 5 both completed; otherwise leave it pending and say why).

Stop conditions (stop the task, restore nothing unless you changed something, report):
- Phase A counts differ from the numbers above by more than 1 percent, or off-minute rows turn out to be the ONLY rows for some minutes (deleting them would make holes): then do not delete; propose a tick rebuild instead.
- The backup count does not equal the delete count.
- Any step would touch rows dated after 2026-09-14 (live-era data).
- The live server is mid-session with open positions: check `curl -s localhost:3002/api/sierra-chart/summary` first; if it reports an open position, wait or stop.

## Task 3. Roster-level pass-probability simulator (tool only, no new test)

Why: the prop account is a race: $2,000 end-of-day trailing loss limit from the start, $3,000 profit target, no daily limit. A day-block bootstrap of that race already exists in two places but only for one stream at a time. The next study (risk rules) needs one that takes a pooled list of trades, applies skip rules, and reports P(pass), P(fail), P(unresolved) and days to resolution.

Steps:
1. Read `race()` in `scripts/vacuum_sim/unified_exit_lock.py` and the pass-race block in `scripts/learning_monitor_build.mjs`. Read the memory note on account rules: `/home/mmoniz/.claude/projects/-home-mmoniz-trading-journal/memory/reference_prop_account_rules_20261102.md`.
2. Create `scripts/lib/pass_race.py` with ONE shared implementation: `race(day_pnl, n_paths, horizon_days, block_days, floor, target, seed)` (end-of-day trailing floor that rises with the highest end-of-day balance; confirm against the memory note whether the floor stops rising at the starting balance, and implement what the note says) and `apply_rules(trades, rules)` where `trades` is a list of dicts with at least `date`, `entry_time`, `direction`, `risk_dollars`, `net`, `session`, `stream`, and `rules` is a list of callables `(trade, state) -> take: bool` evaluated in time order with `state` holding the running balance, the current cushion and the day's earlier trades. Ship three rule builders, each with its parameter as an argument and NO default value (the values are chosen in a pre-registration later, not here): `risk_cap(fraction_of_cushion)`, `same_direction_lockout()` (skip a trade when the previous taken trade of the same stream, same day and same direction was a full stop), `session_off(session_name)`.
3. Make `unified_exit_lock.py` import `race` from the new module instead of its own copy (CLAUDE.md cv-077, cv-079), and check its output does not change: run its unit tests (`unit_tests()`), and confirm the tell baseline pass probability it prints is still 0.385 (it reads `scratch/unified_exit_lock_20261110/tell_pairs.csv`; this is a re-read of an already-logged result, not a new look).
4. Unit tests in `scripts/lib/test_pass_race.py`: (a) a zero-mean symmetric daily P&L gives P(pass) within 2 points of exp(-3000/2000) = 22.3 percent when the floor trails continuously, and you report what it gives under the end-of-day rule; (b) all-positive days always pass, all-negative always fail; (c) each rule builder skips exactly the hand-built trades it should; (d) `apply_rules` with no rules returns the input unchanged.
5. Add the module to `ARCHITECTURE.md`.

Do NOT: choose parameter values, run the rules on real trades, or print any P(pass) for a rule on real data. Acceptance: tests pass; `unified_exit_lock.py` prints the same baseline.

## Task 4. Forward read for candidate Q4-6 (wire it so it cannot be forgotten)

Read `docs/TELL_GEOMETRY_NULL_PREREG_20261110.md` in full, including its RESULT section if present, and `scripts/vacuum_sim/tell_geometry_null.py`. The pre-registration promises one forward read of the same statistic on live tell fires at 150 fires and at 300 fires. Nothing computes it yet.

Steps:
1. Find where live tell fires are stored (start at `scripts/amt_tell_live/`, `docs/AMT_TELL_LIVE_PROJECT_SPEC_20261028.md`, tables beginning `amt_tell_`). Count the fires since 2026-10-28 (count only).
2. Write `scripts/vacuum_sim/tell_geometry_null_forward.py` that reuses `race()`, `last_bar()` and `boot()` from `tell_geometry_null.py` by import (do not copy them) and computes the same T1 on the live fires, using the stop and the range edge recorded at the fire. If the fire rows do not store the range edge, say so and stop this task: do not reconstruct it by a different method.
3. The script must REFUSE to print T1 unless the fire count is at or past 150 (first read) or 300 (second read) and that read has not been logged yet; below that it prints only the count. Each read logs a ledger look first (`logLook`, family `tell_geometry_null_20261110`, kind `FORWARD`, tests 1; see `scripts/record_tell_geometry_null_registration_20261110.mjs` for the call shape).
4. Add the count line (fires so far, next read at N) as a row in the existing Monitor & Learning page data, not a new tab (CLAUDE.md cv-110): find how `scripts/learning_monitor_build.mjs` feeds the page and add one small section with a next-step line (co-022). Any field the page reads must tolerate being absent (cv-112). Run `npm run lint:frontend` and `npm run build` if you touched anything under `src/`.
5. Run `node scripts/check_research_organized.mjs` and fix what it reports about your additions.

## Task 5. Housekeeping

1. `/home/mmoniz/.claude/projects/-home-mmoniz-trading-journal/memory/MEMORY.md` is 30.8 KB against a 24.4 KB load limit, so the last 57 lines are not loaded. Shorten every index line to under 200 characters (keep the link and a short hook; the detail already lives in the linked file). Delete no line and no memory file. Check the size afterwards.
2. Run `bash .claude/hooks/check-docs-drift.sh` and `node scripts/test_invariants.mjs`; read the output line by line; fix only failures caused by this work order and list the rest in your report.
3. `ps -ef | grep -E "start.sh|server/index.js" | grep -v grep`: report what is running. Do not stop or start anything.

## Not in this work order (leave alone)

- Candidate D (the risk-rule study itself), candidate B (thin versus crowded vacuum onsets: it needs the user's own definitions), candidate C (turn-signal ladder).
- Re-enabling tell orders; any change to `server/services/amtTellOrders.js`.
- Bringing the HIGH decision queue down to 8: that is the user's call.
- Committing. The working tree has many uncommitted files from earlier sessions; leave them.
