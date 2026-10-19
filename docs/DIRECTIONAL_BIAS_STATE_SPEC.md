# Directional bias state ("crack size + open single print + stretch") — design spec v1 (2026-10-18)

Status: DESIGN ONLY. Nothing built, nothing wired. Written before any model code, per the higher-stakes-work rule
(DeepSeek design critique first). Backing: user request 2026-10-18 after the Oct 12-16 down week.

## 1. The idea in the user's words
"The system should acknowledge the crack size and possibly gate off it: 'hey, maybe we should only fire shorts today. We
haven't had a down period in a while, and there is a sizeable single print (TPO) that needs to be filled — target shorts
only and possibly extend the target.'" Not about the crack-type SETUPS; about the SIZE of the crack as context.

## 2. What happened (the motivating week, descriptive only — n=1)
- Oct 12-16 NQ fell ~1,790 pts (31,167 -> 29,379), 5-session net = -4.4 normal daily ranges (3rd worst of 228 windows).
- Heavy legs (own trailing-40 percentile): Mon night -257, Tue night -240 (fastest 60-min drop of the week, 98th pct),
  Wed RTH -367, Wed night -410, Fri RTH -644. Wed RTH IB-low break at 10:37, speed burst from 09:57 (-144/15min, vol 98th pct).
- Open (unfilled) bullish single prints below were filled in order: 9/21 buying run 30,216-30,397 (Wed), 9/17-9/18
  29,606-29,692 (Thu), 9/16 29,304-29,373 (Fri). Next open: 9/16 buying tail 29,053-29,122.
- Roster that week (536 ACTIVE+SHADOW rows incl. siblings): shorts +3,611, longs -2,531 (counter-trend fades:
  GLOBEX_VWAP_FADE_L -1,090 etc.). Five filled POC_ROTATION_JOIN shorts were shaken out by ROTATION_FLIP (3) / breakeven stop (2)
  for ~-2 to -94 each, then ran 261-807 pts.
- Already tested at bar level, NOT supported as defined: IB break+hold continuation; heavy-Globex-leg -> later RTH; stacked heavy
  legs; speed burst alone; exit-agnostic expansion vs balance. See RESEARCH_CLAIMs *_20261018.

## 3. The question, split into testable layers
**L1 (market, bar level, FIRST per CLAUDE.md):** at a decision checkpoint, does an as-of state S(d) = {crack size in direction d,
open single print in direction d, context "stretched against d / no recent d-period"} predict a larger / more persistent move in
direction d over the rest of the session and the next session than an unconditional sign-matched, time-of-day-matched baseline?
**L2 (roster, gating):** for days/sessions where S(d) is on, does restricting the roster to direction-d trades beat the unrestricted
roster (and do counter-direction trades lose)? Declustered, ACTIVE+SHADOW as would-be-live (BACKFILL reported as a labeled
simulation arm, never mixed silently). POC_ROTATION_JOIN reported separately (10/11-12 confound).
**L3 (targets):** for aligned trades under S(d), does a wider/extended target (existing walkers: stepWiderTarget 1.5x,
t1-floor runner) beat the calibrated target? Only attempted if L2 is positive.
Order: L1 gates L2 gates L3. A negative L1 ends the thread (kill rule below), because L2/L3 would then be fitting noise.

## 4. Decision checkpoints (both sessions required)
- RTH plan: 09:30:00 ET (inputs: everything through 09:29, i.e., Globex + prior sessions). Outcome windows: rest of RTH, next RTH.
- Globex plan: 18:00:00 ET (inputs: everything through 17:59). Outcome windows: through 09:29, next RTH.
- Optional intraday update at IB close (10:30) is a SECOND stage, not part of the primary cells.

