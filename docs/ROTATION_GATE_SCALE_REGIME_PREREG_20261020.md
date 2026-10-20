# Pre-registration: volatility-scaled, regime-aware rotation-direction gate (written 2026-10-20 BEFORE any scale/regime result)

Origin: user 2026-10-20 (after the fixed 65pt gate failed the 3.5-year replay, docs/ROTATION_GATE_ROSTER_REPLAY_PREREG_20261020.md): "the gate struggles when the market is driving ... the context matters ... its not 65, if vol is high maybe we need to increase the gate." Their second screenshot (11:23 ET) shows the system's own regime reads: EXPAND HIGH, MOMENTUM CHASE (PDH/PDL breakout) active, wide IB, 512pt range. Evidence that motivates it: the fixed-65 replay was positive before 2025-06 (+3.5/trade) and negative after (-2.9; 2026 -4.7), while NQ doubled (65pt = about 0.5 percent of price in 2023, 0.2 percent now) and the fixed 65 fires about twice as often now (see scripts/study_poc_join_scale_check_20261020.mjs). That is exactly what a scale mismatch would produce, so this tests it directly instead of treating the gate as one pooled number.

## Design (explore -> hold-out; selection uses ONLY the explore half)
EXPLORE = trade dates 2023-03-06..2024-12-31. HOLD-OUT = 2025-01-01..2026-10-16 (never printed in the selection stage).
Population/outcome: the RTH level-fade replay of the fixed-gate pre-registration (first touch per level per day, REALISTIC fills, today's OPTIMAL_STOP stop/target, roll days skipped), each touch tagged with the in-progress rotation-leg direction at the touch bar close (confirmed leg idx <= touch bar, 18:00-anchored detector session, `detectRotationLegs`), AGREE = (leg UP) == (trade LONG).
### Scales (the gate's rotation size; all point-in-time)
R(k, d) = k x ATR20(d), ATR20 = mean RTH range of the 20 sessions before d. Grid k in {0.10, 0.15, 0.20, 0.30, 0.45} (about 35-160 points at ATR 350; the fixed 65 is about k = 0.19 today and 0.30 at the 2023 ATR). The fixed-65 gate is reported as the reference. (k=0.19 was NOT added to the grid after seeing anything; 0.20 is the nearest.)
### Regime variables (point-in-time at the touch bar)
- VOL regime: ATR20(d) against the terciles of ATR20 over the 250 sessions before d: LOW / MID / HIGH.
- DRIVING: developing RTH range (high - low from 09:30 through the touch bar) divided by ATR20(d) is at or above the 67th percentile of the same ratio at the same minute of the day over the 60 previous sessions (an expansion read; the system's EXPAND HIGH analogue). Otherwise BALANCED.
- Descriptive only (not used in selection): PDX = close beyond the prior-day high or low (the momentum-chase PDH/PDL breakout state); wide-IB.
### Selection rule (explore half only, mechanical)
For each of the 6 regime cells (VOL tercile x DRIVING/BALANCED) and each k: AGREE minus DISAGREE per-trade mean on EXPLORE touches in that cell (day-blocked). Chosen option per cell = the k with the largest AGREE-minus-DISAGREE provided N AGREE >= 300 and N DISAGREE >= 300 in that cell and the value is > 0; otherwise OFF (no gate in that cell). Also record the best single k pooled across cells (the "scaled single gate").
### Hold-out evaluation (one adaptive rule, applied exactly as chosen)
Adaptive gate: in a cell with chosen k keep only the AGREE touches (direction judged at that k); in an OFF cell keep every touch. Compare on HOLD-OUT: KEPT mean vs ALL mean vs the fixed-65 gate's kept mean (AGREE-only) and vs the scaled single gate.
## Pass criteria (ALL on the hold-out)
1. N kept >= 1,500.
2. Adaptive KEPT minus ALL > 0 with the day-blocked 95% CI excluding zero, and > 0 in both 2025 and 2026.
3. Adaptive KEPT minus ALL exceeds the fixed-65 gate's (AGREE-only minus ALL) on the same hold-out, and the paired difference CI excludes zero.
4. Placebo: for each cell keep a random subset of the same size (2000 draws within cell x direction); one-sided p <= 0.05 that the adaptive KEPT mean is as high.
5. Adaptive KEPT beats the same kept entries re-simulated in the opposite direction (flipped placebo) overall and in both years.
6. KEPT total P&L positive and its top-5 trades under 50 percent of it.
Informational: whether KEPT mean itself is above zero (does the adaptive gate make the roster profitable), by VOL tercile and by DRIVING, and polarity (in which cells DISAGREE beat AGREE in the explore half).
If it fails, the gate stays a tag and the "scale/regime" idea is closed for level fades at these definitions (no re-tuning k or percentile cuts). If it passes: a SHADOW-only frozen tag, forward recheck, and only then a Globex counterpart (not covered here).
