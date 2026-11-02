# Pre-registration: do the opposite of the tell, and the day-drift split behind it (written 2026-11-01 BEFORE any outcome)

Origin: the trader (2026-11-01): "At this point we should just wait for the tell and do the opposite." For the record, `PREREG_DIRECTION.md` already reported that the opposite of the tell was not better (tell side +2.68 per trade, opposite -3.89, random-direction placebo -0.50 with p95 +3.77; paired opposite minus tell -6.57, CI -16.12..+2.16). What that aggregate cannot show is the case the trader saw on 2026-10-30 (8 live longs into a roughly 400-point decline, 7 stopped out): fires AGAINST the day's drift, where the opposite is the with-trend side. The cue-confluence model had a drift feature but no tell-x-drift interaction, so this split is untested. Explore only (1,760 research V1 fires, 516 sessions to 2025-05-16; sealed hold-out not extracted). Script `run_opposite_drift.py`, one run. Research only; Stage 2 unchanged.

## Definitions
DRIFT at the fire = sign(close at the signal bar - the 09:30 open) (as in the cue-confluence run). A fire is WITH-DRIFT if the tell direction equals the drift, COUNTER-DRIFT if it is opposite, NO-DRIFT if zero (counted, excluded from the split). Outcomes: both sides scored with `trade.stripped` (next open plus one tick, the tell's structural stop distance for either side, 120-minute time exit, 15:55 flatten, $2 round trip), per-trade means, day-blocked bootstrap CIs (2000 draws, seeded), random-side placebo 200 draws.
## Policies (2 tests; ledger tests = 2)
- OPP: always trade the opposite of the tell on every fire.
- WITHDRIFT: always trade WITH the day drift on every fire, whatever the tell says (the tell is then only a timing alert).
Reference: TELL (the live rule). Descriptive (not counted): the four cells tell-side / opposite-side outcome within WITH-DRIFT and COUNTER-DRIFT fires.
## Reading rule (absolute dollars; 2 tests, alpha 0.025 each)
A policy "works" only if ALL hold: absolute mean > 0 with the day-blocked CI lower bound > 0; paired improvement over TELL > 0 with the CI excluding zero; mean above the placebo p95; same sign of the improvement over TELL in both chronological halves (by median date). A pass is a LEAD for one sealed look, not a result; a positive paired difference with a negative absolute mean is NOT a rule. Resolution (CI half-widths) reported either way; the COUNTER-DRIFT cell holds a minority of fires, so its own interval is wide.
## Not tested
A rarer delta flip (needs the true flips; an approximate rare flip leaves about 10 percent of fires, an interval of about +/-20 dollars per trade), the sealed hold-out, Globex, changing the live Stage 2 rule.
