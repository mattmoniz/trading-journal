# Vacuum item 2: thin versus crowded (the user's duration idea, candidate B) (pre-registered 2026-11-10 night, BEFORE any outcome of this test is read)

Origin: user 2026-11-10 (items 1-3 of docs/HANDOFF_20261110_LATE_NIGHT_NEXT_SESSION.md), the user's own notes in docs/ORIGINAL_NOTES_500V_LIQUIDITY_VACUUM_20261108.md and docs/USER_SIERRA_INDICATOR_SETTINGS_20261108.md. Queue id Q4-7 (docs/CANDIDATE_QUEUE.md, 7 of 8 used). Improvement register row 53. Explore only (2023-04-04..2025-05-16); sealed window and depth era untouched.

**Definitions are CLAUDE'S READING of the user's idea, not the user's own words** (the user said not to ask, and the handoff allows this). The user's words that it rests on: "bar time duration is the INSTITUTIONAL-INVOLVEMENT signal: fast 500V bars = size being swept; Ratio high with slow bars = thin book but no urgency". So CROWDED / institutional = the thrust bars were FAST for the time of day; THIN = the thrust bars were SLOW for the time of day (book empty, no urgency). The book-depth Ratio half of "thin" is item 3 (depth era), not here. If the user gives their own definition later, it replaces this reading and the test is re-registered.

## Question in plain words
The pooled vacuum onset has no extra run over a coin flip (row 52, claim `vacuum_take_20261110`). The user's idea is that the onset only means something when the thrust was fast for the clock (institutions sweeping), and means nothing when the bars were slow. Does the extra run exist inside the fast onsets, and is it larger than inside the slow ones?

## Population and measure (frozen)
The same 9,116 taken onsets as row 52 (`unified_exit_lock.vacuum_onsets()`), RTH and Globex apart. Per onset, THRUST PACE = the mean over the 5 bars ending at the onset bar of `features.pace_cdf` (the share of prior same-hour bars of the previous 20 sessions of this track that were at least as fast; small = fast), NaN bars ignored, onset dropped if all 5 are NaN. This is already a rolling time-of-day norm (hr-003). Classes by the track's OWN rolling history of this statistic: FAST = thrust pace <= the 33rd percentile of the previous 600 onsets of the track, SLOW = >= the 67th, MID otherwise; the first 60 onsets of each track are burn-in and dropped (counted). No static cutoff.
Outcome = row 52's extra favourable run: (MFE_pre real - MFE_pre same bars opposite direction) / 2 / stop distance (stop 2.5 x EMA10 TR, 30-bar hold), via `vacuum_take_look.walk()`.

## Counted tests (4; Holm 0.10 over the 4)
Per track (RTH, Globex): T1 = mean extra run of the FAST onsets (two-sided; the earlier fast-bar climax lead in RTH was reversed in sign, so direction is not assumed); T2 = FAST minus SLOW mean extra run (two-sided). Day-blocked bootstrap (10,000 draws; seeds 3201-3204), 95 percent intervals. Gate: a cell is counted only with >= 100 onsets and >= 60 days (else PARKED).

## Null gate (before any counted cell is read)
Sign-flip Monte Carlo of the 4-cell pipeline (1,000 iterations, flip the extra-run sign per date): family-wise false-pass rate at Holm 0.10 must be <= 0.10, else fix the pipeline first. Walkers are the row 52 ones (8 synthetic checks, parity with `sim_vac`).

## Descriptive (uncounted)
Terciles fast / mid / slow: N, extra run, live stop/hold net points per trade, bracket k = 1 excess; raw thrust duration in seconds by class; by direction and by half of history; share of the three classes by hour of day (to see whether pace proxies the clock); the fast class by hour 9:35-10:30 vs rest (RTH).

## Next-step tree (co-022)
- T1 or T2 survives Holm AND the effect repeats in both halves: a lead (co-024). Then a forward shadow flag on the live vacuum rows (pace class stored at fire) and, only then, an exit-design test inside the fast class.
- Nothing survives: the user's duration split does not separate a real thrust from a thin one in the extra run, on explore, MDE stated. Second null with row 52 on the pooled question; parked, not retired (co-025 needs two nulls for THIS idea; this is its first).
- A cell significant only in the opposite sign (fast = worse): a lead for a separately registered test, nothing flipped.

## Failure autopsy (co-022)
If null: report each cell's MDE, the class sizes, and whether pace tracks the hour of day (a proxy for the clock would make the split a time-of-day split in disguise).

## Script
`scripts/vacuum_sim/vacuum_thin_crowded.py` (`null` = gate, `run` = the counted cells and descriptives). Output `scratch/vacuum_thin_crowded_20261110/`.

## RESULT (2026-11-10 night; look 273; claim `vacuum_thin_crowded_20261110`; output `scratch/vacuum_thin_crowded_20261110/output.txt`): NOT SHOWN, NO HOLM SURVIVOR
- Null gate passed (family-wise false-pass 0.068). After the 60-onset burn-in per track: RTH 7,058 onsets (FAST 2,351 / MID 2,318 / SLOW 2,389, about 465-493 days each), Globex 1,938 (667 / 641 / 630).
- Counted (extra favourable run in stop units, two-sided): RTH T1 FAST -0.025 [-0.057, +0.007] p 0.122 (MDE 0.048); RTH T2 FAST minus SLOW -0.023 [-0.068, +0.021] p 0.303 (MDE 0.066); Globex T1 +0.027 [-0.030, +0.084] p 0.355 (MDE 0.085); Globex T2 +0.046 [-0.039, +0.129] p 0.285 (MDE 0.125). Survivors: none. Fast classes: thrust duration median 12.7 s RTH (SLOW 32.9 s), 99.8 s Globex (SLOW 304.9 s).
- Descriptive only (uncounted, one-sided p labels in the output): RTH FAST longs -0.054 [-0.096, -0.011] and FAST in 9:35-10:30 -0.070 [-0.120, -0.020] exclude zero on the NEGATIVE side (fast onsets then run less than a coin flip), among 14 cuts and not the registered tests; first / second half of FAST -0.027 / -0.024. Class share by hour is roughly even (FAST 26-40 percent) except the 15h and 19h Globex hours, so pace is not just the clock.
- Reading: on explore the user's duration split does not separate a continuing thrust from a thin one in the extra run, within the stated minimums (about 0.05 stop units RTH, 0.09 Globex). If anything the fast RTH onsets are slightly worse, the opposite of the idea; that is a lead for nothing registered. The other half of the user's "thin" (the book-depth Ratio) is item 3.
- Next-step tree branch taken: nothing survives -> second null with row 52 on the pooled question, parked not retired. Failure autopsy: class sizes and MDEs above; pace does not proxy the hour.
- Item 3 note (book-depth half of 'thin'): already run 2026-11-09 on the 68 depth-era explore sessions (looks 193 / 194, `scripts/vacuum_sim/depth_tell2.py`): thin-book bursts -7.89 vs thick -2.05, the full rule N 84, none of 5 tests survived Holm; not repeated tonight, no queue slot used (Q4-8 free).
