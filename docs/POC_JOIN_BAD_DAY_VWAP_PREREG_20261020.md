# Pre-registration: POC_ROTATION_JOIN "VWAP gate only when the day is already losing" (written 2026-10-20 BEFORE any outcome was computed for this subset)

Origin: user 2026-10-20 after the VWAP-slope gate failed on all joins (docs/POC_JOIN_VWAP_SLOPE_GATE_PREREG_20261020.md): "what about on days where POC is losing a lot (over $400-500) -- does the VWAP guide help then?" Conditioning on the DAY'S FINAL total would be hindsight; the tradeable version is the running state known at the moment of each entry. Power warning (counts only, no outcomes, from the saved class table): joins entered while the realized same-day POC join P&L is already <= -$400: 179 joins on 60 trade dates (89 VWAP-aligned, 84 opposed, 6 flat; PRE 64, POST 115; RTH 124). This test can only detect large effects.

## Definitions
- Events, E1 realistic-fill outcome, VWAP-slope class (UP/DOWN/FLAT, ALIGNED/OPPOSED, 60-minute slope, rolling flat cut): exactly as docs/POC_JOIN_VWAP_SLOPE_GATE_PREREG_20261020.md.
- STATE for an entry = the sum of E1 P&L of EARLIER joins of the SAME trade date (the detector session 18:00 prior evening..16:59) whose exit bar index is <= this entry's bar index (realized, closed trades only; no look at open positions). The state is computed from the ungated stream of all joins (a limitation: a live gate would change later states).
- BAD STATE: state <= -400 dollars (the user's number; -300 and -500 are reported as sensitivity only, never for selection).
- Primary rule: while in BAD STATE, fire only VWAP-ALIGNED joins; ignore the others.

## Comparisons (BAD-STATE joins with a defined VWAP class only; day-blocked bootstrap 2000; per-trade mean = sum/N)
- ALIGNED minus ALL (within bad state) overall and in PRE, POST, RTH, GLOBEX; ALIGNED minus OPPOSED.
- Placebo 1: ALIGNED joins with direction flipped. Placebo 2: shuffle the UP/DOWN/FLAT labels among bad-state joins within entry session x era, 2000 permutations, one-sided p for the observed ALIGNED minus ALL.
- Tail: P(pnl >= +100) aligned vs all; top-5 events' share of the aligned total.
- Descriptive (hindsight, NOT tradeable, clearly labeled): trade dates whose FINAL total is <= -400; how the aligned-only subset of their joins would have totalled.
- Also report the account-style effect in bad state: total P&L of all bad-state joins vs aligned-only.

## Pass criteria (ALL must hold; else "the VWAP gate does not help on losing days")
1. N aligned in BAD STATE >= 60 on >= 25 distinct trade dates.
2. ALIGNED minus ALL > 0 with the day-blocked 95% CI excluding zero.
3. ALIGNED minus OPPOSED > 0 with the CI excluding zero.
4. Permutation p <= 0.05.
5. Aligned beats the flipped-direction placebo overall and in both eras.
6. Top-5 share of the aligned total < 50 percent.
7. ALIGNED minus ALL >= 0 in BOTH RTH and GLOBEX.
If it passes: a SHADOW tag and a forward recheck only. If it fails: stop; the daily-loss threshold and the VWAP window are not to be tuned to rescue it.
