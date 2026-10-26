# Design review: MULTIDAY_DROP_FLOOR_CONTEXT prereg

1. **Selection is circular (most serious).** CONTEXT's FLOOR ("retest within 1 A15 after leaving >=2 A15") is the textbook entry trigger for the level-fade setups (FLOOR_S2, PD_LOW, PW_LOW, MONTHLY_VWAP_FADE_LONG) that dominate the roster. So CONTEXT ~ "setup fired on an actual floor," and CONTEXT-vs-OTHER mostly tests whether a fade does better when its own premise holds, not whether the drop+floor picture predicts wide-stop longs. The moonshot-like cell is one setup (MONTHLY_VWAP_FADE_LONG), so any survivor is a single-setup claim. Fix: compare the setup's forward return against a blind long in the same drop+floor regime without the setup firing, or against a non-fade wide-stop setup in the same context; state the single-setup limitation.

2. **Clock-matched control doesn't match the regime.** Matching only clock (other days, +/-30 min) leaves the post-drop mean-reversion bounce in the "excess," so the effect is confounded with the drop itself (the exact error the doc says it is correcting). Fix: match the control on a similar prior drop (and/or floor) magnitude, same instrument, same start price; report drop-only excess as baseline.

3. **BACKFILL optimism is state-dependent.** They read only the difference, but a simulated "fill at the level" is closer to reality at a retested support (CONTEXT) than in fast breakouts (OTHER), so the difference is still biased. Fix: make ACTIVE+SHADOW the primary read, or model fill realism/queue, or restrict entries to levels actually traded through.

4. **Lookahead at the fire minute.** DROP uses "close at the fire minute," which closes after fired_at. FLOOR's "no bar since" must also exclude the fire-minute bar, or the floor/retest can be established by the fire minute itself. Fix: use only bars with timestamp < fired_at for every term (close of the prior minute).

5. **Overlap: effective N is floors, not rows.** is_cluster_primary dedups one setup's cluster, but different setup_types firing off the same floor at the same minute are all kept, so one market event contributes many rows. Day-blocked bootstrap doesn't handle within-day/floor clustering. Fix: cluster at the floor-event (or fire-minute + level), or subsample one row per floor.

6. **Multiplicity + SCREEN-SURVIVOR is not a clean confirm.** Four cells with no correction; "explore CI LB > 0" selects winners and biases the hold-out point (regression to the mean), and the hold-out isn't independent because the tercile/A15/window knobs were mined on the same history by the floor studies. Fix: preselect one primary cell, Holm/Bonferroni across cells, pre-specify knobs, and use a permutation null for the survivor gate.

7. **Power.** 100-250 CONTEXT rows -> 60-150 explore, then split by setup_type -> very few per cell; "<20 distinct dates" is too lenient. Fix: pre-specify a minimum per-cell N/effect size; pool setups or horizons, or drop the hold-out split and report CI half-width only.
