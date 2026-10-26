# Critique: NQ-ES divergence reversion pre-reg (2026-10-26)

Lookahead itself is clean: beta/scale/cutoff are prior-20-day, and entry is at the open of t+1 (= close of t, no peek). The problems are below, most serious first.

1. **The placebo does not control the bar-close artifact.** Non-synchronous closes produce a *sign-consistent* fake divergence: if NQ's close is systematically fresher than ES's, NQ's minute return leads ES's next minute, so the apparent divergence reverts in exactly the -sign(z) direction. A random-*direction* placebo flips the sign, so its mean is ~-costs and it cannot detect a sign-locked clock bias; H=1-3 cells only show the reversion is short-lived, not that it is untradeable. **Fix:** re-run the primary with open-to-open (or midpoint) returns and with ES shifted +1/-1 minute; require the edge to survive open-to-open and to die under the lag shifts, and report the lag+-1 correlation check.

2. **Refractory (30 min) < L (<=60) and is per-direction.** Overlapping L-minute windows re-trigger on the same move (inflating non-independent N), and opposite-direction trades can run concurrently, silently hedging so per-trade mean != realized single-contract P&L. **Fix:** cooldown >= L (one event per independent move), forbid a new entry while a position is open, and report realized concurrent P&L.

3. **Cost model is optimistic for the edge size.** 0.25/side (one tick) assumes a same-tick fill, and open t+1 = close t gives near-zero signal-to-fill delay, understating real costs against a "few-point" edge, especially Globex. **Fix:** sensitivity at 0.5 and 1.0 slippage/side and an explicit one-tick-adverse delayed fill; report net under each.

4. **Grid/multiplicity is under-specified.** 56 cells x 2 sessions = 112; the "plateau rule" and "not contradicting" are not executable, letting a noise cell be eyeballed into SHOWN, and the 97.5th-percentile placebo gate is not Bonferroni'd across sessions. **Fix:** pre-specify exact rules (>=2 of 3 neighboring H at fixed L,c and >=2 of 3 neighboring L at fixed c,H all positive; "not contradicting" = other session's CI upper bound > 0); print every cell with a CI; use a 99% placebo threshold.

5. **Placebo mechanics.** 200 trials gives a coarse tail and does not resample the day clustering of events, so the null's variance is wrong. **Fix:** >=10,000 day-blocked trials.

6. **Decomposition is an identity but can misattribute.** It uses a *stale* prior-day beta, and "who catches up" is beta-relative, not raw ES points, so intraday beta drift can push the catch-up onto the wrong leg. **Fix:** state the fixed-beta assumption, report both legs raw and beta-adjusted, and add a rolling prior-window beta variant.

7. **No power/MDE is pre-registered.** With edge ~= cost, NOT SHOWN is likely a Type-II miss, and reading "which leg moved" from a null is unsound. **Fix:** pre-compute expected N, per-trade variance, MDE, and power; report MDE with every NOT SHOWN.

8. **Explore/hold-out split.** Chronological 60/40 can be a regime, not a replication; "both positive" is weak. **Fix:** report each split's CI and require point-estimate sign agreement, not just positivity.
