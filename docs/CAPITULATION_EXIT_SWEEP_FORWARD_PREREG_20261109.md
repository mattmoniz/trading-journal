# Capitulation exit on FAILED_SWEEP_REVERSAL: FORWARD test C3 (row 30 amendment A7). PRE-REGISTRATION, FROZEN 2026-11-09 night before any forward row of this setup is judged

Origin: the all-setups replay (`docs/CAPITULATION_EXIT_ALL_SETUPS_PREREG_20261109.md`, A6.2 RESULT) found no effect across all 5,191 real rows (A_RTH p 0.196, A_GBX p 0.565, both NOT SHOWN), but one DESCRIPTIVE split looked different: FAILED_SWEEP_REVERSAL, 43 signalled events on 29 days, mean d +$52.3 per event (CI90 [+16, +86], p 0.013; about ten splits were looked at, so this is a hint). A replay cannot confirm a split chosen after looking at it; this registers the forward test for exactly that population, on rows that did not exist when the hint was found.

## Test (one counted test, its own family, alpha 0.10 one-sided)
- **C3**: forward rows (`capitulation_exit_shadow.forward`, fired 2026-11-09 14:30 ET or later) with `setup_type` FAILED_SWEEP_REVERSAL_LONG/SHORT, `origin_status` ACTIVE or SHADOW, cluster-primary, resolved with an `actual_pnl`. Statistic: mean of `delta_pnl` (virtual exit at the next 500V bar's open after the first same-direction extended thrust, minus the row's own `actual_pnl`, dollars, cost $2) over the SIGNALLED rows, collapsed to one value per thrust event (cv-025), day-blocked bootstrap (the logger's `--report`, now with a C3 line, and the Monitor card "Test 3").
- Signal, exit, extension tercile, blackout: exactly as the logger's header (frozen 2026-11-09), unchanged by this amendment.
- Floor: 20 independent signalled events on 10 days (hr-008). Nothing is judged below it.
- CONFIRM (for a next step, not a live change): lower 90 percent bound of the mean delta > 0, 25 percent trimmed mean > 0, and the result survives dropping the best day. FAIL: upper 90 percent bound < 0 at the floor. CONTINUE otherwise, re-look at 40 events.
- Descriptive (uncounted): the rest of the sweep/auction group (STOP_SWEEP, FAILED_AUCTION), by side, by RTH/Globex fire time (hr-002), by progress toward t1 at the signal.
- Replay baseline for comparison, stated before data: mean d +$52.3 per event, 43 events, 2026-06-15..10-09 (SHADOW fills, theoretical).

## What a confirm would and would not mean
FAILED_SWEEP_REVERSAL is a SHADOW-only, SUPPRESS-status setup (-$6.4 per row in the brief, 35 percent win rate): a better exit for a losing setup does not make it tradable. A confirm opens two separate questions for the user: whether the setup with this exit is net positive (needs its own test of the combined rule) and whether to run it live (cv-078: an early close would be a RESOLVED mark through `sweepExits()`; never new order code).

## Liveness caveat found while registering (not explained)
The sweep/auction setups fired in bursts (10-08/09: 17 and 22 rows, 10-23: 26) and then almost stopped: 2 rows in the 10 sessions 10-27..11-09 against 27 FAILED_SWEEP_REVERSAL rows on 10 days in 10-10..10-30. The detector's calibration row (`SWEEP_DRIVE_CUTOFF`, 2026-11-09, cutoff 0.405) is present and fresh, so it is not silent for want of calibration. Market conditions or another gate may explain it; not root-caused. Expected duration is therefore UNKNOWN: at the earlier rate (about 1.3 rows a day, 43 percent signalled) the floor would take about 5-6 weeks; at the recent rate it would take much longer. Re-look triggers (not retirements, co-025): fewer than 5 new FAILED_SWEEP_REVERSAL rows by 2026-12-10 -> check the detector's gates before waiting longer; no 20 signalled events by 2027-03-01 -> re-look.

## Next-step tree (co-022)
Confirm: a prereg for the combined rule (setup plus capitulation exit) on forward rows and the live-arm decision, with the user. Fail: autopsy by side, session, progress bucket, and how many virtual exits cut a row that went on to its target; park. Continue: logger keeps running unchanged.
