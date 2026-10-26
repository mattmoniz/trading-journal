# DeepSeek review — two four-hour moonshot/picks pre-registrations

## Test 1: moonshot exit

1. **Date-boundary leakage in the screen.** Events are split explore/hold-out by confirmation date, but the 1,440-min outcome (and its control windows) crosses the cut, so explore events read hold-out prices. Fix: assign each event by its exit date and drop any event whose window straddles the boundary.

2. **Control matches clock+direction but not price location.** Blind same-clock entries can sit mid-range; the event enters at a freshly defended extreme, so the excess may capture mean-reversion at a recent low/high, not defense. Fix: add a second excess vs the K=1 fresh-low/high birth events (already specified for the companion study) with the same clock and exit.

3. **Overlapping 24h holds defeat independent-N.** Date-blocked CI assumes day blocks, yet a few trending days can drive many events; top-5 share is printed but not tested. Fix: require leave-one-date-out mean and that the effect survives dropping the top date; state effective distinct dates.

4. **Hold is not guaranteed 1,440 min.** The shared walk() uses cap = capIdx(days[di+2]) (RTH close), not i0+1439, and no target depends on tgtDist=Infinity being benign. Fix: pass cap=i0+1439 explicitly and assert the target is disabled.

5. **Usable-verdict double gate is uncorrected.** Excess CI>0 AND absolute net>0 adds a second condition on one cell beyond the Bonferroni-over-2 screen; a survivor can be declared unusable (or vice versa) and the joint false-positive rate is unstated. Fix: pre-specify one joint one-sided criterion and its rate.

## Test 2: blind rating

1. **Era/date leak despite hidden absolute price.** Candle bodies and volume are rendered in raw NQ points/contracts, which differ ~4x between 2023 and 2025; a 5-day shape plus volume level lets the rater place the era and recognize famous days. Fix: render candles in D20 units and volume as a slot ratio only; force recognized days to be flagged and reported with/without.

2. **Diff-in-diff power is overstated.** TAKE-minus-ASIDE on the excess roughly doubles the SE; the quoted 0.15-0.25 D20 half-width is optimistic for a difference of differences. Fix: print the realized difference half-width and the minimum detectable effect in difference units.

3. **No minimum-bucket / UNDERPOWERED rule.** 60 events split 30/30 then TAKE/ASIDE/UNSURE; if ASIDE is about 6 the contrast is noise, yet no floor exists (unlike Test 1). Fix: void if min(TAKE,ASIDE)<15 or <15 distinct dates; state the rated count.

4. **CI date-blocked but permutation is not.** Reshuffling call labels across correlated same-day events breaks exchangeability. Fix: date-blocked permutation (shuffle whole-date label vectors).

5. **The out-of-sample mechanical-rule check is not out-of-sample.** UNSEEN events are the same mined history, and the rule is derived after seeing the point estimate. Fix: call it a same-sample split, or pre-specify the rule before any outcome is seen.

A null is honestly framed (not shown); but a SCREEN-SURVIVOR or the rating CANDIDATE lead is still the same day-mined history, so both should be read as leads needing forward data, not confirmation.
