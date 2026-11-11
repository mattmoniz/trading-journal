# Protected hold: stop to breakeven when the row's own target is reached, then hold to the capitulation (arm P / HP; row 30 amendment A12). PRE-REGISTRATION, FROZEN 2026-11-09 night before any P / HP outcome is read

Origin: Argon's review of the A10 lead (`docs/ARGON_REVIEW_AUDIT_A10_20261109.md`): holding with the original stop and no target (C0) is stopped out in about 68 percent of rows, so replacing the target is a round trip for many trades; a protected variant that keeps the setup's own target as a TRIGGER (not as an exit) should keep the winners that already reached the target. The user's idea is to let the capitulation, not a price, end the trade; this tests whether it can be done without giving back the gains the target used to bank. No new constant: the trigger is the row's own `t1_level`.

## Arms (per real row; same entry; dollars, cost $2; roll-week / stitching rows excluded, A10.4)
- **A** = the setup's own exit (`actual_pnl`). **C0** and **H** exactly as A10.
- **P0** = hold with the ORIGINAL stop; the first minute bar whose range reaches `t1_level` (long: high >= t1; short: low <= t1) ARMS the protection; the stop then moves to the entry price from the NEXT bar on (the same bar cannot also stop out: stop is checked before the target within a bar, conservative); a breakeven stop is gap-aware (fills at the open when the bar opens beyond it); no target; exit at the expiry bar's open otherwise.
- **HP** = P0 plus exit at the next 500V open after the first same-direction EXTENDED vacuum thrust (the A10 definition) that occurs before the P0 exit, whether or not the target has been reached.
- Rows without a usable `t1_level` (missing, or not beyond the entry in the trade direction) are excluded from every P comparison and counted.

## Windows
W1 (primary): the 5,177 real 2026-06-15..2026-10-09 rows of A10 (roll-excluded). W2 (replication): the 2023-25 BACKFILL level fades of A10.3 (`a11_rows.json`; A is the synthetic backtest outcome; the BACKFILL Globex cells are unusable and excluded).

## Counted tests (family of 2, Holm 0.10 one-sided; hr-002: RTH only, Globex descriptive) on W1
- **P_R2_RTH**: ITT mean HP - A over ALL RTH-fired `at_boundary` rows with a valid `t1_level` (HP equals P0 where no thrust fired), day-blocked bootstrap (4,000). **P_R1_RTH**: the same on RTH `pivot_live` rows. Floor 100 rows on 40 days.
- LEAD gates (all required): Holm pass; lower 90 percent bound > 0; 25 percent trimmed mean > 0; mean > 0 after dropping the best day; HP beats the matched static target T unconditionally (mean HP - T > 0; T = original stop, exit at the walk-forward median excursion of earlier days' HP exits in ADR20 units, at least 10, the A10.2 construction).
- REPLICATES on W2: same sign and lower 90 percent bound > 0 and trimmed mean > 0, day-blocked (A synthetic: a weaker pass).
- MDE printed (80 percent power) in points and ADR20 vs the 0.015 ADR20 bar; above it = PARKED.
## Descriptive (not counted)
ITT tables for all strata and tracks of A, C0, P0, H, HP and the contrasts HP - A, HP - H (does protection add to H), P0 - C0, P0 - A; fraction of rows that armed; how the rows end (stop / breakeven / thrust / expiry); Globex cells.

## Next-step tree (co-022)
Lead on W1 AND replicates on W2: the arms P0 / HP are added to the forward logger (columns, `scripts/lib/holdArms.mjs` with parity check on historical rows) and ONE forward test is pre-registered; nothing live. Lead on W1 only: reported, forward arm optional on the user's go. No lead: parked with the printed MDE; the A10 / F1 / F2 forward tests continue unchanged. Autopsy: by how rows end, armed vs not, tag, track.
## Known limits (stated before data)
The two windows already supplied the idea (A10 / A10.2 looks); only W2's synthetic outcomes are independent of the W1 look; breakeven at the entry price ignores the $2 cost and slippage; the BE trigger is the setup's own target, which differs by setup type (so strata mix target sizes); SHADOW fills are theoretical.

## A12 RESULT (2026-11-09 night; look `cap_a12_register_20261109`; `scripts/vacuum_sim/capitulation_replay_a12.py --go`, log `scratch/capitulation_replay_20261109/a12_go.log`; dollars; roll-excluded)
Rows with a valid `t1_level`: W1 4,795 (the protection armed, i.e. the row's own target was reached, in 43.4 percent; extended thrust before the P0 exit in 979), W2 2,568 (armed 65.3 percent).
COUNTED on W1 (ITT HP - A, all RTH rows of the stratum, Holm 0.10): **P_R2_RTH** 591 rows / 54 days: -$3.3 CI90 [-10.2, +4.0], p 0.773; trimmed25 -$6.1; HP - T (matched static target) -$7.5; no gate passes. **P_R1_RTH** 142 rows / 46 days: **+$15.0** CI90 [+0.6, +28.6], p 0.043 (passes the Holm step), drop-best-day +$10.9, HP - T +$11.2, but **trimmed25 -$0.6**: the gain comes from a few large winners, the typical trade is flat; the trimmed-mean gate fails, so NO LEAD. MDE 3.8 pt (R2) / 10.3 pt (R1), above the 0.015 ADR20 bar for R1 (0.022 ADR20): not retire-grade.
W2 replication (2023-25 BACKFILL, A synthetic): P_R2_RTH +$19.8 [+2.3, +38.3] but trimmed -$14.9; P_R1_RTH +$68.6 [+19.2, +127.1] but trimmed -$3.1: mean positive, trimmed negative in both: REPLICATES = False for both.
DESCRIPTIVE (W1 ITT means per row, A / C0 / P0 / H / HP): R2_RTH -7.2 / -24.5 / -20.1 / -9.7 / -10.6; R1_RTH -10.7 / +5.6 / -4.1 / +13.8 / +4.4; ALL RTH -3.5 / -12.4 / -10.8 / -1.1 / -3.2. Protection alone adds little (P0 - C0 +$4.4 on R2_RTH, +$1.7 ALL RTH, -$9.7 on R1_RTH) and does not add to the capitulation exit (HP - H -$0.9 R2_RTH, -$9.4 R1_RTH); keeping the target as a trigger instead of an exit is worse than taking it (P0 - A -$12.9 R2_RTH).
READING: the breakeven-after-target variant does not fix the capitulation replacement. On defended-pivot rows a positive MEAN in both windows (+$15 / +$69) rests on a few big winners (skew, the home-run side of the user's aim), not on the typical trade; under the registered gates that is not a lead. No forward columns are built (the prereg's rule: forward arm only for a lead on W1 that replicates on W2); the A10 / F1 / F2 forward tests continue unchanged.
