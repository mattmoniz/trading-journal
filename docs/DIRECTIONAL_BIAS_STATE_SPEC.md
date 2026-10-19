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

## 11. RESULTS v1 (2026-10-18 night; locked definitions 10 + 10.1; fit window to 2026-10-10)
**L1 (market level, bar data) — FAILS the pre-registered kill rule.** RTH plan: crack-ON episodes 24 (9 with an open tail print): C-only event-minus-control -5 pts
(CI [-167,+158]); C&P -121 (CI [-277,+26], n=9). Globex plan: 27 episodes (11 with print): C-only -80 (CI [-296,+149]); C&P -167 (CI [-544,+280]). Holm-adjusted
p: 0.42 / 1.0 / 0.93 / 0.97. After a crack the next-day move did not continue in the crack direction in this sample (a strong bull year: NQ ~24.9k -> ~31k;
down-cracks were mostly bought). Exploratory descriptives: Globex crack-DOWN (n=11) aligned move -396 pts at H2 (i.e. a rebound), raw p=0.009, NOT primary, not
corrected. Print-as-magnet: far edge of the open tail print reached by the H2 close 22% (RTH plan) / 36% (Globex plan) vs the mirror level 67% / 55% — the open
prints did NOT act as magnets here (n=9/11). The state's S rung had ~0 events (descriptive only).
**Holdout week (printed only):** the state was ON for the RTH plan on Tue 10/13 09:30 (Cpct 88, open tail print 30,357-30,405 ~215 pts below) and for the Globex plan
on Wed 10/14 18:00 (Cpct 93, no qualifying print); follow-through H2 = +435 and +760 pts in the crack direction. One episode; the fit-window average does not
support relying on it.
**L2 (roster) — exploratory only (L1 killed).** SIM (BACKFILL, a simulation) RTH plan, crack-ON: aligned $30.9/trade (n=220) vs counter -$12.6 (n=389), aligned-counter
+$43.5 (episode CI [14,73], perm p=0.023; W2 +$22.8, p=0.001), symmetric by crack direction (DOWN +40.6, UP +49.0). REAL (ACTIVE+SHADOW since 2026-07-09) RTH plan: 6 episodes,
-$8.0 (CI [-22,16]). Globex plan: SIM +$11.7 (p=0.26), REAL +$8.5 (p=0.68). POC_ROTATION_JOIN: too few rows in crack-ON windows to say anything.
**L2b dose-response control (decisive for "crack SIZE"):** RTH plan SIM, per-session with-direction minus against-direction $/trade by Cpct bucket: 0-40 +34.7, 40-60 +16.9,
60-80 +8.2, 80-100 +44.1; Pearson(Cpct, effect) = -0.02; ALL sessions +26.9 (CI [16,40]). So the roster's with-the-2-session-direction advantage exists on ordinary days
at the same size; the crack adds nothing detectable. REAL arm RTH: ALL +4.3 (CI [-13,20]), flat. Globex plan: SIM flat-ish positive (r=+0.13), REAL r=+0.28 (0-40: -15.0; 80-100: +21.1, 10 sessions) —
the only dose-response hint, thin.
**Reading:** (1) "Crack size predicts a larger continued move" — not supported at market level. (2) "Gate to the crack direction" — in the simulated roster, trades aligned with the prior
2-session direction beat counter trades regardless of crack size; this is a different, broader hypothesis (a multi-session version of the existing observation-only DirGate/MomFade
idea), it does NOT replicate in the real/shadow era for RTH, and its simulation arm needs independent verification (BACKFILL quirks) before anything is built. (3) Nothing is wired.
Held back until the off-peak DeepSeek review of the whole process: any redefinition is post-hoc and must not replace v1.

## 12. POST-HOC REVIEW + ARTIFACT CHECKS (2026-10-19, off-peak DeepSeek review; section 11 results above are UNCHANGED and remain the locked v1 record)
DeepSeek (full-process review, scratch/deepseek_response_bias_review_20261019.md): no lookahead found in the as-of construction; kill rule legitimate; what was
killed is "2-session momentum continuation", not "crack size" (C = 2-session return, so d = sign of the prior 2-session direction); nothing should be built;
SIM-vs-REAL discrepancy is the open question, leading hypothesis BACKFILL artifact (marked by the reviewer as speculation).
Claims audited against code/data: (1) Globex primary horizon: spec wording "next session's RTH close" is ambiguous; code uses the second RTH close after the 18:00
checkpoint (S[i+2]); the first-RTH-close horizon (H1) numbers were already printed and give the same null (GLX C-only -90, CI [-229,41]; C&P -125, CI [-425,161]). Not material.
(2) i.i.d. episode bootstrap vs pre-registered blocking: re-done with a calendar-week CLUSTER bootstrap (scripts/study_bias_state_l2c_artifact_checks.mjs): RTH C-only -5 [-167,153],
RTH C&P -121 [-269,23], GLX C-only -80 [-302,150], GLX C&P -167 [-550,284]: essentially unchanged, null stands. (3) drift control pools other crack-ON sessions: conservative, not material.
(4) confirmed (core confound, already in section 11). (5) BACKFILL artifact: tested three ways. The SIM RTH effect is NOT the known BACKFILL timestamp bug (excluding VWAP_MAGNET types: +29.8 vs
+26.9), NOT a time fluke (first half +23.0, second half +30.7), NOT one-directional (crack DOWN +33.7, UP +21.7). But it does NOT replicate in the real era for the same setup families
with adequate N: OR5_HIGH_FADE SIM +41.0 (n=38/51) vs REAL -2.1 (n=89/84); OR5_LOW_FADE SIM +35.9 vs REAL +2.3 (n=94/53); PD_VAL_FADE SIM +39.9 vs REAL -4.6 (n=47/42); PD_POC_FADE SIM +78.1 vs REAL -0.4
(n=33/23); mixed elsewhere (OR30_HIGH_FADE REAL +57.1 n=33/34; OR10/OR15 negative). The SIM/REAL same-day overlap is only 5 (type,day) cells: uninformative. Reading: a simulation-era effect that vanishes when the same
families are traded for real; consistent with a BACKFILL artifact or a regime change, not distinguishable here. Do not build anything on it.
Part 2 (ML scoring supervisor): the "double restart timer" is latent, not live (the watchdog only kills a child that exists, so a backoff timer can't coexist with a watchdog kill; startMlScoringService is called once at boot) but the guard
was added anyway (spawnChild returns if a child exists and clears a pending timer); stopMlScoringService now SIGKILLs; the banner now shows "unknown" (yellow) before the first health check and a red line for any ML-gate fail-closed event in the last
10 minutes (covers /health OK but /score wedged). Visibility only; the gate's decisions are unchanged.
Decision: the observation-only bias_state tag planned for 6:07 AM is NOT built (the review and the artifact checks give a strong reason not to; crack size has no support and the aligned-direction effect does not replicate in REAL).
