# Decisions Log

## 2026-08-05 (same day, third pass) — live-capital approvals + check [8] methodology fix

1. **`noise_floor_stop_revert_pending_dbwrite` APPROVED and executed.** `GLOBEX_VWAP_FADE_SHORT`
   (10pt) and `PD_CLOSE_FADE_LONG` (14pt) reverted to their last known non-degenerate values
   (33/40 and 32/60 respectively — independently re-verified against full `OPTIMAL_STOP` history
   before running, matching the already-written script's values exactly). Backup table
   `optimal_stop_noise_floor_revert_backup_20260805`. `test_invariants.mjs` check `[13]` clean
   after.
2. **`stop_sweep_long_calibrated_target_pause_or_keep` — PAUSED, both LONG and SHORT.** The
   original decision only named `STOP_SWEEP_LONG`; checked `STOP_SWEEP_SHORT`'s `origin_status`
   mix directly (13 SHADOW + 4 UNKNOWN, zero BACKFILL — same real-dominated profile as LONG) and
   paused both for consistency, not just the one named in the flagged decision. Reverted
   `server/routes/acd.js` to the flat 30pt target for both; stop stays structural (unaffected).
3. **Cascade breaker validation dispatched to Gemini, and its "genuine discrimination" framing
   was WRONG on independent re-verification.** Gemini's response file arrived truncated/corrupted
   (missing sections 1-3 and the day-by-day breakdown) — read and ran its actual script
   (`scratch/cascade_analysis.js`) directly rather than trust the summary, per standing practice.
   Real finding: cascade suppression only outperformed the normal population on 1 of 7 days
   (2026-07-29) and was neutral on 1 more (07-31, a systemic bad day for both populations); on
   the other 5 days — including today — suppressed trades had BETTER EV than what fired normally.
   The entire aggregate case (-$7.27 EV suppressed vs -$0.76 normal) rests on the single 07-29
   outlier (136/410 = 33% of the suppressed sample); excluding it, suppressed-pool EV flips to
   +$5.01/trade. `RESEARCH_CLAIM cascade_breaker_validation_single_day_artifact` (PROVISIONAL),
   `OPEN_DECISION cascade_breaker_validate_or_remove` (HIGH) — not resolved unilaterally, this
   gates live entries for every fade setup_type.
4. **`sweepOptimalStopAndTarget()`'s order-blind EV check** (the root cause blocking
   `rth_holdout_test_needs_chronological_evaluation`) — design critique dispatched to DeepSeek
   before writing the fix, per the standing phase-0 rule for anything touching the core
   calibration engine every live setup_type depends on. Proposed approach: reuse the exact
   bar-loading + `resolve()` pattern already proven in
   `calibrate_overnight_optimal_stops_fresh_holdout_20260720.mjs` (load bars once per
   setup_type's trade population, re-index each trade to its bar-array position via
   minute-floored `fired_at`, call the shared chronological `resolve()` per stop/target
   candidate instead of the order-blind `mae_points`/`mfe_points` comparison). Not yet
   implemented — waiting on DeepSeek's critique before coding.
