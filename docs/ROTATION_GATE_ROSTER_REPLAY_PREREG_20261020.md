# Pre-registration: the 65pt rotation-direction gate on the 3.5-year RTH level-fade replay (written 2026-10-20 BEFORE any gate outcome on this population)

Why: the gate (server/services/rotation65ptGateShadow.js; AGREE = the trade's direction equals the direction of the CURRENT, in-progress 65pt rotation leg) is the only roster filter with a consistent tilt: corrected 2026-10-12 backtest +11.89 dollars/trade pooled (both group CIs crossed zero), live tags since 2026-10-09 (8 days, 817 decided trades): AGREE -2.8 vs DISAGREE -3.3 per trade overall, RTH +4.1 (CI [-12.5,+17.1]), GLOBEX -17.5, AGREE better on only 3 of 8 days (the last two strongly). The live record is too short; this tests the same gate on a population about 25x larger. The rotation direction is price-only (zigzag of highs/lows), so the 2026-10-20 volume-omission finding does not affect it; the earlier no-volume mistake does not apply here because no profile/convergence is used.

## Population and outcome
RTH level-fade touches replayed over 2023-03-06..2026-10-16 exactly as scripts/study_roster_replay_20261019.mjs (first touch per level per day within 15 points of a level in `level_prices` that has a live OPTIMAL_STOP row for the direction; direction = SHORT fade if close[i-5] < close[i] else LONG fade; entry = touch bar close; formation gates; entry from 09:35 to 15:59; stop/target = latest OPTIMAL_STOP rounded; REALISTIC fills: a stop beyond the market fills at the bar open, a target fills at max/min(target, open); resolve to 15:59, mark to market; $2/pt, $2 round trip; roll days (|PD_CLOSE - prior RTH close| > 0.1 ATR20) skipped). Limitation: level fades only (not IB, C, TRT or other families) and today's stops/targets applied to history.
Rotation direction at the touch: the direction of the most recent 65pt leg CONFIRMED by the touch bar's close (confirmed idx <= touch bar index) in the detector session that runs from 18:00 of the previous evening (`detectRotationLegs`, server/services/rotationDetector.js, R=65; equivalent to the live gate's `all_leg_records.at(-1).direction`, verified on >= 200 random (date, bar) samples against `detectSignalEvents` truncated to that bar before the main run; any mismatch is reported and stops the test). No confirmed leg yet = no tag (excluded from AGREE/DISAGREE, reported). AGREE = (leg UP) == (trade LONG).

## Comparisons (all day-blocked bootstrap 2000; per-trade mean = sum/N)
- AGREE minus DISAGREE, overall and in PRE (< 2025-06-01) / POST and by calendar year.
- AGREE-only roster mean vs zero and vs ALL tagged trades (does gating turn the roster positive?).
- Placebo 1 (flipped direction): the AGREE trades re-simulated in the opposite direction with the same stop/target distances. Placebo 2: shuffle AGREE/DISAGREE labels within trade date x trade direction (2000 permutations), one-sided p for AGREE minus DISAGREE.
- Top-5 share of the AGREE total (must be a positive total to pass); P&L effect of a size rule (AGREE x1, DISAGREE x0.5) vs ALL, descriptive only.
- Also report descriptively: the same comparison by level family and the exempt-type sensitivity (none apply to level fades).

## Pass criteria (ALL; else the gate is not supported on this population)
1. N AGREE >= 2,000 and N DISAGREE >= 2,000.
2. AGREE minus DISAGREE > 0 with the overall CI excluding zero, and > 0 in both PRE and POST.
3. Permutation p <= 0.05.
4. AGREE mean beats its flipped-direction placebo overall and in both eras.
5. Top-5 share of the AGREE total < 50 percent of a positive total.
Informational (not a pass condition): AGREE-only mean vs zero; the size-rule effect.
Scope note: this covers REGULAR HOURS only. The Globex gate behaviour (live tags point the other way) needs its own replay of the _OVERNIGHT roster and is not claimed here. If this passes, the next steps are a SHADOW-only RTH frozen tag with a forward recheck and a multi-scale agreement test; if it fails, the gate stays a tag and nothing is promoted.
