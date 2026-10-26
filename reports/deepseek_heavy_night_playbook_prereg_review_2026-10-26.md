# Design review — HEAVY_NIGHT_RANGE_PLAYBOOK_PREREG_20261026

1. **The control does not isolate the test/break signal.** An event needs a wide, *established* range (Hr−Lr ≥ 2·A15, extremes ≥60 min old) plus a test/break; the control is a blind same-direction entry on any same-flag night at ±30 min. E1a thus mixes "wide-range night" with "test/break adds value", leaking the same-night-range selection into the contrast. Fix: draw controls only from nights with a range *also* established at the matched checkpoint, excluding windows where a test/break is already active; add a second control (range-established, pre-trigger blind entry) to separate the test/break increment from the range increment.

2. **CONFIRMED is misleading: the hold-out is not out-of-sample.** The parent studies already saw this whole period, so the 60/40 split is a screen, yet "CONFIRMED = candidate AND hold-out point > 0 AND hold-out CI lower > 0" reads as out-of-sample evidence. Fix: rename to SCREEN-SURVIVOR; reserve "confirmed" for ≥20 untouched forward tripwire days (already the stated next step). Never print CONFIRMED for an already-mined window.

3. **Multiplicity is understated; the 16 cells are not independent.** ALL = HEAVY ∪ NOT (redundant), HEAVY-minus-NOT is a linear combination of them, and S1/R1/B1/B2 share nights and overlapping 60-min windows, so "tested × 0.025 ≈ 0.4" is a floor, not the false-candidate rate. Fix: demote ALL to descriptive (count only 8 group cells + 4 contrasts) and add a joint max-statistic permutation null, as the parent's Amendment 1.3 did.

4. **HEAVY-minus-NOT is confounded and not the question asked.** NOT-HEAVY events already passed the ≥2·A15 range screen (wide range but not heavy — an atypical subset), so it does not measure "heavy helps"; the user's claim is S1/B1-on-HEAVY E1a, not heavy-vs-not. Fix: drop HEAVY-minus-NOT to descriptive; primary = HEAVY E1a vs control.

5. **HEAVY-flag spec gap (lookahead in matching).** The tripwire flag is causal (verified: bars `< cutoff`, baseline strictly prior), but the playbook never pins that the flag is re-evaluated at the fire bar's last completed checkpoint, nor that a control's "same HEAVY flag" is classify() at the *same checkpoint minute*. A whole-night label would be lookahead. Fix: state both explicitly.

6. **Running-range "reset" is ambiguous (lookahead).** "Regime resets (new Lr) if any bar's low < Lr − p" is undefined while Lr descends each bar; frozen-at-test-start vs current-running Lr changes which tests reset, and a later-Lr reading is lookahead. Fix: freeze Lr/Hr at test start; reset on the first bar whose low breaches the frozen Lr − p.

7. **Event overlap and thin cells.** S1 and B1 (and mirrors) fire on one night with overlapping ret60 windows; HEAVY ≈ 14% of nights. Fix: print events-per-night and window-overlap share; night-block the hold-out CI, not just explore.

8. **ret60 is 59 minutes** (close of the bar 59 later). Consistent with the parent, but label it ret59 or state the off-by-one.
   ⎿ ok
Review complete. The design critique is written to `scratch/deepseek_response.md` (468 words, 8 numbered findings, most serious first, each with a concrete fix).

Summary of findings:

1. **Control doesn't isolate the test/break signal** — it must be matched on range-establishment, not just flag+clock.
2. **CONFIRMED is misleading** — the hold-out is a screen of an already-mined window, not out-of-sample.
3. **Multiplicity understated** — the 16 cells are non-independent (ALL and HEAVY-minus-NOT are linear combinations).
4. **HEAVY-minus-NOT is confounded** and isn't the user's actual question.
5. **HEAVY-flag spec gap** — the checkpoint-matched flag vs. whole-night label isn't pinned (lookahead risk).
6. **Running-range "reset" is ambiguous** — Lr must be frozen at test start (lookahead risk).
7. **Event overlap / thin cells** — night-block the hold-out CI too.
8. **ret60 is 59 minutes** — off-by-one label.

I verified the tripwire flag and rotation-leg detector are causal in the source (`server/services/overnightTripwire.js`, `rotationDetector.js`), so the lookahead findings are spec-gap issues rather than code defects.