5. **Stop-side `origin_status` filter (Phase 0.3) — confirmed missing, deliberately NOT
   patched yet.** `update_optimal_stops.mjs`'s `rawRes` query (feeds `rawByType`, the STOP-side
   sweep population) has zero `origin_status` filter — only the separate target-only
   `rawResExpanded` query got this filter on 2026-08-02. Per this codebase's own established
   precedent for this exact class of change (see the circuit-breaker entry in CLAUDE.md:
   "must ship as a deliberate one-time re-baseline... never a quiet formula tweak on a normal
   nightly run"), this should NOT be patched in isolation right now — it collides with item 4
   above (both feed the same sweep), and applying them separately would mean two disruptive
   re-baselines instead of one. Sequenced to land together once the order-blind fix is ready.
6. **`test_invariants.mjs` check [8] had a real methodology flaw, now fixed.** It compared every
   one of the last 10 real fired trades against a single LATEST `OPTIMAL_STOP` snapshot,
   regardless of when each trade actually fired — calibration legitimately drifts over time
   (`CAM_R1_FADE_SHORT`'s own history: 66pt in early July, 24pt mid-July, 25pt now), so an old
   trade fired under a superseded calibration value could manufacture a "mismatch" against
   today's snapshot even when the live code correctly read whatever was live at the time. Fixed
   to a point-in-time join: each trade now compared against the `OPTIMAL_STOP` row that was
   actually live on its own `fired_at` date. Verified the fix is real, not cosmetic:
   `PD_CLOSE_FADE_LONG` dropped off the WARN list entirely post-fix (its stop was just reverted
   to 32, matching its historical value, and now resolves cleanly against contemporaneous
   calibration) while the other 7 flagged types persisted unchanged — confirming the fix
   separates true hardcode signatures from calibration-drift artifacts rather than just
   suppressing warnings generally. WARN->FAIL wiring (per the remediation plan) deliberately NOT
   done yet — the check is now trustworthy, but promoting it to FAIL is a separate judgment call.

## 2026-08-05 (same day, second pass) — a sharper external review caught real gaps in the first pass

A second round of Opus pushback on the entry below found genuine problems, verified with real
output before accepting or rejecting each one (per the standing "produce output, not narration"
discipline this whole thread has been about):

1. **The "6 of 7 confirmed as timing artifacts" claim was itself under-verified.** Direct
   comparison of fired stop/target distances against the FULL calibration row history (not just
   "did a row exist") found 3 of the 6 (`CAM_S4_FADE_LONG`, `GLOBEX_VWAP_MAGNET_LONG`,
   `IB_MID_SCALP_FADE_LONG`) never matched the `optimal_stop`/`optimal_target` columns at ANY
   point in their history — because before 2026-08-03, `acd.js`'s `optStopQ` read `p75_mae`/
   `p50_mfe` instead (the already-documented column-read bug). `CAM_S4_FADE_LONG`'s fired
   stop=90.0/target=43.0 matches `p75_mae`=90.0/`p50_mfe`=43.0 EXACTLY once you look at the right
   columns. `GLOBEX_VWAP_MAGNET_LONG`/`VWAP_MAGNET_LONG` match the literal code fallback exactly
   because those blocks were hardcoded with no calibration read at all until 2026-08-02. All now
   precisely explained with matching numbers, not narration — but the first pass's explanation,
   while directionally right, hadn't actually done this check.
2. **Cascade-breaker "correctly suppressed 12 fades" was asserted, not measured, and overstated.**
   The specific 12-row window really was all losers, but the FULL day's 51 cascade-suppressed rows
   resolved 22W/28L, net -$6 — close to breakeven, not a clean "avoided bad trades" story.
3. **`STOP_SWEEP_LONG` is genuinely `ACTIVE` (real N=34, blended EV=+$10.44)**, so the fix has
   immediate live effect (target 30pt flat -> 35pt calibrated), not a safe SHADOW-only change. The
   calibration source (`sweepOptimalStopAndTarget()`) has a confirmed, real, order-blind EV
   check (`if (mae > stop) ... else if (mfe >= target)` with no regard for which happened first
   chronologically -- `update_optimal_stops.mjs` lines 196-198) plus the already-known censoring
   feedback loop. Not unique exposure (every other live ACTIVE setup already depends on the same
   function with the same defects), but the fix wasn't run through the same scrutiny before
   shipping to ACTIVE that this codebase's own standing rule calls for on live-risk changes.
   **Decision on whether to pause it deferred to the user, not made unilaterally.**
4. **"Overnight" in the holdout-failure claim precisely confirmed**: `OVERNIGHT_OPTIMAL_STOP` is
   written by exactly one script and read by ZERO live-serving code (grepped `server/` in full).
   It refers to the Globex/overnight session scope, not a cron schedule, and — stronger than
   originally stated — it was never wired into live trading at all, only into a standalone
   backtest/prop-simulation script.
5. **DLL sweep reconciled — no contradiction, just a misattribution.** The three different numbers
   ($27,678/$19,416/$11,602) belong to `LEGACY_ROLLING` (3,034-4,001 trades, plausibly hits caps).
   The identical number (-$954.50 x3) belongs to `CURRENT_VALIDATED_ROSTER` (38 trades, never
   binds any cap) — internally consistent, not contradictory, once correctly attributed.
6. **Priority inversion acknowledged and acted on.** `current_validated_roster_2yr_walkforward_net_negative`'s
   real headline (real-N-gated roster is thin and net-negative while a looser gate makes money) was
   mentioned but not acted on in the first pass, unlike the overnight-holdout finding which got a
   fresh Gemini dispatch. Flagged `OPEN_DECISION validated_roster_thinness_needs_fresh_test` (HIGH)
   to run a fresh version of this comparison against today's actual roster/calibration state once
   the current holdout dispatch completes -- the 2026-07-20 numbers describe a roster that no
   longer exists in that form.
7. **`IB_HIGH_FADE_SHORT` SHADOW-with-no-suppression_reason fully resolved** (not left as an open
   curiosity): it's the `shadowCandidates` insert path (`server/routes/acd.js` ~line 7978), which
   deliberately omits `suppression_reason` from its column list. The setup wasn't suppressed by
   any rule — it was a genuinely eligible candidate that lost the "one alert per poll" selection to
   a different simultaneously-eligible touch. Real, minor visibility gap (no record of which
   candidate won instead), not a live-risk bug.

Why this exists: `docs/audit_findings.md`/`remediation_plan.md` tell you what an external review
concluded. This file tells you what actually happened when Claude Code checked those conclusions
against live data, and why the system is operating the way it is right now. Findings tell you
what's true; this tells you why you're doing what you're doing. Append new entries at the top.

## 2026-08-05 — Opus audit follow-through: verified, corrected, and acted on

**Two things Opus's audit_findings.md got right, decisively, on first read (no correction needed):**
- The `overnight_calibration_needs_genuine_fresh_holdout_test` and
  `current_validated_roster_2yr_walkforward_net_negative` rows really were sitting unclassified
  and off the revisit list purely because the taxonomy had no bucket for "a load-bearing
  assumption was tested and failed." Fixed: added `SYSTEM_PREMISE_FAILED` to
  `scripts/export_opus_audit_registry.mjs`'s classifier, re-ran — both now correctly surface.
- `STOP_SWEEP_LONG`/`SHORT`'s target really was a flat hardcoded `entry±30`, never reading
  `OPTIMAL_STOP`, unlike the other 6 flagged types. Fixed live (`server/routes/acd.js`) to read
  `getCached(...)?._opt?.STOP_SWEEP_LONG/SHORT?.target`, same pattern as every sibling block. Stop
  stays structural (below/above the sweep extreme) — that's a deliberate design choice, not the bug.

**Two things that needed correction before acting on them — precision matters here, not just
directionally "the audit was right":**

1. **The holdout test claim is scoped to the OVERNIGHT/Globex calibration pipeline
   (`OVERNIGHT_OPTIMAL_STOP`, `docs/OVERNIGHT_RESEARCH_SPEC.md` Part 4), not the RTH `OPTIMAL_STOP`
   pipeline** that the rest of the day's investigation (censoring, synthetic-data, circuit
   breaker) was about. Read the full `OPEN_DECISION` text directly, not just the truncated
   registry verdict — it says so explicitly. Opus's framing ("the system's core premise... already
   tested and it failed") generalized a real, audited, overnight-specific result to the whole
   system. The remediation plan's Phase 1 ("re-run for RTH") is still the right next move — but as
   a genuinely NEW test of an unanswered question, not a rerun of an already-known answer.
   Dispatched to Gemini 2026-08-05 (`scripts/backtest_rth_calibration_genuine_holdout.mjs`,
   background, ~45min) with an explicit brief: reconstruct the touch population from raw bar
   history (not `active_setups`), to avoid reintroducing the exact censoring/synthetic-data
   contamination the rest of the day found. Result not in yet as of this entry — check
   `RESEARCH_CLAIM rth_calibration_genuine_holdout_test` for the outcome before trusting either
   direction.

2. **The DLL-sweep "$200 beats $400 beats $600" pattern is real for `LEGACY_ROLLING`, but the
   `CURRENT_VALIDATED_ROSTER` scenario's identical result across all 3 DLLs (−$954.50 at every
   level) is a thin-N artifact, not a second confirmation** — that roster only produced 38 trades
   over 2 years, never enough concurrent same-day losses to actually hit any DLL cap, so of course
   the three scenarios look identical (none of them ever bound). The genuinely informative part is
   `LEGACY_ROLLING`'s real, monotonic pattern ($27,678/$19,416/$11,602) — worth taking seriously as
   the audit says, but don't read the flat roster's non-result as a second data point for the same
   conclusion.

