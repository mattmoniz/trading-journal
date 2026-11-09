# Condensed findings of the rigor audit of Argon V0 (2026-11-08; condensed by Claude from the user's paste, which was cut off at H8)

Source: the user pasted the audit output ("Claude Rigor Audit", verdict HOLD / REVISE BEFORE STAGE 4a: 7 Critical, 8 High, 6 Medium/Low). USE THESE AS BUG FIXES TO THE V0 SPEC (`docs/ARGON_V0_PRE_AUDIT_SPEC_20261108.md`), NOT AS A REASON TO REPLACE ITS INDICATOR LOGIC. The later v2 spec replaced the logic; that is the failure the user flagged. Items marked (bug) are real defects in v0; items marked (design) are rigor opinions the user should accept or reject.

## Critical
- C1 (bug) Entry-bar phantom stop: the fill lands 15 ms after bar t closes, inside bar t+1 (or later on a fast sweep); checking `L[t+1] <= stop` with `O[t+1]` fills a stop at a price from BEFORE the entry. Fix: find the real fill bar/tick; on the fill bar evaluate the stop only on post-fill ticks; full-bar logic only on later bars; same rule after a stop ratchet.
- C2 (bug) Zero-duration 500V bars (same-timestamp sweeps) make Quantile_0.01 = 0, RawDepth = 0 and Activity divide by zero. Fix: float microsecond times; the 0.01 quantile over POSITIVE durations only; hard floor 1e-3 s. Also no 20-session prior exists on the first Explore day: burn-in (feature-only sessions before 2023-03-06, or the first 20 sessions warmup-only).
- C3 (bug) Per-wave and per-pullback variables are never reset: wave_ext_px, wave_peak_ratio, wave_peak_z_ratio, wave_ext_roc, qualified_pullback, pb_ext_roc, pb_min_ratio, pb_ext_raw_px, pb_bars_elapsed carry Wave 1 into Wave 2 (Vacuum_Divergence can then never be true; a false climax hook fires one bar into Wave 2). Fix: reset on climax hook and on bounce ignition (the audit lists the exact assignments). Also `stop_px` for entries from ARMED_FOR_REENTRY is undefined: use pb_ext_raw_px -/+ 0.25 EMA_TR capped at 2.5 EMA_TR, rounded to tick, at least 2 ticks from the fill (user decision pending, question 2).
- C4 (bug) bars_since_reset resets only at 18:00, so at 09:35 the 50-bar Bollinger windows mix slow pre-market Globex bars with fast RTH-open bars (spurious Z_Ratio spike at 09:35); the 200-bar CLV and Compression quantiles pool RTH, Globex and gaps; the hardcoded 7500 breaks under overflow='whole'. Fix: track-isolated rolling buffers or a 09:30 track warmup of 60 bars; track-matched history; replace 7500 with the actual 15-bar volume sum.
- C5 (design+bug) A resting limit with protection can fill minutes later on a failed breakout: use Limit IOC/FAK in live; UNFILLED_PROTECTION must return the FSM to FLAT; NQ signal vs MNQ execution basis (MNQ can print 0.5-1.5 pt beyond NQ in a vacuum): sanity gate and validate on MNQ ticks where they exist.
- C6 (bug) TradeMerger at live EOF flushes early (higher num_trades, different RawDepth and Ratio) vs batch; 'weekly recalibration' contradicts the daily 20-session priors. Fix: define streaming merge semantics (flush on timestamp advance) and recalibrate daily 17:00-18:00 ET.
- C7 (design) Estimand mismatches: collapseClusterSiblings vs sum(pnl)/N (use a day-blocked ratio bootstrap, N_clusters >= 150 cycle_ids on >= 60 dates, report total net dollars too); Control A pairing; Control C '-dir' is a strawman because Priority 2 liquidates -dir trades next bar (use mirror-symmetric indicators or day-permuted trigger timestamps); ATR in Stage 4a is undefined, horizons cross the close, consecutive trigger bars are not independent.

## High (summary)
- H1 static constants despite 'zero static thresholds' (Activity >= 1.0 passes about 65 percent of RTH bars; prot_pts 0.50; about 35 constants): freeze them pre-Explore and test +-20 percent; max_pb_bars self-censoring spiral (measure uncensored bounce durations, floor 20, N >= 10).
- H2 roll: crossover from completed session d-1 only; forward-accumulated additive roll offsets, not back-adjustment; compare L_adj with wave_origin_px, never raw.
- H3 CME/NYSE holidays and early closes (13:15 ET CME halt; full NYSE holidays): calendar gate, shift cutoffs.
- H4 volume-bar sampling bias in BaseDur_hour (a panic hour has 20x the bars): session-equal weighting or median of per-session means.
- H5 PULLBACK_HOLD transitions are nested inside Priority 4 (unreachable): make a separate state block with an explicit evaluation order; round_to_tick the ratchets and shadow_stop; write Priority 2's 65 percent rule on C_adj with cycle_ext_px.
- H6 multiplicity is understated: 3 entry arms x 2 continuation modes x 2 tracks = 12 arms; Stage 4a 3 arms x 3 horizons: pre-specify h = 30 as primary.
- H7 loader firewall for the sealed era (assert trade_date <= 2025-05-16); pre-register 2025-05-19..2026-10-09 as the clean sealed holdout and >= 2026-10-12 as the secondary slice.
- H8 live .scid partial-write alignment and a wall-clock staleness gate before any live order (text cut off in the paste).
## Medium/Low (titles only, text cut off): dir == 0 predicate evaluation in FLAT; intrabar stop slippage causality of Z_Ratio; sub-60-minute CME circuit-breaker halts; vague Sunday reopen prose; EMA reset seeding; SHADOW_WAVE1 counter and cutoff cleanup.

## Answers I can give the audit's five questions from the repo (user to confirm)
1. Burn-in data: `NQM3.CME.scid` starts 2023-02-24, so feature-only burn-in exists from 2023-02-24 (only about a week of the earlier 20-session window is missing): use the first 20 sessions as warmup-only.
2. ARMED_FOR_REENTRY stop: needs the user's choice (structural pb_ext stop capped at 2.5 EMA_TR, or fill - dir x 2.5 EMA_TR as M1/M2).
3. RTH buffer isolation: yes, the bug is real (C4).
4. MNQ history: `MNQ` tick files exist only for MNQM4, MNQU4, MNQZ4, MNQH5 (about 2024-03 to 2025-03); otherwise score on NQ ticks.
5. Sealed holdout: yes, end at 2026-10-09 and treat >= 2026-10-12 as the secondary slice (the repo's own confound boundary).
