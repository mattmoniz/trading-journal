# Design review — stuffed big orders AT defended pivots

1. **Pivot-set survivorship (most serious).** "Active at T" requires the pivot to be un-replaced and un-broken at t_ref, and the accepted set comes from a walk over the whole sample. A stuffed SELL at a LOW that later keeps falling is exactly the order whose low gets broken/replaced by a lower low and drops out; a bounce that holds is kept. Selection and outcome sign are mechanically linked, so a positive mean is survivorship, not edge. Fix: build the active set causally by truncating bars at t_ref and re-running walkZigZagAcceptance on the truncated series (not "record replacement in the full run"); report N dropped by the un-broken/replacement rule, plus a sensitivity where any ever-defended pivot counts.

2. **AT-LEVEL "last print" is leaky.** A sell's "at a low" and its "stuffed" both reduce to "last print near the low, then price ticked up 2+"; the same bounce produces the defense and the label, so the 5/15/30-min return is autocorrelation of that bounce, not an independent edge. Fix: anchor the level to the order's first print or VWAP, exclude the t_ref bar from the defending-touch set, and print the mirror cells (sell-at-high, buy-at-low) as a sign-placebo that must sit at ~0.

3. **Control A is incoherent/starved.** "FOLLOWED at a DEFENDED, un-broken level" is near-contradictory: a follow-through breaks the level, so A samples broken levels, not "the level alone." Fix: use a within-level contrast (stuffed vs followed at the same defended, still-unbroken-at-t_ref level) and match on pivot age/time-since-defense, not just side×clock×size.

4. **Order clustering / non-independence.** Many 70+ prints per minute share one outcome and one pivot (the 297 order alone = 250 prints); day-blocking treats them as independent. Fix: collapse to one event per (day × level × side × minute cluster) and run a cluster-blocked bootstrap; report effective-N and per-episode order count.

5. **Definitions diverge from the live detector.** Active/broken ("close beyond band since confirmation") and defended ("leave band to 0.1×D20") are new inventions, not minorDefendedLevelDetector's own touch/BREAKING state machine; "same settings" holds only for the 0.25×D20 and 0.02×D20 constants. Fix: reuse the live state machine verbatim, or run it as a mandatory sensitivity.

6. **Multiplicity and prior.** 2 cells × 3 horizons, sensitivity runs, and the fourth big-order study on the same 63k orders after a ~0 unconditioned null; the explore/hold-out is quasi-out-of-sample because definitions were tuned to the user's chart. Fix: promote the single 15-min contrast as primary with family-wise control, treat hold-out as descriptive, and let only the 2026-12-15 forward look be citable.

7. **Minor.** Band 0.02×D20 ≈ 8pts is non-selective ("many orders near some pivot"); ATR families mix full-day D20 (band) with RTH ATR20 (outcome). Fix: add a wider-band sensitivity and unify the ATR source.