## 5. Candidate as-of features (to be reduced to ONE definition each by the critique; each fork costs power)
**Crack size C(d)** (d = sign of the move). Candidates: (a) signed displacement over the last 24h / last 3 sessions, divided by the
median daily range of the prior 20 sessions, then percentile vs its own trailing 60 sessions; (b) largest 60-min move in the last 24h,
normalized the same way; (c) number of heavy legs in the last 3 sessions (rejected: already tested). Prefer (a).
**Open single print P(d):** 30-min TPO single-print runs (>=12 pts at 0.25 ticks) from PRIOR sessions only; "open" = no later
session has traded through the far edge. Known problem found 2026-10-18: this is open in ~95% of cases because zones accumulate —
non-discriminating. Candidates to make it selective: nearest open print within K normal ranges; size >= q; age bounds; buying-tail
only (location LOW-tail of its day); largest unfilled by size*proximity. K and q must be DERIVED from the rolling distribution of
zone sizes/distances, not hand-picked.
**Stretch / "no down period in a while" S(d):** candidates: percentile of close within the trailing 60-session range;
sessions since the last 5-session decline in the worst 15% of its trailing history; slope of 20-session close vs history.
**Direction d:** sign of C; the state is on only if C, P and S all point the same way (all-three, or C+P, or C alone: report as a
monotone ladder, not three separate hypotheses).

## 6. Pre-registration requirements
- Fit window 2025-11-20 .. 2026-10-10 (clean bars; roll weeks excluded). Holdout: 2026-10-11 onward is the single confirmatory
  look, untouched. The confound boundary 2026-10-11/12 applies to any roster arm.
- Effective N: the state is rare (week-scale regimes); expect tens of events, heavily autocorrelated (a down week is ONE episode,
  not five days). Report episodes (consecutive days merged) as the unit; day-blocked / week-blocked bootstrap.
- Controls: sign-matched unconditional drift at the same clock time; matched time-of-day; label permutation by episode; for L2 a
  random-direction-of-the-day placebo (flip d at random per episode, recompute); structural-advantage check (a "shorts only" rule
  could win simply because shorts won in-window — compare to an always-short and always-long benchmark over the same days).
- K small (<=4 primary cells, Holm); everything else descriptive.
- No static thresholds: every cutoff is a rolling percentile.
- Kill rule: primary L1 contrast CI includes zero in BOTH sessions on the fit window -> stop, record, do not proceed to L2/L3.

## 7. Outcomes
L1: direction-signed move from the checkpoint price to (i) the session close, (ii) the next session close; MFE/MAE ratios; whether the
nearest open print is reached (hit rate and time-to-fill) vs a matched placebo level at the same distance on the OPPOSITE side.
L2: sum and per-trade mean of declustered roster $ for aligned vs counter vs all, by session, `origin_status` split, siblings kept
(user lens) and primaries-only reported alongside.
L3: paired delta of extended-target vs calibrated-target on the same aligned trades.

## 8. Live path if it ever works (NOT part of this build)
Observation-only tag first (`bias_state` JSON on active_setups + a quick-check line "Bias: SHORT — crack +, open print 29,3xx,
stretch +"), SHADOW-parallel hypothetical gating P&L, then a force-SHADOW gate in the existing override chain (mind the
override-order rule), RTH and Globex both. Persisted to performance_audit with a recheck path; OPEN_DECISION for wiring.

## 9. Questions for the reviewer
1. Is the three-part state a sound construct, or are C/P/S redundant / double-counting one thing? Which single feature would you test first?
2. Pick ONE definition for C, P (make it selective), S with rationale; state the rolling-percentile derivations.
3. Is the episode unit and a week-blocked bootstrap adequate, and what N makes a null informative here?
4. What confounds am I missing (volatility regime, roll-week, the roster itself changing, BACKFILL simulation, announce days)?
5. Is "shorts only" gating testable with these data or will it collapse to "shorts won in-window"? What control is decisive?
6. Which of the pre-registered cells would you drop or add?
7. Any lookahead in the way open single prints or percentiles are built as-of?
8. Risks in the eventual live path.

