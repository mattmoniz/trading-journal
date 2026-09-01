# Setup D monster-day early-warning predictors (2026-08-31)

Screened 6 candidates, all known before Setup D's 10:15am entry decision, for predicting a
"monster day" (real RTH session range >= 600pt, N=11 of 100 big-break trades).

**Independently audited after the initial dispatch — 2 real lookahead bugs found and fixed**
(see `scripts/test_monster_day_predictors.mjs`'s inline comments for the exact fix):
- Overnight Range: was joined to the FOLLOWING night instead of the preceding one. AUC corrected
  from a buggy 0.803 down to 0.697 (still real, just weaker than the buggy version showed).
- Gap Size: was computed against today's OWN not-yet-existing close instead of yesterday's.
  AUC corrected from a buggy 0.769 down to 0.534 — essentially erased, no real signal.

| Candidate | AUC | Big Day (N=11) Mean/Med | Normal Day (N=89) Mean/Med |
|---|---|---|---|
| Overnight Range (corrected) | 0.697 | 476.4 / 331.5 | 303.0 / 266.3 |
| OR Range (Raw) | 0.881 | 194.3 / 187.8 | 96.4 / 87.0 |
| OR Range (20d Pct) | 0.796 | 0.78 / 0.90 | 0.48 / 0.50 |
| Prior Day Range | 0.781 | 433.8 / 418.3 | 287.2 / 254.5 |
| Rolling 10d Vol | 0.822 | 413.4 / 421.0 | 290.1 / 259.1 |
| Gap Size (corrected) | 0.534 | 172.0 / 131.0 | 166.7 / 89.0 |

The other 4 candidates were clean, unaffected by either bug, and show genuinely real predictive
power — a pre-entry-time signal for "today will be a monster-range day" does exist.

### Decisive practical check (uses the clean OR-Range-Raw candidate, unaffected by either bug)

Splitting the 100-trade population at the median OR range (90.75):
- **Top half (≥ 90.75):** N=50, correctly captures 10 of the 11 monster days. Avg PnL=$18.79,
  Avg MFE=72.48pt.
- **Bottom half (< 90.75):** N=50, only 1 monster day. Avg PnL=$54.27, Avg MFE=64.34pt.

**Verdict**: predicting a monster day in advance is real and possible — but it does NOT predict a
better trade. The half that correctly flags 10/11 monster days has WORSE average PnL than the
calmer half. Confirms and extends `docs/COMPRESSION_TAIL_MFE_SPEC.md`'s existing finding (wide-IB
days are disproportionately TURBULENT/choppy, not clean TREND) — a predictably-wide morning
doesn't mean a cleaner, more capturable continuation for this setup, it means more chop. No
early-warning-based exit adjustment (widen target, arm a runner) is justified by this evidence.
