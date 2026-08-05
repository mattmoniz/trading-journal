# Decisions Log

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
