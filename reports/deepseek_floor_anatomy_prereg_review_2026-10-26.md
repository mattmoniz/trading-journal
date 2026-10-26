# Design review — `FLOOR_WHEN_IT_WORKS_ANATOMY_PREREG_20261026.md`

1. **The primary outcome cannot answer "only take them then."** E1a is ret60 minus the delay-matched blind control, so a CONFIRMED cell means only "better than a blind same-delay entry," which can still be an absolute loser. The gating decision needs raw ret60 (net of costs), yet that is only descriptive here. Fix: make raw-minus-unconditional (or net P&L) the primary for any "take only then" claim, or restate CONFIRMED as licensing only a forward test scored on absolute P&L, never a gate.

2. **The explore/confirm screen does not control the forking path.** 38 correlated cells at one-sided 0.025 give ~0.95 expected false candidates as a *floor*, the features were chosen after the parent null, and the 40% is not a true hold-out. One CONFIRMED is plausible pure noise. Fix: add a max-statistic permutation null across all 38 cells, or demote everything to descriptive anatomy + forward test (drop the CONFIRMED label).

3. **Depth (feature 4) has lookahead.** "(VAL − lowest low since episode start)" uses the episode low, which the engine can push lower *after* the fire bar. Fix: pin it to the lowest low as of the fire bar.

4. **HIGHER-OR-EQUAL LOW (feature 3) is known at the fire bar but near-tautological and entangled with K arm.** The fire already requires close ≥ m·A15 above the low, so a higher low is almost a restatement of a bullish turn, and it tracks sequence position (K2 vs K3P) rather than "a bottom that held and was retested" — the retest has not completed at the fire bar. A CONFIRMED here is not evidence for the re-entry idea. Fix: stratify on K arm, mark it descriptive, and build the real post-bounce retest event separately.

5. **Calendar cells dominate and inflate multiplicity.** Day-of-week (6) + time-of-day (5) = 11 of the 19 levels, and they are the most correlated with the parent's known session/Globex lead, yet they are counted. Fix: move them to descriptive (as Session was in the context Amendment 1) and count only the 8 structure levels, or split alpha explicitly.

6. **Power is too low to confirm anything real.** Hold-out is 40% of ~365–408 days; day-of-week explore cells have 40–130 events, so hold-out halves are ~20–60 (K≥2 features fewer). "Hold-out CI lower bound > 0" will fail for true small effects while only large, noisy cells pass — winner's curse on top of selection. Fix: print per-cell smallest detectable effect and refuse CONFIRMED whenever CI half-width exceeds the explore point estimate.

7. **Conditional features break the "19 levels" accounting.** Features 3 and 6 are K≥2-only, so the cell count mixes populations and any gate cannot apply to K1 events. Fix: state each feature's applicable population and gate only on features defined there.