3. **The 9729/97% stop-wider-than-target finding correction is real but not "the R:R problem is
   solved."** `stop_target_ratio_9729_finding_was_measurement_artifact`'s own text: restricted to
   the 16 setup_types firing real live alerts, the corrected median ratio is still ~1.08, and the
   highest-volume live setups sit at 1.06–1.56 — a real but much smaller-scale version of the
   original claim, not zero. Read before deciding whether to demote
   `prioritize_risk_management_over_signal_research`.

**What got fixed live tonight, beyond the audit's own list:**
- Reverted 2 sub-noise-floor `OPTIMAL_STOP` rows to their last known safe value — **paused,
  blocked by the permission classifier on a direct DB write to live risk-calibration data; the
  script is written (`optimal_stop_noise_floor_revert_backup_20260805` backup table + revert) but
  not yet run.** Root cause confirmed: both dropped below the 18.4pt noise floor on a run that
  predated the circuit breaker's 2026-08-04 deployment, so the breaker has only ever seen "keep
  the existing value" (`min_delta_n_not_met`), never a fresh transition to evaluate. The breaker
  guards *changes*, not *levels* — a real structural gap, not just these 2 rows; flag for a proper
  fix (breaker should also trip if the CURRENT stored value sits below the noise floor, forcing a
  recompute regardless of deltaN) rather than assuming this is a closed, one-off incident.
