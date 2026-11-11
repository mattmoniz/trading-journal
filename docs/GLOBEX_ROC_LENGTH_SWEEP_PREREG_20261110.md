# Globex vacuum: ROC length sweep 1..20 (row 37). PRE-REGISTRATION, FROZEN 2026-11-10 before any sweep outcome is read

Origin: row 36 (`docs/GLOBEX_ROC3_VACUUM_PREREG_20261110.md`) found no edge at ROC10 or ROC3 on Globex; the user asked "can we try different ROC 1-10?" then "like different variations or maybe we need 1-20" (widened to 1..20 before any run; other variations - Z threshold, hold length, band width - are a SEPARATE later registration because each multiplies the family). HONEST STATUS: lengths 3 and 10 were already read in row 36 on the same data, so this is a forking path; they are INCLUDED in the family (re-counted, same numbers expected) so the correction is not understated. Any survivor is a LEAD for forward testing only, never a promotion (explore data has now been looked at by two families; sealed > 2025-05-16 untouched and not used here).

## Design (cv-026: one variable)
Identical to row 36 arm B except the ROC length L in {1,2,...,20}: same code path (`v2.continuous` + `v2.feats` with `features.L_ROC` = L, shadow `onset` rule, `shadow.calc_outcome`, 30-bar hold, hard flat 09:29:50, one position at a time per length, cost 2.0 pt, window = current session and bar END <= 09:25 ET, Bollinger SMA50 +- 2 SD of that ROC). Explore sessions 2023-03-07..2025-05-16 only. Script: `scripts/vacuum_sim/globex_roc_sweep.py` (build / null / run), reusing the row-36 statistics functions.

## Counted family (assert 40): per L, two one-sided tests
- C_L: continuation net (signed 30-bar change minus 2.0) mean > 0.  R_L: reversion net (-signed change minus 2.0) mean > 0.
Estimator sum(net)/N, day-blocked bootstrap over event days (3000 draws, seed = 300 + L for C, 400 + L for R), p = (1 + count)/(draws + 1). Gate per cell: >= 100 taken events and >= 60 event days, else PARKED (not in the family). Holm alpha 0.10 over the cells that pass (up to 40; the price of looking at 20 lengths is a stricter bar per cell, accepted in advance).

## Null gate
200 iterations of per-day sign flips of every event's signed change, cost 0, 1000 draws, same gate and Holm over the 40 cells; family-wise false-pass <= 0.10 required before the real run. Claim `globex_roc_sweep_null_mc_20261110`.

## Descriptive, never counted (printed per L)
Events per session; pre-cost mean signed change (this is where an edge shows before the 2.0 pt cost; the cost is a fixed 2.0 pt so a pre-cost mean near +2 is the break-even line); median; thirds (chronological) sign; top-5-days share; MDE in ADR20. For the single best-by-continuation and best-by-reversion cell: its own day-cluster, mean vs median and chronological check at its exact population (hr-045). A smooth trend across L is more believable than one isolated cell (printed as the sequence).

## Next-step tree (co-022)
- A cell survives Holm AND thirds agree in sign AND neighbouring L have the same sign: register a forward shadow arm for that L (shadow.py, log only) and a replication check on the sealed window via `spendSealedLook()` ONLY on the user's go.
- Nothing survives (gate met, MDE <= 0.015 ADR20 for most cells): this is the SECOND registered null on the entry rule as a family (row 36 was the first; co-025 needs two nulls each MDE <= 0.015): the Globex ROC-onset entry is parked/retired per co-025 (only the user revives it); the M4 climax fade is the next question.
- A lead that is only in the pre-cost mean (> 0 but below the 2.0 pt cost): the exit/cost side is the question, not the length.
- Autopsy if nothing survives: pre-cost mean by L (is there any gross edge), by hour tercile, by year.

## RESULT (2026-11-10, user go; looks 242 registration / 243 run; null gate 0.045; output `scratch/globex_roc_sweep_20261110/run_output.txt`): NOT SHOWN at any length, Holm 0.10 survivors none (40 of 40 cells passed the gate)
- Build check: L=3 gave 2,046 events and L=10 1,998, identical to row 36. About 513 days, 3.8-4.1 events per session for every L.
- Pre-cost mean signed 30-bar change by L (the break-even line is +2.0): L1 +0.44, L2 +0.78, L3 +0.41, L4 +0.62, L5 -0.85, L6 -0.47, L7 -0.62, L8 -1.42, L9 -1.08, L10 -0.02, L11 +0.21, L12 -0.86, L13 +0.10, L14 +0.11, L15 -0.32, L16 +0.12, L17 -0.33, L18 -0.53, L19 -0.63, L20 -0.99. The best gross value anywhere is +0.78 pt (L2), 1.2 pt short of the cost.
- Shape: short lengths (1-4) lean slightly continuation (+0.4 to +0.8 pre-cost), lengths 5-9 and 12 lean slightly reversion, 11-20 are around zero; no smooth trend, no isolated cell; chronological thirds flip sign within most lengths.
- Best continuation net: L2 -1.22 pt (median -2.25, p 0.895). Best reversion net: L8 -0.58 (median -0.75, p 0.709; the reversion side of the 5-9 band). Neither close to Holm.
- Power: MDE 0.0095-0.0113 ADR20 for every cell (all <= 0.015). So every cell is an adequately powered null.
- Co-025 reading (stated honestly): rows 36 and 37 are both pre-registered, powered nulls on the entry rule, BUT they share the same explore events (L=3 and L=10 are re-counted) so they are NOT two independent nulls. Treatment: the Globex ROC-onset ENTRY (Z>2 on a 50-bar band, 30-bar hold, cost 2.0) is PARKED, not retired; the forward ROC3 arm stays as the only independent evidence; the user decides whether to retire. Variations still untested: the Z threshold, the hold length, the band length (each is a new registration with its own multiplicity), and the exit side (M4 / fade toward ETH VWAP).
