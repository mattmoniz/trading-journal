# Design review — FOUR_HOUR_DEFENDED_LEVEL prereg

1. **The level is the extreme itself; it moves and reclassifies bars (fatal).** `Lf` is the lowest low of the last 12 bars, so the "level" is the very thing being tested, and it slides down as new lows print, retroactively dropping earlier "defended" bars out of the band. `K` then mostly counts how many of the last 12 bars' lows sat within `0.25*H4` of the window minimum — i.e. "price lingered near the 12-bar low," not an independently defined, defended level. **Fix:** freeze `Lf` from a disjoint prior window (bars t−23..t−12), count defenses only in t−11..t, never update during the count; add a random-walk/shuffle null showing K≥3 touches are rare.

2. **Multiple testing guarantees false survivors.** Eight counted cells after "a dozen nulls" is ~20 tests; a one-sided explore CI plus hold-out re-screening yields survivors under the null. **Fix:** collapse to 4 primary cells (volume split descriptive), pre-specify a Bonferroni/FDR gate (e.g. α/8), and make the hold-out a single confirmatory test with no re-screen loop.

3. **Overlap inflates N.** One level emits K=3, 4, 5+ events pooled for the verdict, with near-identical 1,440-minute windows. **Fix:** one event per level (first K≥3) for the verdict; cluster/block SEs by level and date; report effective (distinct-level) N.

4. **Clock-matched control misses the conditioning.** Blind same-direction entries matched on clock don't match proximity-to-extreme or break momentum, so EXCESS reflects selection, not the level. **Fix:** match controls on distance-to-recent-low and volatility, or use K=1/K=2 same-structure events at the same clock.

5. **K=1 paired control is non-exchangeable.** K=1 fires earlier and is unconditional on survival; K=3 is selected on survival. **Fix:** restrict K=1 draws to levels that later reached K≥3, and time-align the windows.

6. **Break arm selects on the move.** Entry after a close through `Lf−b` is a momentum/breakout trade; the K=1 control confounds "defended" with break size. **Fix:** control = K=1 break matched on break distance and recent volatility.

7. **Hold-rate is circular.** K≥3 already conditions on no close-through during formation; "not broken in next 12" re-measures that survival. **Fix:** report a hazard of break from level birth, comparing matched formation lengths.

8. **Volume metric is weak.** Dichotomizing at the in-sample median doubles cells and loses power, and volume is averaged over the same defended bars that define K (correlated with K). **Fix:** keep volume continuous (regression), split descriptive only.

9. **Snooped exclusions/seed.** Roll weeks and the 2025-09-28..11-19 carve-out are chosen with data knowledge; "up to 10 draws" is seed-dependent. **Fix:** pre-specify exclusions and a seed; treat both as robustness.