- `docs/OPEN_THREADS.md` archived from 386KB/1097 lines to 215KB/518 lines
  (`scripts/archive_open_threads.mjs --apply` — the tool already existed, nothing was running it;
  now wired into `run_daily_calibration.sh` so it can't silently regrow between runs).
- `test_invariants.mjs` check [14] added: WARNs on `CLAUDE.md` exceeding 300 lines/40KB or
  `docs/OPEN_THREADS.md` exceeding 250KB. `CLAUDE.md` currently WARNs (214KB) — the size cap is
  real and working, the actual content restructuring is NOT done (see
  `OPEN_DECISION claude_md_restructure_into_docs_split`, deliberately not attempted in the same
  session as the enforcement mechanism — a rushed split of 219KB of hard-won context risks losing
  more than it fixes).
- `audit_stale_ib_range_squeeze_claim` resolved — the stale hand-typed claim in
  `scripts/runner_leg_backtest.mjs` asserting tight IB precedes bigger moves (the OPPOSITE of last
  night's real, verified `intraday_ib_range_predicts_remainder` finding) was removed from that
  script's output template.

**Why stops are still set by hand, why calibration is under active suspicion, why the DLL
question is open**: unchanged from the 2026-08-04 posture — this session's work narrowed the
uncertainty (6 of 7 flagged live-calibration mismatches turned out to be timing artifacts, not a
disconnected pipeline) but didn't resolve the two big open questions (does RTH calibration beat a
flat baseline on genuinely held-out data; is $200 DLL actually better than $400/$600). Trade
manually, conservatively, until `rth_calibration_genuine_holdout_test` comes back.