## 10. PRE-REGISTRATION v1 — LOCKED 2026-10-18 ~21:30 ET, BEFORE ANY RUN (Claude's own choices; DeepSeek review deferred to off-peak, after the run)
Process deviation, user-directed: the DeepSeek design critique (this spec's section 9) is NOT done first. It is dispatched off-peak
(Mon 06:00 ET or later) with the spec, code and results together. Anything it changes is a POST-HOC variant, re-run on the fit window,
labelled as such, and never replaces these locked results. The 2026-10-11+ holdout stays untouched until a final frozen definition exists.
- Data: scripts/lib/biasStateData.mjs (sessions 2025-11-20.., roll weeks dropped). Fit window ends 2026-10-10.
- Direction d at a checkpoint = sign of C. **C** = (price now - price at the same clock time 2 sessions earlier) / median full-session range
  of the prior 20 sessions (as-of). **Cpct** = percentile of |C| vs the same statistic over the prior 60 sessions. Crack ON if Cpct >= 80.
  Lookbacks of 1 and 3 sessions: descriptive sensitivity only.
- **P(d)** (print): an OPEN single-print zone on the target side of price (d down: BELOW; d up: ABOVE), loc = LOW_TAIL for d down /
  HIGH_TAIL for d up (the tail type, not interior), size >= median size of zones formed in the prior 60 sessions, and distance to the
  near edge <= 2 x the 20-session median range. Open = not fully traded through as of the checkpoint (Globex trading counts).
- **S(d)** (stretch): descriptive rung only, not a primary cell: for d down, close position in the trailing-60-session closing range >= 0.75
  AND 20-session return percentile (vs prior 120 sessions) >= 70; mirrored for d up.
- Checkpoints: RTH plan 09:30 ET (inputs through 09:29); Globex plan 18:00 ET (inputs through 17:59).
- Unit = EPISODE: consecutive qualifying checkpoints with the same d merge; the first qualifying checkpoint of an episode is the event.
- Primary outcome: direction-signed move from the checkpoint price to the NEXT session's RTH close (the "day or two" horizon),
  in points; secondary: same-session close; MFE/MAE descriptive.
- Control: for each event, the mean over all sessions at least 3 sessions away of the same direction-signed move from the same clock time over
  the same horizon (sign-matched drift). Contrast = event - control, bootstrap over episodes (5-session blocks for the control).
- PRIMARY CELLS (K=4, Holm): {RTH plan, Globex plan} x {C-only ON, C&P ON}. Incremental value of P = (C&P) minus (C-only-without-P).
- Print-as-magnet check (descriptive, P-on events): was the zone's far edge reached by the next-session RTH close, vs a mirror level at the
  same distance on the opposite side.
- Kill rule: both C-only cells CI includes zero -> L1 fails; L2 (roster gating) is then run only as exploratory, labelled non-confirmatory.
- L2 (exploratory-or-confirmatory per kill rule): roster rows from active_setups fired after the checkpoint, same session window,
  declustered (siblings kept, user lens) with primaries-only alongside; arms: all, aligned-only, counter-only; ACTIVE+SHADOW, BACKFILL as a separate labelled simulation arm;
  POC_ROTATION_JOIN reported separately; benchmarks: always-short and always-long on the same days (structural-advantage control).

### 10.1 Amendment v1.1 — 2026-10-18 ~21:40 ET, still BEFORE any run
Arithmetic check on the locked windows: the 60-session percentile baseline plus the 2-session lookback and 20-session normaliser would leave only
~130 evaluable sessions of the 213 clean ones (roughly 10 episodes per plan), too few to inform anything. Amendment, made without seeing any result:
every "prior 60 sessions" baseline (Cpct, zone-size median) is an EXPANDING window of the prior sessions up to 60, with a minimum of 25 sessions (zone-size median: 15);
S's 120-session baseline expands up to 120 with a minimum of 40. Nothing else changes. Honest consequence stated up front: even so the test has tens of
episodes at best and is underpowered for anything but a large effect; a null here will be "not detectable at this N", not "no effect".
