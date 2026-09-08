# Open Threads / Pending Work

Older resolved/superseded threads are periodically moved to [OPEN_THREADS_ARCHIVE.md](OPEN_THREADS_ARCHIVE.md) (via `node scripts/archive_open_threads.mjs --apply`) to keep this file's per-session read cost down — nothing is deleted, just relocated. Still-pending items are backed by `OPEN_DECISION`/`RESEARCH_CLAIM` rows regardless, so archiving here never buries anything.
## ✅ 2026-09-07 — `cluster_touch_credit_phase3_sibling_rows_shipped`: RESOLVED, full Phase 2 safety net shipped

User was offered 3 options for the still-open cluster-touch-credit gap (sibling rows counting toward live pooled `real_n`/`real_ev` with no safety net): (a) accept the risk, (b) DeepSeek's recommendation — the full `is_cluster_primary`/`POOLED_TRADE_FILTER` build, (c) a smaller distinct-day-floor patch. Picked (c) first, then switched to "Do B please" mid-session — proceeded with the full build.

Per CLAUDE.md's higher-stakes-work rule (this touches live suppression/gating math across ~166 setup_types), drafted the concrete plan and dispatched it to DeepSeek for a design critique BEFORE writing any code. The dispatch reported "failed" (hit its 20-minute timeout) — but per this codebase's own "timeout ≠ failure" convention, the actual full critique was recovered from inside the raw transcript (DeepSeek had composed the complete answer, it just got stuck deciding how to chunk the file write before running out of time). Preserved the raw transcript at `scratch/deepseek_response_RAW_cluster_touch_credit_20260907.md`.

The critique found 3 real bugs in the first-draft plan (all verified against live code/data before acting, not taken on faith):
1. `clusterSkippedTypes.length` is NOT a valid proxy for "a sibling actually got a row" (a candidate on the 15-min refire cooldown, or a `_TRAIL` variant, gets skipped without an insert) — fixed by generating the touch-id unconditionally instead (a winner-only touch becomes a harmless singleton group).
2. The correlation monitor (`monitor_bet_correlation.mjs`) needed a SPLIT filter, not a blanket swap — its bet_class matrix needs `POOLED_TRADE_FILTER` (siblings double-count a bet_class's daily P&L), but its setup_type matrix must stay `REAL_TRADE_FILTER` (a setup_type is never both winner and sibling of its own touch, so excluding siblings there would just hide real co-touch volume).
3. The 1,296 already-shipped sibling rows (17 live-forward + 1,279 from the 2026-09-04 historical backfill) needed an explicit backfill `UPDATE`, not just a column `DEFAULT` — the default only helps NEW rows and the other 7 unrelated insert sites; the existing sibling rows would have silently stayed misclassified as primary forever.

Shipped, in order: (1) schema migration — `cluster_touch_id UUID NULL` + `is_cluster_primary BOOLEAN NOT NULL DEFAULT true`, plus the 1,296-row backfill `UPDATE` (dry-run counted first, confirmed exact match before applying); (2) `acd.js` — `randomUUID()` import, a `clusterTouchId` generated once per poll's cluster-processing block, threaded onto every sibling's INSERT directly and onto the winner via a post-insert `UPDATE` (mirroring the existing `cluster_attributed_setups` pattern, per DeepSeek's lower-risk alternative to splicing a new column into the ~25-positional-param main INSERT); (3) `POOLED_TRADE_FILTER` exported from `backtest_setup_status.mjs`, wired into its own `betClassPooledQ` and both other consumers — fixing a real, independently-confirmed pre-existing drift bug as a byproduct (`monitor_bet_correlation.mjs` and `backtest_bet_class_status.mjs` each had their own hand-rolled "real trade" filter, both missing the `ib_window_stale_basis` exclusion the canonical one already had); (4) the stacking count (`acd.js` ~5484) made touch-aware (`COUNT(DISTINCT COALESCE(cluster_touch_id, id))`), documented explicitly as a deliberate live sizing-input change, not a silent bugfix; (5) `test_invariants.mjs` check `[25]` — positive+negative, synthetic-drift-tested (a deliberately reintroduced local filter copy was confirmed to trip it before being reverted).

**Real, live-consequential finding that validates picking the full build over the cheaper patch**: `VALUE_FADE`'s bet_class-level pooled EV (the number gating `BET_CLASS_SUPPRESS_ENABLED`'s override, which force-suppresses constituent types without independent positive EV whenever pooled EV<0 at N≥200) **flips sign** once cluster siblings are excluded — sibling-contaminated: N=2733, EV=-$1.33/trade (would trigger the override); primary-only (correct): N=1583, EV=+$1.35/trade (does not trigger). Confirmed directly against live data both ways, not just the script's own reported number.

Verification: all 3 consumer scripts re-run live with sane real output; server restarted via `./restart.sh` and confirmed via PID/start-time that the running process is actually new (not a stale-process false-positive on a 200 response); the live `/api/acd/setup-detection` response was checked directly and shows a real `clusterTouchId` populated end-to-end; `test_invariants.mjs` shows the identical 19 pre-existing failures (zero regressions); `npm run lint` clean. `docs/CLUSTER_TOUCH_CREDIT_SPEC.md` updated with the full outcome; `OPEN_DECISION cluster_touch_credit_phase3_sibling_rows_shipped` RESOLVED.

## ✅ 2026-09-07 — `backtest_unified_detectors_systemic_divergence_20260907`: RESOLVED, all 5 detectors closed out

Continued the `backtest_unified.js` vs. live-`acd.js` divergence audit (see the entry below) starting with `detectVwapMagnet`, per the decision's own instruction to ask the user delete-vs-build rather than default to "reconcile." Asked; user chose "properly test scale-out first, then decide."

Found the divergence was worse than originally scoped: the backtest's 2-leg scale-out simulation (bank half at T1, run the rest toward VWAP) was ALSO still using a stale, pre-2026-08-02 hardcoded stop=30/target=20 — so its negative EV number was confounded with an outdated entry geometry, not a clean read on the exit mechanism alone. Fixed properly:
1. `backtest_unified.js`'s `detectVwapMagnet` now reads the SAME `OPTIMAL_STOP` calibration `acd.js`'s live INSERT reads (new `loadData()` field `vwapMagnetCalib`) and resolves flat (no scale-out) — matches live exactly. Trigger detection factored into a shared `findVwapMagnetTriggers()` so any future exit-mechanism comparison can never differ in trigger population.
2. Built `scripts/backtest_vwap_magnet_scaleout_test.mjs` — a confound-controlled A/B (same trigger population, same calibrated stop/T1, differing ONLY in exit mechanism) via a new exported `detectVwapMagnetScaleOut()` research variant. **Result: scale-out is worse than flat in both directions**, on a real, non-clustered, rigor-clean sample — LONG N=135, flat EV=-$10.31 vs. scale-out EV=-$11.86 (Δ-$1.55/trade); SHORT N=83, flat EV=-$13.88 vs. scale-out EV=-$14.66 (Δ-$0.78/trade). Recorded as `RESEARCH_CLAIM vwap_magnet_long_scaleout_vs_flat_20260907` / `..._short_...` (both `REJECTED`). **Decision: do not build the 2-leg scale-out live.**
3. Independent, orthogonal bug fixed in the same pass: `acd.js`'s live VWAP Magnet trade-brief text (`targetLabel`/`description`) told users "Scale out: half at Xpt, runner to Ypt... Breakeven stop after T1" — never mechanically enforced (the live INSERT resolves flat). Corrected to describe the real behavior.
4. Full production `backtest_unified.js` re-run immediately (780 UNIFIED_BACKTEST + 321 SYSTEM_BACKTEST rows, same count as before) rather than waiting for Sunday's cron. `test_invariants.mjs` shows the identical 19 pre-existing failures with this change stashed vs. applied — zero regressions.

Continued to `detectVAResp` next (same session). Made 4 real, verified fixes to match live's actual code: (1) added the missing `OPEN_DRIVE` exclusion gate, via a newly-extracted `classifyOpeningCallType()` (`server/services/queries.js`) that also deduplicated 2 byte-identical inline copies of this classifier already living in `acd.js` itself (verified byte-identical across 250 real dates before replacing both call sites); (2) fixed the "inside prior value" check, which used `bars[0].close` — live's real gate uses the **Opening Range midpoint** `(orH+orL)/2`, a different variable entirely (found by seeing the reconciled backtest's EV **flip sign** against real `SETUP_STATUS` data, which is what prompted digging past the first-pass fix instead of accepting it); (3) removed a noon (`tod>=720`) cutoff the backtest had but live doesn't; (4) replaced the hardcoded `pdVAH+18`/`pdVAL-8` stop and structural PD-level target with the same calibrated flat-distance-from-entry stop/target live uses (`loadDirectionalCalib()`, refactored out of `detectVwapMagnet`'s calibration loader from the entry above so the two setups share one helper instead of two copies).

**After all 4 fixes, the backtest still doesn't numerically match real `SETUP_STATUS`** (LONG: backtest EV=-$5.66 vs. real EV=+$6.36, still sign-flipped; SHORT: same sign but WR off by 2x — 60.0% backtest vs. 28.9% real). Root-caused, not left unexplained: `valueAreaResp` is one of ~15 candidates in `acd.js`'s priority-selection array (`candidates.filter(Boolean)`, take the first eligible one per poll) — live only fires a setup when it's *also* the highest-priority eligible candidate that poll, not merely when its own trigger condition is met. A per-setup-type detector script structurally cannot reproduce this without re-simulating the entire candidates array + priority order for every setup simultaneously — a much larger, different project than fixing one detector's trigger/geometry, and a limitation shared by every detector in this file that goes through the same array (not VAResp-specific). Decision: stop chasing an exact match here — the 4 fixes are real, independently-verifiable corrections to what the backtest computes (not calibrated-to-a-target guesses), and `SETUP_STATUS` (built from real fired trades, already reflecting the true priority-filtered population) remains the authoritative live-gating source regardless. Zero regressions (`test_invariants.mjs` identical 19 pre-existing failures stashed vs. applied; production re-run, same 780/321 row count).

Continued `detectCStandalone` in a fresh context (2026-09-07, same investigation resumed from the prior pass's handoff note). Confirmed once more (per the handoff's own instruction to check, not assume) that `cStandalone` goes through the same `acd.js` priority-selection candidates array (line ~8172) as `valueAreaResp` did, so the same residual-gap caveat applies — don't expect an exact `SETUP_STATUS` match even after fixing real divergences. Fixed all 3 real divergences in `scripts/backtest_unified.js`'s `detectCStandalone`:
1. Added `!hasCFiredToday` to the `aUp||aDown` gate. **Numerically a no-op** — already structurally guaranteed by this function's own single-fire-per-session loop (`cFired`/`break`) plus the fact that ACD's C confirmation requires A to have fired first, so `hasCFiredToday` can never be true here while `aUp`/`aDown` are both false. Kept as an explicit parameter for exact parity with live rather than relying on that being obvious to a future reader, documented in-code.
2. DOWN branch now requires `nearPD2VA` (proximity to a 2-days-prior value area level, computed per-bar since `currentPrice` is per-bar here) — a REAL, population-narrowing fix. Verified via stash-diff: `C_STANDALONE_DOWN` N dropped 23→11 (EV $4→$26, `ACTIVE`→`THIN_N`), and `C_STANDALONE_UP` N *rose* 14→19 (EV -$38→-$52) — sessions that used to falsely fire DOWN early (no PD2VA proximity check) now continue scanning and fire UP later instead, exactly the expected mechanical consequence of narrowing the DOWN population, not a bug.
3. `orRange` fallback constant aligned to live's real 80 (was 60) — dead code either way in practice (`orH>orL` is never falsy for a real OR), fixed for exact parity anyway.
4. **Third instance of the misleading-scale-out-text bug** (already fixed twice this session for VWAP_MAGNET): `acd.js`'s `targetLabel` for `C_STANDALONE_UP/DOWN` said "T1: PD VAH/VAL (half off) · Runner: 45pt" — confirmed zero `runner_trail_width`/`extend_target_level`/`CONDITIONAL_VARIANTS` wiring for this setup, so the scale-out is never mechanically enforced. Corrected to "T1: PD VAH/VAL (flat)".

Closed out the final 2 candidates (`detectStopSweep`, `detectCoilSurge`) to finish the audit, per user request ("close out the detector audit").

**`detectStopSweep`**: confirmed this function is NOT purely a STOP_SWEEP-vs-live comparison — it's also directly imported and reused unchanged by `scripts/backtest_setup_b_failed_sweep_reversal_stage1.mjs`/`backtest_setup_b_correlation_check.mjs` for the real, already-shipped `FAILED_SWEEP_REVERSAL` setup (roster-rebuild Setup B). Its own strategy is genuinely different from live's actual `STOP_SWEEP_LONG`/`SHORT` mechanism (acd.js ~7790): a raw sweep-and-reverse of ANY of ~10+ floor-pivot/PD-VA/OR levels with no confluence gate and a fixed 15/30pt stop/target, vs. live's confluence-gated sweep of only ONL/ONH/PDL/PDH/IB_LOW/IB_HIGH (requires proximity to a separate secondary-level set within 30pt). Writing both under the identical `STOP_SWEEP_LONG`/`SHORT` `signal_name` silently misrepresented `backtest_unified.js`'s own UNIFIED_BACKTEST row as backtesting live's actual mechanism when it never did. Fixed with a **labeling-only** change: confirmed neither Setup B consumer reads `.type` (only `.direction`/`.entry`/`.stop`/`.target`/`.entryIdx`), so the exported function itself is untouched — only `backtest_unified.js`'s own call site remaps the emitted type to `STOP_SWEEP_RAW_LONG`/`SHORT` before aggregating. Verified: `--dry-run` before/after shows byte-identical N/WR/EV (412/31.5%/-$4 and 428/32.5%/-$1) under the new name — pure relabeling, zero behavior change; both Setup B scripts still parse clean. Also deleted the 200 now-permanently-stale `UNIFIED_BACKTEST`/`SYSTEM_BACKTEST` rows under the old `STOP_SWEEP_LONG`/`SHORT` name (all `run_date`s back to 2026-07-26) — confirmed via grep that no live/display consumer reads this signal_type+name combination (live's displayed edge text for the real, paused mechanism comes from `SETUP_STATUS` via `_setupStats`, not `UNIFIED_BACKTEST`; the `/api/performance-audit/unified` display table already excludes it via `hasPrimary()`), so this was a pure hygiene cleanup with no live consequence — but left alone, those rows would have sat frozen forever, increasingly misleading with each passing week. The real `SETUP_STATUS`/`OPTIMAL_STOP` rows for the actual live (paused) mechanism were untouched (confirmed via a post-delete count).

**`detectCoilSurge`**: confirmed the ~zero-population finding is real and independent of the one remaining divergence (a missing `dayTypeOk` gate — live requires `dtClass==='TREND'` or NL30-alignment before firing, acd.js ~2859). Did NOT add this gate to the backtest: `dtClass` is only knowable historically via `acd_daily_log.day_type`, which for a live decision is populated well after the fact — live's own `dtClass` is structurally null at decision time (separately tracked, unresolved `OPEN_DECISION dtclass_null_all_day_neuters_multiple_live_gates`), so a backtest reading the FINAL end-of-day `day_type` value would be simulating the *intended, unbugged* gate rather than reproducing what live *actually* does — a real lookahead risk this codebase's own "no lookahead in backtests" rule exists to catch. Rather than half-reproduce a bugged gate, confirmed the underlying question directly: even the backtest's own strictly LOOSER, ungated version (which should fire in strictly more cases than live's gated version) produces **zero fires across the entire backtested history** (~700+ RTH sessions) — this settles definitively that COIL_SURGE's near-zero population is a genuine property of the coil+surge geometry itself (`RW=15/RT=40/VR=0.40/POP=2.5`, confirmed byte-identical to live's constants), not an artifact of the missing gate. No code change made; this closes the question rather than leaving it open.

Full production `backtest_unified.js` re-run after the STOP_SWEEP fix: same 780/321 row count. `test_invariants.mjs`: identical 19 pre-existing failures (confirmed via diff against a pre-session baseline) — zero regressions across the whole audit. `OPEN_DECISION backtest_unified_detectors_systemic_divergence_20260907` marked RESOLVED — all 5 flagged detectors (`detectVwapMagnet`, `detectVAResp`, `detectCStandalone`, `detectStopSweep`, `detectCoilSurge`) now closed, either with real fixes or a documented reason no further fix is warranted.

Full production `backtest_unified.js` re-run: identical 780 UNIFIED_BACKTEST + 321 SYSTEM_BACKTEST row count. `test_invariants.mjs`: identical 19 pre-existing failures stashed vs. applied (confirmed via `git stash` diff) — zero regressions. `npm run lint` clean on `acd.js`. As expected per the priority-selection finding, `cStandalone`'s real `SETUP_STATUS` numbers still won't match this backtest exactly — not chased further, per the standing rule.

Remaining after `detectCStandalone`: `detectCoilSurge` (trigger/population drift, ZERO real fires either direction — not urgent, low value against a population that doesn't exist yet) and `detectStopSweep` (backtest's version uses an entirely different, MORE sophisticated level set than live's — needs re-scoping/renaming as a research variant, not a trigger/geometry reconciliation, per the framework already used for `detectVwapMagnet`'s scale-out variant). `OPEN_DECISION backtest_unified_detectors_systemic_divergence_20260907`'s own text has the up-to-date state — read that first, don't re-derive from scratch.

## 🔶 2026-09-07 — Two quick OPEN_DECISION wins, 4 larger ones scoped (not built)

Asked "what else can we deal with quickly" — scanned all 55 PENDING `OPEN_DECISION`s and split by whether they're actually mechanical/small vs. requiring real new engineering. Resolved 2 quick ones same session (`setup_status_dow_clear_skips_globally_suppressed_types`, `move_watcher_scripts_to_tracked_dir` — both full detail in their resolution text).

The other 4 were then explicitly SCOPED (a real phased plan, not just re-stated) at the user's request — no code changed for any of them, but each decision's own notes now carry a corrected, evidence-checked plan instead of the original rough estimate:
- `setup_status_excludes_trail_exit_resolution` — corrected site count (8 sites in `backtest_setup_status.mjs`, not 6) AND a much wider blast radius found: the identical TRAIL_EXIT-exclusion gap exists in 6 more live files (`globexFlushDetector.js`, `stats.js`, `setups.js` x2, `rthFlushDetector.js`, `setupEligibility.js`, `update_optimal_stops.mjs` x2). Needs the full 3-phase Gemini/DeepSeek workflow given the expanded surface.

- `globex_same_direction_stacking_no_sizedown` — **stale-premise correction**: its proposed fix ("mirror RTH's `_lfSameDirN` pattern") no longer has a live pattern to mirror — that RTH mechanism was itself removed 2026-09-04, 3 days after this decision was flagged, after being found to be a calendar-time-confounded non-edge. Real scope is now: independently re-test same-direction-stacking on Globex-only data with the same confound checks that killed the RTH version, and separately consider whether the real fix is a Globex continuation/trend-following setup family rather than a stacking penalty on an all-fade roster.

- `nq_bar_gaps_2024_2025_unflagged` — corrected scope: a plain grep for `price_bars_primary` returns 335 files, not the ~20 originally estimated. Root cause is genuinely blocked on the user (Sierra Chart data provenance, not guessable); the script-exposure audit needs a dispatched automated classifier, not manual file-by-file review.

- **`backtest_unified_bracket_detector_diverged_from_live` → SUPERSEDED** by the new, much broader `backtest_unified_detectors_systemic_divergence_20260907`: dispatched a full audit of all 11 `backtest_unified.js` detectors against their live `acd.js` counterparts (2 spot-checks verified against real code before trusting it). Result: only 2 of 8 newly-audited detectors (`TRT`, `RSI_DIV`) genuinely match live — 6 diverge, in three distinct flavors (calibrated-flat-exit-replaced-structural-exit, live-only extra trigger gates, and `STOP_SWEEP`'s entirely different level set). Practical risk stays bounded (`_suppressedSetups` reads `SETUP_STATUS`, never `UNIFIED_BACKTEST`) but any fallback sizing/tier figure sourced from one of these 6 types describes a strategy that isn't what's actually live.

- `claude_md_needs_recondensation_20260901` / `circuit_breaker_mute_tag_ha_page_requirement` — left as-is, both already explicitly scoped by a prior session as "don't rush this."

Older resolved/superseded threads are periodically moved to [OPEN_THREADS_ARCHIVE.md](OPEN_THREADS_ARCHIVE.md) (via `node scripts/archive_open_threads.mjs --apply`) to keep this file's per-session read cost down — nothing is deleted, just relocated. Still-pending items are backed by `OPEN_DECISION`/`RESEARCH_CLAIM` rows regardless, so archiving here never buries anything.
## 🔶 2026-09-07 — acd.js duplication/dead-code audit: 3 dedup fixes, 5 orphaned detectors resolved

User-prompted duplication audit of `acd.js` (asking "how much more copy and paste is in the acd file" after catching Claude about to copy-paste a ~180-line analysis block into a new script). Found and fixed 3 real duplication clusters, each verified byte-identical against real bar data before replacing, then `test_invariants.mjs`/lint/live-restart smoke test:
- Runner-trail-width lookup (4 near-identical inline copies) → `acdShared.js`'s `lookupRunnerTrailWidth()`. Fixed a real bug in the process: the 4th, undocumented copy was missing the `.catch(() => ({rows: []}))` safety net the other 3 had, on the highest-traffic of the 4 sites.

- RSI(14) + bar-resample (2 copies: `absorptionSetup` on 2-min bars, `rsiDivSetup` on 15-min bars) → `server/services/technicalIndicators.js`'s `resampleBars()`/`computeRSI14()`.

- Session-end/expiry-cap string (3 copies) → `acdShared.js`'s `computeSessionEndCapStr()`.

Separately, checking whether RSI is even used live (user asked "Do we use rsi??") surfaced a bigger finding: **5 detectors were computing real setups every 15s poll but never inserted anywhere** — `aUpStrong`, `aDownStrong`, `aUpWeak`, `gapFill`, `rsiDivSetup`. Already flagged as "dead-weight, pre-existing" during the 2026-09-05 `buildAllCandidates()` extraction (this file's own 2026-09-05 P2 entry), but never root-caused or acted on. Traced via `git log -S`/`git blame`:

- `rsiDivSetup` was introduced the same day but never wired into any array at all — untested either way, not a resurrection of a confirmed negative.

**Resolved 2026-09-07**: deleted the `A_DOWN_STRONG`/`A_UP_WEAK` computation blocks outright (confirmed 0/389-day dead, not worth resurrecting) including their `ctx` return references and `EXPIRY_WINDOW` entries. Wired `aUpStrong`, `gapFill` (SHORT-only, matching the same historical finding), and `rsiDivSetup` into `shadowCandidates` — all 3 have zero/thin `SETUP_STATUS` coverage, so `isLiveEligible()`'s `knownTypes.has()` check keeps them SHADOW-only until real N clears the standard N≥20 bar. Added missing `SETUP_DISPLAY_LABELS` entries for `A_UP_STRONG`/`A_DOWN_WEAK`/`RSI_DIV_BULLISH`/`RSI_DIV_BEARISH` (per the new-setup-type checklist item 6). Verified: `node --check`, lint clean, module load, `test_invariants.mjs` (unchanged 19 FAILURE/85 WARNING baseline), live restart + `/api/acd/setup-detection` 200 + no new server errors.

Also added a standing CLAUDE.md convention codifying proactive dedup/extraction as expected practice ("Self improvement should be a rule," user's words), not something to wait to be asked for.

**Resolved same session**: the dispatched audit found real duplication in the color/threshold layer — `quick-check.html`'s `--muted`/`--dim` CSS variables were swapped relative to `MarketPulseBar.jsx`'s `C.muted`/`C.dim` (and `--green` was a genuinely different hue, `#22c55e` vs `#10b981`), so every shared threshold-color function (`sigmaColor()`, range/delta/rvol color mapping) only agreed by coincidence — each file happened to pick the oppositely-named token that resolved to the matching hex. Fixed: canonicalized `quick-check.html`'s tokens on `MarketPulseBar.jsx`'s values (the in-app dashboard is the primary surface), then corrected every duplicated-logic usage site's token-name reference to match (the value fix alone would have broken parity at several sites that were relying on the old swap to agree). Also fixed the 2 already-disagreeing cosmetic items: `ptsFromOpen`/`fmtPct`'s sign at exactly 0pt (quick-check.html now uses `>= 0` matching MarketPulseBar.jsx, not `> 0`), and the session-character fallback color (resolved automatically by the token fix). Added "KEEP IN SYNC" cross-reference comments at every duplicated site in both files, matching the precedent already used for the `sizeMultiplier` fix. Verified: token-name sequence traced by hand at all 6 duplicated-logic sites against the real current file content (not a re-typed guess) confirms parity; `npm run lint:frontend`/`build` (pre-existing unrelated lint failure confirmed via `git stash`), quick-check.html's inline `<script>` extracted and `node --check`ed, live restart + both `/quick-check` and `/api/acd/setup-detection` return 200, `test_invariants.mjs` unchanged (19F/85W baseline).

## 🔶 2026-09-03 "Chasing home runs" thread — 3 real cluster/backfill bugs fixed, 3 exit-mechanism ideas tested (mostly negative), a real new evaluation gap opened

Started from the user watching two big real moves fire live in Sierra Chart (an IB Low fade to
~29370, an IB Mid fade to ~29540) and not seeing them reflected cleanly in the app. Chased down
to root cause, not a hunch:

**3 real bugs found and fixed in the live cluster/backfill pipeline** (all verified: `node
--check` + eslint clean, server restarted, `/api/acd/setup-detection` returns 200,
`test_invariants.mjs` unchanged):
1. `SetupHistoryView.jsx`'s Setup Log had no pagination — hard-capped at 2000 rows ordered
   globally by recency, silently dropping older real rows once enough same-day activity filled
   the window. Added a real "Load more" control using the `offset` param the backend already
   accepted but the frontend never sent.
2. The "early-touch backfill" mechanism (`acd.js` ~8792, exists specifically to credit a level
   that loses the live cluster-priority pick — see `cluster_touch_credit_phased_build`) was
   skipping THIN_N types via the merged `_suppressedSetups` set, defeating its own purpose for
   exactly the population that needs it most. Confirmed live: OR10/15/30-min OR levels stuck at
   2-7 real touches in 3+ weeks specifically because of this. Fixed with a new
   `_trueSuppressedSetups` (SUPPRESS-only) set for this one check.
3. The same backfill INSERT never populated `confluence_score_at_detection`/
   `confluence_levels_at_detection` at all — fixed, computed at the touch's own price (not
   current price, since this credits a past moment).

**3 exit-mechanism ideas tested for "why didn't a winner run further," 2 real Gemini
round-trips audited (one had a genuine survivorship-bias flaw, caught before running; a
follow-up had a real WR-computation bug, caught and corrected directly by Claude — see the
`RESEARCH_CLAIM`s below):**
- `wider_target_second_rearm_volbuilding_signal` (PROVISIONAL) — volume-building signal needs
  21 bars of history; most fast `WIDER_TARGET_HIT` trades resolve before that, so 87% evaluated
  to null. Wrong signal for this decision point, not a real test either way.

- `wider_target_second_rearm_pressure_signal` (PROVISIONAL) — order-flow pressure at the
  1.5x-target-hit bar shows a real *inversion* (strong pressure predicts LESS continuation, weak
  predicts MORE) consistent across two bucketing methods, but the best bucket is 55% from just 2
  calendar days — can't yet separate a real bar-level effect from a day-level trend-day
  confound. Not actionable yet.

- `breakeven_trail_ib_low_fade_runner_negative_20260903` (CONFIRMED) — refreshed
  `scripts/backtest_breakeven_trail.mjs` (had gone 9 days stale vs its weekly schedule) and
  tested a real bar-by-bar trailing exit directly against `IB_LOW_FADE_LONG`: **genuinely tested
  negative** out-of-sample over 25 real trades, not just untried. `OR5_MID_FADE_LONG` failed a
  different way (no stable trail width found — overfitting signature, unresolved not disproven).

**`promote_wr_floor_40pct_band_rigor_comparison_20260903` (PROVISIONAL)** — tested whether
PROMOTE's WR floor should drop from 52% to 40%. Gemini's mine-and-run had a real WR-computation
bug (wrong source, N/EV matched but WR didn't for 4/7 rows) — corrected directly. Real result:
neither band shows any "clean" (non-clustered + stable) types at all (day-clustering is
near-universal roster-wide at this N), so that metric doesn't distinguish them; on stability
alone, the 52%+ band has a thin real edge (2/11 vs 0/9) over the 40-52% band. Doesn't decisively
support or reject the idea — only 1 type (`OR5_MID_FADE_LONG`) is actually blocked by this
today.

**Real new gap opened, not yet scoped**: `tail_skew_aware_setup_evaluation_needed`
(`OPEN_DECISION`) — the user's own framing ("I want base hits and a few home runs") pointed out
that plain mean-EV/WR evaluation can't distinguish "consistently mediocre" from "usually a
small capped loss, rarely enormous" — both can show the same negative/marginal mean and get the
same SUPPRESS verdict. `IB_MID_SCALP_FADE_LONG` (SUPPRESS, -$26.48 avg) catching the exact
inflection of today's ~250pt rally is the concrete example. Needs a design-critique-first
Gemini pass before touching any live SETUP_STATUS logic — connects directly to
`promote_wr_floor_vs_ev_only_suppress_asymmetry`, resolve/scope together.

User ended the session explicit that 2 months of SHADOW types not graduating to live has felt
like "spinning wheels" — worth reading this whole entry back at the start of next session before
assuming more investigation is the right next move; the user may want to see the *effect* of
today's fixes (does real N actually grow faster now) before doing more design work.

## 🔶 2026-09-03 "Point of No Return" thread — SHORT shipped live SHADOW-only, LONG closed 3 ways, new "early commitment" idea opened

Full detail: `docs/EXTREME_PRESSURE_POINT_OF_NO_RETURN_SPEC.md` (read this first, it's the
canonical doc for this whole thread). Origin: user traced real `IB_LOW_FADE_SHORT` stop-outs
and hypothesized a cumulative order-flow "point of no return" — a z-score (90-day trailing,
same-bar-index baseline) crossing extreme relative to history predicts a session won't
reclaim its Initial Balance boundary.

**SHORT side ("Short of No Return") — built and live.** `IB_LOW_PNR_SHORT`
(`server/services/ibLowPnrDetector.js`, new standalone poller, 60s cycle) — sell-side delta
z>=3.0 while price is below IB Low, momentum entry, stop=150pt, no target (hold to session
close, mark-to-market). Backtest N=15, WR=66.7%, EV=$276/trade; a placebo control (same
window/stop, no z-filter) came back flat (EV=-$0.22), confirming the z-score is load-bearing.
DeepSeek design + code review both clean. **Always fires SHADOW** (real live N=0 < this
codebase's N>=20 floor) — zero real fires as of this writing, first real evaluation window is
the next RTH afternoon (10:30am-3:30pm ET). Not yet done: promote the scratch backtest scripts
into `scripts/` + wire through `record_claim.mjs`; a Gemini independent re-verification pass.

**LONG side — tested and closed negative, three separate ways, not revisit-pending under
these constructions:**
1. Immediate entry (mirror of the SHORT construction): N=12, WR=33.3%, EV negative every
   stop/target config.
2. Multi-day hold (1-5 sessions): looked positive (5-day EV=$481) but a drift-subtracted
   bootstrap (5000 random 12-date draws) found 30.8% did as well or better — indistinguishable
   from NQ's own multi-year drift, not signal. A plain 10:30am entry on the same 12 dates beat
   waiting for the z-score ($768 vs $481) — the signal chases, doesn't front-run.
3. Pullback-then-resume entry (patient, "grind" version, not a sign-flip of the momentum
   entry): N=10, WR=0.0% with a structural stop — worse than immediate entry, not better.
   Buys right at the point a fresh local high reclaims after a pause — close to the worst
   timing for a genuinely choppy move.

`RESEARCH_CLAIM ib_high_pnr_long_trade_sim_negative` (CONFIRMED, updated 3x with each result).

**New, UNTESTED idea opened the same day: "early commitment."** A fresh bar-level scan (not
tied to the z-score signal at all) found big trend days (RTH net move >=400pt, either
direction) commit to their direction within the first 20-30 minutes and grind steadily that
way into the close — symmetric between up and down (this disproves the earlier "longs grind,
shorts snap" framing as an explanation). What IS real: big DOWN days (N=22) are 2x+ as common
as big UP days (N=10) at this magnitude. `RESEARCH_CLAIM
big_trend_day_early_commitment_symmetric_timing` (PROVISIONAL, descriptive only). This
suggests an EARLY entry ("has the day revisited its early-session extreme by a checkpoint
time") instead of a LATE, pressure-based confirmation — but nothing beyond the descriptive
scan has been tested. `OPEN_DECISION early_commitment_angle_untested_pending` (MEDIUM) — check
`IB_BULLISH`/`OPEN_DRIVE_LONG`/`SHORT` for overlap first (current status: `IB_BULLISH`/
`IB_BEARISH` both SUPPRESS, `OPEN_DRIVE_LONG`/`SHORT` both THIN_N — none currently strong, but
`IB_BULLISH`/`IB_BEARISH` already has its own open redesign spec,
`docs/IB_BULLISH_BEARISH_AUDIT_AND_REDESIGN_SPEC.md`, that this idea might actually belong
inside rather than duplicate). User's own framing to build any test around: "a day usually has
drift unless it shoots up" — most days won't qualify, the test has to actually separate rare
early-committing days from ordinary drift, not just flag "up in the morning."

## 🔶 2026-09-02 RESOLVED: Unified live-gate checkpoint spec — items 1+2 shipped, item 3 paused

Follow-up to the sibling-reversal gate below: DeepSeek's code review of the initial wiring found
it only reached 2 of `active_setups`'s 7 INSERT sites, missing the RTH `shadowCandidates` loop
(the real fire path for `STOP_SWEEP`/`VWAP_MAGNET`/`C_PAIRED`/`C_REVERSAL`/`TRT`/
`BRACKET_BREAKOUT`) and `STACK_VOL_BREAK_LIVE`. Both gaps fixed directly same session (commit
`ab81fce`). User then asked the structural question directly: "shouldn't there be one insert
site?" A follow-up DeepSeek design critique of the resulting spec found the scope itself was
wrong the same way the original bug was: the "4 live-capable sites" census undercounted by 3 --
`minuteBarSignalDetector.js`/`rthFlushDetector.js`/`globexFlushDetector.js` each hand-roll their
own N≥20/ev≥-5 `getLiveStatus()` with **zero** exposure to any of the 7 gates. Real total: 11
`active_setups` INSERT sites, 7 live-capable. DeepSeek also rejected the original
`evaluateLiveGates({forceShadow,reason})` shape (can't express skip-vs-shadow) and recommended a
3-step sequence instead of building the full runtime refactor immediately.

**Item 1 SHIPPED**: `scripts/test_invariants.mjs` check `[24]` (live-gate coverage census), 0 new
FAILs verified. **Item 2 SHIPPED**: the RTH `active` slot -- this codebase's single highest-volume
live INSERT site -- was fail-**open** on an unknown setup_type (`_suppressedSetups?.has()` read
directly, the only one of 3 competing eligibility checks with that posture). Fixed by swapping in
the canonical `isLiveEligible()` already used at `shadowCandidates`, which also newly applies DOW
suppression at this site for the first time. DeepSeek-reviewed before shipping. Server restarted
so the fix took effect immediately rather than waiting on its own 12h cache TTL.

**Item 3 explicitly PAUSED, not started**: building the full shared `runLiveGates` checkpoint
across all 4 `acd.js` sites. User asked directly "is this worth building" -- answer: not now,
because item 1 already delivers the main practical benefit (a future gate can never silently miss
a site again -- the invariant test fails loudly) at a fraction of item 3's risk (one shared
function touching every site's decision logic at once, vs. today's 4 independent chains where a
bug in one doesn't touch the other 3). Revisit only if a third gate gets added and the per-site
duplication becomes genuinely painful, or the 4 sites drift out of sync again despite check
`[24]`'s safety net -- do not resume preemptively.

Also found in passing, unresolved and unrelated to items 1-3 above (real, but out of scope for
today): OR5/OR10/OR15/OR30 fade families structurally nest and their boundaries frequently share
the same real price; `isCrossDirectionFastFlip` was extended to broaden its opposite-match lookup
across OR-lengths (while on the pooled-fallback path only, per a DeepSeek-caught scope issue in
the first version) -- see the sibling-reversal-gate entry below for the fuller writeup of that
same-day thread. The 3 service-poller sites (`minuteBarSignalDetector`/`rthFlushDetector`/
`globexFlushDetector`) still have **zero** exposure to any of the 4 force-shadow gates -- flagged
by `test_invariants.mjs` check `[24]` every run, not fixed.

Full corrected spec, the complete re-verified 11-site/7-live-capable census, and the full "why
paused" reasoning: `docs/UNIFIED_LIVE_GATE_CHECKPOINT_SPEC.md` -- read it before ever touching
this thread again, line numbers will have drifted. `OPEN_DECISION
unified_live_gate_checkpoint_scoped` RESOLVED same day.

## 🔶 2026-09-02 RESOLVED NEGATIVE: Roster-wide invalidation-boundary bug (beyond IB) — sibling-reversal gate shipped live

**Roster-wide invalidation-boundary extension: built, backtested twice, resolved NEGATIVE, not
shipped.** Same session as the IB_HIGH/IB_LOW fix below: user asked "does this affect other
setups too? I bet there's more" — a DeepSeek roster audit confirmed the same OR-based blanket
invalidation bug *shape* extends to 7 more families (`PD_VAH`/`PD_VAL`/`PD_POC`, `PW_VAH/VAL/POC`,
`IB_MID_SCALP`, `FLOOR_R1`, `CAM_S2`, `ONL/ONH`, `PD_IB_MID`). Two designs were built and
backtested: (1) unconditional own-level replacement, mirroring the IB fix exactly -- pooled
+$1774.34 looked positive, but DeepSeek's own audit found 65% was a SHADOW-only artifact plus
day-clustering, and the real ACTIVE-only number (+$338.62/152) was itself the net of 2 live
families getting WORSE (PD_VAH -$217/51 real, PD_VAL -$349/26 real); (2) DeepSeek's proposed
"wider-of-two" boundary (`SHORT: max(orHigh, ownLevel)`, `LONG: min(orLow, ownLevel)` -- never
fires earlier in TIME than today's live rule) -- DeepSeek predicted this would push the
ACTIVE-only delta ABOVE +$338.62, but a fresh backtest re-run plus an independent DB cross-check
of the real changed trades found ACTIVE-only delta = **-$196.50**, worse than doing nothing.
Root cause (unlike the IB case, where `OR ⊂ IB` is a mathematical invariant giving a clean
unconditional relaxation): these 7 families' own level has no consistent containment relationship
to the OR, and "never invalidates earlier in time" does not imply "never invalidates at a worse
price" -- a relaxed boundary lets price drift further adverse before finally crossing it. Only
`PD_VAH_FADE_SHORT` clearly improved on real trades (+$56.50/7); everything else with real N nets
flat-to-negative. Confirmed NOT the same bug: `OR5_HIGH/LOW/MID_FADE` (level literally IS the OR)
and `GLOBEX_VWAP_FADE`/`RTH_VWAP_FADE` (live-computed rolling VWAPs, need a separate universal
rewrite). Full writeup, both backtests, and what would need to be true to revisit this (a smarter
per-trade mechanism, not another static boundary substitution): `docs/
ROSTER_WIDE_INVALIDATION_BOUNDARY_WHITELIST_SPEC.md` (rewritten with a RESOLVED NEGATIVE header).
`OPEN_DECISION roster_wide_invalidation_boundary_whitelist_scoped` RESOLVED same day.

**Sibling-reversal gate ("post-win opposite-family reversal") — shipped live, RTH + Globex.**
Separate thread, same session: user watched quick-check.html and spotted the same family firing
both directions close together, apparently erasing a win. User-designed rule: after a real win
(ACTIVE or SHADOW), the family's opposite direction can't fire as the very next real trade until
a different family's real trade fires; the winning direction itself stays unrestricted. Went
through 3 real correction rounds before shipping: (1) DeepSeek design critique caught a fired-vs-
resolved-order bug (was mostly re-measuring the *already-live* `isCrossDirectionFastFlip` gate's
own territory, not this new pattern); (2) user pushback ("something is missing") caught a second
bug -- the population filter silently dropped 557 real trades with a `_TRAIL`/`_GAP_*`/
`_OVERNIGHT` suffix; (3) user pushback again resolved a genuine design ambiguity (non-directional
context signals like `IB_BULLISH` don't count as "a different family," in either direction).
Final backtest: N=30, EV -$36.36/trade, total -$1,090.75, rigor-clean (18 distinct dates, no
sign reversal) -- real-money (ACTIVE-only) slice is thin (N=3, +$95.75), user explicitly chose to
wire for all trades regardless so SHADOW data keeps accumulating on what this gate holds back.
Shipped as `isPostWinOppositeFamilyBlocked()` (`server/routes/acd.js` ~356), wired into both the
RTH and Globex forceShadow chains, `suppression_reason='POST_WIN_OPP_FAMILY_REV'`. **A real bug
was found and fixed before the code-review dispatch even went out** (self-caught, not by
DeepSeek): both call sites originally passed the pre-existing `rthLevelBase`/
`crossDirectionLevelBase` variables (borrowed from the sibling `isCrossDirectionFastFlip` gate),
which only strip a trailing `_LONG`/`_SHORT` and leave `_TRAIL`/`_GAP_*`/`_OVERNIGHT` in place --
silently exempting every suffixed candidate from this new gate. Fixed to use the (correctly
suffix-stripping) `postWinFamilyOf()` instead, without touching the existing gate's variables.

**Code review returned and self-verified.** Confirmed correct: both SQL queries implement the
settled design exactly (verified against `postWinFamilyOf`/backtest logic line by line), the
Globex call site's `c.dir` is provably never null (every candidate reaching that point has a
hardcoded direction or gets filtered out earlier), `postWinDirOf()` is genuinely dead code (safe
to delete, not yet done), and the fail-open/fail-closed asymmetry on the two queries' error
catches is intentional and bounded (a `winQ` failure fails open/unblocked, a `resetQ` failure
fails closed/blocked -- both self-heal on the next poll). **One real, headline finding: the gate
was wired into only 2 of 7 `active_setups` INSERT sites** -- missing the RTH `shadowCandidates`
loop (the actual fire path for `STOP_SWEEP`/`VWAP_MAGNET`/`C_PAIRED`/`C_REVERSAL`/`TRT`/
`BRACKET_BREAKOUT`, confirmed live via `grep`) and `STACK_VOL_BREAK_LIVE`. Directly contradicted
the commit's own "applies universally" claim. Checked against the 30-trade backtest population:
29 of 30 historical matches would have been caught by the pre-fix wiring anyway (their families
route through the 2 sites that WERE gated); only 1 (`STACK_VOL_BREAK_LIVE`) would have slipped
through -- but the STRUCTURAL gap was real regardless of how few historical instances it happened
to catch. **Fixed same session** (commit `ab81fce`): both missing sites now wired, using
`postWinFamilyOf()` correctly. The other 2 sites DeepSeek flagged (suppressed-audit SHADOW rows,
early-touch backfill SHADOW rows) turned out to already hardcode `status='SHADOW'`
unconditionally -- nothing for this gate to prevent there, confirmed by reading the code, no fix
needed.

**This coverage gap is what prompted the user's bigger structural question** ("shouldn't there
be one insert site?") -- see the entry above this one for the resulting
`docs/UNIFIED_LIVE_GATE_CHECKPOINT_SPEC.md`, ranked FIRST priority for next session.
`scripts/backtest_post_win_opposite_family_reversal.mjs` has the full corrected backtest
methodology if it needs re-running once real forward data accumulates.

## 🔶 2026-09-02 (in progress): IB_HIGH/IB_LOW structural-invalidation boundary bug found+fixed live; dtClass Gate B split-by-class comes back negative

**IB_HIGH/IB_LOW invalidation bug — fixed, walk-forward tested, NOT yet committed.** User flagged
3x same-morning `IB_HIGH_FADE_SHORT` "inv." fires on quick-check.html. Root cause:
`structurallyInvalidateSetups()` (server/routes/acd.js) killed a SHORT setup the instant price
closed above the day's Opening Range High — a 5-30min level — but the 8 `IB_HIGH_*`/`IB_LOW_*`/
`PD_IB_HIGH_*`/`PD_IB_LOW_*` setup types fade the 60-min Initial Balance high/low, which is
virtually always outside the narrower OR (confirmed that day: OR High 29102.75 vs IB High 29193).
Every one of these entries was born already past the OR-based kill-switch trigger, regardless of
what price did afterward — not noise, a structural mismatch. Historically 13 real trades were cut
short this way (35% of all real POST_ENTRY structural invalidations ever recorded). **Fixed**:
those 8 setup types now use their own IB high/low as the invalidation boundary; every other
setup type's OR-based invalidation is unchanged (zero blast radius elsewhere).
Walk-forward re-simulation (`scripts/backtest_ib_high_low_invalidation_boundary_fix.mjs`, clean
bar-by-bar re-walk of all N=264 real historical trades of these 8 types under both rules, not
just what the live poller happened to catch): OLD rule total=-$1324.00, NEW rule total=-$514.00,
**delta=+$810.00 across 65 changed trades**. Real and directionally consistent (all 3
chronological thirds positive: $25.95/$4.67/$7.26 per trade) but NOT rigor-clean (54% of the
delta from 5 of 24 distinct days) — recorded as `RESEARCH_CLAIM
ib_high_low_invalidation_boundary_fix_walk_forward` (PROVISIONAL, 30-day recheck), not overclaimed
as settled. Checked whether this bug had demoted anything: **no** — the two setup types it
actually touches (`IB_HIGH_FADE_SHORT`, `IB_LOW_FADE_LONG`) were already `ACTIVE` despite the bug;
the 6 others sitting at `SUPPRESS`/`THIN_N` are unaffected (either genuinely unprofitable on their
own merits, or thin purely on real-N count, not touched by this bug's $0-delta geometry).
**Not yet committed** — code change is live (nodemon picked it up) but awaiting explicit
go-ahead to `git commit`.

**dtClass Gate B split-by-class: informative negative, extends `docs/DTCLASS_LIVE_READ_WIRING_AND_REGIME_SPEC.md`.**
That spec (continued this session) predicted splitting the blended OR-expansion `+0.10`
sizeMultiplier bonus (acd.js ~8285, tested blended 2026-09-01 as `dtclass_gate_b`,
POSITIVE_UNSTABLE/98%-day-clustered) into BALANCE-only vs TURBULENT-only sub-gates would reveal a
clean BALANCE-specific signal, since the live day-type read's real accuracy
(`daytype_accuracy_log`) is 65.0% for BALANCE vs 17.8% for TURBULENT. Built and ran
`scripts/backtest_dtclass_gate_b_split_by_class.mjs` (N=1237 real fade trades replayed): **neither
sub-gate is wireable.** BALANCE-only: N=49 but only 7 distinct dates, 91.8% concentrated in the
top 5, EV/trade only $2.71. TURBULENT-only: N=76 but only **2 distinct dates total** (100%
concentration) — an N=2 problem wearing an N=76 costume. Both POSITIVE_UNSTABLE, neither
trustworthy. Recorded as `RESEARCH_CLAIM dtclass_gate_b_balance`/`dtclass_gate_b_turbulent`
(PROVISIONAL, 30-day recheck — more real dates will accumulate live).

Also shipped this session (trivial, safe): guarded `computeIbBullBear()`'s `ask_vol`/`bid_vol`
reduce against `undefined` (caseEngine.js), matching the sibling `confirmedDeltaDir()` convention
— closes a latent NaN footgun, zero live impact today (current callers already pass safe values).

**Still not started from the spec's phased plan**: item 1 (display-tier `dayTypeEdge`/
`dayTypeWarn` live-read wiring — turns out entangled with the DAY_TYPE_ALPHA `dtaRow` that also
feeds real sizing at acd.js ~8259-8263, not the clean-cut "cosmetic only" swap the spec assumed;
needs its own separate variable, not attempted), item 6 (GARCH_VOL_SCALE per-setup pilot — table
confirmed stale, last row 2026-07-18, ~6.5 weeks behind), item 7 (a properly cross-validated
trend/balance classifier trained against `classifyGroundTruth()`). `ABSORPTION_LONG`'s
`dtClass==='BALANCE'` gate (acd.js ~6228, the other BALANCE-keyed consumer) confirmed to have
**zero real fires ever** — can't be backtested the active_setups-replay way; would need a full
bar-level "new setup type checklist" pre-test if ever revisited, out of scope for this thread.

`OPEN_DECISION dtclass_live_read_wiring_and_regime_scope` stays PENDING — updated, not resolved.

## ✅ 2026-09-02 (RESOLVED, negative): Full-day overnight/RTH momentum grid search — nothing tradeable found

User's real goal, stated directly: "capture a larger overnight move that I can bank on being in
at a certain time and it will be in profit later by a certain time." Extensive search, closed by
user request after two ride-pattern candidates both failed verification. Summary so a future
session doesn't re-derive this from scratch:

**Method established and reused throughout**: `pearson()`/`permutationTest()` (exported from
`scripts/pilot_globex_overnight_momentum_persistence_grid.mjs`) + a standing verification gauntlet
— pooled correlation is not enough; a candidate must also show (a) consistent sign across
per-year isolation (2023/2024/2025/2026) and (b) no real sign flips in a rolling 60-session window
before being trusted. Two candidates failed this gauntlet, one partially passed.

**Findings, most to least promising:**
1. **03:30 ET momentum exhaustion (fade)** — the one pattern that reproduces across years
   (`RESEARCH_CLAIM globex_momentum_0330_exhaustion`, `globex_0330_seasonality_breakdown`,
   `globex_0330_rolling_seasonality`). Real but thin (r²≈2.8%), seasonal (flips positive in
   August specifically — a checked, real wrinkle, not a gap). Turned into an actual bar-by-bar
   trade with data-derived stop/target and real MNQ costs
   (`scripts/pilot_globex_0330_exhaustion_tradeability.mjs`,
   `RESEARCH_CLAIM globex_0330_exhaustion_fade_tradeability`): the plain version loses money net
   of costs on every stop/target combo tested; one filtered top-tercile-momentum cell shows
   EV=$4.04/trade (N=137) but is an isolated spike in an otherwise noisy grid and ~60%
   concentrated in 2026 alone — not trustworthy as-is.
2. **01:00 ET persistence (ride)** — looked real pooled (N=417, p≤0.042 across 4 checkpoints),
   FAILED verification: 2023 opposite sign, 0/72 rolling windows independently significant.
   `RESEARCH_CLAIM globex_0100_persistence_verification`
   (`scripts/pilot_globex_0100_persistence_verification.mjs`).
3. **22:00 ET persistence (ride)** — the most promising-looking candidate found: a full-day
   30-min×30-min grid across all ~946 testable pairs (`scripts/pilot_full_day_momentum_grid.mjs`,
   `scratch/full_day_momentum_grid.json`), Bonferroni-corrected for the ~1,000-pair
   multiple-comparisons problem, surfaced a smooth 7-checkpoint positive cluster spanning 23:30
   through 10:30 next day. FAILED verification worse than 01:00 did: per-year signs mixed on all
   7 checkpoints, and the rolling window shows a genuine **documented sign reversal** — the same
   22:00→02:00 pair was significantly NEGATIVE in August 2025 (-0.26 to -0.30, 3 windows) and only
   became significantly POSITIVE from June 2026 onward. `RESEARCH_CLAIM
   globex_2200_persistence_verification` (`scripts/pilot_globex_2200_persistence_verification.mjs`).
4. **09:00 ET pre-RTH exhaustion (fade into midday RTH)** — same full-day grid surfaced a smooth
   negative cluster (09:00→12:00/12:30/13:00, corr -0.15 to -0.17, and a wider raw-significant
   tail through 15:30), same shape-family as the one pattern that DID hold up (03:30). **Never
   verified** — the thread was closed by user request before this candidate got the per-year/
   rolling check. If overnight-momentum research resumes, this is the natural next candidate to
   test, not a new grid search.

**Real data-quality finding along the way, worth knowing for ANY future 2023-inclusive
backtest**: bars landing on an exact minute mark (e.g. 22:00, 03:30) are genuinely sparse in
2023 (~22 sessions/year) vs 2024 (~87) / 2025 (~139) / 2026 (~174), even though 2023 has *more*
total days with *some* data (256) than later years — a real overnight/specific-minute coverage
gap in the earlier data, not a market-behavior difference. This made 2023's per-year read
unreliable on its own, but did NOT rescue the 22:00 finding — the documented Aug 2025→2026 sign
flip happens entirely within well-covered, recent data.

**Bottom line**: no pattern found in this search is currently trustworthy enough to build a live
setup on. Closed by user request ("let it go") 2026-09-02. All 5 `RESEARCH_CLAIM`s above are
`PROVISIONAL` with the standard 30-day recheck — this is a real, recorded negative, not a
forgotten thread; no `OPEN_DECISION` needed since nothing is pending a build/wire choice.

## ✅ 2026-09-02 (RESOLVED): `wire_flush_post_entry_exit_signals_globex` built and shipped end-to-end

Follow-up to the 2026-09-01 "catch more of a big move" thread below — its HIGH-priority
next-session item, `OPEN_DECISION wire_flush_post_entry_exit_signals_globex`, is now fully
built, not just scoped.

**Found and fixed first, before wiring**: `pilot_exits.mjs`/`pilot_exits_extended.mjs`'s `COMM`
constant was `$1`, should be `$2` (MNQ's `commissionPerRoundTrip`) — every $/trade figure the
2026-09-01 thread recorded was $1/trade too generous. Fixed and re-ran; all directional
conclusions (which config wins, which mechanism passes rigor) were unchanged, only absolute
numbers moved. Corrected in the 3 affected `RESEARCH_CLAIM` rows.

**Built, all 3 required parts + both monitoring surfaces**:
1. **Persistence**: `acd.js`'s `resolveSetupsByPrice()` calls `detectPostEntryExitSignals()`
   (extracted from `pilot_exits_extended.mjs`'s existing `simulateRangeSlope()`/
   `simulateVolRollover()` — same detection loop, not recoded) on every open real
   (ACTIVE/SHADOW) `GLOBEX_FLUSH_*` position each 15s poll. New `active_setups.
   post_entry_exit_signals` JSONB column (schema regenerated, `ARCHITECTURE.md` updated).
   Each mechanism (`range_slope`, both Globex modes; `vol_rollover`, Reversal-mode only —
   Continuation fails rigor) persists once: `{mechanism, fired_at, fired_price,
   hypothetical_pnl, config}`. Never touches the row's real `actual_pnl`/`resolution`.
2. **Segmentation**: ALL-fires vs BIG-MOVE-ONLY (top tercile by `mfe_points`), folded into part 3.
3. **Promotion/retirement trigger**: `scripts/backtest_flush_post_entry_exit_signals_promotion.mjs`
   (wired into `run_weekly_backtests.sh`). No-ops below N=20 real fires per mechanism/mode;
   once N≥20, always writes a final verdict — paired against the trade's own real `actual_pnl`
   (not a resimulated baseline) via `computeRigor()`. Positive → `RESEARCH_CLAIM` CONFIRMED +
   flags a new `OPEN_DECISION` proposing to actually change `globexFlushDetector.js`'s live
   target logic (human call, not automatic). Negative → CONFIRMED-negative, closes the
   mechanism out.
4. **Monitoring**: `GET /api/setups/flush-exit-signals-summary` (new route, reuses
   `evalBucket()`/`modeOf()`/`MECHANISMS` from the promotion script — one aggregation, not two
   copies) feeds both surfaces the decision required: (a) `quick-check.html` RangeSlope/VolRoll
   row tags matching the existing Vol++/Tx1.5 `.vb-tag` pattern, **tap** (not hover — the
   touchscreen-can't-hover gap the 2nd revision caught) opens a popup reusing the existing
   `#modal`/`#modal-backdrop` chrome, showing this trade's own hypothetical $ + the mechanism's
   running cumulative; (b) a new ledger card on `setup-performance.html` (ALL + BIG-MOVE-ONLY,
   current claim status).

**Two real bugs caught and fixed mid-build, both before they could bite**: `pilot_exits_
extended.mjs` and (once written) the new promotion script both had an unconditional `main()`/
`process.exit()` call at module scope — importing either into a live route (as this build
needed to) would have run the multi-year backtest sweep, or killed the running server process
outright, on every server boot. Guarded both behind `import.meta.url === file://${process.argv[1]}`
checks before any import landed. Also, the pre-commit hook caught a real hardcoded-trading-date
`new Date().toISOString()` call in the promotion script before it was committed — fixed to
`SELECT CURRENT_DATE::text`, the hook working exactly as designed.

**Verified live at every step, not just at the end**: server restart clean after each change,
`/api/acd/setup-detection` and the new endpoint both respond correctly, `scratch/
server_errors.jsonl` shows zero new entries across the whole build, `test_invariants.mjs` shows
the same 12 pre-existing (unrelated circuit-breaker) failures before and after. Both HTML pages
Playwright-checked: no console/page/request errors, and a synthetic-row test on quick-check.html
confirmed the full tag→tap→popup path (including `stopPropagation` correctly preventing the
underlying row's own trade-detail modal from also opening).

**Real data is still thin (0 real `GLOBEX_FLUSH_*` fires with a persisted signal as of
shipping)** — this is a brand-new mechanism on a low-frequency setup family, so both new UI
surfaces correctly show PROVISIONAL/thin-N rather than a fabricated number. The weekly cron
will self-populate the ledger and eventually trigger a real promotion/retirement verdict as
real volume accumulates — nothing further to do manually. `OPEN_DECISION
wire_flush_post_entry_exit_signals_globex` and its `_impl_note` follow-up both marked RESOLVED.

## ✅ 2026-09-01 (RESOLVED): "catch more of a big move" thread — ATR precursor validated, flush exit mechanisms tested, a real Gemini-dispatch bug found+fixed

User asked (after the bad-R:R `RTH_FLUSH_LONG` thread) whether anything in the data can help catch
more of a big move once one starts, and explicitly asked to look beyond their own VWAP-slope idea
for other candidate signals. Three sub-threads:

**1. Precursor signals (does something in the first 15 min predict more move is coming), tested
directly by Claude (`scripts/pilot_atr_expansion_big_move_precursor.mjs`), no lookahead
(outcome measured only from minute 15 onward):**
- **ATR level** (already validated earlier this session): RTH r=0.621 (N=414), Globex r=0.572
  (N=413) — the one clear, real, independently-confirmed signal.

- **Range-expansion slope** (is range *growing* within the window, not just its average level):
  dropped — it's mechanically almost the same thing as ATR level (cross-corr -0.784 Globex), no
  independent information.

- **Directional persistence** (max same-direction run-length / fraction of bars agreeing with net
  direction): real but weak (r=0.07-0.12), and genuinely independent of ATR (near-zero
  cross-correlation).

- **Combined score (zATR + zAgreeFrac)**: tested per user's "go with what worked" instruction —
  naive equal-weight combination made it WORSE than ATR alone (RTH 0.516 vs 0.621, Globex 0.455 vs
  0.572). ATR level alone remains the best single precursor found. `RESEARCH_CLAIM
  early_atr_expansion_predicts_further_move_20260901` / `range_slope_and_directional_persistence_20260901`
  already recorded earlier in this thread; no live wiring yet (precursor-only, no exit mechanism
  built from it).

**2. Exit mechanisms for RTH_FLUSH/GLOBEX_FLUSH — VWAP-slope exit and structural next-level exit**,
dispatched to Gemini (`scripts/pilot_exits.mjs`) per the corrected design spec
(`scratch/flush_vwap_slope_exit_design.md`). Both use the real live baseline (RTH 2-tier
volume-building target, Globex mode-aware 3-tier), reuse `computeBalanceAndResolution()`, score via
paired P&L (not the tautological MFE-capture ratio), and split RTH/Globex-continuation/
Globex-reversal separately.

**A real bug was found in Gemini's own script and fixed**: `getLiveTargets()`'s SQL query had no
`ORDER BY run_date`, and the dict-building loop did last-write-wins over duplicate
`performance_audit` rows per `signal_name` — for `GLOBEX_FLUSH_LONG`/`GLOBEX_FLUSH_SHORT` this let a
stale 2026-08-27 row (pre-`tierTargets`) silently clobber the correct 2026-08-28/08-30 rows. Since
the Globex-continuation population push gates on `c.tierTargets`, this zeroed the ENTIRE Globex
continuation population — not because Globex never continues, but because of the missing
`ORDER BY`. Gemini's original report showed this as a clean negative (Globex Continuation
-$5.20/trade, N=68) — that number was wrong. Fixed with `DISTINCT ON (signal_name) ... ORDER BY
signal_name, run_date DESC` (the same pattern CLAUDE.md already documents for `OPTIMAL_STOP` reads
elsewhere) and re-ran. RTH's population and Globex-reversal's population were both unaffected by
this bug (verified directly — RTH doesn't depend on `tierTargets`, and `GLOBEX_FLUSH_REVERSAL_*`
only ever had 2 consistent calibration rows).

**Corrected results** (structural exit is a single fixed rule, not swept — not subject to the
overfitting concern below):

- **RTH Continuation** (N=222): baseline $67.62/trade vs structural exit $51.53/trade — structural
  exit UNDERPERFORMS, only beats baseline P&L on 32.3% of trades. RTH stays on its current target.

- **Globex Continuation** (N=119, corrected from the buggy -$5.20): baseline $3.65/trade vs
  structural exit $16.44/trade — real improvement, rigor-clean but date-concentrated (33 distinct
  dates, top5DayPct=15.2%).

- **Globex Reversal** (N=119): baseline $13.24/trade vs structural exit $18.59/trade — real
  improvement, rigor-clean and well-distributed (114 distinct dates, top5DayPct=4.4%).

Recorded as `RESEARCH_CLAIM globex_flush_structural_next_level_exit` (PROVISIONAL — real and
rigor-clean, but not yet independently re-verified and Globex-continuation's date concentration is
thinner than ideal). **Not wired live** — this is a paired-comparison research result, not a shipped
exit mechanism.

**VWAP-slope exit remains unvalidated** — its "best" numbers in `pilot_exits_out.json`
(`bestVwapEv`/`bestVwapConf`) are the best-of-27 parameter-sweep result on the same data with no
held-out split, the same overfitting pattern already flagged in the circuit-breaker dispatch. Do not
trust the VWAP-slope numbers as reported; would need a genuine train/test split before promotion.

**Debug/cleanup**: temporary debug logging added while diagnosing the bug was removed from
`scripts/pilot_exits.mjs` before this was recorded; the fixed query is the only surviving change to
the script.

**UPDATE same day**: dispatched a follow-up to test DeepSeek's other 3 post-entry ideas (#1
range-expansion slope, #2 directional persistence, #4 volume rollover — all post-entry/in-trade
gauges, distinct from the pre-entry precursor versions already tested). Found and fixed TWO more
real bugs in the process:

1. **The structural-exit baseline above was itself wrong.** It used `tierTargets[0]` (the fixed
   conservative tier) for every Globex trade regardless of that trade's actual pace/volume-building
   conditions, instead of the real live score-based tier selection
   (`globexFlushDetector.js:210-212`: `score++` for good pace, `score++` for volume-building,
   `tierTargets[score]`). Fixed in `pilot_exits.mjs` to match. Corrected Globex baselines are
   substantially higher (Continuation $3.65→$13.49/trade, Reversal $13.24→$30.84/trade) and **this
   reverses the Globex-reversal structural-exit finding** — it now underperforms baseline
   ($18.59 vs $30.84). Globex-continuation still nominally beats its corrected baseline
   ($16.44 vs $13.49) but only wins on 42.4% of individual trades and is date-concentrated (33
   distinct dates) — weak, not decisive. `RESEARCH_CLAIM globex_flush_structural_next_level_exit`
   updated in place with the correction; do not cite the original same-day version (Globex Reversal
   "+$5.35/trade") — it was an artifact of the wrong baseline.
2. **Gemini's rigor check tested the wrong config** — `computeRigor()` was called against
   `configs[0]` (the first entry in each sweep array) instead of the actual best-performing config
   being reported as the headline number, and volume-rollover had no rigor check at all. Fixed in
   `scripts/pilot_exits_extended.mjs` to rigor-check the real winning config for all three
   mechanisms. Also found (and fixed, non-correctness, just slow) that a volume-baseline memoization
   cache Gemini's own report claimed to add existed but was never actually called at any of its 3
   real call sites.

**Corrected results for the 3 new post-entry mechanisms** (against the corrected baseline, rigor
against the actual winning config):

- **Range-expansion slope** (`RESEARCH_CLAIM flush_post_entry_range_expansion_slope_exit`,
  PROVISIONAL): real positive for BOTH Globex modes, rigor-clean — Continuation $13.49→$33.89/trade,
  Reversal $30.84→$38.72/trade (both N=119, clean/stable, top5DayPct=4.2%). RTH underperforms
  ($67.62→$41.28, N=222, rigor-clean negative). Best-of-4-configs sweep, no held-out split — same
  caveat as the VWAP-slope result.

- **Directional persistence** (`RESEARCH_CLAIM flush_post_entry_directional_persistence_exit`,
  CONFIRMED negative): clean negative everywhere — RTH $67.62→$35.91, Globex-cont
  $13.49→$13.13 (flat, and fails rigor stability), Globex-rev $30.84→$6.29 (badly underperforms,
  also fails rigor stability).

- **Volume rollover** (`RESEARCH_CLAIM flush_post_entry_volume_rollover_exit`, PROVISIONAL):
  genuinely mixed. RTH underperforms. Globex-continuation shows a huge EV ($13.49→$50.84) but FAILS
  rigor (clean=false, stable=false) — a textbook too-good-to-trust number, do not act on it. Globex
  reversal shows an equally large EV ($30.84→$59.88) and PASSES rigor (clean=true, stable=true,
  top5DayPct=4.2%) — the strongest single number of all the post-entry ideas tested, but the sibling
  cell failing rigor on identical methodology is a real reason for caution; recommend an independent
  re-check before this graduates past PROVISIONAL.

Net picture across everything tested this session for "catch more of a Globex flush move": range-
expansion slope and (cautiously) volume rollover on the reversal side are the two live candidates
worth a follow-up validation pass; the earlier structural-exit and VWAP-slope findings are weaker
than first reported once baselines are computed correctly; directional persistence (both pre- and
post-entry forms) is a clean, closed negative. Nothing here is wired live.

**CORRECTED 2026-09-02, before live-wiring began**: while building the wiring spec below,
found `pilot_exits.mjs`/`pilot_exits_extended.mjs`'s `COMM` constant was `1`, applied once per
trade in `getTradePnl()` (representing the full round-trip commission) — MNQ's
`commissionPerRoundTrip` is `$2`, not `$1` (`server/config/instruments.js`). Every $/trade figure
in this thread was $1/trade too generous. Fixed and re-ran; **all directional conclusions are
unchanged** (a uniform per-trade shift can't change which config wins a sweep or flip a
rigor-clean/unclean verdict), only the absolute numbers moved: range-expansion-slope Continuation
$13.02→$32.89 (was $13.49→$33.89), Reversal $30.35→$37.72 (was $30.84→$38.72); volume-rollover
Reversal $30.35→$58.88 (was $30.84→$59.88, still the strongest number, still Continuation-mode
FAILS rigor). Corrected in `RESEARCH_CLAIM flush_post_entry_range_expansion_slope_exit` /
`flush_post_entry_volume_rollover_exit` / `flush_post_entry_directional_persistence_exit`.

**PRIORITY for next session** (user request, then REVISED same day after user rejected a
display-only badge): `OPEN_DECISION wire_flush_post_entry_exit_signals_globex` (HIGH) — build the
range-expansion-slope exit (both Globex modes) and the volume-rollover exit (reversal mode only) for
open `GLOBEX_FLUSH_*` positions as a closed loop, not a decorative card: (1) persist the actual
hypothetical $ P&L per real fire (not just a boolean flag), (2) segment every comparison by
ALL-trades vs BIG-MOVE-ONLY (top tercile by realized MFE) since "catch more of a big move" is the
whole point of this thread, not marginal average EV, (3) a real weekly promotion/retirement
trigger — once N≥20 real fires accumulate, either promotes the finding to actually change the live
`globexFlushDetector.js` target logic, or closes it out as a negative — never left sitting at
PROVISIONAL indefinitely. Full build spec (persistence shape, monitoring surface, exact configs) is
in the decision's own text — read it via `node scripts/flag_decision.mjs --list` before starting,
don't re-derive from scratch.

## ✅ 2026-09-01 (RESOLVED, negative): rolling-WR circuit breaker — not validated safe, do not ship

Full arc, in order: scoped from Audit #11's R2 recommendation (`roster_level_wr_circuit_breaker_scoped`,
below) → design v1 (pooled roster-wide rolling WR) → killed by a DeepSeek design critique BEFORE
reaching Gemini (doubly confounded: overlapped with the already-known stop-tightening effect, and
a textbook regression-to-the-mean/winner's-curse problem) → design v2 (composition-adjusted
per-type scoring, empirical variance estimation, genuine walk-forward validation, a
forward-EV-conditional-on-trigger reversion-trap kill test, pre-registered Phase 1→2 graduation
rules) → dispatched to Gemini, audited, found 2 real gaps (a portfolio-aggregate claim asserted
with zero backing code; no genuine fit-then-freeze split despite claiming one) → 1 correction round
→ Gemini's corrected version claimed it now passed every check, including the reversion-trap kill
criterion.

**Audited the "passed" claim directly rather than trusting it — it doesn't hold up.** The pass
verdict was an artifact of averaging forward EV across all 6 historical triggers, which hid a real,
individually-confirmed failure: `IB_BEARISH` triggered 2026-07-29 (the one trigger with an adequate
forward sample, N=10) and was followed by **+$19.20 forward EV (7/10 wins)** — independently
re-derived directly from `active_setups`, not just trusted from the script's own number. That's the
exact reversion-trap failure mode (firing right before a bounce-back) this whole design exists to
prevent. The other 5 triggers are all far too thin (N=0 to N=7) to outweigh that one real data
point either way. Separately, the walk-forward fit itself turned out weaker than claimed — its
parameter-sweep objective hardcodes the 3 known Wave-1 setup_type NAMES directly into the scoring
function, closer to fitting against ground-truth labels than a genuine blind degradation proxy.

**Per this codebase's own 2-corrections-then-Claude-takes-over convention, this is Claude's
take-over verdict, not Gemini's**: `RESEARCH_CLAIM rolling_wr_circuit_breaker_v2_not_validated_20260901`
(CONFIRMED) — this specific design has NOT been validated safe for live use. Do not proceed to
Phase 2 (live wiring). `OPEN_DECISION roster_level_wr_circuit_breaker_scoped` marked RESOLVED as
this specific design attempt closing out negative — **the underlying need it was meant to solve is
still real and unaddressed**: real ACTIVE win rate collapsed 68.7%→30.1% and the existing weekly
`SETUP_STATUS` gate took ~13-14 days to catch each of 2 real collapse waves this session
root-caused. If this thread is picked back up, it needs a non-label-leaking fit objective and a
per-trigger (not averaged) reversion-trap check that fails on any single strong-positive-forward-EV
trigger regardless of how the rest of the population looks. Also produced, unrelated but tracked
separately: `OPEN_DECISION circuit_breaker_mute_tag_ha_page_requirement` (design note for a future
attempt, not actionable now).

## ✅ 2026-09-01 (RESOLVED): 8-hour server outage overnight, missed a real move — `check_watcher.mjs` had been silently missing

User's own recollection ("I think there was a watcher that crashed last night and it missed a big
trade") — confirmed real, not misremembered. `trading-journal-server.service` was down **2026-08-31
14:43 to 22:53 ET, over 8 hours**, spanning RTH close through the evening Globex open. Real,
meaningful move happened during the exact outage window: a 105pt swing in 30 minutes (15:21-15:51
ET) and a 156pt full range — comparable to or larger than most live setups' entire stop-to-target
distance, a genuine missed opportunity, not a quiet stretch.

**Root cause**: `trading-journal-watcher.service` (the Gemini error watcher, whose whole job is
detecting the main server going down and auto-restarting it via `systemctl`) had not itself
restarted since before 2026-08-25 — over a week, not just one night. Its own second-order safety
net — a cron job every 5 minutes (`crontab -l`) meant to check whether the watcher is alive and
restart IT if not — had been failing on **every single run** with `MODULE_NOT_FOUND`, because
`scratch/check_watcher.mjs` (the file the cron entry points at) simply did not exist on disk.
`scratch/` is gitignored, so a prior commit message mentioning its addition ("Add Gemini AGENTS.md
+ check_watcher.mjs") never actually tracked the file — it's unclear whether it was ever real on
disk or was lost at some point, but either way nothing has been supervising the watcher's own
liveness for at least a week, and the systemd unit's `Restart=on-failure` doesn't help against
non-crash failure modes (a graceful stop, a WSL2/session-level interruption) — matches the same
`Restart=on-failure` blind spot already documented for the main server in
`overnight_globex_fix_never_ran_uninterrupted` (2026-07-17/18).

**Fixed same session**: rewrote `scratch/check_watcher.mjs` — minimal, single-purpose (checks
`systemctl --user is-active trading-journal-watcher.service`, restarts if not, logs only on
action so it doesn't spam `scratch/gemini_watcher.log` every 5 minutes forever). Tested both paths
live: silent no-op when the watcher is healthy (confirmed), and a real stop→detect→restart→verify
cycle when it's down (confirmed — stopped the service, ran the script, it correctly restarted and
verified success within the same run). `loginctl show-user` confirms linger is enabled and
`cron.service` itself is healthy, so this was genuinely just the missing file, not a deeper
session/linger issue.

**Known residual limitation, worth a future follow-up, not fixed now**: `scratch/
check_watcher.mjs` and `scratch/gemini_error_watcher.mjs` both live in the gitignored `scratch/`
directory, referenced by a systemd unit file and a crontab entry that point at that path — meaning
neither script is actually version-controlled, and this exact "the file silently vanished from
disk with no tracked history" failure mode could recur. Moving both into `scripts/` (tracked) would
need updating `~/.config/systemd/user/trading-journal-watcher.service`'s `ExecStart` and the
crontab entry to match — a slightly bigger change than today's fix, left as a follow-up rather than
done opportunistically here.

## 🔶 2026-09-01: root-causing the real ACTIVE WR collapse — stop-tightening is a real, partial cause, not the whole story

Follow-up to Opus Audit #11 (below). User asked directly what changed between July and August to
cause the collapse. I ruled out two cheap explanations myself first (see `RESEARCH_CLAIM
wr_collapse_not_refire_flood_or_single_day`): not `IB_BEARISH`'s July refire-flood (excluding it
entirely, the collapse survives and is slightly worse: 74.4%→31.8% WR), not one lucky/unlucky day
(excluding 2026-07-29, WR barely moves). Dispatched a dedicated Gemini root-cause mine-and-run
(`scratch/claude_request.md` → `scratch/antigravity_response.md`).

**Gemini's claim: commit `d81d411` (2026-08-03) is THE root cause** — it fixed a real bug
(`optStopQ` reading raw `p75_mae` percentiles instead of the true EV-swept `optimal_stop`), which
crushed live stop distances for many setup_types (e.g. `PD_VAH_FADE_SHORT` 67.8pt→32pt,
`IB_BEARISH` ~87pt→51pt), and this alone explains the collapse.

**Audited before accepting, per CLAUDE.md's standing rule — and it doesn't fully hold up.**
`d81d411` was not a careless change: it was pre-verified via `computeEvAtStopTarget()` resimulation
(77/116 setup_types improve, 39 degrade — the degradations reasoned through as fixing a thin-tail
overfitting bug, not a regression) and DeepSeek-reviewed before shipping (see `RESEARCH_CLAIM
optstop_percentile_vs_ev_sweep_bug_fixed_20260803`, which itself flagged "real-world verification
pending" and never got circled back on — a real gap in this codebase's own recheck discipline).
Direct verification of Gemini's two named setups **contradicted its causal story on timing**:
`IB_BEARISH` went 4-for-4 (100% WR) in its first 4 real trades immediately after its stop
tightened (08-07 to 08-14) — the tightening didn't hurt it immediately; its real losing streak
started weeks later (08-17 onward). `PD_VAH_FADE_SHORT`'s post-tightening sample is only N=3, too
thin to be decisive either way.

**But a proper pooled test (N=425, all real ACTIVE decisive trades Jul1-Sep1, bucketed by actual
stop distance) found a real, partial mechanism Gemini's anecdotes had missed.** Tight stops
(14-50pt) show WR=38.7%/EV=-$6.86; wide (78-92pt) show WR=71.6%/EV=+$10.86 — a clean, monotonic
gradient. This is confounded with calendar time (75% of tight-stop trades are August, 86% of
wide-stop trades are July), but **the gradient survives within-period controls**: within July
alone, tight vs wide is 60.7%/+$10.88 vs 75.0%/+$21.84 (N=84 each); within August alone, tight vs
wide is 24.1%/-$18.79 vs 57.9%/-$5.41 (N=57-58 each). Stop width is a real, structural contributor
(EV degrades with it, not just WR — rules out a pure mechanical artifact).

**It is NOT the sole explanation.** August's WIDEST stops (50-92pt, matched to July's typical
width) still underperform July's TIGHTEST stops (57.9%/-$5.41 vs 60.7%/+$10.88) — there's a real,
unexplained "August got worse across every stop-width bucket" residual on top of the stop-width
effect. `RESEARCH_CLAIM stop_tightening_partial_not_sole_cause_of_wr_collapse` (PROVISIONAL).
Gemini's separate Hypothesis-1 finding (day-type regime mix did NOT shift meaningfully — the WR
collapse happened WITHIN the same day-type, `BALANCE` days alone went 75.7%→30.9%) is independent
of the stop-width thread and not contradicted by any of the above — still stands as ruling out a
regime-mix explanation.

**RESOLVED (superseding the "systemic, SUPPRESS/PROMOTE" hypothesis below): the real root cause
was already found and mostly fixed by a PRIOR session (Opus Audit #9, 2026-08-19) that this
session never checked for before starting its own dig from scratch — a real process miss, worth
naming.** Dispatched DeepSeek to QA this session's own reasoning chain (not just Gemini's), which
correctly flagged that every suspect named (8/3-8/12) predates the actual cliff (Aug-H2,
8/16-8/31) and pointed at a dense, unexamined cluster of commits landing 8/16-8/19. Reading
`scratch/opus_audit_9_results.md` (2026-08-19, triggered by the user's own complaint that night —
*"trades are great and then we get four huge losses that wipe out everything"*) revealed it had
already precisely diagnosed this: **the giveback since the account's exact 2026-08-05 peak was NOT
diffuse — 3 setup_types (`PD_POC_FADE_SHORT` -$649/N=5, `IB_BULLISH` -$380/N=21,
`GLOBEX_VWAP_FADE_LONG` -$240/N=9) explained essentially all of it, while the other 10 real types
combined were net POSITIVE (+$249.50/N=31).** Root cause: (1) the ACTIVE promotion floor is a
static `EV ≥ -$5/trade`, letting `PD_POC_FADE_SHORT` go live at real EV -$2.40; (2) its
`OPTIMAL_STOP` circuit breaker was **deadlocked** — a legitimate 8/16 cleanup deleted 1,072
phantom SHADOW rows, collapsing real-N counts, but the frozen-branch code re-emitted the
pre-deletion baseline forever (`lastRecalibratedN: baselineN` instead of tracking the shrink),
permanently blocking recalibration for **107 of 138 setup_types (78% of the roster, 11 of 17
live-eligible)** — a systemic, roster-wide defect, just a completely different mechanism than this
session's own SUPPRESS/PROMOTE hypothesis. `PD_POC_FADE_SHORT` was left trading a stale, in-sample
82pt/47pt stop (break-even WR 64.3% vs achieved 64.0% — a coin flip at $166 risk/trade).

Fixed same-night/next-morning (commits `ee0f6d8` 8/19 23:44, `30eb1a2` 8/20 06:34, DeepSeek-reviewed
before deploy): baseline now ratchets down on a real population shrink, all 3 culprit types added to
`CAPITAL_EXPOSURE_OVERRIDE` (`server/services/setupEligibility.js`). **Verified this session that the
fix held**: those 3 types combined for only 1 stray real fire (the morning of 8/20 itself) across
the rest of August — the override worked. `PD_POC_FADE_SHORT` was later properly recalibrated
(47pt/30pt, break-even WR 61.0%) and, after 3 consecutive clean `SETUP_STATUS` runs, was correctly
re-promoted 2026-08-31 (`OPEN_DECISION pd_poc_fade_short_capital_exposure_override_revisit`,
user-confirmed).

**But that only explains Aug 6-19. A SECOND, distinct wave hit Aug 20-31 that Audit #9 never saw**
(it stopped at 8/19): `IB_BEARISH` alone lost **-$838 over 12 real trades (EV -$69.83)**, plus
`PD_VAH_FADE_SHORT` (-$398/N=23) and `OR5_LOW_FADE_SHORT` (-$246/N=13). Checked whether this is the
same circuit-breaker-deadlock mechanism: it isn't, cleanly — `IB_BEARISH`'s stop DID unstick once
(8/20, `deltaN=18`, method `accepted`) but the freshly-recalibrated value landed at almost the same
tight geometry it was already stuck at (51pt/50pt, break-even WR≈50.5%). Its real August 20-31
trades ran roughly 16% WR against that bar — a genuine edge failure, not a stale-calibration
artifact. Plausibly connected to (not yet proven) the 2026-08-12 IB-window correction revealing
`IB_BEARISH`'s true post-correction edge is much thinner than its pre-correction blended history
suggested (see the earlier IB-window-reclassification thread above). **The good news, checked
live just now**: the pipeline did eventually catch this — `IB_BEARISH` flipped to `SUPPRESS` on
2026-08-31 (real WR had fallen to 35.7%) and has zero real fires today (2026-09-01). It caught it,
just ~2 weeks slower than the damage.

**Lesson for future sessions, worth internalizing**: before starting a fresh multi-hour root-cause
investigation into "why did performance degrade," check `scratch/opus_audit_*.md` and
`docs/OPEN_THREADS.md` for a prior session that may have already diagnosed the same window — this
session duplicated real effort by not doing that first, and only found Audit #9 because DeepSeek's
QA pass on this session's OWN reasoning happened to surface the exact commit cluster that led to
it. `OPEN_DECISION roster_level_wr_circuit_breaker_scoped` (Audit #11, above) remains open and
relevant regardless — a rolling-WR circuit breaker would have caught both waves faster than the
existing all-time-average `SETUP_STATUS` gate did.

**Reframe (user-requested pooled ACTIVE+SHADOW view — reveals a more fundamental question than
either individual setup's collapse):**

| period | ACTIVE+SHADOW pooled | ACTIVE only | SHADOW only |
|---|---|---|---|
| Jul-H1 | 64.7% / +$23.21 | 68.4% / +$14.18 | 60.0% / +$34.64 |
| Jul-H2 | 60.3% / +$0.87 | 68.7% / +$13.30 | 56.6% / **-$4.65** |
| Aug-H1 | 49.1% / -$3.89 | 60.9% / +$6.51 | 46.5% / -$6.19 |
| Aug-H2 | 46.2% / -$6.32 | 30.1% / -$23.76 | 47.6% / -$4.82 |

**The broader detection-logic population (SHADOW) was already negative by Jul-H2** — meaning the
underlying signal quality had been softening since mid-July. `ACTIVE` wasn't immune to this; it was
successfully **cherry-picking a strong subset out of an already-weakening pool**, staying positive
through July and early August despite the broader decline. Aug-H2's collapse is better understood
as **ACTIVE losing its selection edge over SHADOW** (the two converge to similarly negative EV)
rather than a sudden new problem — consistent with Audit #11's finding that ACTIVE underperformed
SHADOW on shared setup_types since 2026-08-06. `OPEN_DECISION
active_selection_edge_over_shadow_lost_early_august` (HIGH) — this is now the more fundamental open
question than either of the two now-root-caused individual-setup waves above: what changed in HOW
candidates get selected/promoted from SHADOW into ACTIVE that would explain the selection
mechanism's edge disappearing? The SUPPRESS/PROMOTE methodology changes (`bbc2574`/`4a0a263`) this
session originally (wrongly) treated as explaining the individual-setup collapses may still be
relevant to this narrower, different question. `RESEARCH_CLAIM wr_collapse_two_wave_root_cause_20260901`
(CONFIRMED) has the full synthesis.

**Follow-up same session (still open): checked whether the selection-edge loss is the 4 known-bad
types re-appearing, or a cluster-slot-inheritance effect — found the latter is real but minor.**
Excluding the 4 known-bad types entirely, `ACTIVE` (N=62) still underperforms `SHADOW` (N=859) on
the rest of the roster in Aug-H2 (32.3%/-$11.26 vs 46.0%/-$5.59) — not just those 4. Same-type
controlled comparison: 4 of 6 shared setup_types show `ACTIVE` worse than `SHADOW` of the identical
type in the identical window (`OR5_LOW_FADE_SHORT` gap=-$13.03, matching its own live 0-for-7
losing streak flagged in `OPEN_DECISION or5_low_fade_short_recent_0for7_watch`). Using the
`active_setups.selected_over` instrumentation (built for exactly this "which candidate wins the
primary-fire slot" question): confirmed a real **cluster-slot-inheritance effect** — 12 of 83 real
Aug-H2 `ACTIVE` fires explicitly beat another simultaneously-detected candidate (11 beat
`IB_BEARISH`, 1 beat `IB_BULLISH` — both since-suppressed strugglers), meaning a correlated/
overlapping setup absorbed the "primary fire" slot as its stronger cluster-mate got progressively
suppressed through late August. Those 12 performed just as badly (25.0%/-$18.67) as everything
else — but this only covers 12/83 (14%) of the population. **The other 71 fires (86%) had no
contest at all and were independently, deeply negative (31.0%/-$24.62)** — the bulk of the gap
remains genuinely unexplained. `RESEARCH_CLAIM active_selection_edge_cluster_inheritance_partial_20260901`
(PROVISIONAL). Every mechanism checkable via direct query has now been tried (day-type mix, roster
dilution, IB-specific bugs, stop-width, cluster-inheritance) — the next step needs a real
resimulation-style backtest (recompute `SETUP_STATUS` eligibility under different historical
windows), not another ad hoc query.

**Built and dispatched same session, via the full 3-phase workflow (scope → DeepSeek design
critique → Gemini mine-and-run).** v1 of this resimulation test (compare `NEWLY_PROMOTED` vs
`ALWAYS_ACTIVE` setup_types' forward performance) was killed by DeepSeek's design critique before
ever reaching Gemini — genuinely useful, not wasted effort: v1's no-lookahead construction was
backwards (`run_date <= date` instead of the correct `created_at < fired_at`, inverting the exact
convention Opus Audit #9 established), and more fundamentally, v1 was **doubly confounded from
independent directions** — the `NEWLY_PROMOTED` cohort mechanically overlaps with the
already-confirmed stop-tightening cohort, AND any group selected for clearing a noisy small-N
real-EV bar is a textbook regression-to-the-mean ("winner's curse") setup that would underperform
its own promotion-time estimate even with a completely unbiased gate. A positive v1 result would
have been predicted under the null by both mechanisms simultaneously — it could never have
distinguished a real gate bug from ordinary statistics. **v2** (`scratch/promotion_flip_
attribution_test_design.md`) fixes both: correct `created_at < fired_at` reconstruction, plus a
**"just-missed-the-bar" placebo control** (setup_types that were statistically just as good but
didn't quite clear `PROMOTE_MIN_N=15`/`PROMOTE_MIN_WR=0.52`/`PROMOTE_MIN_EV=0`, verified exact
constants from `scripts/backtest_setup_status.mjs`) — if the promoted cohort underperforms at the
same rate as the just-missed cohort, it's pure mean reversion and the gate is fine; only if
promoted underperforms MORE is there a real bug. Dispatched to Gemini 2026-09-01 ~17:50 ET
(30min budget).

**Result (audited before trusting, per standing rule): script is legitimate, result is real but
too thin to close out.** `scripts/backtest_promotion_gate_placebo_control.mjs` — verified correct
`created_at < fired_at` no-lookahead join, `computeRigor()`/`computeReplication()` genuinely
imported not reimplemented, MTM/IB-window-stale exclusions match established convention. Result
(all-data cut): `PROMOTED` underperformed its own promotion-time estimate by -$15.57 (N=7,
estEv=+$7.71→fwdEv=-$7.86); `JUST_MISSED` placebo underperformed its near-threshold estimate by
**more**, -$42.59 (N=22, estEv=-$0.86→fwdEv=-$43.45). `computeReplication()`: replicates=true,
held-out favorable fraction=1.0. Stop-width control: 100% of both cohorts' forward trades fell in
the same 30-50pt bucket, cleanly ruling out that confound. **Supports pure regression to the mean
(winner's curse), not a promotion-gate bug** — but `PROMOTED` N=7 badly violates this codebase's
own N≥20 floor, and `computeRigor()` shows `clean=false` for `PROMOTED` in both the all-data and
strict (excluding known multi-calibration-run days) cuts. Also flagged: the script didn't filter
to decisive outcomes only (`STOP_HIT`/`TARGET_HIT`) like the rest of this session's analysis,
relying instead on excluding `MARK_TO_MARKET`/`RECOVERY_MTM` resolutions as a rough proxy — not
identical. `RESEARCH_CLAIM promotion_gate_regression_to_mean_thin_20260901` (PROVISIONAL, NOT
decision-grade — flagged with an `unblockCondition` to recheck once `PROMOTED` real N clears 20).
Wired into `scripts/run_weekly_backtests.sh` so it self-recalibrates as real N grows. **This is
the honest current state of the selection-edge residual: the leading hypothesis (a promotion-gate
bug) now looks unlikely rather than confirmed-wrong — a real, if thin, negative — and the
remaining ~86% of the Aug-H2 ACTIVE-underperforms-SHADOW gap (the "no contest" fires) stays
genuinely unexplained.** No further mechanism is queued to test next; would need a fresh angle if
resumed.

**Closed loose end, same session**: the SUPPRESS/PROMOTE-overhaul resimulation the superseded
hypothesis below called "not yet built" actually got written (`scripts/backtest_revert_split_legs.mjs`,
found sitting run-but-unrecorded) — reran and audited it rather than leaving the output
unrecorded. Leg A (old p75_mae/p50_mfe stop/target instead of today's EV-swept `OPTIMAL_STOP`,
real Aug3-Sep1 ACTIVE trades): N=173, +$611.20 total simulated delta (~$3.53/trade) vs. what
actually happened, but `Top5DayPct=52%` — badly date-concentrated, fails this codebase's own
rigor bar. Leg B (old rec90 SUPPRESS/PROMOTE thresholds instead of the real historical gate,
named-formula reconstruction not a literal old-code diff): N=859 (729 newly-eligible from
SHADOW), +$2146.00 total delta, also fails rigor (`Top5DayPct=44.4%`). Both legs point the same
direction as the closed-negative headline (tighter formulas cost money in this window) but
neither clears the stability bar, so this doesn't reopen or change the two-wave root-cause
conclusion above — recorded as `RESEARCH_CLAIM revert_stop_and_suppress_promote_resim_thin`
(PROVISIONAL, thin/date-concentrated) so the result isn't lost, not as a decision-grade finding.

<details><summary>Prior partial hypothesis (superseded, kept for the record — the "systemic,
SUPPRESS/PROMOTE" framing below was a reasonable inference from the data available at the time,
but was superseded by the two-wave root cause above)</summary>

`OPEN_DECISION roster_level_wr_circuit_breaker_scoped`
(flagged in Audit #11 below) is unaffected by this — a circuit breaker is a safety net regardless
of full root-cause attribution. Full detail, all query provenance: `scratch/antigravity_response.md`
+ `RESEARCH_CLAIM stop_tightening_partial_not_sole_cause_of_wr_collapse`'s claim text.

**Continued digging (same session): 2 more candidate explanations tested and ruled out, narrowing
to a systemic-cause hypothesis.** (1) **Not IB-specific** — excluding `IB_BULLISH`/`IB_BEARISH`
entirely, the collapse persists and is just as stark (non-IB: Jul WR=72.0%/EV=+$25.73 N=93 vs Aug
WR=37.9%/EV=-$13.41 N=124); even August's widest-stop non-IB trades are still deeply negative.
Also checked whether the 2026-08-12 IB-window correction (30min→60min IB definition,
`docs/IB_WINDOW_RECALIBRATION_SPEC.md`) explains IB's own share — it doesn't cleanly: excluding
the 15 stale-window-flagged July rows barely moves July's IB numbers (67.1%→66.4% WR). (2) **Not
roster dilution** — weekly distinct real-firing setup_type count actually SHRANK across the window
(17→14→8→7 types/week in July down to 9→9→7→7→6 in August), with at most 1 genuinely new type per
week in August. The roster got MORE concentrated in already-established types, not diluted by
unproven ones. `RESEARCH_CLAIM wr_collapse_residual_not_ib_specific_not_roster_dilution`
(PROVISIONAL). **Combined with the already-ruled-out day-type-mix and single-day/single-setup
explanations, the residual now looks systemic — a roster-wide effect, not attributable to any one
setup_type, signal-definition bug, or composition shift.** Leading untested candidate: the
SUPPRESS/PROMOTE methodology overhaul that landed the same week as the stop/target fix (`bbc2574`,
2026-08-10, gate on real EV not blended; `4a0a263`, 2026-08-03, exclude `TIME_EXPIRED` from
population queries) could have a roster-wide effect via a shared codepath no single-setup
spot-check would surface. Properly testing this needs resimulating `SETUP_STATUS`/`OPTIMAL_STOP`
calibration under pre- vs. post-8/3 logic across the whole roster — a real backtest script, not
another ad hoc query. Not yet built.

</details>

## 🔶 2026-09-01: Opus Audit #11 — the "firehose" problem (user watching a dense afternoon firing stream)

User watched a ~2.5hr stretch (13:02-15:23 ET) of the live activity feed showing ~26 fires across
11+ setup_types, mostly stop-outs, and asked whether the system knows when to stop firing / change
approach, whether it can catch a genuinely large trade, and whether there's a better way to decide
when a trade fires. Dispatched to a full Opus strategic audit (`docs/OPUS_AUDIT_PROMPT_11.md` →
`scratch/opus_audit_11_results.md`, both real DB queries + code tracing, not reasoned in the
abstract).

**Finding 1 (fixed same session): ~77% of the screenshot was a display bug, not a firing
problem.** `server/routes/antigravityEdges.js`'s `/antigravity/edges-context` "Active setups"
query filtered on `s.status != 'SHADOW'` — but `status` transitions to `RESOLVED`/`EXPIRED` the
moment ANY row resolves, shadow or real, so every SHADOW fire leaked into the live feed a few
minutes after firing. Of the 31 visible feed entries in the screenshot window, only **7 were real
`ACTIVE` fires**; 24 were SHADOW-origin. **Fixed**: query now selects `s.origin_status` and
filters `origin_status NOT IN ('SHADOW','BACKFILL')` (the immutable, correct field) instead of the
mutable `status` column. Verified live against the running server post-fix: today's feed dropped
from 31 mixed rows to 27 genuinely real `ACTIVE` rows.

**Finding 2 (the real one, NOT fixed, needs a design decision): real `ACTIVE` win rate collapsed
68.7%→30.1% between 2026-07-H2 and 2026-08-H2** (28.6% in Sept), payoff structure unchanged (avg
win flat ~$80, avg loss shrank) — a pure hit-rate collapse. Equity peaked +$4,919.61 on 08-05, now
+$1,739.51 (-64.6%, 14 of last 18 sessions negative). SHADOW-origin population on the same tape
declined only gently (63%→41%), so generic chop is an incomplete explanation. `RESEARCH_CLAIM
active_vs_shadow_wr_divergence_since_20260806` (PROVISIONAL, full confound checklist applied —
composition artifact, parameter asymmetry, entry-ordinal, single-type domination all controlled
and the gap survives each; honest limits stated: over full history the gap nearly vanishes, this
emerged specifically in the Aug-H2→Sep window). `OPEN_DECISION
roster_level_wr_circuit_breaker_scoped` (HIGH) — recommended design: key on rolling
DECISIVE-OUTCOME WIN RATE (not loss count, not fire count — both tested and found to run the wrong
way, see below), `origin_status='ACTIVE'`-scoped, σ-derived threshold, shipped SHADOW-parallel/
log-only first with a pre-registered kill criterion. Diagnosing WHY the divergence happened should
come before building the breaker — a mechanical fix beats throttling around an unknown cause.

**Finding 3: portfolio loss-count/dollars do NOT predict the next fire's outcome — the naive
"throttle after losses" intuition is INVERTED on this system's real data.** By running realized $
today, the deepest-drawdown bucket (≤-$300) has the BEST EV (+$18.44, WR 64.1%) and the
flat/first-trade bucket is the WORST (-$17.53). `RESEARCH_CLAIM
portfolio_loss_density_inverted_next_fire` (PROVISIONAL, all buckets `computeRigor()`-flagged
clustered/unstable — the loss-density variable itself explains nothing; every bucket's most recent
chronological third is negative regardless of loss context, which is really just Finding 2 showing
up again). **Direct implication: the live "Death Sequence" 0.5x sizeMultiplier ceiling
(`hasLossToday`, `acd.js:9008/9340`) may be sized in the wrong direction per this data** — not
changed, flagged for the same `roster_level_wr_circuit_breaker_scoped` decision above. A hard
fire-count cap was separately tested and also rejected — high-fire days are the PROFITABLE ones
(2026-07-29 fired 61 times for +$1,231); a count cap would have truncated the system's best day.

**Finding 4: will it catch larger trades? No, structurally — a correctly-identified design fact,
not a bug.** Zero of the OR5/OR10/OR15/IB types in the screenshot are wired to any trail/runner
mechanism (`CONDITIONAL_VARIANTS` has 7 `_TRAIL` entries, none in the OR/IB families). Six of
today's types share one generic `volatility-scaled-default` calibration (37pt stop/38pt target,
~$76 hard ceiling); `OR10_*`/`OR15_*` fired today with **no `OPTIMAL_STOP` row at all**. Realized
OR-family ceiling all-time: $118. The one trail-wired type that fired today
(`PD_POC_FADE_SHORT_TRAIL`) produced the day's single largest real winner, +$146.90 (N=1,
suggestive only). This roster is scalp-sized mean-reversion by design; catching a real
continuation move needs either repairing the already-built-but-mostly-broken
`BREAKEVEN_TRAIL_TEST` machinery (5 of 6 blended survivors non-functional since 2026-08-04, see
existing `OPEN_DECISION breakeven_trail_4_more_variants_lost_calibration_row`) or the longer-horizon
IB break/retest/drive redesign (`docs/IB_BULLISH_BEARISH_AUDIT_AND_REDESIGN_SPEC.md`).

**Finding 5 — Resolved 2026-09-03: `cascadeBreaker` deleted entirely.** ~~the disabled
`cascadeBreaker` mechanism's trigger query has no `origin_status` filter~~, so its historical
counterfactual analysis (`cascade_breaker_validation_single_day_artifact`,
`cascade_breaker_suppressed_ev_unstable_recent_reversal`, both now closed as `CONFIRMED`/moot) was
measuring SHADOW/BACKFILL noise, not real trade behavior — the identical bug class already fixed
once in `hasLossToday`. Correctly scoped to real ACTIVE trades, the old trigger (≥3 distinct-type
stops in 45min) would have fired on only 6 of 444 real trades (1.4%) — structurally unvalidatable
either way, confirming option (b) rather than (a). `OPEN_DECISION
cascade_breaker_query_missing_origin_status_filter` resolved via full deletion: the computation,
the audit-row insert, a separate duplicate computation in `antigravityEdges.js`, and the frontend
"FADE REGIME OFF" banner (`ACDView.jsx`/`App.jsx`) are all gone. **New follow-on found during the
deletion, not yet resolved**: `cluster_attributed_setups` was deliberately scoped narrow in 2026-07-29
because `cascadeBreaker` was, at the time, handling the more extreme trending-cascade case — that
coverage has had nothing behind it since 2026-08-05, over a month before anyone noticed. See
`OPEN_DECISION trending_stop_cascade_no_suppression_since_20260805`.

**Also found, not yet fixed**: the RTH refire cooldown (`isInRefireCooldown()`/
`REFIRE_COOLDOWN_MINUTES`, real and wired at `acd.js:9747`/`9968`, contrary to what the audit brief
assumed) is a hardcoded ~15-entry static minute map covering ~15 of ~130 live types — a standing
no-static-thresholds violation, not evaluated further this session. Full detail, all query
provenance, and the complete confound-checklist workthrough: `scratch/opus_audit_11_results.md`.

## ✅ 2026-09-01 (RESOLVED, clean negative): post-stop price continuation / order-flow imbalance as a refire quality signal

User's idea, prompted by a real chart showing sustained one-sided cumulative delta: after a
stop-out, does what price/order-flow actually did in the window between the stop and a same-type
refire predict the refire's outcome — was the move that caused the stop CONTINUING (real momentum
against the fade) or reverting/fizzling (more legitimate re-test)? Two direction-aware measures,
independent of the already-confirmed-negative `displacement_since_last_visit_fade_quality` test
(that one used generic magnitude; this one specifically tracks further movement in the failed
trade's own adverse direction, plus order-flow imbalance over the same window). Tested on real
(`origin_status='ACTIVE'`) same-type refires specifically after a `STOP_HIT` (not after a win),
N=156 across 21 distinct days (top5DayPct=55.1%, thin-ish but not disqualifying). **Clean
negative**: post-stop continuation AUC=0.516, post-stop order-flow imbalance AUC=0.516 — both
indistinguishable from chance. Tercile spread (T3 EV=$14.67 vs T1/T2 both negative) looked
suggestive but isn't a real monotonic relationship given the AUC — consistent with noise, not a
graded effect. Formation-type breakdown (`SAME_DAY_FORMING` LOW-cont EV=$0.17 vs HIGH-cont
EV=-$8.42, N=18/26) is directionally interesting but too thin to trust on its own. `RESEARCH_CLAIM
postloss_aggression_predicts_refire_outcome` (PROVISIONAL, 30-day recheck). Script:
`scripts/backtest_postloss_aggression_refire.mjs`. Approach pace (below) remains the one validated
lead from the whole refire-quality investigation; this closes out the last of the user's proposed
angles on it.

## 🔶 2026-09-01: what actually discriminates GLOBEX_VWAP_MAGNET/PD_VAH_FADE_SHORT refire outcomes — approach pace, a real lead

User pushed back on the earlier refire-cooldown fix ("id hate to just mute something that is live
rather than find out a more strict way to trade it") and asked directly: when these refiring
setups DO work out, is it more volume, more confluence, something else? Tested 4 candidates via
real AUC on the 58 real (`origin_status='ACTIVE'`) fires of `GLOBEX_VWAP_MAGNET_LONG/SHORT` +
`PD_VAH_FADE_SHORT`: `confluence_score_at_detection` (AUC=0.462, noise), reconstructed
`minutesSinceVisit`/freshness (AUC=0.554, weak — and structurally can't discriminate this
population since 52/58 trades already share the same "just visited" status by construction of
being refires), volume-building compositeStrength with full 58/58 bar-reconstructed coverage
(AUC=0.477, noise — an initial N=14-coverage read of 0.625 was sampling noise from the live
column's sparse population). **One real signal: approach pace** (points/bar over the 15 bars into
the touch) — AUC=0.776, clean monotonic tercile WR (slow=15.0%/mid=40.0%/fast=66.7%),
chronologically stable and strengthening ($13.67→$52.17→$105.93), 12 distinct days. Mechanistically
sensible: a slow grind into a level suggests weak participation likely to chew through it; a sharp
spike is the classic exhaustion-and-reverse pattern a fade wants. `RESEARCH_CLAIM
approach_pace_discriminates_globex_refire_setups` (PROVISIONAL). **Real caveat**: dominated by
`PD_VAH_FADE_SHORT` (N=14/18 in the fast tercile) — `GLOBEX_VWAP_MAGNET` itself only has N=2 per
direction here, too thin to validate specifically for the setup type that started this thread.
First-pass exploratory (N=58, single test), not yet a proper walk-forward backtest on the broader
roster.

**Built out same session** (user: "yes" to scoping the real backtest) —
`scripts/backtest_approach_pace_fade_quality.mjs` on the FULL real fade roster (N=1354, not just
the 3 refire-prone types). **Stronger and broader than the exploratory pass, not just a
replication**: clean monotonic walk-forward quartile EV ($-7.22/$-0.43/$5.59/$7.44), Q4
chronologically stable, holds independently in both RTH (AUC=0.540, N=1010) and Globex (AUC=0.563,
N=344) per this codebase's hard rule, and — resolving the earlier concentration worry — broad
across **76 distinct setup_types** in the fast-approach quartile with the top type only 9.1%
share. `RESEARCH_CLAIM approach_pace_fade_quality_full_roster` (PROVISIONAL). Wired into
`run_weekly_backtests.sh` as a standing recheck. `OPEN_DECISION
wire_approach_pace_as_size_factor` scopes the real remaining work before this sizes real risk: a
bar-by-bar stop/target simulation (per the new-setup-type checklist's own item 5 — the current
result is a correlation against trades' own already-calibrated exits, not a from-scratch
simulation) and a sensitivity check on the 15-bar window (taken from the exploratory pass,
never independently swept). If both hold, this is a real candidate cross-cutting size factor for
the whole fade roster — a meaningfully bigger win than the original refire-cooldown fix, if it
pans out. Does not replace the separate, already-flagged `OPEN_DECISION
wire_refire_cooldown_into_detectglobexsetup` (the dead-config bug fix) — the two are
complementary, not either/or.

**User's follow-up idea, tested and closed** ("just quieting the refires vs waiting until
something more legitimate turns the odds in our favor... how far has price moved from the first
failed trade") — a displacement-based "watcher" instead of a time-based cooldown: has price
genuinely left the level and come back (a real re-test) vs. just chopping/clustering around it
(should be ignored)? The single-setup exploratory check (12 `PD_VAH_FADE_SHORT` refires) looked
like clustering wins, but 11 of 12 came from a single day (2026-08-28) — too thin/clustered to
trust. Built the full-roster version (`scripts/backtest_displacement_since_last_visit.mjs`,
N=958, 30+ distinct days): **clean negative, not just inconclusive**. Pooled AUC=0.514 (noise),
and — unlike pace, which agreed in direction across every family — the formation-type breakdown
genuinely disagrees in SIGN (`SAME_DAY_FORMING` favors clustering, `OTHER` favors displacement).
`RESEARCH_CLAIM displacement_since_last_visit_fade_quality` (CONFIRMED negative). The single-day
read was real but not generalizable. Approach pace remains the one validated lead from this whole
refire-quality investigation. Kept scheduled per this codebase's no-dead-ends convention.

## 🔶 2026-09-01 (in progress, methodology corrected mid-session): SAME_DAY_FORMING volume-building fade filter re-verified and STRENGTHENED, day-thin — standing weekly recheck wired

User asked to forward-test/wire the parked `momentum_ctx_sameday_walkforward_stable` finding
(docs/VOLUME_BUILDING_EXPANSION_SIGNAL_SPEC.md sec 6b, original N=324, $11.95-12.19/trade, IB/OR
family only) given real IB/OR trade N is now healthy (446 real fires/39 days).

**First pass** (smoothed 30-bar backdrop average, tercile split): binary median weakened/lost
stability ($3.59/trade); a tercile split found a real, non-reversing top-tercile effect
($18.06/trade, N=90) blocked only on day-diversity (12 distinct days).

**User directly challenged the methodology** ("I thought we were testing using terciles? ... your
very quick to discard when negative" / "it looks like you are terciling over a small timeframe")
after the PRIOR_DAY_OR_DEVELOPING follow-up (below) came back looking like a clean negative on the
first pass. Two real bugs, not just style: (1) the test measured a 30-bar **trailing average** of
compositeStrength, not compositeStrength **at the touch bar itself** — a different variable than
the one the large RUN/HELD test (N=36,848) actually found its signal with; (2) tercile split was
inconsistent with that RUN/HELD test's own quartile bucketing, risking exactly the coarse-bucket-
hides-a-real-effect failure this thread had already seen once (SAME_DAY_FORMING's binary split
hiding what terciles revealed). **Corrected methodology (AT-TOUCH compositeStrength, quartile
split, shared in `scripts/lib/volbuildWalkforwardAtTouch.mjs`) made the SAME_DAY_FORMING finding
STRONGER, not weaker**: genuinely monotonic Q1→Q4 ($-7.28/$1.25/$10.17/$26.87), Q4 chronologically
stable=true (was borderline before), progression $32.95→$30.24→$16.42. Still blocked only on
day-diversity: Q4 spans 12 distinct days (67.2% from top 5), same constraint as before, need ≥25.
Wired as a **standing weekly recheck** (`run_weekly_backtests.sh`) — `RESEARCH_CLAIM
same_day_forming_volbuild_quartile_fade_quality` upserts fresh numbers weekly; `OPEN_DECISION
same_day_forming_volbuild_quartile_promotion_trigger` (superseding the pre-correction version)
names the concrete bar. Real IB/OR volume (15-30 fires/day) suggests weeks, not months, away.

**Follow-up chased same session** (user: "yes chase it") — does the much larger, cleaner
PRIOR_DAY_OR_DEVELOPING RUN/HELD signal (N=28,984, stable, `RESEARCH_CLAIM
volume_building_run_held_by_level_formation_type`) translate into a real fade-quality edge for
that family? Reused the same shared walk-forward lib. **First pass looked like a clean negative**
(no tercile bucket positive) — but this was the SAME flawed methodology (smoothed backdrop,
tercile) that undersold SAME_DAY_FORMING, so declaring "CONFIRMED negative" off one bucketing
choice was premature, exactly the pattern the user's pushback named. **Corrected version (at-touch,
quartile) is still NOT a clean positive** — genuinely inconclusive, not confirmed either way:
U-shaped, not monotonic ($2.44/-$9.02/-$6.01/$3.14), Q4 unstable (63.5% day-clustering) and
*declining* over chronological thirds ($9.30→$7.30→-$7.63). A raw (non-walk-forward, in-sample
only) top-decile check hinted at more promise (+$8.66/trade) but isn't trustworthy on its own —
at this point 4 different cuts have been tried on the same historical data, and continuing to hunt
for a positive cut is exactly the multiple-comparisons fishing this project's rigor culture exists
to prevent. `RESEARCH_CLAIM prior_day_volbuild_quartile_fade_quality` (PROVISIONAL, genuinely
inconclusive — not CONFIRMED negative, that status was walked back). Kept scheduled in
`run_weekly_backtests.sh` per this codebase's no-dead-ends convention. **Do not re-run with yet
another ad hoc bucket/measure choice** — if revisited, it needs real accumulating forward N via
the weekly recheck, not a new cut chosen after seeing the data.

**Process lesson, stated directly because it recurred**: don't declare a rigor check's result
(positive OR negative) final after trying only one bucketing/measure choice, especially right
after a different bucketing choice already proved decisive for a sibling test in the same session.
Test consistency across related claims (did I use the same measure the other test that found the
underlying signal used?) before trusting either a positive or a negative.

## ✅ 2026-09-01 (RESOLVED): idea D Step 5 built (too thin) + a large volume-building validation (user's idea) + a real Globex refire-cooldown gap found

**Idea D Step 5** (`scripts/backtest_liquidity_zones_idea_d_step5.mjs`): extends the Step 0 census
with `clusterFreshFrac`/`clusterMaxAccepted`. N=20 matches the census exactly after fixing a real
bug (a different naive-timestamp footgun than the one below — `fired_at::text` + `new Date(str)`
parses as local time in V8 vs node-pg's UTC-labeled native parsing, a 4hr shift that starved the
population to N=5 before the fix). Only 14 of 20 have resolved P&L, split 1-7 per 2×2 cell — too
thin to be decisive. `RESEARCH_CLAIM liquidity_zones_idea_d_step5_full_build` (PROVISIONAL).

**Volume-building cross-check** (the user's own idea — "can we use volume build work to help
verify liquidity zones"): does volume-building composite strength at a level touch predict RUN
(consumed) vs HELD (defended)? Dispatched to Gemini; it produced a correct script but timed out
(15min, 479 dates × 78 levels is genuinely heavy). Claude audited it in full, found and fixed a
real performance bug (O(session-length) backward walk per touch → O(1) precomputed lookup,
verified byte-identical output before trusting the fix), scoped to the most recent 120 trading
days, and ran it for real: **N=36,848 scoreable touches, RUN rate rises monotonically with
compositeStrength (pooled 6.5%→24.5%), holds independently in both RTH and Globex, chronologically
stable, not day-clustered (10-17%)**. `RESEARCH_CLAIM
volume_building_strength_predicts_level_run_vs_held` (CONFIRMED) — a real, large, independent
validation of the liquidity-zones concept, though a caveat applies: this is a market-behavior
finding, not license to re-run the already-rejected blanket fade-roster P&L filter using the same
measure. Full writeup: `docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md` §4.24.

**Separate, unrelated finding surfaced mid-session** (user noticed a real dashboard pattern —
`GLOBEX_VWAP_MAGNET_LONG` firing 9 times in 2.5hrs, mostly losers): `REFIRE_COOLDOWN_MINUTES=30`
exists in `acd.js` for `GLOBEX_VWAP_MAGNET_LONG/SHORT` but is **never consulted by
`detectGlobexSetup()`** (the function that actually fires them) — that function has its own,
narrower re-arm check (blocks a refire only if the prior trade resolved in under 3min, a bad-tick
filter, not a time-since-resolution cooldown). Confirmed via real `origin_status='ACTIVE'` trade
data: every refire in the flagged cluster fired 2-11 minutes after the prior resolution, not 30.
Tested whether to broaden the fix to all Globex setup types — **no**: most (`PD_POC_FADE_LONG/
SHORT`, `GLOBEX_VWAP_FADE_LONG`, `PD_VAL_FADE_LONG`) have never refired within 30min in real
trading history at all. Two real candidates: `GLOBEX_VWAP_MAGNET_LONG/SHORT` (design-intent
matches, but its entire real history is only 12 trades across 3 days — too thin to prove refiring
itself is the problem vs. the setup being weak overall) and `PD_VAH_FADE_SHORT` (not currently in
the cooldown map, but a real, 24-distinct-day negative: refire WR 25.0%/EV -$16.50 (N=12) vs.
baseline WR 53.6%/EV +$8.23 (N=28)). An apparent 84-fire single day (2026-07-29) turned out to be
stale `SHADOW`-only flooding predating the 2026-08-20 `SHADOW_NOISE_SUPPRESSION_MINUTES` fix for
exactly this pattern — excluded from the real analysis. `RESEARCH_CLAIM
globex_refire_within_30min_penalty_by_setup_type` (PROVISIONAL). Recommended fix (not yet shipped
— live entry-gating change, needs explicit go-ahead): wire `detectGlobexSetup()` to consult
`isInRefireCooldown()`/`REFIRE_COOLDOWN_MINUTES` for `GLOBEX_VWAP_MAGNET_LONG/SHORT`, and add
`PD_VAH_FADE_SHORT` to that map. `OPEN_DECISION wire_refire_cooldown_into_detectglobexsetup`.

**Also flagged, not yet designed**: user's own idea for a "dip absorption speed" signal (does a
small adverse move get bought/sold back quickly and repeatedly, as a stay-in-the-trade signal) —
distinct from liquidity zones (dynamic in-trend behavior, not static level defense), closer to the
existing exit-management/runner thread. Real scoping gap found immediately: this codebase has no
volume-bar/tick-bar data source, only 1-minute time bars — the user's own reference granularity
(500/1000-volume bars) doesn't exist here today. `OPEN_DECISION
adverse_move_absorption_speed_runner_signal`.

## ✅ 2026-09-01 (RESOLVED): liquidity-zones idea D census contradiction reconciled — a 3rd SQL bug, not a real negative

Resumed after a context clear left `OPEN_DECISION liquidity_zones_idea_d_census_contradiction`
mid-investigation (flagged, not yet root-caused): the same-day 92%/N=12 (§4.1, 2026-08-26) vs.
0.0%/N=766 (Task 2 above, 2026-09-01) idea-D-census disagreement. Found both scripts
(`scratch/census_idea_d_cluster_freshness.mjs` and `scripts/pilot_idea_d.mjs`), read both in full,
and reproduced the disagreement directly against the DB rather than trusting either number.

**Root cause: a 3rd, previously undiscovered bug in `pilot_idea_d.mjs`**, distinct from the 2 fixed
in the same-day audit above. Its bar-window query used one `$1` parameter both cast `::date` (day
boundary) and compared bare against a `timestamp` column (`ts < $1`). Postgres unifies a parameter's
type across every appearance in a single query — the explicit `::date` cast silently truncated the
bare comparison to midnight too (confirmed directly: `SELECT $1 as raw_param` in a query mixing
`::date` and bare usage of the same param returned `'2026-08-20'`, no time-of-day at all). That made
`ts < $1` equivalent to `ts < <midnight>`, impossible together with the script's own `time >= 570`
filter — **the bar-window query returned zero rows for literally every input row**, mechanically
forcing both `anchorVisited` and `anyPartnerVisited` to false regardless of the real data. The
0.0%/N=766 "decisive negative" was a pure artifact.

Fixed (two separate query params). Corrected script: **1/6 (16.7%)** — N-starved, and using a
narrower/less rigorous construction than the 2026-08-26 script (FADE-only population, `entry_zone`
midpoint as an anchor-price proxy instead of a real `level_prices` lookup, no same-day-forming-level
formation gate). Re-ran the 2026-08-26 script's more rigorous construction fresh against 6 more days
of data instead: **N grew 12→20 (clears this codebase's N≥20 floor for the first time), rate held
92%→90%.** Per the spec's own pre-registered rule, **idea D genuinely survives Step 0 and is worth
building** — the opposite of what the buggy same-day audit concluded.

`RESEARCH_CLAIM liquidity_zones_idea_d_free_census_rigorous_construction` (CONFIRMED, N=20/90%) is
now the load-bearing number; `RESEARCH_CLAIM liquidity_zones_idea_d_free_census` (the
`pilot_idea_d.mjs` N=6 result) is kept as directional-only, not weighed against it.
`OPEN_DECISION liquidity_zones_idea_d_census_contradiction` resolved. New `OPEN_DECISION
liquidity_zones_idea_d_step5_build_needed` (MEDIUM) flags the real remaining work — a genuine
EV/WR-tested comparison (already-visited-partner cluster vs. genuinely-fresh cluster), which needs
its own N≥20 per arm and will likely start as a SHADOW-tagging pass rather than a full live wire.
Full writeup: `docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md` §4.23.

## ✅ 2026-09-01 (RESOLVED): POC_ROTATION_JOIN_LONG/SHORT built and shipped live (SHADOW-only)

Resolves `OPEN_DECISION poc_rotation_join_build_live_detector`. Ported
`detectSignalEvents()` (the ZigZag-style leg/pivot + running-median-fair-value
convergence detector, originally built and audited in
`scripts/backtest_poc_rotation_vbp.mjs`) into a live, poll-computable form:

- **Extracted the canonical detector** into `server/services/pocRotationService.js`
  (moved, not copied — `backtest_poc_rotation_vbp.mjs` now re-exports it unchanged so
  its 14 existing downstream importers keep working without modification). Verified via
  a fresh backtest re-run before/after the extraction: N grew 767→775 from real new
  sessions between runs, same methodology, no behavior change.

- **New live poller** `server/services/pocRotationJoinDetector.js`, wired into
  `server/index.js`'s existing 60s `setInterval` alongside `detectRthFlush`/
  `detectGlobexFlush`/`detectMomentum60Trend` (same "own poller, not the level-touch
  candidates array" pattern — this is a whole-session leg-tracking construction, not a
  price touching a fixed level). **Stateless/restart-safe by design**, directly applying
  this same session's GLOBEX_FLUSH restart-fragility lesson: every poll recomputes
  `detectSignalEvents()` fresh from real bar history; the one in-memory cache field is a
  poll-skip optimization only, never a correctness dependency (a reset just re-attempts
  inserting already-fired events, which harmlessly no-ops against `active_setups`'
  unique index).

- **Construction**: JOIN direction (trade WITH the leg that just converged back to the
  running 24hr median fair value) + Time60_Stop20 exit (20pt stop, 60-minute time limit,
  mark-to-market, **no fixed price target**) — the validated winner per
  `RESEARCH_CLAIM poc_rotation_join_fade_levels_med50_fixed` (N=1935, WR=29.2%,
  EV=+$2.40/trade, real but thin, not rigor-clean).

- **Resolution**: since this is a genuinely target-less exit shape, it does NOT go
  through `resolveSetupsByPrice()`'s shared generic bar-walk (WIDER_TARGET/trail/extend
  logic) — added its own custom early-`continue` branch there instead, matching the
  existing `ABSORPTION_LONG`/`COIL_SURGE` precedent, deliberately avoiding edits to that
  complex shared critical path without its own review. `t1_level` on the live row is an
  unreachable informational placeholder (entry ± 1000pt), never checked for resolution.

- **Session span**: the full 6PM–5PM ET window continuously (matches
  `developing_value_log`'s convention), not RTH-only or Globex-only — legs freely cross
  both, so this satisfies CLAUDE.md's RTH+Globex-both-required rule structurally rather
  than via two separate calibrations (per the backtest's own KNOWN LIMITATION note).

- **Checklist items closed**: `bet_class` (added to `CONTINUATION_TYPES` — JOIN is a
  continuation-shaped bet, not a fade), `SETUP_DISPLAY_LABELS`, `setupDefinitions.js`
  (Setup Reference), `ARCHITECTURE.md` services table, `SETUP_STATUS` seeded via a live
  `backtest_setup_status.mjs` run (THIN_N, N=1 each, closing the "zero real touches ever
  is not automatically SHADOW-safe" gap immediately rather than waiting for the weekly
  cron). `SHADOW`-only throughout (real N=0 < 20).

- **Verified end-to-end in the actual restarted server process** (not just a manual
  script): 2 real events fired live within the first two 60s poll cycles after restart
  and resolved correctly — one `STOP_HIT` at exactly -$42 (20pt×$2/pt + $2 commission,
  confirming the custom branch's bar-by-bar stop check works), two more via
  `TIME_EXPIRED`/`MARK_TO_MARKET` at +$132/+$186.50 (confirming the time-limit path).

- **Deliberately NOT wired yet**: the ONH/ONL (`RESEARCH_CLAIM
  poc_rotation_join_onh_onl_confluence`, N=335, EV $21.18) and WS1 (N=42, EV $22.15)
  confluence findings — get the base type accumulating real data first, per the original
  decision's own explicit sequencing. Revisit as a follow-up once real N grows.

## ✅ 2026-09-01 (RESOLVED): audited 3 Gemini scripts from the combined dispatch — 2 real bugs found and fixed

Resolves `prefire_orderflow_touch_gate_candidate` and `liquidity_zones_defended_levels_ideas_pending_test`
(Step 0 only) and `volume_building_thread_untouched_angles_for_later` (sub-item a only). Each of the
3 delivered scripts was read in full before trusting anything, per the standing rule — 2 real bugs
found and fixed, one script clean as-is:

- **Task 1 (pre-fire order-flow gate)**: clean methodology (verified the `volZ`/`oneSidedRatio`
  formula genuinely matches `acd.js`'s live `STACK_VOL_BREAK_LIVE` code), one caveat noted (uses
  the bar strictly before `fired_at`, not the exact trigger bar — a related but not identical
  test). Result: negative, no monotonic predictive power, N=1446.

- **Task 2 (liquidity-zones idea D census)**: **2 real bugs found and fixed here**, plus **a 3rd,
  more severe one found later the same day (see the 2026-09-01 "idea D census contradiction
  reconciled" entry below — this paragraph's "0.0%/N=766, dies for free" conclusion was WRONG,
  a pure SQL artifact, not a real result; do not cite it).** (1) reconstructed "anchor freshness"
  using a window going back to 6PM the prior evening, but the real live `minutesSinceVisit` only
  ever looks at same-day RTH bars — a materially wider, non-equivalent window. (2) `fired_at` was
  never cast to `::text`, so a JS Date object got passed back as a SQL parameter and silently
  shifted 4 hours by the session timezone on round-trip (verified directly: Postgres rendered a
  09:37 ET touch as 05:37 ET) — this codebase's own documented naive-timestamp footgun, hit again.
  These 2 fixes alone were genuinely correct and needed — but a 3rd bug (a Postgres parameter
  type-unification issue that made the bar-window query unconditionally empty for every row) was
  still present after them and wasn't caught in this audit pass; it made the "N grew 154→766,
  14.9%→0.0%" result meaningless. See the later entry for the real, reconciled finding.

- **Task 3 (volume-building day-type conditioning)**: clean methodology, the closest audit given
  it's the one positive finding — verified the composite score formula matches `acd.js`'s real
  live `compositeStrength` computation exactly (not an invented formula), correct ground-truth
  day-type source, canonical `classifyLevelFormation()`, no lookahead. Reproduced identically on
  independent re-run (N=1161). Real finding: day-type composition doesn't explain the inherited-
  vs-same-day dose-response gap, but a real BALANCE-day sign-flip interaction does (high
  volume-building hurts same-day levels, helps inherited ones) — TREND shows an unexplained
  same-sign puzzle in both groups, flagged for later.

**Common gap across all 3**: none of Gemini's `recordClaim()` calls populated `sampleSize`/
`winRate`/`evPerTrade`/`rigorStatus` — only free-text `claimText`, leaving the RESEARCH_CLAIM
ledger's structured N/EV columns blank. Fixed in all 3 before finalizing. 3 throwaway scaffolding
scripts (`check_msv.mjs`, `read_claims.mjs`, `read_all_claims.mjs`) deleted — exploration
artifacts, not deliverables. Remaining follow-on work re-flagged as its own decisions:
`liquidity_zones_steps_1_through_4_remaining` (MEDIUM) and
`volume_building_inherited_level_remaining_angles_bc` (LOW).

## ✅ 2026-09-01 (RESOLVED): GLOBEX_FLUSH missed a real ~530pt overnight move — 2 real bugs found and fixed

User asked "did we catch the overnight drop?" — investigation of a genuine ~530pt NQ move
(2026-08-31 evening into 2026-09-01 morning) found `GLOBEX_FLUSH_LONG/SHORT/REVERSAL_LONG/
REVERSAL_SHORT` fired **zero** times despite this being exactly the mechanism built to catch this
shape of move. Two real, distinct bugs, found in sequence (the first hypothesis was wrong and
corrected before shipping anything):

1. **Restart fragility** (`server/services/globexFlushDetector.js`) — the armed departure state
   lived only in an in-memory module variable across the ~17hr overnight watch window, no DB
   persistence. 339 `SERVER_SHUTDOWN` events in the 7 days checked — restarts are routine in this
   codebase's dev workflow, never a rare edge case. Fixed by removing the cache and re-deriving
   the departure fresh from real bar/level history every poll, matching `rthFlushDetector.js`'s
   own already-restart-safe design (RTH never caches its trigger at all).
2. **Narrow trigger window** — the actual explanation for last night, found *after* first
   wrongly concluding bug #1 alone explained it (a manual check used the wrong day's PD_VAH,
   caught before it shipped). The departure check only looked in a fixed 30-minute window right
   at RTH close (4:00-4:30 PM ET) — last night's real value-area break didn't happen until
   **10:35 PM ET**, ~6 hours after that window closed, structurally invisible regardless of
   server uptime. Widened to check the full overnight watch period (4 PM through 9:30 AM).

**Retroactively verified against real data**: the fixed logic now correctly finds the DOWN
departure at 22:35 ET and would have fired `GLOBEX_FLUSH_SHORT` at 22:42 ET (entry 29436.75) —
well ahead of the continued slide to ~29040. Server restarted, healthy, `test_invariants.mjs`
shows no regressions from this change (one new unrelated FAIL, confirmed pre-existing calibration
drift on `IB_HIGH_FADE_SHORT`, zero code overlap with the touched file).

## ✅ 2026-09-01 (RESOLVED): POC-rotation-JOIN promotion decided YES, build deferred as its own session

Resolves `OPEN_DECISION poc_rotation_join_promote_to_live_setup_type`. Reviewed the actual
detection mechanism (`detectSignalEvents()`, `scripts/backtest_poc_rotation_vbp.mjs`) before
deciding — it's a genuine ZigZag-style leg/pivot detector with an incremental running-median
fair-value tracker, not a simple level-touch check. Porting it into `acd.js`'s live 15s-poll
detection loop safely is comparable in scope/risk to the VWAP-reclaim structural-stop build
already deferred this session, not a quick wire.

**Decision: yes, worth pursuing.** The base trade construction has real, independently-replicated
confluence findings with somewhere to attach (ONH/ONL EV $21.18/trade N=335; WS1 EV $22.15/trade
N=42) and the user has asked to wire this in multiple times. Not attempted this session — flagged
the actual build as its own new decision (`poc_rotation_join_build_live_detector`) with the full
5-step scope (port the detector live, pick/confirm the canonical exit, wire the confluence
findings, SETUP_STATUS/OPTIMAL_STOP calibration, SHADOW-only per N<20) since "should we start" and
"build it" are different questions.

## 🔶 2026-09-01 (in progress): 3 more research items dispatched to Gemini

`prefire_orderflow_touch_gate_candidate` (a genuine pre-entry order-flow filter pilot, reusing the
live `volZ`/`oneSidedRatio` block `STACK_VOL_BREAK_LIVE` already uses), the liquidity-zones spec's
"idea D" free census (`liquidity_zones_defended_levels_ideas_pending_test`), and day-type-
conditioning the inherited-vs-same-day raw expansion signal
(`volume_building_thread_untouched_angles_for_later`, sub-item a) — all dispatched together.
Not yet returned; audit before trusting any number, per the standing rule.

## ✅ 2026-09-01 (RESOLVED): all 3 dtClass-gated sizing/standdown gates come back negative — extends the trend-gate finding

Resolves `OPEN_DECISION dtclass_other_3_gates_untested`. The 2 combined Gemini dispatch tasks
finished with very different outcomes — audited both before trusting either.

**Task 1 (dtClass gates) succeeded, after a real bug fix.** The delivered script
(`scripts/backtest_dtclass_sizing_standdown_gates.mjs`) filtered its loss-streak lookback on
`fired_at < candidate's fired_at` — a genuine lookahead bug (a prior trade that fired earlier but
*resolved after* the candidate fired could get counted using an outcome that wasn't actually
knowable yet). Fixed to `resolved_at <` before running. Result, real (`ACTIVE`/`SHADOW`) fade
population N=1122, live-reassessment TREND reads 68.0% of the time (consistent with the
already-established ~70.6% false-positive rate for touch-moment evaluation): **all 3 gates come
back negative or unreliable** if swapped from the dead `dtClass` source to the live reassessment
engine — TREND-day sizing penalty (delta -$187.95, N=763, not rigor-clean), OR-expansion bonus
(delta +$125.90 but 98% day-clustered, not trustworthy), STAND DOWN filter (delta -$1534.80 across
574 suppressed rows). **Do not wire any of the 3** — extends, rather than contradicts, the
original 2026-08-03 `isTrendCounterFade` finding. Recorded as `dtclass_gate_a/b/c` RESEARCH_CLAIMs.

**Task 2 (IB-range exit signal) failed audit, discarded rather than run.** Its script
(`scripts/backtest_ib_range_exit_daytype_gated.mjs`) had 3 disqualifying problems: used $20/pt
(full NQ) instead of this codebase's MNQ $2/pt (a direct hard-rule violation), no `computeRigor()`
call despite explicit instruction, and the comparison itself didn't test the actual research
question (compared average MFE points across buckets — a market-move measure, not what an actual
hold-longer exit mechanism would capture; its own comments call it "very simple/a proxy for now").
Deleted rather than left as a misleading starting point. `wire_intraday_ib_range_exit_signal`
stays genuinely PENDING — re-flagged with the specific fixes a real rebuild needs (real $/pt
constant, `computeRigor()`, an actual net-P&L delta comparison instead of an MFE-magnitude proxy).

## ✅ 2026-09-01 (RESOLVED): bar-10 stop-cushion checkpoint re-attempted at 8x larger population — real, no longer reverses

Resolves `OPEN_DECISION trade_management_continuous_score_worth_reattempting`. Re-ran
`scripts/backtest_stop_cushion_checkpoint.mjs` — the exact bar-10 "how much stop-cushion remains"
test that reversed sign at N~200 back on 2026-07-27 — against the current real population
(N=907 checkpoint-eligible events, up ~4.5x from the eligible-subset count, ~8x on the base
ACTIVE/SHADOW population this decision's own trigger was keyed to). Result this time: a real,
clean effect that does **not** reverse. Median split at stopCushionFraction=0.967: LOW cushion
(closer to stop at bar 10) N=453, EV=**-$37.37/trade**; HIGH cushion (more room) N=454, EV=**+$13.09/trade**
— delta $50.46/trade. Chronological 70/30 split holds up (train delta $53.35 N=634, test delta
$42.99 N=273, same sign, similar magnitude — no reversal). `computeRigor`: stable=true,
clustered=false, clean=true (all 3 chronological thirds negative for the LOW-cushion group).
Recorded as `RESEARCH_CLAIM bar10_stop_cushion_reattempt_larger_population` (PROVISIONAL).

**Real open caveat before this goes anywhere near live/SHADOW**: it may substantially overlap
with the already-live `bar6_checkpoint`/`targetDistFraction` mechanism — both measure "how far
underwater is this trade," just at different fixed bars (6 vs 10). Before trusting this as a
genuinely *additive* signal rather than a later, redundant re-measurement of what bar6 already
captures, check the correlation between the bar-6 and bar-10 reads on the same trades, and
whether bar-10 adds real incremental information conditional on the bar-6 read. Also not yet done:
`bet_class` split (this codebase's own standing pooling-risk caution) and `computeReplication()`.
Does **not** itself build "the fuller continuous per-bar re-evaluation function" the original
2026-07-26 idea envisioned — that remains a separate, larger undertaking.

## ✅ 2026-09-01 (RESOLVED, wired live): slow+deep adverse-grind early exit — new informational mechanism

Resolves `OPEN_DECISION slow_deep_adverse_grind_early_exit`. The CONFIRMED finding (N=691,
family-gated across 4 bet_classes, rigor-clean, replicates — `docs/SLOW_DEEP_EARLY_EXIT_SPEC.md`)
had no live mechanism built. Added `computeSlowDeepEarlyExit()` (`server/services/maeMfeReplay.js`),
matching `computeBar6Checkpoint()`'s exact precedent — a pure function called once from
`resolveSetupsByPrice()`'s shared resolution loop with the same `bars.rows` array, compute-once-
never-overwrite. Walks forward bars tracking running MAE; the first bar where MAE crosses 75% of
the trade's own original stop distance sets `speed=FAST` (≤2 bars) or `SLOW` (3+ bars), matching
the CONFIRMED claim's own bar-count convention exactly. `ruleSaysExit=true` only when `speed=SLOW`
AND the setup's bet_class is one of the 4 validated families — family-gated per the spec's own
"never ship pooled" rule.

New columns `active_setups.slow_deep_exit_speed`/`slow_deep_exit_recommended`, migrated live,
`schema.sql` regenerated (also caught up broader unrelated drift since the last 2026-06-30
snapshot). Purely informational — this system has no broker execution capability, matching the
same caveat `bar6_exit_recommended` already carries. Server restarted, HTTP 200 confirmed,
`test_invariants.mjs` shows the same 8 pre-existing FAILUREs as baseline (no regressions), lint
clean. **Not done**: frontend display on `quick-check.html` — DB tracking was the priority piece,
matching the same precedent used for the OR-range/RVol tagging earlier this session.

## ✅ 2026-09-01 (RESOLVED): 3 more backlog items — 2 turned out already-stale, 1 needed user input

- **`value_fade_daytype_positive_signal_needs_live_gate_research`** — RESOLVED, accepted as
  currently unactionable. Checked for a viable new live regime signal before defaulting to that:
  none exists (the only candidate, the value-area regime layer, is explicitly tagging-only/
  unvalidated per its own documentation) and re-testing the already-tried reassessment engine
  would very likely hit the same structural bias already found for `isTrendCounterFade` (fade-touch
  moments look like momentary trends). The BALANCE-day-positive edge stays real but unactionable;
  path 1 (a genuinely new signal) stays open in principle, not permanently closed.

- **`claude_md_restructuring_scoped_not_executed`** — RESOLVED as STALE. The restructuring this
  decision tracked ("not started") had actually already been executed the same day it was flagged
  (2026-08-12, per `docs/CLAUDE_MD_RESTRUCTURING_PLAN.md`'s own "Result" section — 4 commits, all
  3 detail files genuinely exist with real content, verified directly). CLAUDE.md has since grown
  back to 111KB (from 99KB post-split) over the 3 weeks since, as new hard rules/conventions were
  added in full narrative form without re-applying the same condensation discipline going forward.
  Re-flagged the actual remaining work as a fresh decision (`claude_md_needs_recondensation_20260901`,
  LOW) rather than reusing the stale slug — this is "condense 3 weeks of new content," not "redo
  the original split." Not started; per the original plan's own caution, this is a real multi-hour
  task that shouldn't be rushed into a single sitting.

- **`rolling_window_backtest_generalization_idea`** — user narrowed scope to the OR family only,
  then asked to skip describing the boundary basis for now. Left parked, unchanged.

- Also ran the scheduled `archive_open_threads.mjs` manually (cron catch-up hadn't caught it) —
  `docs/OPEN_THREADS.md` was 404KB against its own 250KB cap; moved 1 old section out, still over
  cap but that's expected given how active the last 7 days have been, not a new problem.

## ✅ 2026-09-01 (RESOLVED): 4 more backlog items closed — exit-mechanism family, VWAP_RECLAIM_SHORT, 18-script cron audit

Continuation of the same-session backlog-clearing pattern, same "check for newer superseding work
before redoing anything" discipline throughout.

- **`exit_logic_family_holistic_reassessment_20260818`** — RESOLVED. Verified, both in code and
  empirically against the DB, that the 4 independently-built exit-timing mechanisms (bar6,
  wider-target, slow-deep-early-exit, breakeven-trail) cannot produce contradictory signals on the
  same trade: bar6 is purely informational (never changes resolution), slow-deep isn't wired live
  at all, and `wider_target_mult`/`runner_trail_width` (the 2 that DO change resolution) are
  mutually exclusive by design at every one of 5 INSERT sites checked — confirmed empirically, 0
  of 1600 real `wider_target_mult` rows and 0 of 3 real `runner_trail_width` rows ever co-occur.
  bar6's cutoff re-check is already tracked separately (`verify_bar6_exit_recommended_live`).
  Sharing machinery between slow-deep and bar6 is deferred until slow-deep clears CONFIRMED
  (still PROVISIONAL, unwired). Breakeven-trail is worth keeping scheduled — `PD_POC_FADE_SHORT`
  already graduated to real calibration earlier this same session.

- **`vwap_reclaim_short_structural_stop_not_yet_built`** — decision point RESOLVED (build itself
  deferred as new decision `vwap_reclaim_short_build_structural_stop`). Real forward SHADOW data
  has accumulated (N=20, right at the N≥20 trigger this decision set): EV=-$39.78 to -$43.58/trade,
  WR 19-25%, `SETUP_STATUS`=THIN_N, all 3 chronological thirds negative — the fixed-point-stop
  simplification is underperforming badly vs. Phase 1's validated structural-stop prediction
  (EV=+$5.96/trade). Per the decision's own pre-stated logic, this means: yes, build the real
  structural-stop resolution path. Not attempted this session — genuine risk to a shared,
  heavily-loaded function (`resolveSetupsByPrice()`), deserves its own dedicated, reviewed session.

- **`roadmap_phase0_18_scripts_need_recordclaim_wiring`** — RESOLVED. Individually inspected all
  18 scripts. None actually need `recordClaim()`/cron wiring — they're one-time diagnostics (2
  literally self-labeled "one-off, not scheduled" / "INCONCLUSIVE" in their own header comments)
  whose findings are already superseded by later, more current live-wired work (bar6 mechanism,
  BIGMOVE_LIVE_SIGNAL, the current flagship 1yr prop-walkthrough script, the closed candle-pattern
  spec) or already fed into the standard `SETUP_STATUS` pipeline. Caveat: categorization based on
  documented history + each script's own comments, not a line-by-line status re-verification of
  all 18 `RESEARCH_CLAIM` rows.

## 🔶 2026-09-01 (in progress): 2 dtClass-gated backtests + IB-range exit signal, dispatched to Gemini

`dtclass_other_3_gates_untested` (the 2 remaining sizeMultiplier/standDown gates keyed on the
permanently-null `dtClass` — freshly relevant after today's sizeMultiplier audit independently
confirmed `dtClass` is NULL on 63/63 real fires) and `wire_intraday_ib_range_exit_signal`
(compression-based exit timing, needs day-type as a REQUIRED live condition, not the dead
end-of-day column the original test used) both need the same live day-type reassessment engine
(`dayTypeReassessmentService.js`/`computeCase()`) and the same rigor discipline as the
already-resolved `backtest_trend_gate_suppression.mjs`. Dispatched together to Gemini
(2026-09-01) with explicit instruction to reuse that exact pattern, not reimplement. Not yet
returned — check back before trusting any number, per the standing audit-Gemini-output rule.

## 🔶 2026-09-01: sizeMultiplier composite redesign Phase 0 — critique overturns the spec's own premise, redirected

`OPEN_DECISION sizemultiplier_composite_redesign_scoped_pending_review` — dispatched
`docs/SIZE_MULTIPLIER_COMPOSITE_REDESIGN_SPEC.md` to DeepSeek for the Phase 0 design critique its
own rollout plan called for. DeepSeek used real DB tool access to verify its claims rather than
critique abstractly (timed out mid-writeup at 15min, but had already run its verification) — its
finding was independently re-confirmed directly against the DB (N=63 real `ACTIVE`/`SHADOW` fires
with `size_factors_at_detection`, larger than DeepSeek's own N=41 subset, same pattern):
`dtaRowRecommendation` NULL 63/63, `entryPressureShortBoost` TRUE 0/63, `dtClass` NULL 63/63
(matches the already-tracked `dtclass_null_all_day_neuters_multiple_live_gates`), `smallGapDay`
TRUE 57/63. Only 4 distinct `size_multiplier` values exist across all real fires
(`{0.10:27, 0.25:34, 1.25:1, 1.30:1}`) — 97% sit at the two clamp floors.

**The 2 factors the spec held up as the model of "self-recalibration done right" (day-type bump,
entry-pressure boost) are exactly the two that never fire on any real row.** Real output variance
is almost entirely loss-streak-driven (`lfConsecLosses` + `hasLossToday`), not the other ~23
factors the spec proposed making continuous. Recorded as `RESEARCH_CLAIM
sizemultiplier_factor_hygiene_audit_reveals_dead_factors` (PROVISIONAL — sample is day-clustered,
92% top-5-day, but the 0%/100% factor rates are extreme enough to be structural).

**Redirected, not resolved**: building a composite score on top of the current stack would fit a
fancier model on mostly-dead/constant inputs — the spec's own Phase 1 (Gemini mine-and-run
comparison) is premature. Next step is a factor-hygiene/saturation census (fix or remove dead
factors, especially `dtClass` which is already separately scoped) *before* deciding whether a
composite redesign is still worth building on whatever factors actually vary. Spec doc updated
with a "Phase 0 critique result" section at its top; not yet done.

## ✅ 2026-09-01 (RESOLVED): RTH VWAP_MAGNET's "stable loser" reading was a short-history artifact, not real

Resolves `OPEN_DECISION globex_vs_rth_vwap_magnet_divergence_unexplained` (open since 2026-08-04).
The original finding compared `GLOBEX_VWAP_MAGNET_LONG` (real, strengthening edge, ~3.5yr
reconstruction) against RTH `VWAP_MAGNET_SHORT` (a "stable loser across all 3 chronological
thirds") at the same S=100/T=60 configuration — an unexplained session-dependent flip. The RTH
side's reconstruction depended on `getTrailingVwapStd()`, which reads `session_analysis.close_vs_vwap`
— only ~109 real days deep (back to 2026-03-25), nowhere near the Globex side's ~3.9yr
`price_bars_primary`-derived history.

Built `getTrailingRthVwapDists`/`getTrailingRthVwapStdFullHistory` (`server/services/queries.js`)
— the RTH-bar equivalent of the Globex helper, computing the same quantity directly from
`price_bars_primary`'s full history instead of the short table. Verified byte-identical to
`session_analysis.close_vs_vwap` on 5 overlapping dates before trusting it. Re-ran the identical
S=100/T=60 reconstruction both ways in the same pass (`scripts/backtest_vwap_magnet_rth_extended_window.mjs`):

| | N | Mean P&L | SHORT | Rigor |
|---|---|---|---|---|
| Old (109-day window) | 271 | +$2.28 | **-$15.10/trade** | not stable/clean |
| New (3.9yr window) | 747 | +$18.19 | **+$20.44/trade** | stable, clean |

With 2.75x the data, RTH `VWAP_MAGNET_SHORT` flips from a "stable loser" to the strongest leg of
the comparison. **Neither original hypothesis (a: real session mechanism / b: no mechanism, be
skeptical of Globex too) was right — the actual answer is (c): the RTH-loser reading was itself a
short-history statistical artifact**, exactly as the original decision's own text speculated might
be the case. Recorded as `RESEARCH_CLAIM vwap_magnet_rth_extended_window_reconstruction`
(PROVISIONAL — single-script, not yet independently re-verified). Does not by itself explain
Globex's strengthening z-trend (a separate, still-open question) — isolates that the RTH side
specifically was the artifact. New functions are backtest/reconstruction-only, not wired into any
live path — `getTrailingVwapStd` (the live threshold source) is unchanged.

## ✅ 2026-09-01 (RESOLVED, not promoted): 2-lot scale-out with breakeven-minus-5 runner — closed against the corrected baseline

Resolves `OPEN_DECISION twolot_scaleout_breakeven_minus5_runner_scoped_20260831`. The 2026-08-31
second-pass headline (+$7.63/trade) compared the mechanism against a synthetic "exit-all-no-runner"
strawman, not the user's actual current strategy — the second pass's own text had already computed
an `exactBe` reference arm (2-lot, exact-breakeven runner) without promoting it to primary. Doing
that promotion: **delta beMinus5 vs exactBe is only +$1.39/trade at T1=12pt**, and **negative at 3
of the other 4 T1 candidates** (T1=16: -$0.34, T1=20: -$1.18, T1=30: -$0.41; T1=24: +$0.19 near
zero). Most of the original edge was a structural-baseline artifact (beating giving-up-the-runner-
entirely, not beating what's actually already being done).

**Independent re-verification**: dispatched to Gemini with an explicit instruction to build a
fresh implementation blind to the existing script. Gemini's independent build
(`scratch/reverify_be_minus5.mjs`) corroborated the qualitative result (+$2.30/trade at T1=12,
thin/mixed-sign elsewhere) — audited the actual script (not just the writeup) and confirmed it
independently arrived at the same same-bar-ambiguity handling and the same real-`stop_level`
design choice without having seen this codebase's code, genuine convergent validation.

**Conclusion: closed, not built.** The real edge over the user's actual strategy is too thin and
not robust across the T1 neighborhood to justify live/SHADOW execution plumbing. `docs/TWOLOT_SCALEOUT_BREAKEVEN_MINUS5_SPEC.md`
updated with a "Third-pass result — CLOSED" section; `OPEN_DECISION twolot_scaleout_generalize_to_other_setups`
(the deferred "apply this elsewhere" question) is now moot for this specific mechanism.

## ✅ 2026-09-01 (RESOLVED): breakeven-trail 5-of-6-uncalibrated decision closed; contaminated `B_FLOOR_S1_FADE_LONG` row nulled

Resolves `OPEN_DECISION breakeven_trail_zero_real_survivors_20260816`. Checked current state before
acting (the last update to this decision was 2026-08-16/20) rather than redo stale analysis:
**`PD_POC_FADE_SHORT` has since genuinely graduated** — a real `BREAKEVEN_TRAIL_TEST` row exists
(run_date 2026-08-25, real N=24, trail=19.3pt, OOS EV +$30.31 vs -$2.31 fixed-target baseline),
already tracked and already wired live on both RTH and Globex (2026-08-31 `resolveUnconditionalTrailVariant`
work) — left untouched. The other 5 wired `_TRAIL` variants remain uncalibrated (no current
`BREAKEVEN_TRAIL_TEST` row at all — 0/5, not 0/6 as previously framed).

Took the decision's own option (b) for the one remaining stale row: `B_FLOOR_S1_FADE_LONG` still has
real (`ACTIVE`/`SHADOW`) `TARGET_HIT` N=0 (all 68 real target-hits are `BACKFILL`-origin) — nulled
`notes.trail` on all 5 historical weekly rows for this signal_name (all held an identical stale
trail=20.3pt, confirmed before nulling, so no distinct history was lost; original value preserved
per-row as `notes._original_trail_before_null`). The live consumer now falls back to a plain
fixed-target trade for `FLOOR_S1_FADE_LONG_TRAIL` instead of trailing on a synthetic-only basis,
matching the `OPTIMAL_STOP` circuit-breaker precedent. Verified via read-back same turn.

## ✅ 2026-08-31 (RESOLVED): Setup D's range+RVol finding wired for live tracking — no longer a dead end

Follow-up to the range+RVol combo finding above (`RESEARCH_CLAIM
setup_d_range_rvol_combo_robust_across_windows`) — user asked "how can I track this?" and the
honest answer was "not yet, it's backtest-only." Per this codebase's own "no dead ends" hard rule,
wired it properly rather than leaving it a passive claim: added `active_setups.or_range_at_detection`/
`.rvol_20d_at_detection` (real migration — `ALTER TABLE`, `server/schema.sql` regenerated,
`ARCHITECTURE.md` updated), stamped on every future `OPENING_DRIVE_15MIN_LONG/SHORT` fire (both
the immediate and pullback entry paths) via a new day-cached `getOrVolBaseline20d()` helper
(trailing-20-day OR-window volume average, strictly prior days, no lookahead). NULL for every
other setup_type, which never sets these on their candidate object. `node --check`/`eslint` clean,
`test_invariants.mjs` shows no new regressions (the one new FAIL, `GLOBEX_VWAP_FADE_LONG`, is an
unrelated OPTIMAL_STOP calibration drift, confirmed out of scope).

**Discovered along the way**: the dev server's systemd unit had been cleanly stopped (not crashed)
8 hours prior — restarted via the standard `./start.sh` per the existing dev workflow.

**Still not done**: no frontend display of the new columns yet (Setup History view could show
them per-fire, matching how `SHADOW`/`BACKFILL` tags already render) — the DB-level tracking is
the priority piece (satisfies "persisted queryable" + "has a recheck path" once real SHADOW fires
accumulate), frontend display is a nice-to-have, not blocking. No live filter/downweight wired
yet either — this is tagging only, matching the deliberate `vol_building_signal`/`regime_pos_Nd`
precedent (informational, not gating) until real forward data confirms the backtest finding.

## 🔶 2026-08-31: Setup D — direction asymmetry, drawdown, day-type, and monster-day threads (late-session round)

Continuation of the Setup D thread below, prompted by user follow-ups after the exit-mechanism
work closed out. Several distinct findings, all independently re-verified:

- **Win rate reveals shorts carry the whole edge**: current live 159/80 hits target 55.0%
  overall (needs 66.5% to break even on target/stop alone — the strategy survives on what the
  31% "expired" bucket does, not the raw hit rate). Split by direction: **SHORT hits 69.4%**
  (self-sufficient, clears break-even on its own) vs **LONG only 41.2%**, with LONG's defining
  failure being *failing to commit* (41% of longs neither hit target nor stop, just meander to
  session end) rather than getting stopped out more. Recorded as `RESEARCH_CLAIM
  setup_d_direction_split_winrate_long_weak_link`.

- **LONG-side entry filter screen** (5 candidates: drive magnitude, order-flow, volume-building,
  NL30, gap): one real but thin, counterintuitive lead — lighter volume-building at entry lifts
  LONG's hit rate from 41% to 56% (N=25 vs 26) — still short of the 66.5% break-even bar. Verdict:
  LONG's weakness is structural, not fixable with a smarter filter on what's been tested.

- **Real drawdown check**: worst historical losing streak (both directions combined) is 4 trades,
  -$964; worst peak-to-trough drawdown $1,088 — both centered on the most recent stretch in the
  data (late July–Aug 2026). With only ~100 trades on record, a worse streak than anything
  observed (e.g. 5 stops in a row, ~$1,600) hasn't happened yet but isn't statistically far-fetched.

- **Day-type check**: LONG's only losing bucket is TURBULENT days (50% WR, N=8, thin) — BALANCE
  and TREND are fine. SHORT is robust across all three. Not usable live as stated, though — day_type
  isn't known until ~8:20pm ET, well after the 10:15am entry decision (same structural gap that
  broke IB_BULLISH/IB_BEARISH).

- **Monster-day early-warning screen**: does anything before 10:15am predict a 600+pt session?
  Dispatched to Gemini, then independently audited — **2 real lookahead bugs found and fixed**
  (Overnight Range joined to the wrong night; Gap Size compared today's open to today's own
  not-yet-existing close — both corrected in `scripts/test_monster_day_predictors.mjs`, full
  before/after numbers in `reports/monster_day_predictors_2026-08-31.md`). Core finding survives
  correction: a real, clean, pre-entry signal for "today will be a monster day" exists (best:
  first-15-min OR range, AUC=0.881), but the days it correctly flags have WORSE average PnL
  ($18.79 vs $54.27) — extends `docs/COMPRESSION_TAIL_MFE_SPEC.md`'s existing finding that wide
  mornings predict chop, not clean trend. No early-warning-based exit adjustment is justified.
  Recorded as `RESEARCH_CLAIM setup_d_monster_day_predictors_corrected_still_negative`.

- **Follow-up, the strongest lead found all session**: does OR range COMBINED WITH relative
  volume (RVol) predict something the monster-day screen missed? `scripts/backtest_setup_d_range_rvol_combo.mjs` —
  splitting into quadrants (OR range vs its own median) × (RVol vs its own median), the
  "HIGH range + HIGH RVol" bucket is the worst by a wide margin (avg PnL -$9.65, N=31, contains
  9 of the 11 real monster days) vs "LOW range + LOW RVol" (+$69.09, N=29) at a 20-day RVol
  window. **Deliberately swept 5 RVol lookback windows (10/15/20/25/30 days) before trusting
  any single one** — the user's own habitual 10-day convention initially showed this, then
  reversed sign under a chronological-stability check (first-half direction flipped). Sweeping
  the neighborhood found 15/20/25/30-day all agree (same direction in BOTH chronological
  halves), only the thinnest (10-day) window disagrees — consistent with 10-day being the noisy
  outlier, not the true answer. This is the one filter idea from today that survived a genuine
  robustness check across parameter choices, not just one lucky number. Recorded as
  `RESEARCH_CLAIM setup_d_range_rvol_combo_robust_across_windows` (PROVISIONAL — still needs
  real forward SHADOW confirmation before hardening into a live filter).

- Real full-population NQ daily range check (not just Setup-D-triggering days): mean 317pt,
  median 275pt across all 449 trading days — confirms the user's own instinct that daily range
  typically runs north of 300, with a real fat right tail (max 1,620pt) pulling the mean up.

**Where this leaves Setup D**: entry (hybrid drive-magnitude rule) and exit (159/80, single entry)
both stand as tested. The clearest actionable open thread is the long/short asymmetry — SHORT is
a real, standalone, well-validated edge; LONG is a genuinely weak, close-to-coin-flip signal that
survives mostly on its non-resolving trades landing near flat rather than losing badly.

**RESOLVED 2026-09-01**: flagged as `OPEN_DECISION setup_d_long_short_sizing_asymmetry` and put to
the user directly (live-capital-sizing-affecting). **Decision: leave as-is for now** — no sizing
change, both LONG and SHORT stay SHADOW-only at the existing 159/80 combined exit (which already
implicitly prices in the asymmetry). Revisit once real N grows past the current ~2-fires-in-20-days
starvation level — re-check the direction split and the volume-building LONG filter lead
(41%→56% hit rate, N=25/26) with a larger sample before deciding size-down vs pause.

## 🔶 2026-08-31: Setup D (OPENING_DRIVE_15MIN) Stage 2 — a real, currently 100%-forfeited opportunity found; discriminator screen in progress

Follow-up to the (resolved, below) IB_BULLISH/IB_BEARISH thread — user's redirect: "figure out
how to capitalize on big breaks." Landscape check first: `BRACKET_BREAKOUT_SHORT` is a real,
decisive loser (real EV -$42.60/trade, N=20, stable); everything else in the breakout family has
essentially no real trade history except `OPENING_DRIVE_15MIN_LONG/SHORT` (Setup D), which
already passed a real Stage 1 bar-history validation (N=138, rigor-clean, beat a blind-delay
control) but has fired only 2 real times in 20 days — thin by starvation, not by failure.

**Stage 2** (`scripts/backtest_setup_d_opening_drive_stage2.mjs`, dispatched to Gemini, every
number independently re-verified by re-running directly): tested (a) an immediate-entry variant
(no pullback wait) and (b) a volume-building magnitude split on both entry styles. Immediate
entry alone fails OOS (-$1.80/trade vs Arm A's $38.15) — driven by ~46pt of real average worse
entry price. **User's own question ("are they addressing the same trade just differently?") led
to the real finding**: decomposing immediate-entry's 205 signals into "overlap" (139 days that
also pull back — Arm A's entry fires) vs "exclusive" (66 days that NEVER pull back — Arm A
structurally can't take these at all) showed the exclusive population alone is worth
**EV=$85.54/trade — more than double Arm A's $37.54/trade on its own population** — a real,
currently 100%-unexploited opportunity (~15% of all classified-drive days). Volume-building does
NOT discriminate which bucket a day falls into (score distributions barely differ, median -0.41
vs -0.20) and is actually mildly counterproductive as a filter within the exclusive bucket
(bottom tercile $111.43 > top tercile $65.07) — ruled out as the tool for this specific job.
Recorded as `RESEARCH_CLAIM setup_d_immediate_entry_vs_pullback_decomposition` (PROVISIONAL).

**Discriminator screen ran, same session** (`scripts/backtest_setup_d_opening_drive_stage3_screen.mjs`,
dispatched to Gemini, independently re-verified byte-for-byte): of 6 candidates, **drive
magnitude at confirm-close is a real, OOS-validated discriminator** — `(price - OR boundary) /
OR range`, signed by direction. Exclusive days had already traveled a median 0.69 OR-ranges by
10:15am vs 0.38 for overlap days; holds on a chronological train/test split (train AUC=0.293,
test AUC=0.329, same direction, doesn't decay). Honest caveat: this is close to "already-traveled-
further is mechanically harder to fully retrace," not a hidden order-flow secret — still real,
previously-unused information though. All 5 other candidates (order-flow imbalance,
volume-building, lookahead-corrected NL30 alignment, gap status, structural-level proximity)
came back genuinely null (AUC 0.45–0.51). Recorded as `RESEARCH_CLAIM
setup_d_drive_magnitude_discriminator` (PROVISIONAL).

**Built and OOS-validated, same session** (`scripts/backtest_setup_d_opening_drive_stage4_hybrid.mjs`):
a hybrid rule — immediate entry when drive magnitude clears a threshold, otherwise the existing
pullback-wait entry. Threshold (median split, 0.479 OR-ranges) picked using ONLY the
chronological train fold (4 pre-registered candidates, no fine grid search), then applied blind
to the untouched test fold: baseline (pullback-only) EV=$33.07/classified-day → hybrid
EV=$41.96/classified-day, a real **$8.89/classified-day OOS lift**. Rigor-clean, no
day-clustering (top5DayPct=2.7%), stable across all 3 chronological thirds. Tautology check (is
this just "ran out of time to retrace"?) came back reassuring, not conclusive — both an
ample-remaining-time and a thin-remaining-time subgroup show a comparable positive edge.
Recorded as `RESEARCH_CLAIM setup_d_hybrid_drive_magnitude_entry_oos_validated` (PROVISIONAL).

**Wired live SHADOW-only, same session** (`server/routes/acd.js`'s `openingDrive15Min` block):
at confirm-close, if drive magnitude clears `DRIVE_MAG_IMMEDIATE_THRESHOLD` (0.479, hardcoded
fallback pending a dedicated calibration row — same bootstrap pattern the pullback path's own
stop/target already uses), fires immediately using the confirm-close bar's own price (not
`currentPrice`, to avoid drifting away from what was actually backtested) with its own
stop/target (159/80); otherwise falls through to the existing pullback-wait logic unchanged.
`existingSetup`'s per-(trade_date, setup_type) dedup already guarantees this fires at most once
per day regardless of which branch a given poll takes — no new time-window guard needed.
`test_invariants.mjs` shows no new regressions (same 6 pre-existing FAILUREs). Still SHADOW-only
(no real trade alerts) — real forward data needs to accumulate and confirm this before any
promotion consideration, standard pipeline.

**Separately requested, not yet built**: a real excursion check (MFE/MAE, uncapped) on the
"immediate entry" population showed the current 80pt target is likely too tight (median real
favorable run ≈98pt, p75≈140pt, p90≈246pt) and the 159pt stop lets ~25% of trades' real adverse
excursion through — but MAE and MFE are comparably sized (median 88.5pt vs 98pt), so a wider
fixed target alone probably isn't the fix; a trailing/runner mechanism (already built and
validated on a different family earlier this session) is the more promising next angle, not yet
tested on this specific setup. Sizing-up this setup (user's own suggestion, given its rarity) is
reasonable in principle but premature before real forward SHADOW data exists to size against —
revisit once it does.

**Exit-mechanism follow-ups, all tested and closed out this session** (user: "test all avenues"):
velocity (magnitude/time-to-break) added nothing beyond drive magnitude as a discriminator or MFE
predictor (test AUC ≈ random). A fixed multiple of the trailing-20-day 1-min-bar-range as an
ATR-scaled target/stop lost decisively to the current fixed 159/80 both in-sample and OOS. A
precisely-confirmed Sierra Chart "ATR Ranges" level (read directly from the user's own study
settings: session-open ± 10-session RTH ATR) does NOT reliably pin the real MFE — spread over 200
points in the middle 50% of trades — nor does a prior-week high/low for overshoots (N=20, same
problem). One real, smaller pattern did emerge: bearish big-break drives tend to reach/exceed the
ATR-low, bullish ones tend to fall short of the ATR-high — a directional bias, not a magnet.
Recorded as `RESEARCH_CLAIM setup_d_atr_weekly_level_exit_negative` (CONFIRMED). User's own take:
"ATR gives a general target but not spot on" — consistent with the data.

**Bearish floor / bullish bimodality claims, tested and closed out**: the claimed "~200pt minimum"
for bearish drives once volume-building is confirmed sustained is false — even the top-tercile
building subset shows median MFE only ≈119pt (N=16, thin), with 200+ reached by roughly the top
15-25% of cases, not a floor. The "shoots up quickly OR grinds up all day" bullish pattern is real
but not in the way floated — fast-peaking drives (<60 bars) are typically the SMALLER moves
(median ≈60pt, N=21), slow-grinding ones (≥180 bars) the bigger ones (median ≈118pt, N=11, thin) —
different-sized outcomes, not two equal paths to the same result.

**Exit-mechanism comparison, tested and closed out**: a proper fixed-target sweep, the already-live
breakeven-trail runner, and the already-live wider-target-on-fast-arrival mechanism (both reused,
not reimplemented) were all tested against the current live 159/80 on this exact population, with
one real bug caught and fixed along the way (a walk-loop off-by-one vs this codebase's own
`resolve()` convention — made zero practical difference once corrected, since 1-min bar ranges are
far smaller than these stop/target distances). Breakeven-trail is a clear loser (-$21 OOS,
confirms it's a mean-reversion-tuned mechanism, a category error here). Wider-target is a wash
(effectively identical to baseline; this setup develops too slowly for the mechanism's own
fast-arrival assumptions to even engage). A tighter fixed target initially looked like a small
win but its own OOS thirds are decaying badly ($171→$78→**-$104**) — not trustworthy. **No change
made** — the live 159/80 stands, nothing tested earns the right to replace it. Recorded as
`RESEARCH_CLAIM setup_d_exit_mechanism_comparison_negative` (CONFIRMED).

**Wider target sweep and re-entry test, both settled** (`scripts/backtest_setup_d_stage6_widersweep_reentry.mjs`,
independently re-run, numbers reproduced): a comprehensive fixed-target sweep (60-250pt × 3 stops)
confirms the current 80/159 is the actual WINNER of the whole grid — nothing wider comes close
(100pt drops to $24, 120pt+ falls to near-zero or negative). Re-entry after an exit is a decisive
loser (single-entry EV=$36.53/day vs with-re-entry=-$4.96/day) — re-entering specifically after a
TARGET_HIT is catastrophic (N=55, -$77.66 added EV per bucket), re-entering after a STOP_HIT is
mildly positive but far too small to offset it (N=14, +$8.79), and the whole idea gets worse over
time, not better. Recorded as `RESEARCH_CLAIM setup_d_wider_target_sweep_settled_negative` and
`RESEARCH_CLAIM setup_d_reentry_after_exit_negative` (both CONFIRMED).

**Setup D exit-mechanism thread now fully closed**: after testing ATR-scaled targets, ATR/weekly
pinning levels, the breakeven-trail runner, the wider-target mechanism, a comprehensive fixed-target
sweep, and re-entry — all negative — the live 159/80, single-entry, no-re-entry exit stands as the
validated-by-elimination design. No further exit-mechanism work planned unless new evidence
surfaces (e.g. once real forward SHADOW data accumulates for the entry rule itself).

## ✅ 2026-08-31 (RESOLVED): IB_BULLISH/IB_BEARISH — real thesis doesn't match the live code at all; redesign scoped, tested, both suppressed

User question ("IB_BEARISH continues to stink, how is it still live") led to a real-data audit
that found a live misleading-text bug beyond the already-known
`ib_daytype_calibration_structurally_unreachable` gate issue — the alert's `tier` label is a
dead constant (`dtClass` null collapses it to the same value every fire), and the description
text hardcodes a "best day-type" claim that's empirically wrong per real data, one that has
flipped 3 times across 3 independent audits in this file's own comment history (noise being
re-discovered as signal, not a stable effect).

**Then the user clarified what these setups are actually supposed to be**: capitalize on a
break-and-retest of the 60-min Initial Balance boundary, then drive until the move exhausts.
That reframed the whole thread — confirmed the live code (`computeIbBullBear()`) implements
none of it: no break-of-boundary check (only a midpoint-position check), zero "retest" logic
anywhere in `acd.js`, no drive/continuation confirmation, fires as one unconditional snapshot
the instant IB closes. The entry signal never tested the thesis it's named for, which plausibly
explains the whole history of unstable, contradictory day-type findings.

Rectified against siblings per user request: `OPEN_TEST_DRIVE_LONG/SHORT` (test-then-drive off
the open) is the closest existing analog and is a decisive real negative (EV -$29.54/-$14.74,
N=113/106, suppressed since 2026-07-05) — a real prior worth weighing, though the IB boundary
(60-min-earned, widely-watched) is a different anchor than a single open price. The general
structural-breakout-retest engine (`docs/STRUCTURAL_BREAKOUT_RETEST_SPEC.md`) already tested
this same shape of idea on swing pivots and got a clean 0/8 negative — second independent
caution. `IB_HIGH_FADE`/`IB_LOW_FADE` (fade thesis) and `STOP_SWEEP_LONG/SHORT` (reversal
thesis, currently `ACTIVE` and fine) confirmed as different families, left alone.

Full doc rewritten: `docs/IB_BULLISH_BEARISH_AUDIT_AND_REDESIGN_SPEC.md` now leads with a
concrete break/retest/drive detector (Idea 1, PRIMARY) as the real redesign — required confound
controls (immortal-time-bias, structural-advantage control arm) explicit up front, given the two
negative priors. Exit shape naturally pairs with the wider-target/breakeven-trail mechanisms or
the 2-lot scale-out thread scoped earlier this same session (a continuation trade fits a
runner-style exit far better than the current fixed 30-45pt target). Two refinements folded in:
reusing the already-live `vol_building_signal` specifically as a live drive-vs-exhaustion gauge
DURING the trade (not just an entry filter, per the user's own refinement), and a continuous-
strength upgrade path for the break/retest/drive parameters once validated. Would be one of the
only genuine trend-continuation bets in a ~118/122-fade roster, matching the user's documented
breakout-trading preference — a real reason to test properly, not a guarantee of success given
the priors.

**Step 1 shipped same session**: removed the dead `tier` field (`server/routes/acd.js`, a
dtClass-keyed ternary that always evaluated to the same value — dtClass is null at this point in
the live session, so every live IB_BULLISH fire showed `tier='WEAK'`, every IB_BEARISH fire
showed `tier='MARGINAL'`, regardless of actual conditions) and the two hardcoded "TREND days:
strongest"/"TURBULENT: strongest. BALANCE: suppressed" description claims (unverified static
text, contradicted by real data). Grepped first to confirm no frontend component reads this
setup's `.tier` field — pure no-op on display. The live `_edgeText()` call still gives the real
blended-EV summary. `node --check` + `eslint` clean.

**Step 2 shipped same session**: dispatched the plan (not code) to DeepSeek for a design critique.
Audited the result before acting on it (per the standing "audit all model output" rule) — caught
one misread (DeepSeek claimed a hard contradiction between Idea 1's retest tolerance and Idea 3's
deferral; the spec's own text already resolves this, Idea 3 only defers the OTHER two params).
Everything else checked out and is now incorporated into the spec: resolved state-machine
definitions (break=close not wick, fixed-fraction-of-IB-range retest tolerance for v1 not
ATR-relative, one-signal-per-day, distinct-bar sequencing to kill an intra-bar lookahead risk), a
redesigned confound-control plan (the naive "blind-delayed-entry" control was invalid for a
direction-committed setup — replaced with an all-break-days control + a placebo/level-swap
control), a new confound (drive-confirmation distance is itself a momentum filter), and an
exit-shape correction (the fade-validated wider-target/2-lot-scaleout mechanisms are a category
error for a continuation trade's return shape, not just mistuned — must be re-validated from the
observed forward-return distribution, not reused wholesale). Full detail:
`docs/IB_BULLISH_BEARISH_AUDIT_AND_REDESIGN_SPEC.md`'s new "DeepSeek design critique" section.

**Step 3 (the placebo/level-swap test) ran and came back CLEAN NEGATIVE, same session.**
Dispatched to Gemini, independently re-verified (Gemini's script omitted its own print calls;
re-added them, re-ran directly against `gemini_readonly`, every number reproduced exactly — see
`scratch/reproduce_ib_placebo_test.mjs`). NQ 1-min RTH bars, 2022-12-14 to 2026-08-31, 449 days.
The real IB boundary showed flat-to-negative, sign-inconsistent forward returns and was actually
WORSE than an economically meaningless IB-midpoint placebo on the bearish side across all 3
horizons (20/40/60min) — this directly refutes the one differentiator ("a widely-watched,
60-min-earned level") that justified testing IB despite the two prior negatives (`OPEN_TEST_DRIVE`,
the structural-breakout-retest engine). The all-break-days control also showed the retest+drive
filter adds no measurable EV over trading the raw break. DeepSeek's design critique predicted
this exact outcome on mechanism grounds before the test ran. Recorded as
`RESEARCH_CLAIM ib_break_retest_drive_placebo_test_negative` (CONFIRMED). Full numbers:
`docs/IB_BULLISH_BEARISH_AUDIT_AND_REDESIGN_SPEC.md`'s new "Step (a0) result" section.

**RESOLVED, same session: user confirmed "dump them both."** Implemented via a new
`MANUAL_SUPPRESS_OVERRIDE` in `scripts/backtest_setup_status.mjs` (removed both from
`DAY_TYPE_CONDITIONAL`, which was itself the mechanism giving them a pass whenever any one
bucket cleared the bar). Ran the pipeline live — both now show `recommendation='SUPPRESS'` in
`performance_audit`, picked up by `_suppressedSetups` on the next poll, same SHADOW-only
treatment as every other suppressed setup_type. `OPEN_DECISION
ib_bullish_bearish_audit_and_redesign_scoped` resolved. Full detail:
`docs/IB_BULLISH_BEARISH_AUDIT_AND_REDESIGN_SPEC.md`'s final section.

**New thread opened the same turn**: user wants to figure out how to capitalize on genuine big
breaks/continuation moves — not a revival of the IB-specific idea, a fresh direction. Not yet
scoped.

## 🔶 2026-08-31 (RESOLVED): computeRigor() gets a z-score trend field, closing a 2026-08-04 decision

Resolves `OPEN_DECISION add_z_score_trend_to_rigor_stability_gate`. `computeRigor()`'s existing
3-way chronological `stable` check collapses each third to a same-sign boolean, so two
setup_types passing it identically can have very different real trajectories (the original
finding: `GLOBEX_VWAP_MAGNET_LONG`'s per-third z-score strengthened 1.49→2.84→3.02 while its
RTH sibling eroded toward noise 2.46→1.78→0.94, both "stable"). Added `zScores {z1,z2,z3}` and
`zTrend` (`STRENGTHENING`/`DECAYING`/`MIXED`, null when thin) as standing output fields —
each third's mean divided by its own standard error, same ≥5-events-per-third gate as the
existing fields, informational only, never feeds `clean`. Surfaced everywhere `boundaryStraddle`
(the 2026-08-17 precedent) already was: `rigorContext()` plus all 3 real consumer sites in
`backtest_setup_status.mjs` (the local helper, the main SUPPRESS/PROMOTE gate's notes, and the
`SETUP_STATUS_DOW` sub-pass's notes + blended_rigor). Verified via a live re-run: 0 DOW
suppressions before and after (unchanged from baseline — `clean`'s gating logic untouched),
`zTrend` populated for exactly the same rows where `stable` is computable, `test_invariants.mjs`
shows no new failures.

## 🔶 2026-08-31 (RESOLVED): condition_memory rebuilt after a month-long daily_performance_log pipeline gap

Two-part fix, resolves `OPEN_DECISION condition_memory_needs_rebuild_not_backfill` (HIGH, open
since 2026-08-19). **Part 1 — pipeline gap**: the catch-up mechanism that populates
`daily_performance_log` only ever checked whether *today's* row existed, so a trade landing
after its own calendar day had passed (confirmed: 2026-08-03 and 2026-08-12 trades were both
imported in one batch on 2026-08-12 20:52 ET, 9 days late for 08-03, amid a server-instability
window matching the already-fixed pre-2026-08-18 "multiple simultaneous nodemon supervisors"
bug class) permanently never got backfilled — `daily_performance_log` stalled at 2026-07-31 for
a month with zero errors logged. Fixed with a bounded historical scan added to `server/index.js`'s
existing 30-min self-healing cron; both missing dates manually backfilled and verified same turn.

**Part 2 — condition_memory rebuild**: the original double-counting concern (occurrences/wins/
losses inflated up to ~6x by a since-removed redundant `setInterval`, fixed 2026-08-19 with an
idempotency guard that stops NEW corruption but does nothing to un-corrupt existing counters).
Confirmed before rebuilding: `sum(occurrences)=1088` across 31 rows vs. only 343 real qualifying
`daily_performance_log` rows (~3.2x inflated in aggregate). Rebuilt via `scripts/rebuild_condition_memory_20260831.mjs`
— backed up first (`condition_memory_backup_20260831`, cataloged in `docs/DB_BACKUP_CATALOG.md`),
wiped, then replayed every qualifying date chronologically through the now-idempotent
`updateConditionMemory()`. Deliberately done in this order (pipeline fix first) per the original
decision's own sequencing note — rebuilding from a still-broken source would have just
re-encoded a fresh gap. Verified: post-rebuild `sum(occurrences)=343` exactly matches the
qualifying date count, live endpoints (`/api/pattern/combinations`, `/api/pattern/today-combination`)
spot-checked, `test_invariants.mjs` shows no new failures (6 present failures are pre-existing
OPTIMAL_STOP circuit-breaker trips, confirmed unrelated and already tracked separately).

## 🔶 2026-08-31: 2-lot scale-out (breakeven-minus-5 runner) — SECOND pass with a real structural target, both open questions resolved, PROVISIONAL

Follow-up to the same-day scoping doc (`docs/TWOLOT_SCALEOUT_BREAKEVEN_MINUS5_SPEC.md`). First
pass (`RESEARCH_CLAIM twolot_scaleout_be_minus5_orshort_firstpass`, now superseded) used the
setup's own tight `t1_level` as a placeholder runner target — user confirmed both remaining open
questions the same day (runner arms the INSTANT Lot 1 fills; runner target should be a real
structural level, not the setup's own tight target), so `scripts/backtest_twolot_scaleout_be_minus5.mjs`
was rebuilt to pull the nearest known `level_prices` level below Lot 1's exit (prior-period-only
categories, no lookahead — see script header for the full category list) as the runner target.

Population: real (`ACTIVE`+`SHADOW`) OR-length SHORT-fade family, N=140 (picked up 1 new fire
since the first pass), 139 walkable, 130 usable at the winning T1 candidate (9 excluded per
candidate where no structural level existed below Lot 1's exit that date). **Best T1=12pt**:
delta vs exit-all-no-runner mean=**+$7.63/trade**, plateau-clean, `computeRigor` clean, bootstrap
98.9% positive. **Meaningfully stronger OOS behavior than the first pass**: train +$7.57/trade
(N=91) vs test +$7.75/trade (N=39) — nearly identical, versus the first pass's train/test
near-halving ($12.04→$6.19). Outcome composition also improved: targetHit share rose from 33.1%
to **46.2%** (now the largest of the three buckets, not just a minority tail) — structurally
explained, not a fluke: the first pass's target could sometimes sit closer than a wider T1
candidate and "win" trivially; the structural-level version can't, by construction. Full
breakdown, level-usage distribution, and remaining gaps in the spec doc's "Second-pass result."

**Still not done:** independent re-verification (single script's own output); comparison against
the user's actual current live/described strategy as the *primary* baseline (an `exactBe`
reference arm is computed, exit-all-no-runner remains primary). Broader generalization to other
"struggling" setup_types was raised and explicitly deferred by the user — tracked separately,
`OPEN_DECISION twolot_scaleout_generalize_to_other_setups` (LOW), with a recommended screen
(Setup Reference's "Left on Table" metric) for whenever it's picked up.
`RESEARCH_CLAIM twolot_scaleout_be_minus5_orshort_structural`, `PROVISIONAL`.

## 🔴 CURRENT TOP PRIORITY (set 2026-07-29): risk management, not more entry-signal research

**STALE NUMBER CORRECTED 2026-08-19 (Opus Audit 8, `scratch/opus_audit_8_results.md`):** the
"118 of 122 (97%) have a stop wider than target" figure cited below is no longer current — a
fresh census of the latest `OPTIMAL_STOP` row per type found **14 of 138 (10.1%)**, median
stop/target ratio **0.86** (was 1.67). The risk-ceiling machinery visible in `OPTIMAL_STOP`'s
`notes.risk_capping` has evidently fixed the raw ratio problem since this was written. **This
does NOT mean risk management is solved** — the realized payoff shape has not followed: ACTIVE
population (n=344, real capital) shows avg win $85.30 vs avg loss $118.00 (1.38 loss/win ratio),
driven by (a) a fatter loss tail on fade-family setups specifically (STOP_HIT MAE overshoots the
stop by >50% at 13.2% of the time vs 3.6% for breakout-family, both N≥20) and (b) a much larger,
newly-found structural bug: `IB_BULLISH`/`IB_BEARISH` — which together produce 67% of real-capital
big losses — have their entire day-type-conditioned stop/target/suppression wired to
`acd_daily_log.day_type`, a column that's NULL for the entire live session (written by cron at
8:20 PM ET). Four real, correctly-swept day-type `OPTIMAL_STOP` rows have never once been read
live. See `OPEN_DECISION ib_daytype_calibration_structurally_unreachable` (HIGH, flagged same
session) — **this, not the stop/target ratio, is the re-aimed top priority.**

**User directive, verbatim intent**: the system needs to find a way to manage risk effectively — throttling losing trades, achieving a better R:R, or some other mechanism — because right now it fires sequential counter-trend/low-R:R trades that produce small wins and large losses. This is the top priority over further signal-discovery work. Stated end goal: make the system **autonomous and profitable** — both halves matter, not just finding more signals. Recorded as `OPEN_DECISION` `prioritize_risk_management_over_signal_research` (HIGH) so it resurfaces every session start regardless of whether this file gets read carefully.

**Third lead tested and closed out, same night (2026-07-30): the user's own 4H-50-EMA trend filter idea (only fade LONG above it, only fade SHORT below it) — discard, real negative on 3 independent checks.** Built with genuine no-lookahead (`scratch/run_ema_filter_test.js` — Claude verified this directly by reading the code, not just trusting Gemini's summary: the DB session timezone is America/New_York, so the hour-based 4H bucket boundaries are correctly ET-midnight-anchored, and a touch only ever sees the EMA as of the previous CLOSED 4H bucket). A 9-combination sensitivity sweep (period ∈ {20,50,100} × timeframe ∈ {1H,2H,4H}, RTH) showed no consistent neighborhood — e.g. 1H/50 gap=-$2.87 vs 4H/50 gap=+$10.10 — the same brittle, parameter-specific signature that already killed the Regime A/B/C classifiers. The Globex/overnight leg fully INVERTED the RTH result (ALIGNED EV=-$2.06 vs COUNTER EV=+$5.27) — a real trend-alignment relationship shouldn't flip sign between sessions. Chronological rigor on the RTH headline failed (thirds -$4.20/-$1.42/+$17.42) with the entire apparent edge concentrated in the most recent third of ~3.5 years of history — independently corroborated by the 80/20 train/test split showing the identical pattern (two different slices of the same data agreeing it's a recent-history artifact, not a bug). `RESEARCH_CLAIM ema_4h_trend_filter_brittle_overfit_discard` (CONFIRMED negative). Not wired. **This closes out all 3 risk-management leads tested this session** (drawdown-velocity, risk-adjusted stop/target re-optimization, EMA trend filter) — all 3 real, honestly negative/inconclusive results, none wireable. Remaining un-tried angles: lean into `STACK_VOL_BREAK_LIVE` (the one breakout-family setup, naturally better R:R by construction — matches the user's own stated trading style, see memory `user-trading-style-breakout-preference`), or the never-built SPC/Kelly position-sizing ideas.

**Follow-up, same day, after the two threads below were exhausted**: user asked Claude+Gemini to work together on the root cause directly, and mentioned two new pieces of context — (a) they personally prefer trading breakouts, not fades, and (b) confirmed the objective-function hypothesis is worth pursuing. Investigation found: **118 of 122 calibrated setup_types (97%) have a stop wider than target** (median ratio 1.67, several need 65-81%+ WR to break even) — a direct, structural consequence of `update_optimal_stops.mjs` picking stop/target to maximize raw mean EV with zero penalty for variance/drawdown. This is very likely the real driver of "PnL volleys too much." Separately, the ONE live breakout-family setup, `STACK_VOL_BREAK_LIVE`, already has a healthy R:R by construction (LONG 40pt stop/70pt target, SHORT 40/40) — much better than the fade family, matching the user's stated preference; saved as memory `user-trading-style-breakout-preference`. User chose to pursue the root-cause fix. Ran the full 3-phase Gemini workflow:
   - **Phase 0 (design critique)**: Gemini recommended a Sortino-like ratio (`mean(pnl)/stdev(negative pnl)`), the plateau+chronological-rigor-check combo over full walk-forward (correctly judged walk-forward impractical given most setups have well under 150 total trades), and a hard EV-retention floor (`candidate_EV >= 0.5 * maxEV`) so the optimizer can't pick a near-zero-trade "solution." Also flagged that any resulting narrow-target pick deserves scrutiny since this codebase's backtests don't model slippage.
   - **Phase 1 (mine-and-run), attempt 1 — failed audit**: Gemini's Sortino-based pilot produced nonsensical ratios (values in the billions/trillions). Root-caused directly: this codebase's synthetic MAE/MFE-threshold stop-hit resolution resolves every stop-out to an *identical* dollar loss for a given (stop,target) candidate — downside stdev is ~0 by construction for nearly any candidate, so any per-trade Sortino/Sharpe computed on it is structurally degenerate, not just noisy. A real, reusable methodological finding for future risk-adjusted-objective work in this codebase, not a one-off bug. Also caught a second issue: 4 of the 8 pilot setups' live baseline EV comes from the corrected-resimulation target-calibration path, not the simpler function the pilot reused for speed — an apples-to-oranges baseline for those 4.
   - **Phase 1, attempt 2 (correction, per the standing 2-attempts rule)**: redirected to a Calmar-like objective (`EV / maxDrawdown` of the real resimulated equity curve) instead. Results genuinely promising: across the 6 evaluable pilot setups (2 of 8 failed the N≥20 gate), **maxDrawdown fell in 6/6** (12-72% reductions), EV improved or turned positive in 5/6. But the pilot's own overfitting guard (a plateau/neighbor-stability check) failed 100% of the time, including on the two highest-N setups (N=3026, N=1481) that shouldn't have a grid-resolution problem — inconsistent with a genuine instability finding. Root-caused directly (Gemini's 2 attempts were used, Claude took over per the standing rule): the check requires a neighboring grid cell within a hardcoded ±20% band of the chosen candidate's Calmar ratio — too tight for a compound ratio (EV/maxDrawdown, both independently noisy) at N~100 scale, and itself a static-threshold violation of this codebase's own standing rule.
   - **Round 3, same thread, next day (2026-07-30) — RESOLVED NEGATIVE.** Fixed the plateau tolerance (MAD-based, data-derived — no more hardcoded %) and re-ran on a clean 8-setup sample confirmed to all be on the plain-EV-sweep baseline (avoiding round 2's corrected-resim confound entirely): `OR_LOW_FADE_LONG`, `OR_HIGH_FADE_SHORT`, `IB_HIGH_FADE_SHORT`, `IB_LOW_FADE_LONG`, `IB_BEARISH`, `ONH_FADE_SHORT`, `ONL_FADE_LONG`, `WEEKLY_VWAP_FADE_LONG`. Result: **0 of 8 produced both a genuinely different AND a robustly-validated improvement.** 4/8 already sit at the risk-adjusted optimum (legitimate no-change result). 1/8 (`IB_BEARISH`, already EV-negative) correctly found no positive-EV candidate exists anywhere in its grid — the profitability floor working as designed. Of the 3 that did produce a different pick: `ONH_FADE_SHORT` cut maxDrawdown 37% but EV declined slightly and failed its own stability check (independently re-verified this setup really is plain-sweep, not corrected-resim — Gemini's report had mislabeled it, caught on audit); `IB_LOW_FADE_LONG` cut maxDrawdown 60% in dollars but its losing-STREAK LENGTH more than doubled (7→15 consecutive losses) — a real tradeoff (many small losses vs fewer big ones) that may not solve the user's actual "PnL feels like it volleys" complaint even though the dollar metric improved, and it also failed its own stability check; `ONL_FADE_LONG` showed no real improvement on any axis and failed all 3 checks. `RESEARCH_CLAIM risk_adjusted_stop_target_pilot_promising_unproven` updated to `CONFIRMED` status describing this final negative result (superseding round 2's promising-looking PROVISIONAL read, which is now understood to have been inflated by the round-2 baseline-mismatch confound). `OPEN_DECISION fix_plateau_tolerance_before_scaling_risk_adjusted_objective` RESOLVED: **do not scale this technique (Calmar-ratio re-optimization over the existing fixed MAE/MFE percentile grid) to the other 114 setup_types.** The underlying 97%-stop>target problem remains real and unaddressed — a genuinely different technique (finer/continuous candidate grid, or a different lever entirely) would be needed. **Not wired. Nothing changed live.**

**What was actually built/tried this session, and what's still open (original entries):**

1. **Drawdown-velocity circuit breaker — RESOLVED (as far as today's data allows): only the 15min leg is trustworthy, and it's the wrong-direction leg for risk management.** Same-day follow-up (2026-07-29, `scratch/pilot_drawdown_velocity_window_sweep.mjs`) ran a finer 11-point window sweep (10-60min, chronological 80/20 train/test, thresholds derived from TRAIN only) instead of just the original 15min/30min pair. Pooled EV across the sweep looked like a strikingly smooth, monotonic crossover around 25-30min — but two follow-up checks undercut treating that shape as real corroboration: (a) the TEST severe buckets are day-clustered at *every* window (top5DayPct 61-100%, only 4-15 distinct days behind each number — inherent to a volatility-conditioned bucket, not a bug); (b) chronological 3-way stability only passes at the ORIGINAL 15min window — every wider window, including large-N ones (30min N=160 train, 40min N=208 train), flips sign across its own history. Dispatched a Gemini methodology critique (`scratch/gemini_review_drawdown_rigor_methodology.md`) per direct user request to sanity-check whether `computeRigor()` itself was too strict — Gemini's independent read: the day-clustering flag is reasonably dismissed as structural for this kind of signal, but the large-N stability failures at 30min+ are a **real red flag, not an artifact of an overly strict check**, and the smooth crossover shape is mostly autocorrelation (adjacent windows share most of the same underlying touches) rather than 11 independent confirmations. **Net: the only trustworthy piece is the 15min "severe drawdown → BETTER next trade" (capitulation) leg (N=31 test, EV=+$18.35, rigor-clean)** — and that's the *opposite* direction from what a risk-management circuit breaker needs (it argues for re-engaging after a fast flush, not throttling). The useful leg (severe drawdown 30min+ → worse next trade) remains statistically unresolved. `RESEARCH_CLAIM drawdown_velocity_window_dependent_effect` updated with the full account (still PROVISIONAL). **Not wired, and not expected to be wireable from this angle without new data or a different technique** — Gemini recommends a GAM/spline regression treating window length as a continuous covariate (not built) as the correct way to actually pin down the crossover with a confidence band, rather than more discrete-bucket sweeps.

2. **R:R / bank-vs-extend (wider targets) — RESOLVED negative: fixed the broken replication check, real cross-setup held-out test does not replicate.** Same-day follow-up (`scratch/pilot_bank_vs_extend_replication_fix.mjs`) fixed both problems named below: (a) selection of the "best" extend multiple per setup is now reachability-weighted (must clear that setup's own median reachability across its 5 candidates, plus ≥10 trades that actually entered extending mode) instead of picking whichever multiple has the single highest raw EV — the prior pass's "best" picks were often driven by rare, barely-reachable outsized winners (0-20% reachability); (b) replication is now genuinely cross-setup (`idFn=setupType`, matching every other `computeReplication()` caller in this codebase) — top-half of the 17 tested setups by improvement-over-baseline selected as "winners," bottom half genuinely held out (the original bug: `selectedIds` was every trade id in the population being tested, so `heldOut` was always empty). **Result: does not replicate.** At the primary top-9-of-17 cut, selected pooled improvement is +$7.03/trade (N=827) vs. held-out −$3.61/trade (N=642) — opposite sign. Sensitivity-checked across cut points (K=3/5/9/13): only K=3 barely replicates (held-out +$0.17, weak), K=5/9/13 all fail, and the held-out favorable fraction degrades monotonically (0.79→0.75→0.63→0.25) as more setups are counted as "winners." 6 of 17 setups have every candidate multiple below the 10-trade reachability floor regardless of method — genuinely too thin to select on at all. `RESEARCH_CLAIM bank_vs_extend_wider_target_replication_check` recorded (new, PROVISIONAL). **Wider/extended targets are not currently a validated R:R lever. Not wired.**

3. **A specific gate idea (hivol_lopace_at_detection) was tested as a suppression mechanism and rejected** — 95.7% of the time it fires, it's on setup_types already suppressed by the existing system, so gating on it would be mostly redundant. Not a risk-management win, but a real negative result, properly recorded (`RESEARCH_CLAIM hivol_lopace_gate_promotion_not_supported`) rather than silently dropped.

4. **Two ideas raised early this session were never actually built or tested**: equity-curve/SPC (statistical-process-control) style self-throttling, and Kelly-criterion dynamic position sizing. Both respond to the system's own realized P&L/variance rather than trying to classify market conditions — structurally different from everything tried above, and still on the table as the next thing to actually scope.

**How this session's work got built (new standing process, see CLAUDE.md's Collaboration section for the durable rule)**: a 3-phase Gemini workflow — (0) send Gemini the intended approach for critique BEFORE writing code, (1) full mine-and-run for the actual test, (2) a separate code-review pass on the resulting script before trusting any number. Adopted mid-session after Claude shipped a live change (the `hivol_lopace_at_detection` badge) without any of this and a real off-by-one bug reached production undetected until the user asked "did gemini review your code?" Used properly for the gate-backtest above and caught real, load-bearing problems (a broken level-name mapping, a buried marginal-utility number, a stability-check failure the first write-up ignored) before anything was trusted. **Apply this to whatever risk-management work comes next — it's higher-stakes than signal discovery, not lower.**

**Also shipped this session, lower-stakes**: a standalone external dashboard (`server/public/quick-check.html`, exposed via a persistent Cloudflare Tunnel + Access at `tj.6claire.page` — see CLAUDE.md's new "Where to look" entry) and a fix for `active_setups` firing duplicate live rows when several levels cluster within a few polls of each other (`cluster_attributed_setups`).

## ✅ 2026-07-17: built `scripts/flag_decision.mjs` — pending decisions are now actively monitored, not buried in prose

Direct follow-on to the "no structural way to tell live pipeline from abandoned" thread below, after the user pushed further: "anything that needs to be reevaluated should [be] flagged with something and actively monitored. Nothing can be buried." Considered and rejected overloading `RESEARCH_CLAIM` (`scripts/record_claim.mjs`) directly — a pending product/architecture decision ("wire this in or delete it," "merge this branch") has no statistical content and doesn't go stale the way a tested research finding does; it just sits until a human decides. Built a deliberate sibling instead, reusing the same underlying mechanism (same `performance_audit` table, same JSON-notes-with-date shape, same session-start-hook integration pattern) rather than a parallel table/file — this codebase already has a documented anti-pattern of uncataloged ad hoc tables (see `docs/DB_BACKUP_CATALOG.md`'s own origin story).

**Built**: `scripts/flag_decision.mjs` (`flagDecision`/`resolveDecision`/`listDecisions`, `signal_type='OPEN_DECISION'`, vocabulary `PENDING`/`RESOLVED` — deliberately not `RESEARCH_CLAIM`'s `CONFIRMED`/`PROVISIONAL`/`STALE`, which wouldn't make sense for a yes/no decision). `.claude/hooks/session-start.sh` gained an `OPEN_DECISIONS` section, printed unconditionally every session, sorted oldest-first with age since first flagged (computed in SQL via `CURRENT_DATE - date`, not JS `Date()` — caught and fixed a real naive-timezone rounding bug during testing, exactly the class of bug this codebase's own `parseDateTime` writeup already warns about). **The hook section is the actual fix, not the table** — a row nobody ever queries again is exactly as buried as a paragraph nobody re-reads; printing it every session unconditionally is what makes it un-buriable.

**Seeded with 10 real pending decisions**, each written with full context (what's being decided, why it matters, what resolving it looks like — not a bare fact), pulled from this session and the prior day's SSOT/dead-end audit: `unrendered_dashboard_cards_5`, `rule_overrides_noop_pipeline`, `dead_backend_routes_20`, `premarket_walkthrough_and_screenshot_upload_orphaned`, `main_branch_55_commits_behind`, `latency_audit_sunday_only_cadence`, `vol_regime_history_cron_undecided`, `value_area_responsive_short_runner_followup`, `pd2_2dpoc_ev_magnitude_needs_scrutiny`, `backtest_pipeline_freshness_consumption_report`. Full text for each lives in the `OPEN_DECISION` rows themselves (`node scripts/flag_decision.mjs --list`), not duplicated here — this file's job now is narrative history, not the live pending-items list.

**Verified end-to-end**: smoke-tested add/list/resolve cycle before seeding for real; ran the hook standalone and confirmed all 10 print with correct 0-day age; confirmed `--resolve` correctly removes an item from the default `--list` (still visible via `--list-all`). Documented as a new convention in `CLAUDE.md` alongside the `RESEARCH_CLAIM` entry.

**Not done**: the actual "freshness + consumption cross-reference report" idea (querying every `performance_audit` signal_type's cron-wiring and live-consumer status automatically, instead of hand-archaeology each time) is tracked as its own pending `OPEN_DECISION` (`backtest_pipeline_freshness_consumption_report`), not built tonight — this session built the *tracking mechanism*, not that specific report.

## ✅ Dedup pass finished 2026-07-15 (picked up from the "READ THIS FIRST" item below) — went from ~86-102 requests to a stable 72-75, settle time now mostly hitting the 5-6s target

Picked up the explicit next step from the section below ("finishing the dedup pass... should be done regardless"). Found and fixed several real independent-fetcher duplicates beyond the 7 named there — the earlier sweep's own components (`useSharedPollData`, `refreshSharedPollData`) generalized cleanly to all of them:

## ⏱️ EXPLICIT TARGET, READ THIS FIRST: Morning Prep full-page settle time ≤ 5-6s

User-set threshold, restated explicitly here (2026-07-15) so it isn't buried in prose in the section below. Measure with the convention already established: Playwright, `page.locator('text=Loading…').locator('visible=true').count()` polled ~every 500ms-1s from page load until it hits 0. Current state: **6-11s range, hit the target on at least one run, not consistently.**

**Honest math on how much further pure deduplication can take this, worked out directly rather than assumed:** a real Morning Prep load fires **34 unique API endpoints**. React StrictMode (dev-mode only, always on in this project's normal day-to-day workflow — it doesn't run a production build) double-invokes every effect, so even a *theoretically perfect* app with zero redundant fetchers still fires **68 requests** (34 × 2) — this is not fixable in app code short of disabling StrictMode (loses a real safety net) or moving off dev-server workflow (not how this app runs). Chrome caps 6 concurrent connections per origin; 68 ÷ 6 ≈ 11 sequential waves is a real structural floor even with every individual request fast. Currently measuring **88 total requests** — ~20 above that 68 floor, meaning **7 more endpoints are still duplicated beyond StrictMode's unavoidable 2x**, found via the same request-tracing method used all session (`market/pulse`, `case`, `accounts`, `morning-brief/trade-alerts`, `acd/feedback`, `behavioral-patterns`, `acd/today` — each 4x instead of 2x — plus `setups/today` at 6x, see below).

**Conclusion: getting under 5-6s *consistently* via deduplication alone is not guaranteed.** Finishing the dedup pass (bringing 88 → ~70, close to the 68 floor) is real, available, safe work and should be done regardless — but the last mile past that floor likely needs one of the two levers already deliberately deferred earlier this session (see "connection-starvation fix" entry below for the full reasoning on why they weren't done):
1. **HTTP/2 for the dev server** — removes the 6-connection cap via multiplexing entirely. Real tradeoff: changes the URL scheme (`https://`) and needs a one-time self-signed cert acceptance in the actual daily-use browser — a workflow change, not a code change, needs explicit confirmation before doing.
2. **Fewer distinct backend calls** — combine several small independent endpoints into one combined response (e.g. one "Morning Prep bundle" endpoint instead of 34 separate ones). Real engineering, not a quick fix — redesigns the API surface `useSharedPollData` currently subscribes to per-URL.
Don't reflexively reach for either without re-measuring first — finishing the dedup pass alone might get close enough that the remaining gap no longer matters in practice. Re-run the request-count + settle-time trace after the dedup pass before deciding whether (1) or (2) is actually still needed.

## Pending decisions / unconfirmed proposals

- ~~**HomeAssistant hosting (future, no timeline).** Access journal from HA sidebar via Cloudflare Tunnel (already running). Easiest: add `panel_iframe` to HA `configuration.yaml` pointing at tunnel URL — no backend/frontend changes. Prerequisite: verify tunnel URL is stable (not ephemeral trycloudflare.com free tier).~~ — **Resolved 2026-07-29.** Built as a persistent named tunnel (not the ephemeral free-tier concern this entry worried about) at `tj.6claire.page`, serving a dedicated standalone page (`server/public/quick-check.html`, `GET /quick-check`) rather than an iframe of the full app, with Cloudflare Access (Google OAuth) + exact-path ingress allowlisting in front of it. This entry sat here describing already-built work as "future, no timeline" for long enough that it was actively misleading — see CLAUDE.md's "Where to look" section (new entry, same date) for the real, current pointer, and Claude's own memory `reference_ha_cloudflare_tunnel.md` for full history.

## 30-day shadow validation

- **Runner/trailing-stop optimization — saved, not started.** Full notes: `docs/RUNNER_OPTIMIZATION_NOTES_20260814.md` (DeepSeek's plain-English mechanism explanation, the broader "next level" roadmap DeepSeek volunteered — flagged as mostly out-of-scope institutional advice, not a near-term backlog — and Gemini's `structural_runner_optimization.py` prototype, permanent copy at `docs/structural_runner_optimization_20260814.py`). **Blocked on a real schema mismatch** (the script assumes flat `trades` columns and a `price_bars_primary.bar_time` column that don't exist in this codebase's real schema) — that's the actual next step, not a backtest. User explicitly: review the design first, don't just run it.


- **RESOLVED 2026-08-31: `price_bars_primary_systemic_quarterly_data_gap` — root cause fully confirmed and a standing gap-guard shipped.** `price_bars_dedup_hist` (the historical branch `price_bars_primary`'s view unions in — effectively ALL historical data, since the view's other, calendar-JOIN branch only ever covers `ts` after `dedup_hist`'s own `max(ts)`, always very recent) has 6 real, permanent, unrecoverable gaps of ~63-70 days each, one at every NQ quarterly contract rollover from Dec2023 through Mar2025 inclusive: `2023-12-14→2024-02-15`, `2024-03-14→2024-05-23`, `2024-06-20→2024-08-22`, `2024-09-19→2024-11-21`, `2024-12-19→2025-02-20`, `2025-03-20→2025-05-22`.
  - **Mechanism, confirmed bar-by-bar at every boundary via the `contract` column**: the OLD front-month contract's data stops dead exactly at its own 3rd-Friday expiration (a partial final day, e.g. `NQU24`'s last real day is 2024-09-20), and the NEW contract's data doesn't begin until ~2 months later (also a partial first day, e.g. `NQZ24` starts 2024-11-21) — consistent with a chart/feed being manually re-pointed to each new front-month contract roughly one full rollover cycle late, for 6 consecutive quarters running, before whatever process fixed it (no gaps of this kind found after 2025-05-22).
  - **Fix shipped**: `server/services/queries.js` gained `findTradingDayGaps()`/`assertNoTradingDayGaps()` — shared helpers for any script building a positionally-indexed trading-day array to call before treating `dates[i+1]` as "the next trading day." Retrofitted into the 2 scripts whose audits originally surfaced this bug: `scripts/backtest_turn_of_month_effect.mjs` (also migrated off its own raw `pg.Client` with hardcoded credentials onto `server/db.js` — a real DeepSeek round-3 finding, fixed in the same pass, which also surfaced a real breakage: `server/db.js` globally overrides `pg`'s `date` type parser to return a plain string rather than a `Date` object, process-wide — a raw `pg.Client` elsewhere in the same process silently inherits that override the moment anything imports `server/db.js`, which is exactly what broke this script's own `.toISOString()` calls mid-fix) and `scripts/backtest_range_boundary_rejection_traversal.mjs`. Both now skip any event/window whose index range would straddle a real gap rather than silently computing a corrupted one — verified: turn-of-month runs clean end-to-end (N=21 events); range-boundary-rejection's gap-detection and skip logic confirmed executing correctly (its own full run is genuinely long — DB query per date across years of history — not completed in-session, but the fix itself is verified working).
  - **Not yet done**: a grep for the same `dates[i-1]`/`dates[i+1]` positional-indexing pattern found 4 more scripts with the same exposure (`backtest_poc_convergence_and_drift.mjs`, `backtest_or5_low_gap_down.mjs`, `mine_or_conditional_fade.mjs`, `backtest_unified.js`) — none audited or fixed yet. All are one-off research scripts (not live-wired), so this doesn't block resolving the main decision, but it's real — tracked as `OPEN_DECISION audit_remaining_positional_dategap_scripts_20260831`.
  - **Separate, smaller, NOT-yet-root-caused finding surfaced while investigating this**: a ~2-month window of THIN (not absent) data around the 2025-09 rollover — `contract=NQH26` (an unusually far-dated contract for the time) appears 2025-09-28 with chronically low bar counts (~20-340/day vs the normal ~1380), and `NQZ25` (the contract that actually should have been current) shows up afterward, 2025-11-19 through 2025-12-12, an inverted sequence. Bar counts return to normal by 2025-12-01. A genuinely different symptom (present-but-sparse, not absent) from the 6 root-caused gaps above — tracked separately as `OPEN_DECISION price_bars_nqh26_contract_thin_and_early_20260928`.


- **FIXED 2026-08-31: `detectGlobexSetup()`'s main INSERT never set `wider_target_mult`/`runner_trail_width`/`extend_target_level` at all — every setup_type firing through the entire overnight/Globex level-fade engine (~30+ types: the original `PD_VAH_FADE_SHORT`/`PD_VAL_FADE_LONG`/`PD_POC_FADE_SHORT`/`PD_POC_FADE_LONG` plus every `WIDER_WINDOW_OVERNIGHT_LEVELS` type) has never been eligible for either exit mechanism, full stop.** User caught this directly from the `quick-check.html` mobile view — 3 real overnight fires (`PD_VAL_FADE_LONG`/`PD_POC_FADE_LONG` x2) hit T1 in 3-14 bars, well within the wider-target mechanism's `MAX_BARS_TO_T1_FOR_WIDER=4` arming window, but resolved as plain fixed-target trades with `wider_target_mult`/`runner_trail_width` both `NULL` and asked why. **Not the same bug as tonight's earlier session-boundary fix** (`server/services/sessionBoundary.js` — that one fixed the mechanism's INTERNAL session-end check for candidates that DO get `wider_target_mult` set; this is a structurally different gap — the column was never in this INSERT's column list at all, so the mechanism never had a chance to try). Same bug CLASS as the already-documented `backfill_wider_target_4th_site_miss_20260818.mjs` incident (a different insert site missing the same column) and the RTH audit-only insert branch's identical fix (`~acd.js:8028`, 2026-08-18) — mirrors that exact lookup pattern (`CONDITIONAL_VARIANTS[type].trailSignalName` → `BREAKEVEN_TRAIL_TEST` calibration if trail-diverted, else `WIDER_TARGET_MULT`) rather than re-deriving it.
  - **Verified before and after**: confirmed live via direct query that all 3 of tonight's real fires (plus the day's other 3 overnight fires) had `wider_target_mult`/`runner_trail_width` both null. Fix applied to `detectGlobexSetup()`'s INSERT (`server/routes/acd.js` ~1896), lint+syntax clean, server restarted (`./restart.sh`) to deploy — confirmed the new process is live (started 2026-08-31 07:42 ET, port 3002 responding 200, `/api/acd/setup-detection` returning valid JSON, no new server errors).
  - **`PD_VAL_FADE_LONG` is now fully fixed** — it has no `CONDITIONAL_VARIANTS` trail entry, so it will get `wider_target_mult=1.5` on every future fire going forward. **`PD_POC_FADE_LONG` is fixed at the code level but still blocked by a separate, already-known gap**: it IS a trail-diverted type (`PD_POC_FADE_LONG_TRAIL`, `trailSignalName='B_PD_POC_FADE_LONG'`), but `BREAKEVEN_TRAIL_TEST` has no calibration row for `B_PD_POC_FADE_LONG` at all (confirmed via direct query — `B_PD_POC_FADE_SHORT` has one, `trail=19.3` from 2026-08-25; `B_PD_POC_FADE_LONG` has none), so `runner_trail_width` will keep coming back null until `scripts/backtest_breakeven_trail.mjs` actually produces that row — this matches the session-start hook's own standing `INVARIANT_WARN` for this exact signal_name, not a new gap. Once that calibration exists, this insert site will pick it up automatically with no further code change.
  - **Follow-up audit, same night, user-requested ("check if other setups won't widen")**: checked all 22 distinct real setup_types that have ever fired via this insert site (`bet_class='GLOBEX_LEVEL'`). **None of their raw type strings match a `CONDITIONAL_VARIANTS` key directly** — every one is inserted under its base name, never diverted — so with the shipped fix, **all 22 now get `wider_target_mult` set unconditionally**; nothing else is silently excluded the way `PD_VAL_FADE_LONG`/`PD_POC_FADE_LONG` were. Full list: `10D_IB_MID_FADE_SHORT_OVERNIGHT`, `3M_POC/VAL_FADE_SHORT_OVERNIGHT`, `GLOBEX_VWAP_FADE_LONG/SHORT`, `GLOBEX_VWAP_MAGNET_LONG/SHORT`, `MONTHLY_VWAP_FADE_SHORT_OVERNIGHT`, `MPP_FADE_SHORT_OVERNIGHT`, `PD_POC_FADE_LONG/SHORT`, `PD_VAH_FADE_SHORT`, `PD_VAL_FADE_LONG`, `PM_POC_FADE_SHORT_OVERNIGHT`, `PW_LOW/POC/VAH/VAL_FADE_*_OVERNIGHT`, `WEEKLY_OPEN/VWAP_FADE_SHORT_OVERNIGHT`, `WR1_FADE_SHORT_OVERNIGHT`, `WS1_FADE_SHORT_OVERNIGHT`.
  - **New, deeper finding surfaced by that same check**: `detectGlobexSetup()` never calls `resolveSetupType()` (confirmed — that function is a local closure defined entirely inside the separate RTH engine, ~acd.js:7270, and none of its call sites are within `detectGlobexSetup()`'s ~1493-1963 span). This means a Globex touch of `PD_POC_FADE_LONG`/`PD_POC_FADE_SHORT` is **never** diverted to the `_TRAIL` breakeven mechanism the way an RTH touch of the identical level is — it's structurally invisible to `test_invariants.mjs` check [21] and the whole `CONDITIONAL_VARIANTS` trail-health monitoring (which only ever queries `setup_type=X_TRAIL`), and with this fix it'll now default to wider-target instead. Not obviously wrong — could be a deliberate session-specific choice nobody made deliberately — flagged as `OPEN_DECISION globex_trail_diversion_never_applied_20260831` (MEDIUM) rather than silently picking one behavior.


- **`test_invariants.mjs` circuit-breaker/vol-bucket failures investigated (2026-08-31) — one real fix, six confirmed working-as-intended.**
  - **Fixed a real false-positive**: check [check "vol_bucket_at_fire re-derivation"] sampled the CURRENT trade_date, which isn't a genuine determinism test — `getVolBucketAtFire()`'s rolling window keeps reading new bars as the current session progresses, so re-deriving TODAY's own bucket later the same day can legitimately land in a different bucket purely from more of today's own data accumulating. Confirmed live: the sole mismatch this check has ever produced was `trade_date=today` (stored `ABOVE_AVG`, fresh `AVG`, re-derived hours later same session) — not a historical `price_bars_primary` correction, the check's own anticipated failure mode. Now excludes `trade_date < CURRENT_DATE` from the sample; failure count dropped from 7 to 6 as a direct result.
  - **The remaining 6 (`GLOBEX_VWAP_FADE_SHORT`, `IB_BULLISH`, `OR5_LOW_FADE_SHORT`, `PD_POC_FADE_LONG`, `PD_VAH_FADE_SHORT`, `RTH_VWAP_FADE_LONG`) are NOT new bugs.** Traced `IB_BULLISH`'s full `OPTIMAL_STOP` notes directly: real N=60 behind its frozen stop/target, but 89.2% of that N comes from just 8 distinct trading days — this is EXACTLY the already-diagnosed-and-resolved `optstop_sweep_implausible_rr_thin_samples` (RESOLVED 2026-08-30, the session before this one): the circuit breaker is correctly refusing to let a day-clustered, noisy real-data recalibration attempt swing the live stop/target by more than 35%, protecting the older, more broadly-sampled frozen values. That resolution already shipped both a data-derived plausibility gate (`PLAUSIBLE_SKEW_CUTOFF` in `update_optimal_stops.mjs`, reviewed as part of tonight's earlier DeepSeek rounds) and the standing "OPTIMAL_STOP CLUSTERING WATCH" session-start-hook section that surfaces exactly this pattern every session — and explicitly left the "keep `IB_BULLISH` live vs. demote it given the clustering" call to the user, not something to decide unilaterally. Nothing further to fix here; re-verified the diagnosis still holds rather than assuming the prior session's finding is still accurate (per this codebase's own "pre-compaction claims aren't evidence" rule).


- **RESOLVED 2026-08-31: `engagement_entry_timing_backfill_contam` (HIGH) — re-audited, and the corrected result is a materially different headline, not just a magnitude fix.** `scripts/backtest_engagement_confirmation_entry.mjs` (does the user's "wait for the tussle to resolve" idea beat immediate entry) had no `origin_status` filter at all — same unfiltered-population bug already caught once in its sibling study (`backtest_coarser_bar_entry_alignment.mjs`, whose own audit flagged this decision). Fixed to match the sibling's exact filter (`origin_status IN (ACTIVE,SHADOW)`, dynamic-exit-mechanism rows excluded) and re-ran: population dropped **10,881 → 1,501 real touches** (17,259 BACKFILL/UNKNOWN + 1,421 dynamic-exit rows excluded — confirms the ~83% BACKFILL estimate was accurate).
  - **The original study's own headline flips.** Original (contaminated): immediate entry (Arm A) roughly tied with or beat blind mechanical delay (Arm B) in all 3 pooled views ($0.95 vs $0.69 ALL; $1.53 vs -$0.35 CONFLUENCE; $0.62-0.65 vs $1.26-1.28 NON-CONFLUENCE). Corrected (real-only): Arm A is **negative** in ALL and NON-CONFLUENCE (-$0.84, -$1.20 — was positive), and Arm B **clearly dominates** Arm A in all 3 views, including a sign flip in CONFLUENCE (-$0.35 → **+$14.57/trade**).
  - **What stayed the same**: the real-time engagement triggers (C1/C2) still don't beat blind delay in any view, and the per-setup_type replication check still fails exactly as before (`replicates=false` both arms, both on train-selected subsets that don't hold up out-of-sample).
  - **Real caveat, not swept under the rug**: the ALL/NON-CONFLUENCE pooled views still don't clear this codebase's own rigor-clean bar even on the corrected data (`clustered=false` but `clean=false` — fails the 3-way chronological stability check). Only the CONFLUENCE view's A/B arms are rigor-clean — that's the single most trustworthy piece of this correction, not the headline ALL-pool numbers.
  - `RESEARCH_CLAIM engagement_confirmation_entry_timing` updated in place with full before/after numbers (status kept `PROVISIONAL` — real N, not yet rigor-stable, worth another look as real data grows rather than acted on today).


- **DeepSeek code review round 5 (2026-08-31)** audited all three fixes above (`scratch/deepseek_code_review_20260831_round5.md`) — confirmed everything correct with no new bugs, plus a few real, cheap fixes applied same session:
  - **Confirmed the `detectGlobexSetup()` INSERT's parameter renumbering has no off-by-one** (hand-recounted the full column list against the VALUES array) and **independently confirmed via code trace (not just the observed DB outcome) that `CONDITIONAL_VARIANTS[c.type]` is structurally dead** for the trail half — `detectGlobexSetup()` never calls `resolveSetupType()`, so no Globex candidate type can ever match a `CONDITIONAL_VARIANTS` key (which is keyed by `_TRAIL` names, not base types). This is the exact code-level confirmation `OPEN_DECISION globex_trail_diversion_never_applied_20260831` needed. **Fixed the misleading comment** at the insert site (previously claimed to "mirror" the RTH branch's working trail lookup — corrected to explain it's currently non-functional for that half and point at the open decision, so a future reader doesn't mistake it for live).
  - **Confirmed the gap-fix work (`findTradingDayGaps`/`assertNoTradingDayGaps` and both retrofitted scripts) has correct date-diff math and full window coverage**, no missed sites. **Found one real, worth-fixing gap**: `findTradingDayGaps` is a pure function but the *module* it lives in (`server/services/queries.js`) transitively imports `server/db.js`, whose module-load-time `pg.types.setTypeParser()` call is a process-wide mutation — importing the "pure" helper is not actually side-effect-free for a caller using its own raw `pg.Client` (this is exactly what broke `backtest_turn_of_month_effect.mjs` mid-session). Added an explicit warning docstring on the export rather than doing a full db-free-module split (real refactor, left as a documented tradeoff, not urgent since the one caller this bit has already been migrated onto `query()`). Also added a fail-loud guard for a malformed-date-string producing a silent `NaN`-never-flagged gap (no current caller triggers this, defensive only).
  - **Confirmed `backtest_engagement_confirmation_entry.mjs`'s new filter is a faithful field-for-field copy of its sibling** (no population divergence), but flagged that its header comment still asserted the OLD, pre-fix conclusion — **fixed**, now states the corrected headline and 3 real caveats on trusting the flipped numbers at face value: `waitWindow` (the Arm B/C trigger-scan horizon) is derived from a resolved-outcome statistic rather than a fully independent constant (pre-existing, not introduced by the origin_status fix); per-setup-type fallbacks (`bDelay=-1`, `volRatioP50=1.0`) fire more often now that real N dropped ~7x, changing Arm B/C2's composition in a way that isn't a clean "same test, smaller N"; and the replication gate now clears far fewer setup_types, weakening that check's own verdict independent of the headline flip. None of this invalidates the correction itself — it's why the claim stays `PROVISIONAL`.


- **RESOLVED 2026-08-31: `audit_remaining_positional_dategap_scripts_20260831` — all 4 remaining scripts patched with the same gap-guard pattern.**
  - `scripts/backtest_poc_convergence_and_drift.mjs` (Parts A+B, forward-return horizons) — re-ran end-to-end: both parts were already `REJECTED` before the fix and remain `REJECTED` after (kill criteria still trip) — no headline change, now correctly computed. Surfaced an 8th, very recent, much smaller gap (`2026-08-13→2026-08-19`, 6 days) not previously tracked — not investigated, likely unrelated to the historical contract-rollover mechanism given its size and recency.
  - `scripts/backtest_or5_low_gap_down.mjs` (the most exposed per the original flag — live-wired to `OR5_LOW_FADE_LONG_GAP_DOWN`'s SHADOW-only calibration) — re-ran: N moved 147→151 (aligned) / 194→193 (against), EV moved more than the small N-shift alone would suggest ($7.77→$14.86 / -$2.08→+$8.39). Plausibly mostly real data growth over the 13 days since the original 2026-08-18 calibration rather than purely this fix — not fully isolated, and not urgent to isolate since the recommendation stays `THIN_N` regardless either way (hardcoded by design, not data-driven — zero live behavior change).
  - `scripts/mine_or_conditional_fade.mjs` (the source mining script behind the calibration above) — same fix applied for consistency/future re-runs; not re-run this session (one-off dated-CSV output, not part of a recurring pipeline).
  - `scripts/backtest_unified.js`'s `buildTwoDayPOC()` — fixed for correctness; feeds `PD2_VAH`/`PD2_VAL`/`2D_POC`, already confirmed no real edge (2026-07-17) independent of this fix. Not re-run (large whole-roster backtest, downstream signal already known-dead).
  - All 4 lint/syntax clean; `test_invariants.mjs` unchanged (same 6 pre-existing circuit-breaker failures).


- **`price_bars_nqh26_contract_thin_and_early_20260928` root-caused (2026-08-31) — the original framing was wrong, and the real shape of the problem is more dangerous than a calendar gap, not less.** NQH26 (Mar2026)'s thin, early data turns out to be genuine, real market activity for a legitimate far-dated background contract — not the anomaly. **The real gap is in `NQZ25` (Dec2025, the contract that should have been front-month for essentially the whole `2025-09-20`–`2025-12-19` window)**: it only has real (confirmed genuine front-month volume, 400k-990k/day) data in `price_bars_dedup_hist` for `2025-11-19`–`2025-12-12` — missing its own first ~2 months and final ~week entirely. During those missing windows the table has ONLY `NQH26`'s thin (~1-2% of real volume) data for the same calendar dates.
  - **This does NOT show up as a calendar-date gap** — `findTradingDayGaps()` wouldn't flag it, since every date in the window has *some* row. That makes it a materially more dangerous failure mode than the 6 main gaps (which are at least obviously empty): any volume/liquidity-sensitive computation (rolling volume baselines, ATR-by-volume, the volume-building signal, order-flow imbalance) touching `2025-09-20`–`2025-11-18` is silently reading the wrong, ~1-2%-of-real-volume contract without any structural signal that something's off.
  - **Not resolved** — this needs a scope/handling decision, not just documentation: whether to build a separate volume-analysis exclusion guard for this window (distinct from the calendar-gap guard, since dates aren't missing here), whether the real `NQZ25` volume data is recoverable from another source, and how many existing scripts/live features already touch this window's volume data unknowingly. `OPEN_DECISION` updated in place with the corrected root cause, left `PENDING`.


- **RESOLVED 2026-08-31: `globex_trail_diversion_never_applied_20260831` — user decided Globex touches of `PD_POC_FADE_LONG`/`SHORT` should divert to the breakeven-trail mechanism too, matching RTH.** Added `resolveUnconditionalTrailVariant(rawType)` to `server/config/setupTypes.js` — derived from `CONDITIONAL_VARIANTS`'s own `baseType` field (a reverse map built once, filtering to `unconditional`-condition entries) rather than hand-copying the RTH engine's 7-line if-chain a second time, which is exactly the mistake that caused this whole thread. `detectGlobexSetup()` now resolves `c.type` through it before the `CONDITIONAL_VARIANTS` lookup that determines `runner_trail_width`/`wider_target_mult`.
  - **Deliberately scoped narrow for safety**: the row's own stored `setup_type` stays the raw base name (`PD_POC_FADE_LONG`), NOT renamed to the `_TRAIL` suffix RTH uses — only the trail-calibration *lookup* uses the resolved name. Renaming the stored value to match RTH would also require updating the re-arm dedup check and the live-status check (both key off `setup_type`), which touches real live-firing behavior and was judged out of scope for tonight.
  - **Concrete effect**: `PD_POC_FADE_SHORT` (which already has a real, validated calibration — real N=21, trail=19.3pt, OOS EV +$30.31 vs -$2.31 fixed-target baseline) now gets that real benefit on Globex fires too, not just RTH. `PD_POC_FADE_LONG` has no calibration yet, so it correctly falls back to wider-target automatically — same safe-default behavior as before.
  - **Known remaining gap, not fixed here**: Globex fires of these 2 types are still invisible to `test_invariants.mjs` check [21] and the `CONDITIONAL_VARIANTS` trail-health monitoring generally (both filter by `setup_type=X_TRAIL`) — a smaller, not-yet-flagged follow-up if full parity with RTH's monitoring is ever wanted.
  - Verified: `resolveUnconditionalTrailVariant()` unit-tested inline against known base types, lint/syntax clean, `test_invariants.mjs` unchanged, server restarted and confirmed live (new process, no new errors).


- **`quick-check.html` wider-target UI simplified (2026-08-31, direct user request), with one real bug caught by the user in the process.** Removed the per-trade "Wider-target check: could not verify..." counterfactual modal box (`loadWiderTargetCounterfactual()`, `WT_NORMAL_REASONS`/`WT_ABNORMAL_NOTE`, the `#wt-counterfactual` element/CSS) and the aggregate "Wider-target research/live" session-timeline banner (`#research-note`, `loadResearchNote()`/`renderResearchNote()`) — both replaced with a single compact **`Tx1.5`** row tag, matching the existing `Vol++`/`Vol+` visual pattern.
  - **First version was wrong, caught live by the user twice on the same real trade** (id 109447, `GLOBEX_VWAP_FADE_LONG`, fired 08:27 AM, resolved 9 bars later at 08:36 AM as `WIDER_TARGET_HIT`). v1 gated the tag on `wider_target_mult != null`, which only means the mechanism was ARMED at insert — every trade routed into that branch gets a non-null value regardless of outcome, so a trade that reached T1 too slowly to actually qualify still showed the tag. Fixed to gate on `resolution_method` starting `WIDER_` (the field that reflects the mechanism actually engaging, per `stepWiderTarget()`'s own state machine).
  - **Second flag on the same trade was NOT a bug** — traced it against real bars: T1 was genuinely reached in 2 bars (well inside the 4-bar `MAX_BARS_TO_T1_FOR_WIDER` eligibility window), correctly arming the extension; it then rode 7 more bars before the wider target itself printed, making `bars_to_resolution=9` a correct total-including-the-extension-phase figure, not a violation of the 4-bar rule. `bars_to_resolution` conflates "bars to original T1" (the actual eligibility check) with "bars to final resolution" once this mechanism engages — the tag's tooltip now says this explicitly so it doesn't keep reading as a bug.
  - **Max DD stat added to the Session Timeline stats row** (Wins/Losses/Net/Gross/Comm), reusing `computeRangeStats()` for the shared fields. After user clarification this is deliberately NOT the cumulative peak-to-trough figure already shown in the Performance section — it's the worst single-trade MAE (in dollars) among today's trades, scaled by that trade's own `size_multiplier` (the system's live sizing recommendation at fire time, baseline 1.0x) per a further user request to reflect "actual risk," not a flat 1-contract assumption. Deliberately NOT scaled by `trades.quantity` (the real broker-fill table) — no established, validated join from an `active_setups` row to a specific real trade's contract count exists, and CLAUDE.md's own collaboration rule bars conflating that table with the signal-firing engine without one.
  - Verified via a real Playwright check (not just `node --check`/`curl`) per the frontend hard rule: page loads clean, zero console/page errors, `#research-note` fully removed, `Tx1.5` tag renders with the corrected count, modal opens with no leftover `wt-counterfactual` element.


- **Five quick LOW/MEDIUM `OPEN_DECISION` items cleared in one pass (2026-08-31), picked specifically for being tractable without new backtests/mining (unlike most of the ~58-item backlog, which is blocked on N<20 or needs fresh research).**
  - **`remove_cascade_diag_after_confirmed`** — NOT resolved, re-checked and re-flagged with fresh evidence. Re-audited the full `scratch/cascade_diag.log` (5891 lines, 2026-08-12 through 2026-08-28 — quiet since because its logging is gated behind `cascadeBreaker.active`, not a bug). Still only 2 total multi-candidate `candidates-stage` lines in 16 days of instrumentation, and in both the winner was the first-listed candidate — the fallback-picks-a-non-obvious-candidate case this decision exists to observe has still never happened. Do not remove the 4 diagnostic checkpoints yet.
  - **`optstop_notes_malformed_json_concatenation`** — RESOLVED. No code in the current codebase or git history produces the concatenation bug (a one-time manual `noiseFloorRevert` annotation, most likely via the untracked `fix.js`/`patch.cjs`/`patch.js` scratch files present earlier this session, since cleaned up). Confirmed all 146 `OPTIMAL_STOP` signal_names' *current* rows are clean JSON — no live consumer was ever at risk. Repaired the one orphaned historical row (`FLOOR_R1_FADE_LONG`, `run_date=2026-08-07`) by merging the two concatenated objects properly.
  - **`wider_target_pressure_gate_fails_open_on_null_reading`** — RESOLVED, the recommended fix applied. `stepWiderTarget()`'s pressure gate now fails CLOSED on a missing reading (banks instead of silently arming) once a real calibrated threshold exists; the no-threshold-supplied case is unchanged. Added synthetic test T21; full suite 42/42.
  - **`confluence_levels_naming_canonicalization_4_sites`** — RESOLVED. Canonical form is `'VWAP'` for RTH developing (not `'RTH_VWAP'` — matches `backtest_confluence.js`'s own `availableLevels.VWAP` key), `'GLOBEX_VWAP'`/`levelBase` generally for Globex. New shared `canonicalConfluenceLevelName()` helper used at both RTH sites; Globex `detectGlobexSetup()` switched from human-readable `.name` strings to the already-existing `.levelBase` field (already used for confluence pair-matching a few lines up). Confirmed zero live consequence — `backtest_confluence.js` doesn't read this column at all.
  - **`breakeven_trail_backfill_path_latent_width_gap`** — RESOLVED. Added the missing `runner_trail_width` lookup (3rd copy of the pattern used at the other 2 insert sites) to the early-touch backfill INSERT path. Confirmed still purely defensive/latent — all 6 live `_TRAIL` variants remain `THIN_N` in `SETUP_STATUS` (per `breakeven_trail_zero_real_survivors_20260816`), so this path never actually fires a `_TRAIL` type yet; closes the gap for whenever one is eventually promoted.
  - All 5: lint/syntax clean, `test_invariants.mjs` shows the same pre-existing 6 circuit-breaker failures as baseline (no regressions), server restarted and confirmed live after each code change.




- **A second batch of 5 backlog items cleared (2026-08-31)**, same "tractable without new backtests/mining" selection as the earlier 5-item pass this session.
  - **`price_bars_multicontract_collision_audit`** — RESOLVED. Grepped every script/service referencing raw `price_bars` without `price_bars_primary`; found 3 genuinely vulnerable, currently-live/scheduled consumers (`server/routes/playbook.js` x3 sites, `scripts/derive_day_types.js`, `scripts/daily_coaching.js` x2 sites) and switched all to `price_bars_primary`. Verified near-identical query timing (489ms vs 465ms), no regression. Remaining research-only scripts (`runner_leg_backtest.mjs`, `replay_all_setups.js`, `combo_backtest.js`, `volatility_predictive_backtest.mjs`, `backtest_wpp_short_gap.mjs`) documented but not fixed — lower priority, not live/scheduled.
  - **`optimal_stop_circuit_breaker_n_count_unreconciled_drop`** — RESOLVED, bookkeeping only. Already fixed by Opus Audit 9 (2026-08-19/20, a circuit-breaker baseline-ratchet bug) — the code's own comment explicitly names this decision as resolved; the tracker entry was just never closed.
  - **`nodemon_child_orphan_silent_stale_serving`** — RESOLVED. Added a check to `.claude/hooks/session-start.sh`: whenever exactly one nodemon supervisor is alive, verifies the actual port-3002 holder's real PPID matches it, flagging loudly on mismatch (the exact silent failure found live 2026-08-25 — nodemon alive, port healthy, but no longer supervising the real process). Scoped to the ===1 case only to avoid noise on top of the existing 2+ duplicate-supervisor check.
  - **`compute_levels_11am_cron_overwrites_full_session_levels`** — RESOLVED. Added an optional `--category=X` flag to `scripts/compute_levels.js` (additive, every other caller unaffected); the 11am ET post-IB cron now passes `--category=CURRENT` so it only re-upserts OR/IB levels instead of also overwriting `RTH_VWAP` with a partial-session average.
  - **`app_jsx_dead_casesetupmap_regularevents_code`** — RESOLVED, mixed. The dead-code deletion itself was already done in earlier work this week (confirmed via the code's own dated comment). The genuine open question it left behind — should timeline enrichment (bar6_checkpoint/historical_win_rate/delta-confirmation) scope to only the 12 true case-engine types, or stay unconditional for every setup — was put to the user directly. **Decision: leave it unconditional** (scoping would have hidden this context from IB_BULLISH/BEARISH and the entire fade roster, the setups actually watched most).
  - Two of the five (circuit breaker, dead App.jsx code) turned out to already be fixed by other work earlier this week — the tracker just hadn't been updated. Verified each against live code before acting, not assumed from the flag text, per direct user instruction mid-session not to blindly reapply a stale fix over newer work.
  - All code changes: syntax/lint clean, `test_invariants.mjs` shows the same 6 pre-existing circuit-breaker failures as baseline (unrelated, confirmed predating this session), server restarted and confirmed healthy after each change.


- **A third batch of 5 backlog items checked (2026-08-31)**, same session as the two earlier 5-item passes.
  - **`selected_over_starvation_recheck_at_n20`** — still PENDING, correctly left open. Real N grew from 2 (8/18) to 10, still below the N>=20 floor this decision itself requires before drawing a conclusion. Directionally, every one of the 10 rows shows IB_BULLISH/BEARISH being the type passed over, never the reverse — consistent with the original starvation concern but too thin to call real yet.
  - **`ai_setup_review_needs_validation_check_at_n20`** — still PENDING. Max real N is 5 (PD_VAH_FADE_SHORT), nowhere near the N>=20 trigger.
  - **`value_area_measurement_layer_first_look`** — RESOLVED, checked 2 days ahead of the 2026-09-02 self-imposed checkpoint. Real N across all 7 lookback windows ranges 32-1343 (comfortably above thin). Honest result: value-area position (Edge vs Mid) shows no meaningful, consistent differentiation in outcome at ANY lookback — avg_pnl -$1.70 to -$7.77 for both labels, win rates flat 46.5-51.5% regardless. A genuine, decisive negative, recorded as `RESEARCH_CLAIM value_area_regime_position_first_look_no_differentiation` (CONFIRMED). The tagging itself stays live (zero cost, self-populating) — this closes the "don't let it run forgotten" checkpoint, not the mechanism.
  - **`pd_poc_fade_short_capital_exposure_override_revisit`** — RESOLVED. All 3 stated conditions genuinely cleared (see commit `4bd4db8`): real WR beats break-even for 3 consecutive runs (not just the required 2), real_n 42-44 each time, no longer circuit-breaker-deadlocked. Put to the user directly since it's a live-capital-affecting change — confirmed, override removed. `PD_POC_FADE_SHORT` returns to normal SETUP_STATUS-driven eligibility.
  - **`backfill_time_expired_null_resolved_at_329_rows`** — investigated, repair deliberately deferred. Confirmed worse than the original sample suggested (263/329 rows, 80%, show an impossible `resolution_bar_time < fired_at` ordering — the original sample found 3/5, 60%). The offsets are irregular (31-47 minutes), NOT the clean 4-5-hour DST-shift signature that matches this codebase's already-documented naive-timestamp bug elsewhere — a different, not-yet-identified cause. Deferred building a dedicated repair script given confirmed zero real-capital impact (100% synthetic BACKFILL data, `actual_pnl` already correctly 0).
  - 2 of 5 genuinely couldn't be resolved yet (both correctly left PENDING, not forced) — this batch is a mix of real closures and honest "not yet" answers, not a clean 5-for-5, matching the project's own no-fabrication standard.


- **A fourth batch of 5 backlog items checked (2026-08-31)**, same session, same "verify current state, no fabrication" discipline.
  - **`touchqualitytest_pace_window_off_by_one_affects_live_sizing`** — RESOLVED, user-confirmed. `_tqBars` was a 10-bar slice (9-interval span) z-scored against a genuine 10-interval baseline — fixed to an 11-bar slice so the span matches what was actually validated.
  - **`lf_session_delta_partial_vs_fullday_percentile_mismatch`** — RESOLVED, user-confirmed. Re-read the original 2026-07-08 backtest: it validated partial-day cumulative delta on both sides (self-consistent). Live's threshold was a flat full-day sum percentile instead — a different, unvalidated simplification, explaining why the factor almost never fired "high" (1/704) and almost always fired "neutral" (609/704). Rebuilt the threshold as a pooled percentile of the running cumulative delta sampled at every minute of every historical session, matching the original's implicit sampling.
  - **`rth_active_construction_stopped_20260803`** — RESOLVED 2026-09-01 as MOOT. A third zero-real-ACTIVE-fire day was found (2026-08-18) and left genuinely unexplained at the time this batch note was written. Superseded later the same session (2026-08-31, 18:19 ET, commit `c0f62d1`): IB_BULLISH/IB_BEARISH were suppressed outright, user-confirmed, after the full redesign audit came back negative. Both now permanently `recommendation=SUPPRESS` — the "why didn't IB fire" question this decision tracked no longer applies since there's no ACTIVE-eligible state left to investigate. Verified live 2026-09-01: zero ACTIVE fires of either type since the suppression deployed.
  - **`unbounded_price_bars_primary_4_weekly_scripts`** — RESOLVED, no code change. Confirmed none of the 4 scripts can be safely bounded without risking truncation of data they genuinely need (one needs a full trading-day index for lookback correctness, the other 3 need multi-year history by design). Matches this decision's own original caution against picking an arbitrary bound.
  - **`globex_ambiguous_names_need_session_backfill`** — RESOLVED. Backfilled 84 historical rows (of 4 setup_types sharing names across the RTH/Globex engines) from `VALUE_FADE` to `GLOBEX_LEVEL` based on real fired_at time-of-day, backed up per `DB_MIGRATION_PROTOCOL.md`, re-ran both dependent bet_class resweeps with the corrected population (`GLOBEX_LEVEL` N grew from 227 to ~560, verdict `SHIP_FLAT`; `VALUE_FADE` verdict `SHIP_CALIBRATED`).
  - 4 of 5 resolved; 1 correctly left open with new diagnostic progress rather than a forced answer.


- **A fifth batch of backlog items checked (2026-08-31)**, plus one standing test_invariants.mjs failure that had never been individually investigated.
  - **6 circuit-breaker-tripped setup_types** (not a formal OPEN_DECISION, a standing daily FAIL nobody had reviewed per-type) — individually reviewed. 5 correctly held (real-to-real recalibration with unconvincing EV improvement on thin/large swings, or the breaker correctly blocking a downgrade attempt). `OR5_LOW_FADE_SHORT` was the real judgment call: attempted move would have flipped a favorable ~1:1.9 risk:reward into an unfavorable ~2:1 one — user confirmed leave frozen despite the positive point-estimate EV, since that EV almost certainly reflects a compensating high win rate rather than a real edge. Recorded as `RESEARCH_CLAIM circuit_breaker_6_tripped_types_reviewed_20260831`.
  - **`price_bars_nqh26_contract_thin_and_early_20260928`** — partially resolved. Added `overlapsThinVolumeWindow()`/`THIN_VOLUME_WINDOWS` to `queries.js` (companion to the existing gap-guard). Identified the 3 highest-risk consumers (full-history + volume-using backtest scripts) but a full audit of all ~20 candidate files remains open — left PENDING.
  - **`do_not_ingest_tick_depth_into_postgres`** — resolved as a standing architectural decision with no action item (was sitting PENDING with nothing left to do).
  - **`time_expired_display_stats_sweep_remaining`** — RESOLVED, user-confirmed. `stats.js`'s capture-ratio and `monteCarloService.js` both now include TIME_EXPIRED trades (real mark-to-market P&L), classified win/loss by sign. `patternMemoryUpdate.js`'s TARGET_HIT-only queries audited and correctly left as-is (different semantic — move magnitude on a clean hit, not a general win/loss aggregate).
  - **`condition_memory_needs_rebuild_not_backfill`** — escalated to HIGH, not resolved. Found something bigger than the original double-counting concern while scoping the rebuild: `daily_performance_log`'s last row is 2026-07-31, a full month dead, despite real `trades` data existing through 2026-08-12 that should have triggered the pipeline's own catch-up mechanism. Not root-caused this session (deliberately not rabbit-holed) — needs its own focused investigation before any rebuild, since rebuilding from a still-broken source would just re-encode a fresh gap.


- **`derive_day_types.js` same-day lookahead bug — RESOLVED same-day (2026-09-04).** Found via a fresh `test_invariants.mjs` run after this session's cluster-touch-credit backfill work: the script's own "is today's session complete yet" gate was `HAVING COUNT(*) >= 200` bars — reached ~12:50pm ET, hours before the real 4pm RTH close — not an actual time check, despite the file's docstring claiming it was a completeness gate. Root cause: this session ran `run_daily_calibration.sh` (which calls `derive_day_types.js`) manually mid-afternoon per a user request to "refresh the daily and weekly cron," ahead of its normal 20:20 ET schedule; since today's RTH session already had 200+ bars by then, the script classified today's still-open session as `BALANCE` hours early and wrote it to `acd_daily_log`, which then leaked into 8 real `active_setups` rows' `day_type_at_fire` tag (informational only, never gates/sizes anything — confirmed zero live-capital impact) between 15:59-16:32 ET. Fixed: `derive_day_types.js` now requires real ET wall-clock time >= 16:00 before it will classify the current calendar date at all (previously only bounded by `ts::date <= CURRENT_DATE` with no time check), verified both that a legitimate post-close re-run still produces the same `BALANCE` result (no regression) and that a simulated 12:50pm run would now correctly be excluded. The 8 affected rows were reset to `day_type_at_fire='UNKNOWN'` to match what every other RTH-session row correctly shows at insert time (the value itself was coincidentally correct — BALANCE matched both the premature and legitimate classification — but the *process* was a real lookahead violation regardless of the coincidentally-right answer, so the honest fix is the reset, not leaving a "right for the wrong reason" value in place). `test_invariants.mjs`'s day_type_at_fire check now passes clean (was the one non-baseline FAILURE found this session, 10→9 total). **Practical takeaway for future sessions**: don't run `run_daily_calibration.sh` (or `derive_day_types.js` directly) mid-session as a "just refresh things" action without considering that some of its steps are time-sensitive to when in the trading day they run — this one specifically should only ever run at/after RTH close.


- **🔶 2026-09-04: revisiting the 2026-09-01 "86% genuinely unexplained" ACTIVE-vs-SHADOW residual — real progress, NOT closed.** Follow-up to the `active_selection_edge_over_shadow_lost_early_august` thread (RESOLVED 09-03 for the dead-zone-bug mechanism, but the thread's own "86% of the Aug-H2 no-contest gap stays genuinely unexplained" line was left open). This session found and fixed the dead-zone bug's live-code side (verified working, see the OPEN_DECISION resolution above) and then tested — via the full DeepSeek-critique → Gemini-mine-and-run → DeepSeek-review pipeline, user-requested — whether that same bug explained the residual. It doesn't, but something more useful turned up.
  - **Real finding, independently verified**: the "4 known-bad types" excluded from the original N=62/EV=-$11.26 baseline (`PD_POC_FADE_SHORT`/`IB_BULLISH`/`GLOBEX_VWAP_FADE_LONG` + `IB_BEARISH`) never included `PD_VAH_FADE_SHORT` or `OR5_LOW_FADE_SHORT` — even though both were named as wave-2 contributors in the SAME 09-01 paragraph. Direct SQL confirms: excluding only the 4 named types over Aug 16-31 gives N=64/-$626.50 (matches the documented baseline closely), and `PD_VAH_FADE_SHORT` (N=23/-$398) + `OR5_LOW_FADE_SHORT` (N=15/-$115) alone account for 38/64 trades (59%) and 82% of the net dollar loss.
  - **First-pass Gemini synthesis ("dead-zone/circuit-breaker contribute nothing, residual negligible") was WRONG, caught by DeepSeek's second review pass, not accepted at face value.** The "circuit-breaker-frozen: 0" and "dead-zone-leak: 0" bucket counts were structurally guaranteed by (a) a stale hardcoded `circuitBreakerTypes` list missing `PD_VAH_FADE_SHORT`, and (b) a bucket-precedence order that checked `wave-2` before `dead-zone-leak`/`circuit-breaker-frozen`, even though the script's own `DEAD_ZONES` table listed both dominant types as dead-zone-leak candidates. "Negligible residual" was also an overstatement — the `genuinely-unexplained` bucket's per-trade EV (-$8.10) is still worse than `SHADOW`'s, "negligible" only in raw dollar terms because N is small.
  - **Traced the real mechanism for `PD_VAH_FADE_SHORT` directly (independent SQL, not another dispatch)**: 66% of its entire Aug 16-31 loss (-$264 of -$398) happened in a SINGLE-DAY refire storm on 08-28 — the same fixed PD_VAH level (entries clustered within a ~30pt band, confirming real repeated touches of one level, not a data artifact) got re-touched 16 times in ~16 hours, each using a circuit-breaker-FROZEN stop (23pt, frozen since 08-25) while a fresh calibration was trying to widen it to 39-41pt. A too-tight stop gets hit more often in exactly this kind of chop, so the frozen breaker plausibly compounded rather than just failed to help. This is a real, concrete two-part mechanism (frozen stop + no same-day refire cooldown gate) — genuinely new, not a relabeling.
  - **`OR5_LOW_FADE_SHORT` does NOT show the same clean story** — its Aug 16-31 losses are noisier (a bad day 08-31 at -$264/N=6, partly offset by 3 positive days), no single dominant mechanism identified. Not investigated further this session.
  - **Still genuinely open, not resolved by this**: the thread's actual original question — why did the SUPPRESS/PROMOTE selection mechanism itself stop reliably picking winners roster-wide — is NOT answered by "these 2 types did most of the damage." What's shown here is a real, verified explanation for the two dominant dollar-contributors, not a general mechanism for the whole roster's edge loss. `OPEN_DECISION setup_status_dow_clear_skips_globally_suppressed_types` (flagged this session, unrelated narrower bug) and the existing `same_type_refire_gate_live_wiring_pending` (still not live-wired — this `PD_VAH_FADE_SHORT` 08-28 storm is a concrete, real-money illustration of exactly the gap that decision already describes) are the two standing mechanisms most directly relevant to preventing a recurrence — worth prioritizing over further root-cause archaeology on this specific window.
  - Full evidence trail: `scratch/antigravity_response.md` (2 Gemini rounds, 1 real correction), `scratch/deepseek_response.md` (2 DeepSeek critique/review rounds, the second one catching the premature "moot" conclusion).
  - **CLOSING UPDATE, same overnight session (2026-09-04, later)**: independently re-verified Gemini's final reconciled population directly against the DB (own SQL, not trusting the script) — confirmed exactly N=50 no-contest ACTIVE fires, wave-2 (`PD_VAH_FADE_SHORT`+`OR5_LOW_FADE_SHORT`) = 29/50 trades/-$304, leaving 21 fires/-$170 genuinely unexplained (matches Gemini's report exactly once its `resolution_method NOT IN (MARK_TO_MARKET, RECOVERY_MTM)` + `ib_window_stale_basis IS NOT TRUE` filters — legitimate data-quality exclusions, not cherry-picking — are applied). **Checked current live SETUP_STATUS for all 6 named culprits (today's 2026-09-04 run): all 6 are `SUPPRESS`** (`GLOBEX_VWAP_FADE_LONG`, `IB_BEARISH`, `IB_BULLISH`, `OR5_LOW_FADE_SHORT`, `PD_POC_FADE_SHORT`, `PD_VAH_FADE_SHORT`) — the self-correcting weekly pipeline has already caught and shut off every setup_type responsible for effectively the entire traceable Aug-H2 selection-edge gap; no manual live-wiring action needed beyond what already ran. Quantified the real-world impact: since 2026-08-01, ALL real ACTIVE trades net -$1897.90 (N=261); excluding those same 6 now-suppressed types, the surviving roster nets -$277.00 (N=117, WR=37.6%, EV=-$2.37/trade) over the identical window — an ~85% reduction in realized loss, though the survivors are still marginally negative EV, not yet clearly profitable. This thread is now genuinely closed for practical purposes (the mechanism is understood, the fix is already live via the ordinary weekly pipeline) — the deeper "why did the selection mechanism stop reliably picking winners" question from the paragraph above remains open, but is no longer blocking.
  - **Also this session: removed a stale sizeMultiplier stacking override** (`if (_lfSameDirN >= 7) mult = 0.10`, calibrated 2026-07-05 on a roster ~5x smaller / ~27x less active than today, non-monotonic on current data, both sides of a clean 7-split showing the same account-wide chronological decay rather than an independent signal) — DeepSeek-reviewed (approved with 4 fix-list items, all applied: dead-variable cleanup, stale comment reference removed, and a note added that two OTHER hard ceilings — the loss-streak cap and the post-IIFE `hasLossToday` 0.5x "Death Sequence" cap — remain and independently explain most of why real trades cluster at 0.10-0.25x, so a future revalidation must measure the delta in the no-loss-streak subset, not the whole population). `OPEN_DECISION stacking_sizemultiplier_override_removed_needs_revalidation`.
  - **Tested and rejected (then partially un-rejected) a per-setup-type daily loss cap** (force-SHADOW rest of day once a setup_type's running real PnL crosses -2x its own OPTIMAL_STOP distance): full-history backtest (N=478 real trades) showed this would have been NET HARMFUL (+$1159 to trades it would have skipped, dominated by 2 huge recovery days Jul 29-30) — the 4th reactive-exposure-cutting idea this session to show the same reversion-trap signature (joining standDown, the stacking override above, and the pre-existing `pilot_same_direction_throttle.mjs` negative). But restricting to trade_date>=2026-08-01 (the account's actual recent losing stretch) REVERSES it: NET HELPFUL (-$550 avoided, 5 of 8 recent trigger-days negative). Thin (8 distinct days) — not shipped, `RESEARCH_CLAIM perSetup_daily_loss_cap_reversion_trap_20260904`, `OPEN_DECISION per_setup_daily_loss_cap_recent_regime_reversal` (ship as SHADOW-only log, ship live, or shelve — genuine product-risk call, not decided).


- **2026-09-05: resolved 2 of the 4 outstanding items from the overnight session, using best judgment where the user deferred the call.**
  - **`standdown_loss_streak_premise_refuted_needs_ui_decision` — RESOLVED, option (a) removed.** The `standDown` field (drove MarketPulseBar.jsx's/quick-check.html's "⛔ SKIP" badge) was removed from `server/routes/acd.js` entirely rather than patched with an unvalidated replacement — a verdict-style warning built on a refuted premise works against this project's own unemotional-discipline purpose. **Found a second, worse instance of the same refuted premise while fixing this**: `server/routes/playbook.js` was feeding an LLM prompt the identical logic as "a system rule, not discretionary" (`Do NOT recommend new fades`), AND had a hand-typed `-$9,802 total, 58.6% WR` literal baked into TWO branches — a `CLAUDE.md` hard-rule violation independent of the standDown question. Both replaced with honest, non-fabricated text (informational streak count; a note that no live pooled TREND-day-fade figure is currently derived to quote, defer to each setup's own live `sizeMultiplier`). All 3 consumers (acd.js, MarketPulseBar.jsx, quick-check.html, playbook.js) verified clean via `node --check`/lint/`test_invariants.mjs` (19 failures after, down from 20 — a stale test_invariants nag from a mis-scoped `unblockCondition` on my own claim from the night before, unrelated to this fix, fixed separately). Not yet done: deriving a real, live pooled TREND-day-fade EV/WR figure for playbook.js's text, if that's judged worth doing at all — currently just says "no figure available," not a fabricated placeholder.
  - **`per_setup_daily_loss_cap_recent_regime_reversal` — partially resolved (a 3rd path, not the 3 originally offered).** Rather than ship live or build a brand-new SHADOW-parallel tracking mechanism on 8 days of thin, previously-reversing evidence, built `scripts/backtest_per_setup_daily_loss_cap.mjs` (wired into `run_weekly_backtests.sh`) so the finding self-recalibrates weekly instead of sitting as a dead one-off inline analysis — satisfies the no-dead-ends checklist without committing to a live behavior change prematurely. Manual recheck trigger recorded in the claim's own notes (revisit the ship/shadow/shelve call once the recent-regime post-cap population clears ~20 distinct trigger-days) since `recordClaim`'s structured `unblockCondition` mechanism doesn't have a shape that matches this claim's semantics (checks lifetime N per setup_type, not recent-window distinct-day count).
  - **dtaRow dead-factor investigation — CLOSED, not a separate bug.** Confirmed `dtaKey = dtClass ? \`${type}-${dtClass}\` : null` means `dtaRow` inherits `dtClass`'s exact same structural gate (null until the nightly `derive_day_types.js` run, hours after RTH close) — this was already implicitly documented via the 2026-09-01 `sizemultiplier_factor_hygiene_audit_reveals_dead_factors` finding (`dtaRowRecommendation NULL 63/63`) under the `dtclass_live_read_wiring_and_regime_scope` thread. No new fix needed here; the real fix is whatever eventually lands for `dtclass_null_all_day_neuters_multiple_live_gates`.
  - Stacking-override revalidation (`stacking_sizemultiplier_override_removed_needs_revalidation`) — no action taken, correctly left as a future recheck once real post-removal data accumulates; nothing to decide yet.


- **2026-09-05: direction-loss-alternation gate — SHIPPED as SHADOW-only observational logging, prompted by a real user-provided example.** User asked to test "how sharp momentum is, stop fighting/trading against it," which led to a real, durable finding (momentum-against-fade filter, holds up across 5/15/30-bar windows and a chronological split — `RESEARCH_CLAIM momentum_against_fade_filter_20260905`, calibration script built) but the user's actual concern turned out to be broader: preventing CLUSTERS of losses (their words: "there was one day in shadow where 10+ losses fired off... another cluster in globex"). Direct query confirmed real refire-storm clusters exist (`GLOBEX_VWAP_MAGNET_LONG` 84 fires/1 day, `BRACKET_BREAKOUT_SHORT` 71 fires/1 day, 87% loss rate) caused by a documented, already-known gap: `REFIRE_COOLDOWN_MINUTES` only changes ACTIVE-vs-SHADOW labeling, never insert *frequency* (2026-08-20 incident comment already in the code). But the user's own screenshot (real quick-check.html data, 2026-09-03 18:51 → 2026-09-04 02:57) showed a DIFFERENT, more relevant pattern: 13 real SHORT losses across 6 different setup_types (not one refiring type) while every real LONG in the same window won — a whole-roster same-direction pile-up during a real overnight uptrend. Replaying that exact sequence through the already-built-and-tested direction-alternation gate (`RESEARCH_CLAIM direction_alternation_after_loss_gate_20260905`, from the earlier 2026-09-05 entry above) turns -$657.50 into +$194.50 (11 of 13 losses blocked). User initially asked to wire it live for real; reversed to SHADOW-only after being shown the honest walk-forward caveat (flat EV in the first half of account history, real only in the second half) — an explicit, informed choice, not a default.
  - **Shipped**: `isDirectionLossBlocked()` + `tagDirectionGateShadow()` in `server/routes/acd.js` (right after `isOppositeDirectionOpen()`, same architectural pattern — roster-wide, event-based state derived from the most recent real ACTIVE/SHADOW resolution, no timer). Wired into all 4 real insert sites (Globex, STACK_VOL_BREAK_LIVE, RTH main path, shadowCandidates loop) via a post-insert `UPDATE ... WHERE id=$2` keyed by each INSERT's own `RETURNING id` — deliberately NOT threaded through the INSERT's own positional `$N` parameter lists, to avoid the exact "manually counting params across 4 sites" failure mode this codebase's own conventions warn about. New column `active_setups.direction_gate_shadow` (JSONB). Zero real trades are affected — no stop/target/resolution/ACTIVE-eligibility changes anywhere.
  - **Made visible where the user actually looks** (explicit ask: "I don't check open decisions often"): `GET /api/setups/direction-gate-shadow-summary` + a "DirGate" tag/tap-popup on `quick-check.html` (shown only on trades that WOULD have been blocked — the informative case), mirroring the existing PnC/StepTrail tag pattern exactly.
  - Server restarted (`systemctl --user restart trading-journal-server.service`) to pick up the new route/column; verified healthy post-restart (no new errors, `test_invariants.mjs` unchanged at 19 failures/88 warnings with vs. without this session's diff).
  - **Not done this session, deliberately out of scope**: the refire-storm/insert-frequency gap (`REFIRE_COOLDOWN_MINUTES` not capping insert count) and the momentum-against-fade filter's live wiring — both real, both tested, neither shipped. `OPEN_DECISION direction_alternation_after_loss_gate_pending` updated to reflect the SHADOW-only ship; still open is the eventual live-or-not call once real `direction_gate_shadow` data accumulates.


- **2026-09-05, same overnight thread continued: step-trail per-(setup_type x time-of-day) calibration built, self-recalibrating weekly, with a real bug caught and fixed on its first run.** User asked to monitor+calibrate the step-trail runner extension "for all setups" automatically, not just the 3 leads a one-off backtest happened to find, and for it to be structured so it would naturally carry forward if the mechanism is ever promoted to live.
  - **Built `scripts/calibrate_step_trail_per_setup_time.mjs`** (wired into `run_weekly_backtests.sh`): reuses the exact Arm A/B simulation from `step1_ratchet_v3.mjs`, grouped by every real (setup_type, time-of-day) cell plus a roster-wide-per-time-block pooled fallback. GATE requires N≥20, positive mean delta, not day-clustered, and rigor-clean OR the Opus-Audit-#12 big-win-excluded fallback (≥-$3).
  - **First run GATEd `ALL_TYPES__0930_1030_open_ib` (N=260, +$7.89)** — the exact pooled market-open finding already manually retracted earlier the same session (real-ACTIVE-only N=27 was negative and 70%+ day-clustered). The script's criteria didn't check real-vs-SHADOW agreement, so it silently re-approved a debunked result. **Fixed same session**: added a real-vs-SHADOW subgroup-reversal check (any cell with real-ACTIVE N≥10 whose mean delta sign disagrees with the pooled mean is disqualified, regardless of what SHADOW alone shows) — re-run correctly drops that cell. Currently 1 cell clears the bar: `ALL_TYPES__1030_1200_post_ib` (N=152 pooled, real-ACTIVE N=22 independently agrees in sign and clears N≥20 alone, +$2.08/+$2.52) — modest but genuinely more defensible than the retracted finding.
  - **`GET /api/setups/step-trail-shadow-summary`** updated to read this real calibration table (`gatedCells`) instead of a cruder live-computed version that lacked the reversal check; the StepTrail popup on quick-check.html shows only GATE cells, self-expanding as new ones clear the bar.
  - **Deliberately NOT wired to gate or size any real trade** — matches the overall step-trail mechanism's own Phase 1 SHADOW-only posture (zero real armed data as of today). `OPEN_DECISION step_trail_per_cell_live_wiring_pending` tracks the design question of whether/how this per-cell table should feed live wiring once (if) the overall mechanism clears its own Phase 2 bar — not urgent given current data.


- **2026-09-05, closing the one deliberately-deferred item from the overnight session: momentum-against-fade wired as SHADOW-only observational logging.** The direction-loss-alternation gate entry above paused this mid-build (`getMomentumAgainstFade()` and `scripts/calibrate_momentum_against_fade.mjs` were already built and tested that same day — `RESEARCH_CLAIM momentum_against_fade_filter_20260905`, held up across 5/15/30-bar lookback windows and a chronological half-split) so the loss-cluster investigation could take priority. Picked back up and shipped, same architectural pattern as `direction_gate_shadow`/`step_trail_shadow`/`pitch_catch_shadow` — never gates/sizes a real trade, only annotates each real row after insert with what a future sizing decision would read.
  - **Shipped**: `getMomentumAgainstFadeCalib()` (cached read of the calibrated top-quartile "against momentum" cutoff, `_global`/12h TTL, same convention as `getCrossDirectionFlipCalib()`) + `tagMomentumAgainstFadeShadow()` in `server/routes/acd.js`, right after `getMomentumAgainstFade()`. Wired into all 4 real insert sites (Globex `detectGlobexSetup()`, `STACK_VOL_BREAK_LIVE`, RTH main path, `shadowCandidates` loop) via a post-insert `UPDATE ... WHERE id=$2` keyed by each INSERT's own `RETURNING id`, deliberately not threaded through positional `$N` params (same reasoning `tagDirectionGateShadow`'s own header documents). New column `active_setups.momentum_against_fade_shadow` (JSONB: `value`/`p75Cutoff`/`lookbackBars`/`against`/`direction`/`checkedAt`).
  - **Corrected a stale, false claim**: `scripts/calibrate_momentum_against_fade.mjs`'s `recordClaim()` text originally said this was "wired live... as a bounded sizeMultiplier penalty" — written aspirationally before the pause, never actually true. Fixed to describe the real SHADOW-only wiring; re-ran the script to refresh the stored `RESEARCH_CLAIM` text.
  - **Self-recalibrates weekly**: added `scripts/calibrate_momentum_against_fade.mjs` to `run_weekly_backtests.sh` (it existed but was never scheduled — would have sat as a compute-once-and-forget script otherwise, violating this codebase's own no-dead-ends checklist now that something live actually reads it).
  - **Made visible where the user actually looks**: `GET /api/setups/momentum-against-fade-shadow-summary` + a "MomFade" tag/tap-popup on `quick-check.html` (shown only on trades that cleared the "against" cutoff — the informative case), mirroring the DirGate tag pattern exactly.
  - Verified end-to-end: `ALTER TABLE active_setups ADD COLUMN momentum_against_fade_shadow jsonb` applied and confirmed via `information_schema`; `server/schema.sql` regenerated; `node scripts/test_invariants.mjs` unchanged (19 failures/88 warnings, same as baseline); server restarted, new endpoint curl-verified returning a well-formed (currently N=0, brand new) response; `scratch/server_errors.jsonl` has no new entries post-restart.
  - **Still open**: whether/when to promote this from SHADOW-only logging to an actual live sizeMultiplier penalty. `OPEN_DECISION momentum_against_fade_sizemultiplier_wiring_pending` (MEDIUM) tracks that separate, not-yet-made decision — revisit once the real `momentum_against_fade_shadow` population (`GET /api/setups/momentum-against-fade-shadow-summary`) has accumulated enough N to judge, same posture as the sibling step-trail/direction-gate promotion decisions.


- **2026-09-05: DeepSeek dead-code/shrink audit of `acd.js` (13,990 lines, ~908KB, ~10x the next-largest route file) surfaced a real live-behavior bug, not just cleanup — fixed same session.** User asked for a DeepSeek review looking for dead code and file-size reduction; DeepSeek (read-only, `scripts/invoke_deepseek.sh`, ~9 min run) came back with a well-organized report (`scratch/deepseek_response.md`) that Claude independently re-verified line-by-line before acting on anything, per the standing "audit all DeepSeek output" rule — every claim below was confirmed against the real file/DB, not passed through.
  - **🔴 The headline finding, HIGH confidence, independently confirmed: `getCached()` (module-level, `acd.js` ~line 105) returns `null` on a cache miss, never `undefined` — but ~9 distinct calibration readers across ~15 inline blocks checked `cached !== undefined` instead of checking for `null`.** Since `null !== undefined` is always `true`, every one of those readers treated a genuine miss as a hit and returned the stored `null` forever — the real `await query(...)` fallback was unreachable dead code. Confirmed by reading `getCached`'s own definition directly (not trusting DeepSeek's line numbers blind) and by re-simulating the exact broken-vs-fixed logic against live `performance_audit` data (see verification below).
    - **Real, not theoretical, live impact — confirmed by direct DB query before fixing anything**: `ENTRY_PRESSURE_SHORT` (a validated, positive-EV live sizeMultiplier boost — real backing N=242 above-threshold trades at +$8.94/trade vs N=482 below at -$4.69, calibrated as recently as 2026-09-04) and `WIDER_TARGET_PRESSURE_GATE` (real threshold 0.10, calibrated since 2026-08-24) both had real calibration rows sitting unused in `performance_audit` the entire time — both mechanisms silently ran in their null/fail-safe state instead of their real, calibrated behavior for ~12 days (since whichever commit first introduced each broken reader, 2026-08-24 through 2026-09-05 per DeepSeek's `git blame`).
    - **This session's own `momentum_against_fade_shadow` tagging (shipped hours earlier, same session) was dead on arrival** — the exact same broken pattern was used when writing `getMomentumAgainstFadeCalib()`, copied from `stepTrailCalib`'s already-broken code instead of the correct `getCrossDirectionFlipCalib()` truthy-check pattern. The earlier "verified end-to-end" claim for that ship only confirmed the endpoint didn't error, not that a real tag ever got written — a real miss per `feedback-verify-writes-same-turn`, corrected here.
    - `completeStepTrailShadows()`/`completePitchCatchShadows()` both hit `if (calib == null) return 0;` immediately after their own broken read, so both were fully inert (always returned 0, never completed a single shadow) since being built.
    - Also broken, lower-impact/informational: `2D_POC` level (never computed, both the stack-vol-levels site and the RTH `Promise.all`-based site), and `dayTypeForStack`/`dayTypeLabel` (triple-stack day-type gating never fired — informational display only, doesn't gate/size anything).
  - **Fixed same session** (all 9 sites, ~15 call-site edits): consolidated the 7 `_global`-scoped keys (`momentumAgainstFadeCalib`, `widerTargetPressureThreshold` ×3 copies, `stepTrailCalib` ×2, `pitchCatchCalib` ×2, `dailyAdxByDate` ×2, `entryPressureShortCalib`) into one new shared, correct helper — `getGlobalCalib(key, fetchFn)` (`acd.js` ~line 115, right after `setCached`) — so the null-vs-undefined contract only has to be right once instead of independently in 12 places; this also directly advances the original "shrink the file" ask (~12 duplicated blocks → 1 helper + short call sites). The 3 remaining `tradeDate`-scoped sites (`twoDayPOC` ×2 occurrences, the `cached2DPOC` `Promise.all`-crossing site, `cachedDT`/`dayTypeStack`) got minimal targeted `!== undefined` → `!= null` fixes in place, left as one-offs rather than forced into the shared helper since each has a distinct shape (one crosses a `Promise.all` positional-array boundary and needed its skip-condition and its post-resolve reconciliation fixed in matching lockstep; one is a deliberate cache-peek-only read inside `completePitchCatchShadows()` that intentionally does NOT its own query, since `resolveSetupsByPrice()` already warms that cache entry earlier in the same poll).
  - **Verification before and after, not just "it compiles"**: `node --check` + `npm run lint` clean both times; independently re-implemented `getCached`/`setCached`/`getGlobalCalib` in an isolated Node script and ran it against the real live `performance_audit` table — confirmed the fixed logic now correctly queries on a genuine first call (returned the real `{threshold: 0.0076, bump: 0.14}` row) and correctly hits the cache (no re-query, no thrown error) on a second call for the same key; `node scripts/test_invariants.mjs` unchanged (19 failures/88 warnings, matching the pre-existing baseline — no new regressions); server restarted clean, `scratch/server_errors.jsonl` has no new entries post-restart, all touched endpoints curl-verified 200. Also caught and fixed a subtler bug while editing: two of the consolidated blocks had a leftover stray `()` from the old IIFE-call syntax (`})();` where the new code needed plain `});`) that `node --check` correctly did NOT catch since calling a Promise as a function is a runtime error, not a syntax error — caught by manually re-reading every closing bracket, not just trusting the syntax check.
  - **Not yet done, deliberately deferred (DeepSeek's other findings, real but lower-stakes than the bug)**:
    - `postWinDirOf` (`acd.js` ~line 401) — genuinely dead, zero references anywhere in the repo (verified: only its own definition line matches `grep -rn`). Safe to delete.
    - 6 dead imports (`getGLineDaysHeld`, `scanAndSaveSetupEvents`, `scanStructuralEvents`, `getStructuralLevels`, `formatLevelTouchRate`, `formatComboRate`) — each verified to have zero live references in `acd.js` beyond its own import line (some are imported independently, correctly, by other files — that doesn't make `acd.js`'s copy live).
    - `checkFadeAgainstBigMoveExit` — a shipped-disabled stub (`{ return false; }`) plus ~46 lines of commented-out former implementation explicitly marked "preserved for reference, do not re-enable without re-validating" — DeepSeek correctly flagged this as a judgment call, not a clear win, given the explicit preservation note.
    - 5 extraction candidates into `server/services/*.js`, matching the existing pattern (`stepTrailWalker.js`, `pitchCatchWalker.js`, etc.): `resolveSetupsByPrice` (~1029 lines, the single biggest function in the file), the `completeStepTrailShadows`+`completePitchCatchShadows` pair, `detectGlobexSetup` (~594 lines), the `expireStaleSetups`+`structurallyInvalidateSetups` pair. All confirmed to NOT read `liveStats` or `allRthBarsRow.rows` directly, so none of this file's documented block-scoping/freeze footguns apply — genuinely safe extractions, just not done yet.
    - The two `tagDirectionGateShadow`/`tagMomentumAgainstFadeShadow` functions are near-duplicate but flagged "mergeable-with-care, not trivially" — different target columns/payload shapes/short-circuit conditions; DeepSeek correctly declined to recommend a blind merge here and Claude agrees it's low-priority relative to the bug fix.
    - Two one-line identical wrapper functions (`getOvernightLevelLiveStatus`/`getStackVolBreakLiveStatus`, both just `return getCanonicalLiveStatus(x)`), and a cross-file duplicate (`rollingStats`+`getTrailingORWidths`, independently reimplemented in `morningBrief.js` — a real "share modules instead of reimplementing" violation per that CLAUDE.md convention).
    - Explicitly confirmed as NOT a violation, correctly left alone: the `sizeMultiplier` IIFE (too tightly coupled to the `liveStats` block-scoping footgun to extract safely) and `REFIRE_COOLDOWN_MINUTES` (a hardcoded-looking map that's actually the deliberate, researched exception CLAUDE.md's own pre-commit hook allow-lists).
  - **New CLAUDE.md convention added** (see Conventions section: "`getCached()`'s null-vs-undefined contract") — this exact bug class (assuming a cache helper returns `undefined` on a miss, `Map.prototype.get()`-style, when it actually returns `null`) is generalizable enough, and was costly enough (a real live sizeMultiplier boost silently disabled for ~12 days), to warrant a standing rule, not just a one-off fix note.
  - **`OPEN_DECISION acdjs_deferred_cleanup_from_deepseek_audit_20260905` (LOW)** tracks the deferred dead-code/extraction items above so they don't silently vanish — none are urgent (no live-behavior impact), all are safe, well-scoped next-session work.
  - **2026-09-05, same day, partial cleanup**: knocked out the two genuinely trivial, zero-blast-radius items from the deferred list — deleted `postWinDirOf` (re-verified zero references before deleting, not just trusting the audit) and removed the 6 dead imports (`getGLineDaysHeld`, `scanAndSaveSetupEvents`, `scanStructuralEvents`, `getStructuralLevels`, `formatLevelTouchRate`, `formatComboRate` — each re-confirmed dead specifically *within* `acd.js` via a fresh grep, while confirming their sibling imports on the same lines, `getGLine`/`saveSetupEvents`, are genuinely still used before touching those import lines). **Declined to collapse the two one-line wrapper functions** (`getOvernightLevelLiveStatus`/`getStackVolBreakLiveStatus`) despite DeepSeek rating it an easy win — found 7+ comments across the file reference each by name as a documented design/choke-point anchor, so removing them would mean rewriting all those comments too, not a one-line deletion. Verified: `node --check` + module load + `npm run lint` clean, `test_invariants.mjs` unchanged at baseline (19/88), server restarted with no new errors. The extraction candidates (`resolveSetupsByPrice`, `detectGlobexSetup`, etc.) and the remaining lower-priority items are still open under the same `OPEN_DECISION` — this was a partial, not full, resolution.
  - **Offered, not yet dispatched**: quantifying the real dollar cost of the ~12-day bug window via Gemini (how many real SHORT trades since 2026-08-24 would have cleared the `entryPressureShortCalib` threshold and gotten the sizing boost, what the EV delta actually was) — a genuine DB-mining task suited to Gemini's role, distinct from the code-fix itself. User asked "can Gemini help" mid-session; answered that Gemini's role here is analysis not implementation, offered this as the natural follow-up, not yet confirmed/launched.
  - **Independent DeepSeek review of the fix itself, same session (user-prompted: "cross check these changes with whatever deepseek's findings come back with"), per this codebase's higher-stakes-work review convention** — dispatched a second, review-only DeepSeek pass (preserving the original audit at `scratch/deepseek_response_original_audit.md` first, since a second invocation overwrites `scratch/deepseek_response.md`) asking it to check its OWN original finding #0 table against the actual fix, not just re-trust the commit message. **Result: all 14 originally-broken sites confirmed FIXED**, a fresh repo-wide grep for any remaining `getCached(...) !== undefined` came back clean, the `getGlobalCalib` helper's own null-check logic was confirmed correct, every rewritten `fetchFn` closure was confirmed to reproduce its original query/parse byte-for-byte, and — the specific thing Claude asked it to double-check — no OTHER stray leftover-IIFE `})();` was found beyond the 2 Claude had already caught and fixed. Claude independently re-verified the two most consequential claims itself (a fresh grep, and reading the `Promise.all`-crossing site's two check-points directly) rather than trusting the review's own "FIXED" labels at face value, per the standing "audit all DeepSeek output" rule.
  - **The review caught one real thing Claude had gotten wrong: an inaccurate doc comment (not a code bug).** Claude's own comment on the `dailyAdxByDate` cache-peek fix claimed the old broken code "already fell back to `{}` either way" — false; the old `cached !== undefined ? cached : {}` ternary always took the first branch (same bug), returning `null` (not `{}`) on every miss. It was harmless only because a SECOND instance of the same bug (`pitchCatchCalib` also always null) caused an earlier `return 0` that prevented line ~2274's `dailyAdxByDate[row.trade_date]` from ever being reached — two independent bugs canceling out, not a `{}` fallback. Confirmed directly (read the actual old ternary logic and the guard clause) before correcting the comment. This is the second time this exact "two bugs happened to cancel out, don't credit either one with being independently harmless" shape has shown up in this same bug hunt (the original audit found the identical pattern between `cached2DPOC` and `poc2Q`) — worth remembering as a recurring shape when auditing any code found via this bug class.
  - **This thread is now genuinely closed** — both the original bug and its independent-review verification are done, verified, and committed (commits `ed00c5c` + the comment-accuracy follow-up). Only the deferred cleanup items and the optional Gemini dollar-cost analysis above remain open.


- **2026-09-05, same day: 2 more items from the deferred-cleanup list knocked out, plus a genuinely new standing rule + hook mechanism (user directive: "prevent files from getting this large again").**
  - **Deduplicated `rollingStats`/`getTrailingORWidths`** (independently, identically hand-copied in both `acd.js` and `morningBrief.js`) into `server/services/queries.js`, the file's existing shared-query-helpers home (already housed 3 other extractions moved out of these same two files). Verified `rollingStats` byte-for-byte identical via `diff` first — the original audit had flagged a possible std-denominator difference as a caveat to check, and there wasn't one. `getTrailingORWidths` had one real difference (morningBrief.js's copy cached, acd.js's didn't); kept the caching version as canonical, matching this file's own established convention. Verified via `node --check`/lint/module-load smoke test/`test_invariants.mjs` (unchanged, 19/88)/server restart/live endpoint curl.
  - **New CLAUDE.md convention: "Default new `acd.js` logic to `server/services/`, not inline."** Root cause of the re-growth: `acd.js` went from ~13,990 to ~14,030+ lines across one session's worth of individually-small, individually-reasonable edits (a new calibration reader, a shadow-tagger, explanatory comments) — no single edit was ever big enough to trip the existing monolith-file nudge, which only checked growth *since the last commit*, and this codebase's own commit discipline keeps every commit well under the cohort median. New rule: default any self-contained new logic (a calibration reader, a SHADOW-only tagger, a lifecycle pass, a session-specific detector) to `server/services/*.js` from the start, matching the existing `stepTrailWalker.js`/`pitchCatchWalker.js`/etc. precedent — only write directly into `acd.js` when genuinely coupled to its own block-scoped `liveStats`/`allRthBarsRow.rows` state, or when it's the `router.get/post` handler itself.
  - **Fixed the actual mechanism, not just the policy**: `.claude/hooks/post-edit-filesize.sh` now also tracks *cumulative* growth per chronically-oversized file via a small persisted JSON map (`.claude/hooks/.filesize_baselines.json`, gitignored, resets after each nudge) — fires if accumulated growth since the file was last flagged crosses 150 lines, even when no single edit was large enough to trip the original per-edit check. Verified end-to-end with a dry run: seeds a baseline on first sight (no spurious fire), stays quiet on no/small growth, fires and resets correctly once simulated cumulative growth crossed the threshold, and correctly never touches the baseline file at all for a normal, non-outlier file.
  - **Not done**: the actual retroactive shrink of `acd.js`'s existing size (the 5 extraction candidates from the original audit) — this rule+hook change is specifically about not adding to the problem going forward, not the separate, deliberately-paced cleanup tracked under `OPEN_DECISION acdjs_deferred_cleanup_from_deepseek_audit_20260905`.


- **2026-09-05, same day: the retroactive shrink itself — 3 of the 5 extraction candidates done, `acd.js` 13,995 → 12,418 lines (~11% reduction).** Dispatched DeepSeek a third time for a fresh re-audit (confirmed all prior fixes/cleanup still clean against the current file, not stale line numbers) plus implementation-ready extraction plans — exact line ranges, every external dependency, a risk-ordered sequence, explicit circular-import analysis. Claude independently re-verified every plan claim (fresh greps against the current file, not trusted from the plan) before touching anything.
  - **Phase 0 — `server/services/acdShared.js`** (foundation, required first): moved `getCached`/`setCached`/`getGlobalCalib`/`getTouchQualityCalib`/`getTouchQualityBaseline`/`dropToTimeline` out of `acd.js`. Necessary because every remaining candidate references these — extracting any of them directly would have created a true circular import (new service imports from `acd.js` while `acd.js` imports the new service). `acdShared.js` imports only leaf modules (`db.js`, `touchQuality.js`, `setupTypes.js`), so nothing importing from it can cycle back. `acd.js` re-exports `dropToTimeline` so its 5 existing external consumers (`rthFlushDetector.js`, `pocRotationJoinDetector.js`, `globexFlushDetector.js`, `ibLowPnrDetector.js`, `minuteBarSignalDetector.js`) keep working — verified all 5 still load.
  - **Candidate D — `server/services/setupExpiry.js`** (`expireStaleSetups`+`structurallyInvalidateSetups`, done first per DeepSeek's risk ordering — smallest, fewest dependencies). **Caught a real bug mid-extraction**: `export { X } from 'module'` does NOT create a local binding, only re-exports for other importers — the first-pass version would have thrown a `ReferenceError` the moment `acd.js`'s own poll loop called `expireStaleSetups(io)` locally. Fixed by importing AND re-exporting, not just re-exporting; this pattern (already used correctly for `dropToTimeline` in Phase 0) was then applied consistently to every subsequent candidate.
  - **Candidate B — `server/services/shadowCompletion.js`** (`completeStepTrailShadows`+`completePitchCatchShadows`, both observation-only, zero external consumers confirmed before extracting). One intentional comment-wording fix during the move (a stale absolute line-number reference in a comment, corrected to describe the code structurally instead — same "line 2274" class of thing this file has been burned by before).
  - **Candidate A — `server/services/resolveSetups.js`** (`resolveSetupsByPrice`, 1003 lines, done ALONE as its own dedicated pass per DeepSeek's explicit recommendation — the single biggest function in the file, the real resolution/pnl write path, and the epicenter of the earlier `getCached` bug fix). Independently cross-checked DeepSeek's full 13-import dependency list against a fresh grep of the actual function body (all confirmed, zero missing, zero extras) plus checked ~25 other module-level identifiers NOT on the list to rule out a silent miss. Given the stakes, verified beyond the usual gate: directly invoked `resolveSetupsByPrice(null)` against the live database as a decisive end-to-end check rather than inferring correctness from logs — it processed 5 real ACTIVE/SHADOW rows, ran the full bar6/delta-confirmation/touch-quality pipeline, and visibly executed live queries for `WIDER_TARGET_PRESSURE_GATE`/`STEP_TRAIL_FRACTION`/`PITCH_CATCH_FILTER` (direct proof the earlier `getCached` bug fix and this extraction are both working correctly together — these reads used to be permanently stuck returning null), completing with zero errors.
  - **Verification, every step**: byte-for-byte `diff` against the original before deleting it (not just "looks right"), `node --check` + lint clean, a module-load smoke test confirming every export resolves, `test_invariants.mjs` unchanged at baseline (19/88) after each of the 4 commits, server restarted with multiple full poll cycles elapsed and zero new entries in `scratch/server_errors.jsonl` each time.
  - **Candidate C (`detectGlobexSetup`, ~594 lines) remains correctly DEFERRED** — DeepSeek's own re-verified verdict: it depends on ~20 acd.js-internal helpers (gate/regime/fireTag logic) that the RTH main path ALSO uses, making this a large cross-cutting refactor in its own right, not a "5th item" to bundle with the others. If ever attempted: relocate the shared helpers to `acdShared.js` first, then move the function, as its own multi-session project.
  - **Candidate E (`checkFadeAgainstBigMoveExit`) correctly left as-is** — already a 2-line disabled stub with an external caller (`antigravityEdges.js`); extraction would touch another file for a 2-line savings and zero behavior gain.
  - **`OPEN_DECISION acdjs_deferred_cleanup_from_deepseek_audit_20260905` updated, not resolved** — Candidate C is the one substantive remaining item (its own future multi-session project), Candidate E stays declined.


- **2026-09-06: 2 more real acd.js-shrink extractions, prompted by the user asking for an opinion on further breakdown.** Measured the actual remaining structure first (not guessed): `runSetupDetection` (the core level-fade engine, defined as `const runSetupDetection = async (req, res) => {...}` inside `createACDRouter`, not a top-level function — invisible to a naive function-list grep) is **5,548 lines, 45% of the entire file by itself**, and is the real reason `detectGlobexSetup` (Candidate C) can't be cleanly separated — both share ~20 helpers. Gave the user this number plus an honest opinion: don't try to "move" `runSetupDetection` the way the 4 prior extractions worked (each was a clean, one-directional unit); it's built entirely on closure captures over `liveStats`/`allRthBarsRow.rows`, so a mechanical move would relocate the coupling, not fix it. The right next step, if ever pursued, is internal decomposition (named sub-functions with explicit params) BEFORE extraction — a genuine multi-session refactor, not proposed as quick work. Offered 3 smaller, still-easy candidates instead; user asked for the first 2:
  - **`server/services/fireTags.js`** — `getDayTypeAtFire`/`getVolBucketAtFire`/`minutesFromSessionOpen`/`computeFireTags`/`FIRE_TAG_COLS`/`fireTagValues`. This was DeepSeek's own flagged "right long-term fix" for a real layering smell: 5 services (`rthFlushDetector.js`/`globexFlushDetector.js`/`minuteBarSignalDetector.js`/`ibLowPnrDetector.js`/`pocRotationJoinDetector.js`) already imported these directly from `acd.js` — a route file, not a service. **Required an extra fix beyond the move itself**: `scripts/test_invariants.mjs` check `[15]` does a source-TEXT regex scan (`fs.readFileSync` + pattern match, not just an import) specifically on `acd.js` looking for `getVolBucketAtFire`'s definition, to verify its no-lookahead guard is still present — a re-export alone wouldn't satisfy this, since the regex would find nothing in `acd.js` once the real definition moved. Updated both the import and the `fs.readFileSync` path to point at the new file; re-verified check `[15]` passes correctly against the new location before trusting it.
  - **`server/services/acdLiveCalibration.js`** — the remaining day-cached calibration/measurement readers used by `runSetupDetection`/`detectGlobexSetup`: `getOrVolBaseline20d`, `getVolatilityScaledDefault`, `getValueAreaRegimeMap`/`computeRegimeStamp`/`REGIME_STAMP_COLS`/`regimeStampValues`, `getVolumeBuildingCalibration`, `computeLiveVolumeBuildingSignal`, `getPaceBaseline`. A **non-contiguous extraction** — these 9 items were interleaved in the original file with the momentum-against-fade functions (shipped earlier the same session), which correctly stayed in `acd.js`. Verified each of the 9 has zero `liveStats`/`allRthBarsRow.rows` dependency before moving — being CALLED from inside `runSetupDetection`'s closure doesn't itself create a dependency, since each takes explicit parameters (`tradeDate`, `price`, `vaMap`, `sessionBars`) rather than reading closure state directly. Only `getPaceBaseline` had a real external consumer (`scripts/pilot_stackvol_horizon_profile.mjs`), re-exported for it.
  - **Verification, both extractions**: byte-for-byte `diff` against the originals before deleting them, `node --check` + lint clean (zero `no-undef` errors — a real signal that every local call site inside `runSetupDetection`/`detectGlobexSetup` still resolves correctly through the new imports), module-load tests, `test_invariants.mjs` unchanged at baseline (19/88) after each commit, server restarted with zero new errors each time. For the calibration-readers extraction specifically, went further than the syntax/lint gate and directly invoked all 6 non-trivial functions against the live database — `getValueAreaRegimeMap` returned real VAH/VAL data, `computeRegimeStamp`/`regimeStampValues` produced correct 14-value output, `getVolumeBuildingCalibration` found a real calibration row, `getPaceBaseline` returned 1375 real baseline entries, `getVolatilityScaledDefault` computed a real stop/target — not just inferred correctness from logs.
  - **`acd.js`: 13,995 → 12,135 lines across the full session (Phase 0 + Candidates D/B/A + fireTags.js + acdLiveCalibration.js) — a ~13% total reduction.**
  - **Still open, correctly not attempted (at the time)**: `runSetupDetection`'s internal decomposition (the real remaining monolith, ~45% of the file) and Candidate C (`detectGlobexSetup`) remain a genuine future multi-session project. A third "easy" candidate mentioned but not requested: splitting some of the chunkier standalone router handlers (`/performance-audit/unified` ~899 lines, `/acd/live` ~573 lines) into their own small route files, matching the existing `dll.js`/`cooldown.js`/`profitLock.js` pattern.


- **2026-09-06: regime-filter idea (user-prompted) — both tracks tested and RESOLVED, correcting Claude's own initial framing.** User asked for a critique of some AI-generated NQ "regime filter" ideas (overnight Globex range, VXN momentum, opening-5min-volume, all with hardcoded multiplier thresholds). Claude critiqued the hardcoded-threshold problem and found 2 of 3 ideas already close to existing infra/findings (VXN: no data source exists; opening volume: `getOrVolBaseline20d()` already does this). User then asked to derive a real version via rolling percentiles + price behavior at known levels. Claude initially framed the existing, validated `volatilityRegimeService.js` classifier (CHOP/DIRECTIONAL split, +$6.75 vs -$17.99/trade aggregate, 358 real days) as an "underused asset" since it's only wired into one narrow gate (killing `C_STANDALONE` in CHOP) — **this framing turned out to be wrong once tested.**
  - **Gemini dispatch hygiene note**: both the Phase 0 design-critique response and the Phase 1 mine-and-run response arrived with corrupted/truncated files (started mid-sentence, missing the opening section) — a new, recurring failure mode distinct from the already-documented timeout-partial-output one. Both times the surviving content was still real (not fabricated), but Claude independently re-ran every SQL claim and every saved script directly rather than trusting the writeup, per the standing "audit all Gemini output" rule — this caught one materially wrong number (see below) that the writeup itself didn't flag as uncertain.
  - **Feasibility-check correction**: Gemini's first pass claimed "822 overnight sessions from 2022-12-14" — wrong. `price_bars_primary` has a pre-intraday placeholder era (1 row/day, no real minute bars) from 2022-12-14 through 2023-11-15; the query didn't join against real RTH-day presence and silently counted ~370 fake sessions from that era. Corrected, independently verified: **453 real overnight sessions, 2023-11-16 to 2026-09-04, 415 with dense (>800 bar) coverage** — this lines up almost exactly with `level_prices`' own start date (2023-11-13), not a coincidence. Confirmed accurate on the same pass: zero VIX/VXN data anywhere in the schema; `level_prices` has exactly 30,576 rows / 482 distinct days / 2023-11-13 to 2026-09-04.
  - **Track A (widen the existing validated classifier's live scope) — TESTED NEGATIVE, corrects Claude's own "underused" framing.** A per-setup-type replication check (real `ACTIVE`/`SHADOW` `active_setups` joined to `VOL_REGIME_HIST` by date, `computeReplication()` from `rigorDiagnostics.js`) found the aggregate CHOP>DIRECTIONAL split is driven almost entirely by `IB_BEARISH` (pooled N=45, EV diff +7.74 — but CHOP -7.60/tr and DIRECTIONAL -15.34/tr are BOTH negative; `IB_BEARISH` is itself a manually-suppressed, dead setup per the 2026-08-31 "dump them both" audit). The held-out pool of the other 30 real-N setup types (N=71) shows the OPPOSITE sign (EV diff -21.24/tr, only 15/30 individually favorable — a coin flip). **`replicates=false`.** Independently re-run both of Gemini's saved scripts (`scratch/task1_vol_regime.mjs`) directly and reproduced identical numbers before trusting any of it. Conclusion: the classifier's current narrow single-gate scope is likely already correctly scoped, NOT an underused asset — do not widen it into the general `sizeMultiplier` IIFE or broader suppression on the strength of the aggregate number alone. Recorded: `RESEARCH_CLAIM vol_regime_chop_dir_split_does_not_generalize_20260906` (CONFIRMED).
  - **Track B (new pre-market/overnight predictive regime classifier) — TESTED NEGATIVE at the cheapest possible kill-gate.** Design: rolling 20-session tercile of overnight Globex true-range (percentile-derived, not hardcoded), tested against the raw 15-minute forward price move at each RTH day's first touch of any real `level_prices` level (signed away from the level, per the project's "measure raw forward return vs. the unconditional mean, never vs. zero" convention). Using the corrected 453-session population: 415 passed the density filter, 396 got a valid tercile label, 392 had a qualifying first-touch event. **HIGH-range days: 21.51pt mean move (N=152) — statistically indistinguishable from (slightly below) the unconditional baseline of 21.74pt (N=392).** LOW=16.09pt (N=128), NORMAL=28.51pt (N=112) — non-monotonic, no clean directional story. Independently re-ran `scratch/task2_overnight_regime.mjs` directly and reproduced identical numbers. Killed at the raw-signal stage — no trade simulation, parameter-robustness check, or placebo test needed. This is a third independent negative data point (alongside the existing wide-IB/TURBULENT finding and the overnight-CVD-extremity finding) against the general "overnight range/compression predicts next-session character" framing the original pasted content asserted. Recorded: `RESEARCH_CLAIM overnight_range_tercile_level_touch_reaction_kill_20260906` (CONFIRMED).
  - **Net effect**: both tracks of this thread are resolved negative in one session, with no live code changed and no new classifier shipped — exactly the outcome this codebase's validation discipline (learned the hard way from Regime A/B/C's own placebo/changepoint failure, `docs/REGIME_DETECTION_SPEC.md`) is supposed to produce when an idea doesn't hold up. Both scripts preserved at `scratch/task1_vol_regime.mjs`/`scratch/task2_overnight_regime.mjs` for anyone who wants to re-verify or extend later.
  - **User pushed back ("no giving up," "be open minded, don't just kill ideas without trying further angles") — correctly so.** Two negative constructions don't mean the regime-filter idea itself is dead, just that those two specific shapes didn't work. Went back to find what's ALREADY real and unwired, plus new untried angles, rather than re-running the same failed shape again.
  - **`prior_day_trend_profile_anticipates_rotation_day` — RECHECKED, and STRONGER on fresh data, but a real bug was caught in the verification script itself.** `scratch/analyze_overnight_anticipation.mjs`'s headline "I found 97 rotation days" line is a **hardcoded string literal**, not a live-recomputed value — its own deeper per-field breakdown table (computed correctly from the real query) actually sums to 104, not 97. Recomputed directly and cleanly (bypassing the buggy narrative-generation script entirely): on the current live dataset (N=436 days, up from 408), prior-day TREND → today's 500+pt rotation odds are 34/94 (36.2%) vs 70/342 (20.5%) for everything else — **chi²≈10.01, p≈0.0016, even stronger than the original 2026-08 measurement.** This is a real, standing, completely UNWIRED signal needing zero new infrastructure (`auction_reads.prior_day_profile` is already computed and stored on every day's row) — the single cheapest real win in this whole thread. Still needs a fresh day-clustering/chronological-stability check on the larger sample before being called fully clean, and a real decision on how to use it live (coaching flag vs. a fade-setup risk adjustment vs. a dashboard badge — not yet scoped). Refreshed: `RESEARCH_CLAIM prior_day_trend_profile_anticipates_rotation_day` (CONFIRMED, N=436).
  - **New candidate angle from the user, feasibility-confirmed same session: IB-boundary touch/extension-alternation as a live balance-vs-driving measure.** Idea: during the 60-min IB formation window, count "new extreme" events (a bar extending the running IB high or the running IB low) and count DIRECTION SWITCHES in that event sequence — few switches with one-directional runs = a driving/trend formation, many switches = genuine two-sided balance. Quick 10-day feasibility check (no new infrastructure needed, plain 1-min bars) confirmed real variance and a real distinction the existing wide-IB-range-only metric can't make: 2026-08-24 (range 296pt, only 1 switch — genuinely clean drive) vs. 2026-08-27 (range 199pt, 6 switches — genuine chop) vs. 2026-08-28 (range 304pt — very wide — but only 4 switches arranged as two clean directional legs, not churn). **This could refine, not just compete with, the existing wide-IB→TURBULENT finding** — that finding only measures final range width and can't distinguish "wide via two clean legs" from "wide via constant churn," which may be exactly why it predicts TURBULENT rather than TREND; switch-count could be the missing second dimension. Not yet backtested against real forward outcomes — added to the candidate queue below.
  - **Full candidate-angle queue, tiered by readiness (for pickup any future session, not just "the morning")**:
    - **Tier 0 — validated, zero new infrastructure, ready to scope for live wiring**: `prior_day_trend_profile_anticipates_rotation_day` (above — the strongest, cheapest candidate in this whole list).
    - **Tier 1 — already-validated signal, needs a proper rebuild (not a fresh idea)**: wide-IB → TURBULENT (`docs/COMPRESSION_TAIL_MFE_SPEC.md`, `OPEN_DECISION wire_intraday_ib_range_exit_signal`) — a prior Gemini attempt at this was aborted on audit (wrong $/pt constant, no `computeRigor()` call, and it measured average MFE magnitude instead of simulating an actual exit-timing P&L delta — the dtclass-gate scripts' net-P&L-delta pattern is the right template to reuse this time).
    - **Tier 2 — proven mechanism or well-reasoned new construction, needs one targeted test each**:
      - IB-boundary touch/extension-alternation count (new, above) — test directly against real forward-outcome day-type, ideally paired WITH the wide-IB range metric (2-factor: range × switch-count) rather than alone.
      - Day-Type Classifier v2 candidate (`docs/daytype_classifier_v2_candidate.md`, reclassifies at IB close using the actual break) — designed 2026-06-06, never scored against v1's weak 41%/25%-on-TREND accuracy. Purely a backtest-and-compare task, no new data needed.
      - Earlier-commit timing on the existing validated CHOP/DIRECTIONAL vol-regime classifier (`volatilityRegimeService.js`) — does a 15-30min version keep most of the accuracy the current 9:30-10:30 commit gets, making an already-proven signal usable earlier in the session (from the earlier-agreed 3-item plan).
      - GARCH-forecast-based forward vol regime (`REGIME_DETECTION_SPEC.md` §3.4) — reuses the already-validated GARCH stop-sizing machinery as a regime label instead of backward-looking realized vol; genuinely computable before the open using only the prior day's close.
    - **Tier 3 — new construction, moderate research, retry-with-different-metric per the "don't kill an idea from one construction" pushback**:
      - Retry the overnight kill-gate (`scratch/task2_overnight_regime.mjs`'s methodology) with Globex VOLUME terciles instead of range, and with range+volume combined jointly, before fully closing that door.
      - Intraday Hurst exponent/variance-ratio computed on today's bars-so-far (distinct construction from the already-failed daily-NL30-sum Regime A) for a continuously-updating live trend/mean-reversion read.
      - Volume-building-strength composite (`docs/VOLUME_BUILDING_EXPANSION_SIGNAL_SPEC.md`, already validated as non-directional) as an early-session "expect a bigger swing soon" read, computed as early in the session as its own construction allows.
    - **Tier 4 — heavier/speculative, real unsolved-problem territory, lowest priority**: formal Markov-switching/HMM regime model (`REGIME_DETECTION_SPEC.md` §3.3); CUSUM/BOCPD changepoint anticipation (§3.2) for "a shift is coming" rather than "what regime now."
    - `OPEN_DECISION regime_filter_candidate_angles_queue_20260906` tracks this whole tiered list for pickup.


- **2026-09-06, same day: Batch 1 of the candidate queue run for real (Tier 0/1/2a) — user again pushed back mid-audit ("no giving up," "how can we look at new angles") when Gemini's blanket verdicts undersold what the data actually showed.** Dispatched all 3 as real backtests against `active_setups` (`origin_status IN ('ACTIVE','SHADOW')` only). Every claim independently re-verified by re-running Gemini's own saved scripts directly — this caught real problems in 2 of the 3 tasks that Gemini's own prose summary did not disclose.
  - **Task 1 (`prior_day_trend_profile` vs real fade setups) — Gemini's "Negative" verdict was WRONG, corrected via direct re-derivation.** Two separate overstatements caught: (1) Gemini's `computeRigor()` chronological-stability check found the base rotation-day effect "unstable," but the actual per-third numbers (re-derived directly) show only the OLDEST, thinnest third (N=21 days, 1 rotation event) reversed — the two more recent thirds (2/3 of the sample) both show a consistent positive effect of similar size (+15.5%, +14.4%). Overstated as "unstable" when the accurate read is "weak/absent in the earliest, thinnest data; real and consistent since." (2) The real-fade-setup replication check was built on a genuinely broken selection rule — `selectedIds` for `computeReplication()` had no minimum-N floor, so it silently selected 2 setup types with only 5 total trades each as the "dominant driver," and Gemini's own prose then MISREPORTED which 2 types it had actually tested (claimed `CAM_R1_FADE_LONG`/`PD_IB_MID_FADE_SHORT`; the real selection, confirmed by matching the reported `n=10`, was `DAILY_OPEN_FADE_LONG_TRAIL`/`OR10_LOW_FADE_SHORT`, both N=5). Redone properly with an adequate N floor (≥10 per bucket): 2 real, adequately-sized types (`IB_LOW_FADE_SHORT` N=56, `PD_VAL_FADE_LONG` N=76) do BETTER on TREND-preceded days, while the broader real roster (19 other types, N=1027) averages WORSE (-$10.86/trade diff, only 37% favorable). **Real conclusion: prior-day-TREND is a genuine net risk signal for the broad fade roster — not a dead end, just pointing toward caution/size-down rather than the "size up for the rotation" framing originally hoped for.**
  - **Task 2 (wide-IB + LIVE-TURBULENT-reassessment exit-timing rebuild) — confirmed accurate as reported, this one held up.** Correctly reused `stepWiderTarget()` (not reimplemented), correct MNQ $2/pt, `computeRigor()` actually called. Independently re-ran the full script directly and reproduced identical numbers: N=367 valid trades (gated to real trades where the LIVE day-type engine had ALREADY reassessed TURBULENT by resolution time — this floor is itself informative, since the reassessment mechanism's own timing, not just its existence, determines how much real data qualifies), mean hold-longer delta = -$15.09/trade, `stable=true` (all 3 chronological thirds negative) but `clustered=true` (100% of the sample sits in just 5 distinct calendar dates) → `clean=false`. Real, stable-signed, genuinely confirms the underlying theory (holding longer hurts on wide-IB+TURBULENT days) but too concentrated in a handful of sessions to trust broadly yet.
  - **Task 3 (plain IB-boundary switch-count) — confirmed negative as reported**, no bugs found in this one: neither market-behavior (TREND/TURBULENT base rates) nor real fade-setup EV separated cleanly by switch-count alone.
  - **Task 3b — the user's own follow-up idea (mid-conversation), built and tested same day: add the up/down EVENT-COUNT RATIO as a second dimension alongside switch-count**, since plain switch-count treats "9 up-events, 1 down-event" (a strong lopsided push) identically to "1 up, 1 down" (a barely-formed range) — both score as "1 switch." The 2D signature (switch-count tercile × directional-ratio tercile) recovered a REAL signal switch-count alone missed: among wide-IB days, "Clean Leg" (low switch + lopsided, N=36) shows TREND=25.0%/TURBULENT=19.4%, vs "Churn/Grind" (high switch + lopsided, N=48) showing TREND=16.7%/TURBULENT=31.3% — the theorized direction, holding up on a first real test. Thin (N=36/48) and a pooled "Balanced" catch-all (N=116, mixing genuine two-sided chop with a distinct "thrust-then-reversal" shape not yet separately tested) dominates both wide-IB subpopulations — needs a larger sample, its own parameter-robustness/placebo check, and ideally splitting the Balanced bucket into its 2 conceptually distinct sub-shapes before being trusted. Against real setup performance: no clean uniform boost for the fade roster (`VALUE_FADE`, properly N-floored replication check does not generalize, 41% held-out favorable); the breakout/continuation roster (`FAILED_SWEEP_REVERSAL`, real N=110 total — genuinely new since the 2026-08-10 roadmap noted "zero real fires yet") could not be meaningfully tested at all — its relevant "Clean Leg" bucket only has 12 real trades, far below any usable floor. Recorded: `RESEARCH_CLAIM ib_switch_directional_ratio_2d_signature_20260906` (PROVISIONAL — real, thin, promising, not yet validated).
  - **Process notes, arguably as durable as any of the findings above**:
    1. The very Batch 1 dispatch that produced all this came back with `status: failed, exit code 1` from the wrapper (agy itself returned non-zero, no "Done" line ever printed) — yet the response file was complete and every claim in it checked out as real (even where the VERDICT drawn from real numbers was wrong). This is the exact mirror image of the earlier truncation incident (clean exit hiding bad content) — confirms `invoke_gemini.sh`'s exit status is uninformative in BOTH directions; the only real signal is reading the file and re-running the scripts directly, every time, regardless of what the wrapper reports. CLAUDE.md's Collaboration section and the `feedback-gemini-response-silent-truncation` memory both updated to reflect this.
    2. **A correct, well-reasoned final verdict (`computeReplication()`, `computeRigor()`, real $/pt) does not protect against a broken selection rule feeding those functions.** The tools being "real, imported, not reimplemented" is necessary but not sufficient — the INPUT selection logic needs the same scrutiny as everything else. An `aggImpact = n × diff`-style ranking (used successfully in the earlier vol-regime Track A test) is the right pattern to reuse for "find the real dominant contributor" — a raw `diff`-only ranking with no N floor will reliably cherry-pick noise.
    3. Scripts saved directly into `scripts/` this round (`task1_*`, `task2_*`, `task3_*`, `task3b_*`) don't match this project's `backtest_<hypothesis>.mjs` naming convention — left as-is for now since they're still exploratory/under-audit, not yet promoted; rename or move to `scratch/` if/when any of these get formalized into a real recurring calibration pass.
  - **Queue status update**: Tier 0 (`prior_day_trend_profile`) is DONE being tested against real setups — real signal confirmed, reframed from "size up" to "risk/caution flag," not yet scoped for live wiring (needs a decision on mechanism: coaching flag vs. sizeMultiplier down-adjustment vs. dashboard badge). Tier 1 (wide-IB exit-timing) is DONE — real, stable, too thin (5 dates) to wire yet, self-recalibrates as more TURBULENT-reassessed wide-IB days accumulate, `OPEN_DECISION wire_intraday_ib_range_exit_signal` RESOLVED on this basis. Tier 2a (IB switch+directional-ratio) is DONE for its first pass — promising, needs a larger sample and its own validation discipline before anything further. Tiers 2b-4 (Day-Type v2 vs v1, earlier-commit vol-regime timing, GARCH forward regime, overnight-volume retry, intraday Hurst) — the first 3 done in Batch 2 below; overnight-volume retry and intraday Hurst still queued.


- **2026-09-06, later same day: Batch 2 (Day-Type v2 vs v1, earlier-commit vol-regime timing, GARCH forward regime) — dispatched with the specific lessons from Batch 1 baked into the request (N-floor on any "dominant contributor" selection, report actual selected IDs, full per-third numbers not just a stability boolean). Response file arrived corrupted a 4th time this session** (Task 1's entire detailed section was missing — an abrupt jump from the executive summary straight into Task 2's write-up) — same recurring `agy --print` truncation pattern, now confirmed frequent enough to plan around, not a fluke. Filled the gap by reading and independently re-running every saved script directly rather than treating any prose claim as given.
  - **Task 1 (Day-Type Classifier v2 vs v1) — real numbers recovered by direct re-run (the writeup's one-line summary was accurate, but all supporting detail was lost to corruption).** First verified the implementation actually matches the real spec (`docs/daytype_classifier_v2_candidate.md`) before trusting it — the decision tree (TREND above/below IB, drive-reversal TURBULENT, wide-IB TURBULENT, else BALANCE) is faithful. Real ground truth `acd_daily_log.day_type`, N=421: **v1 standard = 45.1% overall (TREND recall only 9.6%, matching the doc's own claimed weakness); v2 candidate = 34.9% overall — WORSE than v1, not better.** V2 does raise TREND recall (14.9%) and TURBULENT recall (75.4% vs v1's 41.5%), but only by massively over-calling TURBULENT (260/421 days, 62% of the whole sample) while crashing BALANCE recall (32.1% vs 58.8%). A third variant (v1's logic with IB width substituted for OR width, isolating "more data" from "better logic") craters to 27.1%, predicting TURBULENT on 81% of all days — confirms this substitution breaks the logic rather than validly isolating a timing effect. **Verdict: v2 as spec'd should NOT be deployed.** Recorded: `RESEARCH_CLAIM daytype_v2_candidate_scored_negative_20260906` (CONFIRMED).
  - **Task 2 (earlier-commit timing on the validated vol-regime classifier) — confirmed real, but a genuine unit-conversion bug was caught and the true finding is stronger than reported.** Agreement rates independently reproduced exactly (15-min=46.8%, 30-min=65.4%, N=361). The writeup's headline EV numbers ("$-24.33 vs $+27.14") turned out to be raw POINTS mislabeled with a dollar sign — half the real MNQ $2/pt dollar value (confirmed by direct re-computation: the 60-min ground truth is actually **-$48.66/trade DIRECTIONAL vs +$51.25/trade CHOP**, N=29/27). More importantly, re-deriving the 15-min/30-min downstream EV directly (the saved script's `computeReplicationReal()` never actually printed these, so the writeup's specific figures couldn't be traced to anything the saved script computes — a process gap, not evidence of fabrication given the 60-min numbers matched point-for-point once unit-converted) found the effect isn't just weakened by early commit, **it reverses sign**: at 30-min, HIGH-VOL-CHOP flips from +$51.25 to -$15.68/trade (N=210), and no HIGH-VOL-DIRECTIONAL bucket even forms; at 15-min, HIGH-VOL-DIRECTIONAL flips from -$48.66 to +$13.46/trade (N=101). **Verdict: committing this classifier earlier is actively dangerous, not just less accurate — do not build an early-commit variant for live use.** Recorded: `RESEARCH_CLAIM vol_regime_early_commit_reverses_not_just_weakens_20260906` (CONFIRMED).
  - **Task 3 (GARCH-forecast forward vol regime) — genuinely blocked on data coverage, spot-checked and plausible.** `GARCH_VOL_SCALE` in `performance_audit` is a single backtest snapshot (`run_date=2026-07-18`, not an ongoing daily series) with real, meaningful disagreement from the realized-vol classifier (35% agreement — a real, different signal, not redundant) — but real `active_setups` history barely overlaps its forecast window, leaving too few real trades to test downstream EV. Not resolved either way; would need either the GARCH forecast re-run on recent dates or backfilled trade history to actually test. Left queued, not a verdict.
  - **Process note, now a load-bearing one**: this is the 4th corrupted/truncated `agy --print` response this session (2 in the original design-critique thread, this being the first in the actual mine-and-run thread). Given the frequency, default to expecting partial corruption on any longer, multi-task Gemini dispatch and budget time to independently re-derive whatever the corruption drops — this happened again on the SAME dispatch that also contained a real, confirmed unit-conversion bug (points reported as dollars) in a task that wasn't even the corrupted section, reinforcing that content corruption and script-logic bugs are two fully independent risks that both need checking every time, not either/or.
  - **Queue status, fully updated**: Tiers 0, 1, 2a, 2b (Day-Type v2, earlier-commit timing, this batch) are all DONE with real, audited verdicts. GARCH forward regime is blocked on data, not resolved. Remaining, not started: overnight-volume-instead-of-range retry, intraday Hurst/variance-ratio.


- **2026-09-06, later same day: Batch 3 (overnight-volume retry, intraday Hurst) — user explicitly instructed not to drop an angle after one flat construction ("don't be myopic"); baked that into the dispatch itself.** Response arrived with `status: failed` from the wrapper again (uninformative either direction, per the now-standing lesson) AND corrupted/truncated a 5th time this session (opened with a stray `Error: timeout waiting for response` line then jumped mid-word into the real content) — none of that stopped the actual findings from being real once independently checked.
  - **Task 1 (overnight volume, then joint range+volume) — did exactly what was asked: didn't stop at the first flat result.** Volume alone: flat (LOW=24.60pts/N=153, HIGH=20.21pts/N=143, baseline=21.74pts/N=392 — thin ~4.4pt spread). Instead of stopping there, tried the joint "high conviction" angle (high range AND high volume together): a real, independently-reproduced, modest dampening effect — `HIGH_CONVICTION` sessions (N=102) show 17.34pts vs the 21.74pt baseline (N=392) and 23.45pts for the non-conviction group (N=204). Not a clean kill, a real partial effect — an already-loud overnight session saps some of the next morning's first-touch continuation. Recorded: `RESEARCH_CLAIM overnight_volume_and_joint_conviction_dampening_20260906` (PROVISIONAL).
  - **Task 2 (intraday Hurst exponent, standalone then combined with the IB signature) — real standalone effect; the combined finding is real numbers but a serious overclaim that needed correcting.** Standalone (log-variance-ratio regression on trailing 60min bars at 10:30, independently reproduced exactly): PERSISTENT Hurst tercile shows -$12.52 fade EV (N=1348) vs MEAN_REV +$2.36 (N=1246) — real, moderate, directionally sensible (persistent/trending micro-structure hurts fade setups). **Combined with the already-real IB switch+directional-ratio signature**, the response reported a dramatic day-type swing — MEAN_REV+CleanLeg 53.8% TREND (N=13) vs PERSISTENT+CleanLeg 9.1% TREND (N=11) — calling it "definitively proves" distinct micro/macro physics. Independently reconstructed this exact table from scratch (it wasn't even in the saved script — the THIRD time this session the single most dramatic claim in a writeup wasn't traceable to anything actually saved) and reproduced the numbers exactly, so they're real, not fabricated. **But the "definitively proves" framing is not earned**: both N=13 and N=11 are far below this project's own N≥20 floor, and this specific pair was the most extreme contrast pulled from an unstated 9-cell grid (3 Hurst terciles × 3 IB-shapes) with zero correction for that multiple-comparisons exposure and no stability/placebo check. Corrected and recorded honestly: `RESEARCH_CLAIM intraday_hurst_10_30_standalone_and_ib_combo_20260906` (PROVISIONAL) — the standalone Hurst effect is a real lead, the combined-with-IB-signature number is a hypothesis-generating curiosity only, explicitly flagged not to be cited or wired as if established.
  - **Process notes**: (1) 5th corrupted response this session, now unambiguously the expected norm for any longer Gemini dispatch, not an edge case. (2) A THIRD instance of "the most decisive claim in the prose isn't actually computed by the saved script" — this needs to become a standing check: before trusting ANY headline number, confirm it's traceable to a `console.log` line that actually exists in the file that got saved, not just plausible-sounding prose. (3) The user's "don't be myopic" instruction produced a genuine positive result (Task 1's joint-conviction finding would have been missed if Volume-alone's flat result had ended the inquiry) — worth keeping as standing practice for future dispatches, not just this one.
  - **Queue status: ALL 5 original tiers (0, 1, 2a, 2b, 3) are now done with audited verdicts.** No untested items remain in the original candidate queue. `OPEN_DECISION regime_filter_candidate_angles_queue_20260906` updated to reflect full completion — next real work is deciding what (if anything) among the CONFIRMED findings gets scoped for actual live wiring, not more testing.


- **2026-09-06, later same day: user's own new idea — does the prior day's (or prior few days') value area overlap predict continued balance vs. a breakout?** This turned out to already exist: `va_overlap_streak` (consecutive prior sessions whose value areas overlap, no lookahead) was backfilled onto real `active_setups` trades back in `docs/COMPRESSION_TAIL_MFE_SPEC.md`'s work — but that trade-gated population (only 186 real CONTINUATION trades) was too thin to resolve the one hypothesis-consistent cell it found (+3.3pp, not significant). Rather than rebuild, retested the underlying market-behavior question directly against all 453 real NQ RTH trading days (no setup-gating), per this project's own "market behavior hypotheses go through bar-history first" convention, reusing the exact `vaOverlap()`/`computeProfile()` logic verbatim.
  - **Real, clean, monotonic result on the first correctly-bucketed attempt.** (One bucketing bug caught and fixed immediately: a rolling-percentile tercile degenerately collapsed — `va_overlap_streak` is heavily zero-inflated, 52% of days at streak=0 — switched to raw-count bins NONE=0/SHORT=1-2/LONG=3+ instead.) Real day-type (ground truth `acd_daily_log.day_type`): TREND rate rises 22.1% → 22.6% → 33.3% across NONE/SHORT/LONG buckets (N=231/177/36); BALANCE rate falls the same direction (61.9% → 58.2% → 50.0%). **Independently confirmed by a second, unrelated measure**: raw next-session RTH range also rises monotonically in the same direction (301.76 → 329.16 → 355.57 pts).
  - **Given how many "looks great at N=13-36" results needed correcting this session, ran the same stability check before trusting this one — it held up.** The LONG bucket (N=36, streak≥3) clears this project's N≥20 floor, spans **16 distinct months** from 2023-11 to 2026-06 with no single month dominating (max 7/36 = 19.4%), and is chronologically stable: a 3-way split shows **TREND=33.3% in all three thirds, exactly** (N=12 each). This is a materially cleaner result than the Batch-3 Hurst+IB combo finding — real distribution, real stability, not a cherry-picked cell from a multiple-comparisons grid.
  - **Interesting tension worth noting, not resolving**: this finding's "coiled spring — extended balance eventually resolves into a breakout" shape is the OPPOSITE mechanism from this project's own volume-building-strength research (`docs/VOLUME_BUILDING_EXPANSION_SIGNAL_SPEC.md`), which found "momentum feeds momentum" beats "coiled spring" for a different, shorter-horizon signal. Not a contradiction — different horizons (multi-session value-area structure vs. intraday volume momentum) can genuinely have different mechanisms — but worth keeping in mind if either gets extended further.
  - Recorded: `RESEARCH_CLAIM va_overlap_streak_predicts_breakout_bar_level_20260906` (CONFIRMED). `docs/COMPRESSION_TAIL_MFE_SPEC.md` updated with a pointer at the top so this doesn't sit only in this file.
  - **Same-day follow-up: tested against real setup EV, found a genuine structural data gap, not a negative.** Zero days with the qualifying LONG streak (3+) have occurred since real `active_setups` trade tracking began (2026-07-09) — the last qualifying day was 2026-06-29, 11 days before the real-trade window starts, and the current live window (42 trading days) tops out at streak=2. So the real test (does a LONG streak actually favor continuation-style setups over fades) genuinely cannot be run yet — not disproven, not testable with current data. A partial NONE-vs-SHORT look (streak 0 vs 1-2, real data that does exist) is thin and mixed: `CONTINUATION_LEGACY` (-$7.65→+$2.03, N=320/440) and `GLOBEX_LEVEL` (-$21.29→+$3.81, N=178/276) both shift toward the hypothesized direction; `FAILED_SWEEP_REVERSAL` shifts the opposite way (thin, N=83/27); `VALUE_FADE` barely moves. None of this clears any real floor — suggestive at best, not a substitute for the real LONG-streak test. **Wired live, same day.** `getVaOverlapStreak(tradeDate)` added to `server/services/acdLiveCalibration.js` (day-cached via `getCached`/`setCached`/`DAY_CACHE_TTL`, reusing `computeProfile()` — no lookahead, entirely prior-day). Independently verified against the already-confirmed offline computation (exact match on 3 spot-check dates) before wiring. Threaded into all 7 real `active_setups` INSERT sites in the file (5 ACTIVE-capable + 2 always-SHADOW-but-already-regime-stamped audit sites), correctly skipping only the minimal `CLUSTER_SIBLING_TOUCH_CREDIT` insert (consistent with it already lacking regime-stamp columns). Verification: `node --check` + ESLint clean, module-load test, server restart with zero new errors, and — since a param-count bug here would fail silently (swallowed by an existing `.catch()`, not a crash) — a full dry-run of all 6 modified `INSERT` statements in a rolled-back transaction confirmed every site's parameter count exactly matches its SQL placeholder count (caught and fixed 3 off-by-one bugs in the *verification harness itself* along the way, not the real code — a reminder that a test script's own arithmetic needs the same scrutiny as the code it checks). `test_invariants.mjs` unchanged at baseline (19 failures). Still purely informational — nothing reads this column to gate or size anything yet, per the recorded claim's own explicit caution. `RESEARCH_CLAIM` updated in place with this finding.


- **2026-09-06, later same day: the user asked directly for real protection, not more research** ("I want to control and prevent several negative trades. I don't feel like I have that") — shipped the first LIVE, sizing-affecting wiring from this whole regime-filter thread: a prior-day-TREND risk gate in `sizeMultiplier`.
  - **DeepSeek design critique (dispatched before any code, per this project's higher-stakes-work rule) changed the plan for the better.** The original plan was to mirror the existing `DAY_TYPE_ALPHA` mechanism exactly (per-`(setup_type, prior_day_profile)` cells, z-score classification, `performance_audit` round-trip). DeepSeek found this would mostly fail: the confirmed finding is a POOLED effect (19 setup_types, N=1027) — decomposed into per-cell buckets at this project's own N≥20 floor, the cells go too thin (~9 trades/cell average) and almost everything classifies NEUTRAL, silently failing to act on a real, already-confirmed finding. DeepSeek also found `DAY_TYPE_ALPHA` itself has **never once fired live** — `dtClass` is null all through RTH (a separate, already-documented bug, `dtclass_null_all_day_neuters_multiple_live_gates`) — so "mirror the proven live system" was based on a false premise. Recommendation: a direct, pooled gate mirroring the codebase's OWN existing `dtClass === 'TREND'` pattern (`acd.js` ~7445) instead of a new per-cell mechanism.
  - **Built the pooled gate**: `if (priorDayProfile === 'TREND') mult = Math.max(mult - 0.25, 0.25);` — same magnitude as the existing `dtClass`/`sessionConflictFor` factors, applied within the same `sizeMultiplier` IIFE. `priorDayProfile` read via a new `getPriorDayProfile(tradeDate)` day-cached helper (`acdLiveCalibration.js`, mirrors `getVaOverlapStreak`'s pattern), fetched once right after `buildAllCandidates()` and reused as a closure variable (the field was ALSO separately re-fetched much later in the file for an unrelated coaching-text feature — consolidated into one fetch, removed the duplicate).
  - **Deliberately NOT placed alongside `dtClass`'s existing gate.** DeepSeek's review found something worth knowing regardless of this specific change: `dtaRow`'s SUPPRESS (`mult=0.25`) and the mid-stack additive factors are NOT actually terminal — later boosts (OR expansion, regime persistence, delta-high, touch-quality, worth up to +0.50 combined) can silently erode a mid-stack reduction back up to ~0.70. Placed the new gate immediately BEFORE the loss-streak cap instead (after every remaining additive boost) specifically so a real reduction actually sticks — a deliberate deviation from the `dtaRow` precedent, documented in the code comment, not a blind mirror.
  - **Real bugs from the original per-cell plan, caught before any of them shipped**: `prior_day_profile` is not a clean 3-value enum like `day_type` (real values: TREND/NONTREND/NORMAL/NORMAL_VARIATION/NEUTRAL/NULL) — a naive suffix-match copy of `_dta`'s parsing would have silently mismatched `NORMAL` against `NORMAL_VARIATION`. A naming slip in the original plan text itself (`PD_VAL_FADE_LONG` vs `PD_VAL_FADE_SHORT` for one of the 2 real SIZE_UP-exception types) was also caught — would have tagged the wrong, opposite-direction setup type had the per-cell version been built as originally planned. Neither matters for the pooled gate actually shipped (it doesn't touch per-type logic at all), but both are recorded so a future per-cell supplement doesn't repeat them.
  - **Silent-inertness risk, made visible rather than fixed away.** `prior_day_profile` is a human-entered pre-market ACD read with no cron guarantee — if not yet entered for the day, the gate silently no-ops, the same disease as the `dtClass` bug DeepSeek found. Added a once-per-day `console.error` warning (`_pdpMissingLogged` dedup, mirrors the existing `_dtaGateLogged` pattern) so a missing read is visible rather than silently doing nothing. **Confirmed firing correctly**: today (2026-09-06) genuinely has no pre-market read entered yet (verified directly against the raw DB row — no `auction_reads` row exists for today at all), so the gate is correctly inert right now, not broken.
  - **Verification**: `node --check` + ESLint clean on both files, module-load test, `getPriorDayProfile()` independently verified against raw DB values on 2 dates (exact match), server restart, `test_invariants.mjs` unchanged at baseline (19 failures). **One honest gap**: this specific code path lives inside the RTH-only candidate-building function (`buildAllCandidates`), and the restart/verification happened at 22:37 ET — deep into Globex hours, confirmed via the live endpoint response (`sessionClosed`/`globexMode`, not the RTH shape) — so a full live end-to-end firing (including the warning log itself) could not be observed this session. Static/functional verification is thorough; live RTH confirmation is still pending the next real trading session. Flag this for a quick check tomorrow during RTH.
  - Also incidentally found while reading this code region, not yet fixed: `acd.js` ~8498-8503 hand-types a "61% WR (N=23)" claim directly into a coaching-text generator for `prior_day_profile === 'NONTREND'` — a direct "never hand-type a WR%/N literal" violation. Separate, smaller follow-up.


- **2026-09-06, same day: `runSetupDetection`'s internal decomposition — Pass 1 started and completed (P1 + a revised P2), per user approval ("Lets do it. Deepseek can review everything after").** DeepSeek produced a full structural map + phased decomposition plan (P1 fetch/derive → P2 candidate builders → P3 factor pre-fetch → P4 level-fade/sizing → P5-P10 assembly/persist). Every phase boundary was independently re-verified against the live file before implementing, not trusted from the plan — this caught real gaps in DeepSeek's own summary twice.
  - **P1 — `fetchDetectionInputs(todayET)` + `extractSessionState(inputs)` — DONE, committed `9cb7bc2`.** Two purely one-directional "fetch, then derive" functions replacing ~26 values' worth of inline queries/derivation at the top of `runSetupDetection`. DeepSeek's own plan sketch had compressed/omitted 3 real cached blocks (prior-day VA, floor pivots, PD-2 VA) — found by direct code reading, fixed before shipping, then independently re-confirmed complete by a DeepSeek review pass dispatched afterward (see below). Also promoted `getHistory` to a `makeGetHistory(nl30, openingCall)` factory and hoisted `t1Guard`/`t1GuardLabeled` (already pure) to module level. Verified: byte-diffed against the original, zero lint errors, live `curl localhost:3002/api/acd/setup-detection` returned a real fully-computed response.
  - **DeepSeek review of P1 (dispatched as a code-review-only pass, no DB/file access) — CONFIRMED CORRECT, no live bugs.** Checked completeness of the 6 cached blocks (all present, one-to-one against the old deletion), confirmed zero downstream raw references to the 6 non-destructured rows (`acdRow`/`arRow`/`volumeCtxRow`/`timelineRow`/`sessionHiLoRow`/`first15Row` — all only used inside the two new functions), confirmed `getHistory`/`t1Guard`/`t1GuardLabeled` are byte-identical to the deleted closures with no stale shadowing at any call site. One noted-but-harmless overstatement in the commit message (`ibBarsRow`'s "real downstream references" claim was slightly stronger than the actual comment-only mentions) — not a bug, just an imprecise commit message.
  - **P2 — re-planned mid-stream after DeepSeek's own re-examination of its "~19 tiny pure functions" plan found it didn't hold.** Given the same dispatch (P1 review + "flag anything relevant to P2"), DeepSeek independently confirmed the entanglement Claude had already spotted while reading ahead: `dtClass`/`sessionBiasMatch`/`sessionConflictFor` sit mid-list (not before/after the builders) and thread into P4 (level-fade IIFE) and P6 (assembly) 8+ call sites downstream; `ibSetup` gets a genuine post-hoc mutation (~650 lines after its own construction, gated on `dtClass` computed in between) rather than a clean build-and-return; `absorptionSetup`/`rsiDivSetup`/`coilSurgeSetup` hand-roll real inline work (2-min re-bucketing, RSI(14) loops), not simple condition-check-and-build. DeepSeek's honest revised recommendation: go coarser, not finer — one phase-wrapper function, not 19, preserving the mid-list ordering and the `ibSetup` two-step exactly as-is.
  - **Shipped `buildAllCandidates(ctx)` as that single wrapper, committed `8b622c5`.** ~1255 lines of the original candidate-building body (SETUP 0a-10, `dtClass`/`sessionBiasMatch`/`sessionConflictFor`, the `ibSetup` DTA gate, `absorptionSetup`/`coilSurgeSetup`/`rsiDivSetup`, `morningRegime`) moved verbatim into one function taking an explicit `ctx` bundle and returning every candidate plus the cross-phase values P4/P6 still need. Zero internal logic touched — explicit params in, explicit return out, exact original ordering preserved (the whole point, per DeepSeek's own "still hard" spots list: the mid-list `dtClass` block must stay mid-list, the `ibSetup` build/gate split must stay split with builders in between).
  - **Two real mechanical mistakes made and caught during this pass**: (1) `cat >>` appends to end-of-file, not at an edit point — the first insertion attempt appended the 1255-line body after the wrong location entirely, nesting the rest of the file inside an unclosed function; caught immediately via eslint's parse error, fixed by restoring from a pre-edit backup and redoing the insertion with precise line-indexed Python slicing instead of Edit+cat. (2) `npm run lint`'s `no-undef` rule caught a real gap in the manually-assembled `ctx` inventory — `etMin` (computed even earlier than P1, needed by 2 of the candidate gates) had been missed by direct reading; fixed by adding it to both the function's destructuring and the call site's ctx object.
  - **Verification**: byte-diffed the moved 1255-line body against the original (only a cosmetic trailing-blank-line difference), `node --check` + lint clean (zero errors after the `etMin` fix), module-load test, `test_invariants.mjs` unchanged at baseline (19 FAILUREs/88 WARNINGs), server restart with zero new `scratch/server_errors.jsonl` entries, and a live functional test via `curl localhost:3002/api/acd/setup-detection` returning a coherent full response (including real `sigmaContinuation` sigma/expectedExtraPts values). The `git diff --stat` for this commit showed an unusually large 3500/3444 insertion/deletion count for what was actually a +56 net line change — confirmed as a git diff-algorithm artifact of relocating a 1255-line block a long distance in the file, not a real content problem, since the byte-diff already proved the moved content identical.
  - **`acd.js`: 12,418 → 12,250 lines net across P1+P2** (internal reorganization, not a large line-count reduction — that wasn't P1/P2's goal; the goal was breaking closure-capture coupling before any future extraction to a separate file).
  - **Remaining, NOT started**: P3 (factor pre-fetch, ~340 lines) and P4 (the level-fade block itself — `liveStats`, the sizeMultiplier IIFE, the real `active_setups` INSERTs — the actual point of this whole effort, and explicitly the highest-stakes phase per both DeepSeek's original plan and this pass's own experience that P2 was messier than planned). P5-P10 (post-fade setups, assembly, active enrichment, backfill persist, informational signals, final persist) also untouched. Approach P4 the same way P2 required: verify DeepSeek's boundaries against the live file before implementing, expect real structure to be messier than any plan's summary, and default to a coarser/safer decomposition over a fine-grained one when cross-cutting state runs deep. Full narrative, including both mechanical mistakes and their fixes: memory `project_runsetupdetection_decomposition_in_progress.md`.
  - **DeepSeek independently reviewed commit `8b622c5` afterward — CONFIRMED CORRECT, no live bugs, plus a revised P3/P4 risk assessment.** (First dispatch attempt hit its own 600s timeout mid-answer — the partial file was already correct through 3 of 4 checks; re-dispatched at 1200s for the full answer, see the new standing note in CLAUDE.md's Collaboration section on partial-but-valid DeepSeek timeout output.) Claude independently spot-checked the highest-stakes claims directly against the file before trusting them (the `otdSetup` unconditional null, the `dtClass` read inside P3's `_lfRegimePersistQ`, the `sizeMultiplier` IIFE's "order-dependent with absolute sets" comment, both in-block INSERT line numbers) — all confirmed exactly.
    - **Check 1 (verbatim body): CONFIRMED byte-identical**, 1254 lines, zero diff. Both "still hard" spots (mid-list `dtClass`/`sessionBiasMatch`/`sessionConflictFor`, the `ibSetup` build-then-gate two-step 678 lines apart) independently re-verified still in their original order.
    - **Check 2 (`ctx` completeness): CONFIRMED, no missing dependency** — a full free-variable enumeration (not spot-checking) found all 31 `ctx` names genuinely used and zero excluded pre-block locals referenced in the body. No second `etMin`-style gap lurking.
    - **Check 3 (return completeness): CONFIRMED correct, with 7 dead-weight entries flagged** (not bugs — pre-existing dead detectors carried through faithfully): `otdSetup` (unconditionally nulled, a 2026-07-05 confirmed-negative-EV kill), `aUpStrong`/`aDownStrong`/`aUpWeak`/`gapFill`/`rsiDivSetup` (built but never wired into `candidates`/`shadowCandidates`), `sessionBiasMatch` (only consumed via the `sessionConflictFor` closure). None of these are new — the move just carried forward code that was already unreachable.
    - **P3 revised assessment — NOT the "clean, low-risk" phase the original plan implied.** Reading the actual code found it's not one `Promise.all`: only the first 7 queries are batched, then scattered conditional `await query()` calls follow, one of which (`_lfRegimePersistQ`) reads `dtClass` — a P2 output — meaning P3 is already entangled with P2, the same mid-phase-threading hazard the P2 review flagged. It also reads P1 outputs (`allRthBarsRow`, `aUpFired`/`aDownFired`) and produces ~20 factors that all feed P4's `sizeMultiplier` IIFE. Recommendation: still extractable, but as one coarse wrapper (`computeLevelFadeFactors(ctx)`), never a fine-grained split, with the same byte-diff-before-delete discipline as P2.
    - **P4 revised assessment — confirmed as the genuinely hard part, arguably harder than the original plan suggested.** New findings beyond the original plan: (a) its outputs (`levelScalpSetup`, `vwapMagnetSetup`, `stopSweepSetup`, etc.) are `let`-declared early and assigned deep inside nested loops, not returned cleanly; (b) the `sizeMultiplier` IIFE reads ~25 cross-phase factors and is explicitly commented as "order-dependent with absolute sets" — must not be split; (c) the block is NOT side-effect-free — it contains 2 real `active_setups` INSERT sites inline (the `CLUSTER_SIBLING_TOUCH_CREDIT` SHADOW insert and a second one), interleaved with cluster/confluence dedup logic; (d) control flow nests 4+ levels deep before reaching the IIFE, so the "phase boundary" is genuinely fuzzy — P4's real inputs are basically everything P1+P2+P3 produced. **Recommendation: the coarsest safe move (one `buildAllCandidates`-style wrapper for the whole block) — or, if state-threading still looks too risky on a live re-read, the defensible fallback is to NOT extract P4 this pass at all**, and instead extract only P3 plus the more clearly-separable P5-P10 assembly/persist tails, since P4 is the one phase where a boundary mistake lands directly on the live-trading write path. This is a materially more cautious recommendation than the original plan's framing — treat P4 as a decision point for a future session, not a default next step.




- **2026-09-07: intraday Hurst standalone finding — retested with a proper per-type replication check before wiring, came back negative.** Yesterday's Batch 3 finding (PERSISTENT tercile -$12.52 fade EV vs MEAN_REV +$2.36, pooled N=1246/1348) was flagged as "one check away" from being ready to queue behind the prior-day-TREND gate as a second real `sizeMultiplier` wiring candidate. Ran the same N-floored (≥10 per bucket), aggImpact-ranked replication check used for the vol-regime classifier and `prior_day_profile` earlier — **does not replicate**. 30 setup_types cleared the floor; the 6 most-penalized (`OR5_HIGH_FADE_SHORT`, `PD_CLOSE_FADE_SHORT`, `PD_OR_MID_FADE_LONG`, `RTH_VWAP_FADE_LONG`, `CAM_R2_FADE_LONG`, `ONH_FADE_LONG`, pooled N=249) drive the entire pooled effect, and the held-out pool (24 remaining types, N=1032) actually **reverses sign** (+$16.96, only 58% individually favorable — a coin flip). Unlike `prior_day_profile`, which held up under this identical test and got wired live, Hurst does not — **not wired**. Recorded: `RESEARCH_CLAIM intraday_hurst_1030_replication_check_negative_20260907` (CONFIRMED). Not a dead end for the 6 concentrated types specifically (a real, large effect there), but that would need its own dedicated, narrower validation — not assumed from this pooled test.


- **2026-09-07: the pending "confirm the TREND gate fires live" check now self-resolves — no human needs to remember it.** Built `scripts/verify_prior_day_trend_gate_live.mjs`, wired into `run_daily_calibration.sh` (already scheduled 8:20 PM ET every weekday, confirmed via `crontab -l` — no scheduling change needed). It checks daily for a real `active_setups` fire on a trade_date where `auction_reads.prior_day_profile='TREND'` since the gate shipped, no-ops quietly until that happens, then auto-calls `resolveDecision()` on `OPEN_DECISION prior_day_trend_gate_pending_rth_confirmation_20260906` itself. Deliberately scoped to confirm EXECUTION only (a real non-null input reached the code path on a real trading day) — not a re-verification of the reduction's own correctness, which DeepSeek's code review and this session's dry-run checks already covered. Tested: correctly no-ops right now (0 real fires since 2026-09-07, as expected).



- **2026-09-07, later same day: dispatched the staged v3 rolling-WR-circuit-breaker design critique (per the prior session's own "NEXT SESSION: dispatch this first" note) — decisive negative, thread closed.** DeepSeek's critique went past the two specific bugs A/B were meant to fix and found the root cause: 3 of the 6 real historical collapse types (`GLOBEX_VWAP_FADE_LONG`, `PD_POC_FADE_SHORT`, `OR5_LOW_FADE_SHORT`) had fewer than 20 resolved real trades at their own collapse onset, so a baseline-gated detector structurally cannot fire on them during the window it exists to catch; the one wave type with rich history (`IB_BEARISH`, 155 real trades) is exactly the one whose only adequately-sampled trigger fired into a genuine bounce-back (+$19.20 forward EV, within ~1 SE of zero at N=10) — consistent with this codebase's own prior finding that short-horizon WR dips have NEGATIVE autocorrelation (anti-predictive, not just noisy). Lowering the forward-N floor to 10 (as B proposed) doesn't fix this — it's noise-on-noise (SE ≈ ±$15–32 against per-type dispersion this large), and it would also make the "single positive-EV trigger kills the design" rule likely to self-destruct from chance alone if applied roster-wide.
  - **Independently re-verified against the live DB before accepting the verdict** (not trusting DeepSeek's prose numbers): total real decisive N and type count (2,653/183, matching DeepSeek's 2,574/183 closely — both correctly used the `is_cluster_primary` filter from last session's cluster-touch-credit Phase 2 ship, confirming DeepSeek used current, not stale, schema knowledge), the daily-not-weekly `SETUP_STATUS` cadence (confirmed in `run_daily_calibration.sh`), and all 6 wave-type resolved-before-collapse counts (within ±1–3 trades of DeepSeek's cited figures — the sub-20-baseline claim for 3 of 6 types holds under independent re-derivation).
  - **Recorded `RESEARCH_CLAIM wr_circuit_breaker_v3_framing_rejected_20260907` (CONFIRMED)** with the full reasoning and both sets of verified numbers. **Resolved `OPEN_DECISION roster_level_wr_circuit_breaker_scoped`** — closed as not-solvable-at-this-data-volume via a faster leading detector; the existing daily `SETUP_STATUS` gate remains the detection mechanism, no v3 build.
  - **Flagged a new, separate `OPEN_DECISION wr_lag_exposure_bound_alternative_20260907` (MEDIUM)** for DeepSeek's proposed alternative: since the ~13–14 day detection lag is a data-volume floor (not a schedule problem — `SETUP_STATUS` already runs daily), the honest fix is to bound the DAMAGE a collapsing type can do during that lag (a preventive per-type exposure/concentration cap) rather than trying to predict the collapse faster — a genuinely different mechanism with no fitting phase, no labels, no reversion-trap validation to fail. Not scoped or built — flagged for a future session, would need the same 3-phase workflow given it gates live position sizing.



- **2026-09-07, continued: runSetupDetection decomposition — P3 (factor pre-fetch) extracted, and P4's real scope confirmed much larger than the last assessment implied.** Picked this back up per the prior review's own recommendation to continue with P3 while leaving P4 as a deliberate future decision.
  - **P3 — done, committed `c138e7d`.** The ~365-line factor pre-fetch block (overnight-inventory reads, win/loss-streak + same-direction stacking counts, VWAP-sigma, turbulence confirmation, session-delta percentiles, entry-pressure calibration, pulse-score precomputation) moved verbatim into a new top-level `computeLevelFadeFactors(ctx)`, mirroring `buildAllCandidates()`'s pattern exactly. Free-variable check confirmed only 5 inputs needed from outside (`todayET`, `dtClass`, `allRthBarsRow`, `aUpFired`, `aDownFired`); return-completeness was checked by grepping all 26 candidate names against the entire rest of the file, not eyeballed — caught that `_lfOvOpen` and `_pulseVolSigma` are genuinely read downstream (would have been easy to miss as "just intermediates"), and confirmed `lfPriorStop`/`lfPriorWin` are pre-existing dead code (zero references anywhere in the file) — carried forward unchanged rather than pruned mid-move. Verified: exact byte-diff of the moved body, ESLint clean (no-undef — the same net that caught the `etMin` gap in P2), `node --check` clean, module load, server restart clean, live `GET /api/acd/setup-detection` returns 200, `test_invariants.mjs` byte-identical to baseline (19F/84W).
  - **Honest gap**: today is a market holiday (Labor Day) — the session-closed early return short-circuits before the request ever reaches `computeLevelFadeFactors()`, so live RTH execution of the new function is verified structurally/statically but not yet exercised end-to-end. Flag for a quick check during the next real RTH session (2026-09-08).
  - **P4's actual scope, mapped precisely for the first time this session — significantly bigger and messier than the 2026-09-06 review's summary suggested.** The prior assessment described "the level-fade block" as a phase alongside P5-P10; in the current file it's one continuous, unbroken region from the "Level Scalp detection" comment through the final persist step, with NO clean internal seams:
    - Level Scalp / VWAP magnet / VWAP reclaim / `liveStats` / the `sizeMultiplier` IIFE: ~1,956 lines on its own (old "Level Scalp detection" through "Stop Sweep detection").
    - Stop Sweep + Failed Sweep Reversal + priority selection + edge-based filtering + ZONE EDGE FADE + `candidates`/`shadowCandidates` array construction + the full trade-brief builder (WHY NOW/PACE/SIZE) + the first persist-to-`active_setups` step: another ~1,100+ lines after that.
    - **5 separate `INSERT INTO active_setups` sites now live inside this combined region** (not the 2 the last review counted) — the touch-credit sibling insert, the cluster-winner insert, and at least 3 more added since (prior-day-TREND-gate era, momentum-against-fade-shadow era).
    - The `sizeMultiplier` IIFE itself is still exactly where it was described: order-dependent, ~25+ factors, explicitly commented as unsafe to split.
  - **Decision: still not touching P4 this session.** If anything, this more precise map makes the prior caution more clearly correct, not less — a boundary mistake anywhere in ~3,000 lines carrying 5 live INSERT sites is a materially worse risk than what the original estimate implied. Before any future attempt, get a **fresh** DeepSeek boundary/risk assessment against the file as it now stands (the 2026-09-06 review is stale — code has moved and grown since) rather than resuming from the old line numbers or old INSERT-site count.



- **2026-09-07, continued: fresh DeepSeek P4 boundary review came back — decisive, and it closes out this decomposition effort at P3.** Dispatched against the current file (not the stale 2026-09-06 map), asking specifically whether any clean seam exists in the remaining ~3600-line region and to risk-order the now-5 `active_setups` INSERT sites.
  - **Verdict: no clean seam exists anywhere in lines 5854–9485.** Four kinds of state thread end-to-end: `liveStats` (read via a shared module-level cache, not a parameter, at 7+ downstream points including both remaining persist sites); the `sizeMultiplier` IIFE's result (carried on a mutable `levelScalpSetup`/`active` object read ~2,500 lines later at the main INSERT); the `active` object itself (mutated in place across selection → enrichment → persist with no point where it's a finished value); and 2 of the 5 real INSERT sites already sit inside what would be the "detection" half of any split, so "detection is read-only" is false regardless of where a boundary is drawn.
  - **The one theoretically possible coarse wrapper** (before the `candidates` array, ~line 8195) would need ~60 free-variable inputs and ~20 return values while relocating 2 live INSERT sites — DeepSeek's own bottom line, despite its mandate being to find any safe extraction: **the safer answer is to leave 5854–9485 alone entirely**, not even attempt the coarse wrapper.
  - **Independently spot-checked before accepting** (not just trusted): the "order-dependent, do not split" sizeMultiplier comment, the exact `willGetTouchCredit` conditional, and several specific INSERT line numbers — all confirmed accurate against the live file. Also caught a small, harmless error in Claude's own prior commit message (said P3 returns 26 names; DeepSeek correctly counted 28 — the code was always right, only the prose undercounted).
  - **Decision: the runSetupDetection decomposition effort stops at P3.** P4 stays as internally-tangled but functionally-verified-correct code. Any future work here would need a fundamentally different approach (e.g. genuinely rewriting `sizeMultiplier` as a data-driven score rather than an imperative IIFE — a much bigger, separate project) rather than a mechanical extraction. Recorded on `OPEN_DECISION acdjs_deferred_cleanup_from_deepseek_audit_20260905` (this specific sub-thread closed; the decision stays open only for whatever other deferred-cleanup items it originally tracked). Full DeepSeek response preserved at `scratch/deepseek_response_p4_boundary_review_20260907.md` (before the next dispatch overwrites the live `scratch/deepseek_response.md`).



- **2026-09-07, continued: sizeMultiplier factor-hygiene census re-run at N=88 (up from the original informal N=63 look) — confirms and extends the 2026-09-01 finding, with 4 factors now confirmed fully dead.** Direct SQL census against `active_setups.size_factors_at_detection` (real, `is_cluster_primary`-filtered fires only), cross-referenced against the actual `sizeMultiplier` IIFE conditions in the live code.
  - **4 factors confirmed fully dead (0 real firings across 88 trades)**: `confluencePairPartner` (+0.15 boost), `eliteZone` (+0.15 boost), `regimePersist` (+0.10 boost — doubly dead, also gated on the already-broken `dtClass`), `entryPressureShortBoost` (a calibrated bump — still zero true occurrences).
  - **3 more conditions dead specifically because of the already-tracked `dtclass_live_read_wiring_and_regime_scope` bug** (`dtClass` reads NULL 99% of the time): the OR-Expansion-Bias, Regime-Persistence, and TREND-day-penalty branches. This census gives that already-known bug its first precise blast-radius count *inside* `sizeMultiplier` specifically — 3 of ~26 conditions.
  - **Newly noticed**: `overnightAlignment` is `NEUTRAL` 97% of the time, so its −0.1 penalty is functionally an always-on tax rather than a discriminator; `priorDayProfile` (added 2026-09-06) is missing from the `size_factors_at_detection` snapshot object entirely — a real tooling gap that would let a future added factor go stale unnoticed the same way.
  - **Real output distribution**: 79/88 (90%) of real fires still sit at the 2 floor clamps (0.25 or 0.10) — less extreme than the original 97%-at-N=63 figure but still heavily saturated; `hasLossToday` (the post-IIFE ceiling, not part of the IIFE itself) is true on 88% of real fires, confirming it's now the dominant driver of real sizing outcomes, not an edge case.
  - Recorded `RESEARCH_CLAIM sizemultiplier_factor_hygiene_census_20260907` (CONFIRMED). Updated `OPEN_DECISION sizemultiplier_composite_redesign_scoped_pending_review` with a concrete next step: prune/fix the confirmed-dead set (needs its own DeepSeek design critique first, per the higher-stakes-work rule, since this touches live sizing code) before revisiting whether a composite-score rebuild is worth building on the surviving factors. Not yet implemented — this session did the census only, no code changed.



- **2026-09-07, continued: DeepSeek design critique of the proposed sizeMultiplier dead-factor prune caught real classification errors — 0 factors deleted, 1 safe instrumentation fix shipped.** Dispatched before touching any code, per the higher-stakes-work rule (this gates live trade sizing).
  - **The critique found my "4 fully dead" classification was internally inconsistent and wrong for 3 of 4.** `eliteZone` and `regimePersist` are themselves gated on `dtClass` (which reads NULL 99% of the time) — they're 2 more faces of the already-tracked `dtclass_live_read_wiring_and_regime_scope` bug, not independently dead. `eliteZone` also still drives 3 other live sites (the T2 runner target, `targetLabel` text, the `description` eliteNote) that deletion would have silently broken. `confluencePairPartner` is **deliberately** armed-and-waiting — the code's own comment documents that no confluence pair has cleared its distinct-day floor yet, so 0/88 is correct-by-design, not a bug; it also shares its name with an unrelated Globex-path variable, a real collision hazard for any future edit. `entryPressureShortBoost`'s 0/88 window is contaminated: `entryPressureShortCalib` was permanently null from the `getCached()` bug (~2026-08-24 to ~2026-09-05), so most of the census window measured a known-broken calibration read, not genuine inertness.
  - **Independently re-verified every load-bearing claim against the live code before accepting the correction** — all confirmed (the `eliteZone`/`regimePersist` dtClass-gating, the `confluencePairPartner` comment, the Globex name collision, the `entryPressureShortCalib` outage dates).
  - **Net action: 0 factors deleted.** Only `priorDayProfile` added to the `sizeFactorsAtDetection` snapshot (commit `1aead0c`) — pure additive instrumentation, verified byte-safe, `test_invariants.mjs` unchanged from baseline.
  - **Corrected `RESEARCH_CLAIM sizemultiplier_factor_hygiene_census_20260907`** in place (the original recording asserted the wrong classification) and updated `OPEN_DECISION sizemultiplier_composite_redesign_scoped_pending_review` with a dated re-check (~2026-09-21 to 2026-10-05, once `entryPressureShortCalib` has a real post-fix sample).
  - **Worth noting as a process point**: this is exactly why the design-critique-before-code step of the higher-stakes-work workflow exists — the original plan, if implemented directly, would have deleted 3 factors that were never actually broken.



- **2026-09-07, continued: dtClass item #7 (cross-validated day-type classifier) closed — real precision improvement found, but disqualified by day-clustering.** After DeepSeek's design-critique dispatch hung (32+ min, no progress, stopped), Claude designed the methodology directly and dispatched the actual mine-and-run to Gemini.
  - **Result: a logistic regression model beats the existing live estimator's precision on the classes that matter** — TREND 36.2% vs the real 23.3% baseline, TURBULENT 44.0% vs 17.8%, holding directionally across a 3-way walk-forward stability check. Used the full 445-day `acd_daily_log` history (not the narrower 414-row live-tracked subset, which undercounts TREND ~3.5x) — a real, useful correction found along the way.
  - **But a day-clustering check disqualifies it as usable**: 100% of correct TREND test predictions (17 of 17) come from just 4 distinct historical dates. The model is recognizing a handful of unusually clean days, not a generalizable detector.
  - **Independently verified before accepting** — not just taken on Gemini's word: read both saved scripts directly (found and resolved one apparent leakage concern — `classifyOpeningType()` receives the full day's bars instead of the as-of-checkpoint slice, but the function only ever reads the first 5 bars internally, so it's harmless), re-derived the test-set base rates via a completely separate raw DB query (exact match: 62.4%/25.6%/12.0%), confirmed all 4 cited TREND dates are genuinely TREND in the DB, and re-ran the saved training script fresh in a clean Python venv — every reported number reproduced exactly.
  - Recorded `RESEARCH_CLAIM dtclass_cross_validated_model_test_20260907` (CONFIRMED). Updated `OPEN_DECISION dtclass_live_read_wiring_and_regime_scope` — items 4 and 7 (the core "can we build a better regime classifier" question) are now closed as a genuine, informative negative. Items 1 (display-tier wiring, entangled with real sizing) and 6 (GARCH per-setup pilot, stale data) remain open.
  - **Process note**: the Gemini dispatch for this was interrupted once mid-flight for a "clear out gemini first" check — confirmed print-mode dispatches are already stateless between calls (no file deletion needed), then redispatched the identical task fresh with no loss of continuity.



- **2026-09-07, continued: user pushed back on "our current regime filter isn't good" — dug deeper into the OTHER live regime-adjacent factors (not dtClass) and found a real, live, currently-active problem.** Checked NL30 (a 30-day market-direction bucket, live in `sizeMultiplier` since 2026-07-05, never recalibrated) against current real trade data.
  - **Two of NL30's five direction/bucket branches are currently boosting size (+0.10x) into buckets that have been consistently NEGATIVE EV across their entire real trading history**, based on a one-time 2026-07-05 backtest snapshot that was never rechecked: SHORT+`STRONG_BEAR` (claimed 77.7% WR/+$68.10 EV, real: 40.9% WR/-$10.94 EV, N=413 across 8 distinct dates, negative in all 3 chronological thirds — not a single bad day) and LONG+`MILD_BULL` (claimed 77.3% WR/+$63.70 EV, real: 45.9% WR/-$15.96 EV, N=61, worsening trend across thirds). The two penalty branches also show real EV much closer to breakeven than their original claims (likely over-penalizing now). Only LONG+`STRONG_BULL` still clearly holds up on real data.
  - **A real methodological wrinkle found along the way**: NL30 is a slow-moving 30-day rolling sum, so any given bucket structurally clusters into a small number of contiguous calendar-date stretches rather than many independent days — this is NOT the classic single-lucky-day day-clustering failure mode the standard `top5DayPct` check is built to catch. Worth its own thought before building a recalibration script.
  - **This is the exact no-static-thresholds anti-pattern this codebase otherwise polices** — unlike `DAY_TYPE_ALPHA`/`OPTIMAL_STOP`, NL30's conditioning has never had a scheduled recalibration script; it's a one-time hardcoded snapshot from a single historical backtest.
  - Recorded `RESEARCH_CLAIM nl30_regime_conditioning_stale_boost_inverted_20260907` (CONFIRMED). Flagged `OPEN_DECISION nl30_regime_conditioning_needs_recalibration_20260907` as **HIGH** priority — this is real capital being sized up into a currently-losing edge, not a research-only finding. Not yet fixed — needs a design critique before touching live sizing code, per the higher-stakes-work rule.



- **2026-09-07, continued: the NL30 finding is confirmed SYSTEMIC — two more stale sizeMultiplier factors found and confirmed against the full real trade history, per user direction to keep digging before fixing everything together.**
  - **Loss-streak cap** (applied last, as a hard ceiling): the 3+-losses bucket, which gets the harshest cap (mult ≤ 0.10, same as 2-losses), is now essentially the **best-performing bucket** (50.7% WR, **+$4.08 EV**), not the worst as the 2026-07-05 claim (28.4% WR) assumed. Given the user trades exactly 1 MNQ micro contract and live sizing rounds via `Math.round(1×mult)`, a 0.10 cap forces a hard SKIP — **this is fully blocking real, currently-profitable trades, not just under-sizing them.**
  - **Win-streak boost**: the largest live boost (+0.50x) goes to a bucket now showing only 57.6% WR/+$2.29 EV (claimed 87.8% WR). The 1-win bucket's real +0.25x boost is now applied to a **net-negative** bucket (-$6.39 EV).
  - **Overnight alignment**: penalizes the wrong bucket — `NEUTRAL` gets a live -0.1x penalty while the actually-worst bucket (`COUNTER`, -$13.22 EV) gets none.
  - **This is now confirmed systemic, not isolated**: essentially the entire non-`dtClass`-gated portion of `sizeMultiplier` was calibrated once in a ~4-day window in July 2026 with no scheduled recalibration since — unlike `DAY_TYPE_ALPHA`/`OPTIMAL_STOP`. This directly strengthens the case for the parked `sizemultiplier_composite_redesign_scoped_pending_review` effort — both threads point at the same root cause and the same fix shape (a real, scheduled, self-recalibrating replacement, not individual patches).
  - Recorded `RESEARCH_CLAIM sizemultiplier_loss_win_streak_overnight_stale_20260907` (CONFIRMED). Updated `OPEN_DECISION nl30_regime_conditioning_needs_recalibration_20260907` to reflect the systemic scope.
  - **Dispatched a Gemini audit of the remaining ~6 harder-to-reconstruct factors** (daysSinceTest, minutesSinceVisit, VWAP extension, smallGapDay, deltaNeutral/High, buyersAtLevel/sellersAtLevel — all need bar/level-level history reconstruction), explicitly asked to report SKIP/TRADE-threshold impact at the user's real base=1 contract size, not just continuous EV. Not yet landed as of this entry.
  - **User directive**: finish digging for all remaining stale factors first, then fix everything together in one pass — no code changes started yet.




- **2026-09-07, continued: shipped the first batch of sizeMultiplier fixes — 5 stale factors fixed together, per user direction ("keep digging, then fix all together").**
  - **NL30 regime conditioning — REMOVED entirely** (all 5 branches). User's explicit call, going further than the initially-proposed partial fix (2 inverted branches, 3 weak-but-directionally-right) — given the pattern found across this whole audit, a full removal was judged simpler and safer than a delicate partial patch.
  - **Loss-streak cap — REMOVED entirely.** Real data (split by `origin_status` to isolate actual user-facing trades) showed the harshest-capped bucket (3+ losses) is now the best-performing one (+$9.85 EV), not the worst. Same "revenge trading is reliably worse" premise already failed once for the related STAND DOWN badge (removed 2026-09-05) — failing the same way twice is the premise being wrong, not a stale number.
  - **Win-streak boost — recalibrated, not removed.** The 1-win branch (now net -$6.39 EV) was removed; the 3 surviving branches (3+wins/2wins/firstOfDay) were cut from 0.50/0.35/0.10 down to 0.10/0.05/0.05 to match real, much smaller effect sizes. Explicitly labeled as a conservative interim cut, not a fresh precise calibration.
  - **Overnight alignment — flipped.** Now penalizes `COUNTER` (real worst bucket, -$13.22 EV) instead of `NEUTRAL` (which was barely different from `ALIGNED`).
  - **`daysSinceTest ≤2` boost — removed** (real EV -$3.87 at N=30); the `null`-penalty branch was left untouched (its own real sample is too thin to evaluate).
  - Verified with the full standard discipline: syntax check, ESLint clean, line-by-line diff review before shipping, server restart clean, live endpoint returns 200, `test_invariants.mjs` byte-identical to baseline. Honest gap: today is a market holiday, so live RTH/Globex execution of these branches is unverified until the next real trading session (2026-09-08).
  - **Not done yet**: the ~6 harder-to-reconstruct factors (minutesSinceVisit, vwapExtended, smallGapDay, deltaNeutral, deltaHigh, buyersAtLevel/sellersAtLevel) are still being audited — a first Gemini attempt had a confirmed bug (claimed `minutesSinceVisit>=180` has zero real occurrences ever; ground truth shows 2 in just an 88-row recent window), and a corrective re-dispatch is in flight. The real underlying fix — a scheduled, self-recalibrating replacement for this whole factor class, so it doesn't silently decay again — remains unbuilt; today's changes remove/soften what's currently wrong, they don't prevent future staleness.



- **2026-09-07, continued: dead code deleted, and a recurring live timezone bug found, fixed, and given a prevention mechanism.**
  - **Deleted 2 confirmed-dead items** flagged earlier this session but deliberately deferred: `lfPriorStop`/`lfPriorWin` (computed, never read anywhere) and `sessionBiasMatch`'s exported/destructured binding (the internal copy used by `sessionConflictFor`'s closure is untouched and still works). Verified via `node --check`, ESLint, diff review, restart, live check, `test_invariants.mjs` unchanged.
  - **Found a genuine third occurrence of an already-documented-and-fixed timezone bug.** While auditing Gemini's `smallGapDay`/`deltaNeutral`/`deltaHigh` reconstruction, found `acd.js`'s `_lfOnGapQ` and `_lfDeltaPercQ` both cast `price_bars_primary.ts` through a UTC-then-America/New_York double timezone conversion — but that column already stores naive ET digits directly (per `server/db.js`'s own documented 2026-08-19 fix). Empirically confirmed live: a real 09:30:00 bar returns hour=5 through the cast. `_lfDeltaPercQ`'s own 2026-08-31 rewrite (for an unrelated bug) silently reintroduced this exact pattern that the 2026-08-19 fix was supposed to have ended.
  - **Verified per-occurrence, not blanket-fixed** — the same cast is genuinely correct for `trades.entry_time`/`exit_time` (confirmed against the raw Sierra Chart import string for a real trade), so `server/routes/backtest.js` and `scripts/daily_coaching.js` were left untouched.
  - **Added a prevention mechanism**, per explicit user frustration at this bug "getting refound" — pattern H in `scripts/hardcoded-threshold-patterns.sh`, wired into both the git pre-commit hook and the Stop hook's same-session check, so a fourth recurrence against a non-UTC column is caught automatically. The hook caught a real false positive on its first live run (its own explanatory prose quoting the bad pattern) — fixed by rewording rather than growing the exclude list.
  - Recorded `RESEARCH_CLAIM lfongapq_lfdeltapercq_timezone_double_cast_fixed_20260907` (CONFIRMED). **Not yet resolved**: whether the `vwapExtended`/`deltaHigh` sizeMultiplier branches need fixing too — both now have reliable full-history data (95.5%/94.3% match rates against ground truth) showing negative EV despite live boosts, the same pattern already fixed for the first 5 factors. `smallGapDay` couldn't be reliably reconstructed (72.7% match rate) so there's no trustworthy retroactive number for it yet.
  - Added a new CLAUDE.md rule (audit existing static thresholds, not just block new ones) and a memory entry (dig for every instance of a problem class before batch-fixing) reflecting today's broader pattern.



- **2026-09-07, continued: follow-up sizeMultiplier fix shipped — VWAP Extension and deltaHigh boosts removed (commit `3f29fb5`).** Both now had reliable full-history data (95.5%/94.3% match rates against ground truth from the corrected Gemini audit) showing negative real EV despite live boosts — the same anti-pattern as the first batch. VWAP Extension: claimed z=+2.95, real EV -$2.98 (N=505, 41.1% SKIP/TRADE flip rate). deltaHigh: claimed +$28 EV, real EV -$3.32 (N=549, 37.4% flip rate). `deltaNeutral`'s penalty left unchanged — still directionally correct, zero practical consequence at base=1 either way.
  - **Total across both rounds today: 7 stale sizeMultiplier factors fixed** (NL30, loss-streak cap, win-streak boost, overnight alignment, `daysSinceTest≤2` boost, VWAP Extension boost, deltaHigh boost).
  - **Confirmed still good, no action needed**: `buyersAtLevel`/`sellersAtLevel` (real EV +$3.83, N=819, 55.3% flip rate — this one actually works).
  - **Still unresolved**: `minutesSinceVisit` (36.4% reconstruction match rate, too unreliable to trust) and `smallGapDay` (72.7% match rate, also excluded — though its input computation is now at least correct going forward after the timezone fix, so a fresh look with clean data is more viable than before, just not done yet).
  - Verified with the full standard discipline: syntax, lint, diff review, restart, live check, `test_invariants.mjs` byte-identical to baseline.
  - **The real structural fix — a scheduled, self-recalibrating mechanism for this whole factor class — remains unbuilt.** Today shipped two rounds of manual correction to what was found broken; nothing yet prevents the next decay cycle.



- **2026-09-07, continued: third round — `minutesSinceVisit` and `smallGapDay` also removed, closing out this session's stale-factor audit at 9 total.** Neither could be reliably reconstructed (36.4%/72.7% match rates, below every other factor's trust bar this session), so rather than dispatch a fresh Gemini pass on `smallGapDay`'s now-clean data, the user's call was direct: "Just remove and discard them." Both underlying raw values are still computed and still feed `sizeFactorsAtDetection` for future monitoring — only the live sizing effects are removed (`minutesSinceVisit`'s first-visit +0.15 boost / 3hr+-stale -0.25 penalty; `smallGapDay`'s quiet-overnight -0.15 penalty).
  - **Total across all 3 rounds today: 9 stale sizeMultiplier factors removed/recalibrated.**
  - Verified with the full standard discipline: syntax, lint, diff review (exactly 2 hunks), restart, live check, `test_invariants.mjs` byte-identical to baseline, no new `server_errors.jsonl` entries.
  - Recorded `RESEARCH_CLAIM sizemultiplier_visitlatency_smallgap_removed_20260907` (CONFIRMED). Renamed the tracking decision (the old `nl30_regime_conditioning_needs_recalibration_20260907` misleadingly implied NL30 itself was still unfinished, once its scope had grown across 3 updates to cover the whole factor family) to `sizemultiplier_stale_factor_audit_remaining_scope_20260907`, now narrowed to just the one thing genuinely still open: **the scheduled, self-recalibrating recheck mechanism for this whole factor class remains unbuilt** — nothing yet catches the NEXT decay cycle automatically, for these 9 or the ~15 factors never audited this session.



- ~~**2026-09-07, continued: user spotted a real, concrete instance of the already-documented "Globex cluster sibling touch credit not built" gap.**~~ **Resolved 2026-09-07** (commit `c351e45`) — see the entry below.


- **2026-09-07, continued: shipped cluster touch credit for Globex/overnight fires, closing `OPEN_DECISION globex_cluster_sibling_touch_credit_not_built_20260907`.** A live quick-check.html screenshot had shown 4 real SHADOW setups firing within 0.4 seconds of each other at the exact same entry price (29614.25) — `PW_VAH_SWEEP_REVERSAL_SHORT_OVERNIGHT`, `PM_POC_SWEEP_REVERSAL_SHORT_OVERNIGHT`, `PD_POC_FADE_SHORT`, `PD_VAH_FADE_SHORT` — all with `cluster_touch_id` NULL and `is_cluster_primary=true`, quadruple-counting one real touch across 4 setup_types' calibration stats.
  - **DeepSeek design-critiqued before any code was written** (higher-stakes-work rule): confirmed `detectGlobexSetup()`'s candidates loop has no winner-selection (unlike RTH's EV-ranked `sortedCandidates` + `break`) — it already fires every eligible candidate as its own independent row, so only pooled-dedup TAGGING was needed, not a ported winner-selection mechanism. Also corrected the original implementation plan: instead of splicing 2 new columns into the already ~37-param INSERT, use a post-insert UPDATE keyed by `RETURNING id`, mirroring RTH's own shipped precedent and the `feedback_sql_param_dryrun_verification` convention exactly.
  - **"Primary" means something different here than in RTH** — array-order-first-to-insert-this-poll, not EV-best (Globex's `candidates` array is a fixed enumeration, not EV-sorted) — documented inline so a future reader doesn't misread `is_cluster_primary=true` as "the highest-EV representative." A singleton touch still gets a real non-null `cluster_touch_id` (vs RTH's NULL-for-non-clustered convention) — cosmetically different, numerically identical to any `COUNT(DISTINCT COALESCE(cluster_touch_id, id))` consumer.
  - Verified: `node --check` + ESLint clean, both UPDATE statements dry-run correctly in a rolled-back transaction against a real row (`scratch/dryrun_globex_cluster_tagging.mjs`), server restart clean, live endpoint 200, `test_invariants.mjs` FAIL/WARN lines byte-identical to the pre-change baseline, no new `scratch/server_errors.jsonl` entries.
  - **Honest gap**: no real multi-candidate confluence touch has occurred yet since deploy to observe the tagging fire end-to-end on live data — verified correct by SQL dry-run + static checks, not yet by a real observed cluster. If the next real overnight confluence touch doesn't show the expected `is_cluster_primary`/`cluster_touch_id` pattern, revisit.
  - Deliberately scoped to `detectGlobexSetup()`'s own candidates only — does not cover `globexFlushDetector.js` (structurally unrelated, no confluence concept) or a theoretical cross-detector co-fire between the two, matching the same boundary RTH's own dedup already accepts.
  - Recorded `RESEARCH_CLAIM globex_cluster_touch_credit_shipped_20260907` (PROVISIONAL, pending real-world observation). Resolved `OPEN_DECISION globex_cluster_sibling_touch_credit_not_built_20260907`.



- **2026-09-07, continued: shipped live-safety gates for the 3 previously-unprotected service-poller detectors — but the fix is narrower than the "zero exposure" framing implied.** Closes the "single biggest un-closed gap" from `docs/UNIFIED_LIVE_GATE_CHECKPOINT_SPEC.md`.
  - **DeepSeek design critique (dispatched before any code) found 2 of the 4 originally-proposed gates are structurally unreachable**: `isCrossDirectionFastFlip` and `isPostWinOppositeFamilyBlocked` both check "did the opposite direction of the same family fire earlier today," but each of the 3 detectors (`minuteBarSignalDetector.js`, `rthFlushDetector.js`, `globexFlushDetector.js`) fires at most ONE real row per trade_date across ALL its own setup_types — so that scenario can never occur. Independently re-verified against each file's fire-once logic before accepting.
  - **Only 2 gates do real work**: `CAPITAL_EXPOSURE_OVERRIDE` (future-proofing, currently empty for these families) and `isOppositeDirectionOpen` (roster-wide, not date-scoped — genuinely catches a cross-midnight opposite-direction conflict). Deliberately deviated from DeepSeek's own final recommendation (which suggested keeping all 4 gates with 2 documented as inert) in favor of this project's stronger anti-dead-code precedent — only wiring what can actually fire.
  - Also found a real, already-shipped precedent (`server/services/ibLowPnrDetector.js` already imports and calls 2 of these gates from `acd.js` safely) confirming the import pattern is sound.
  - New shared `server/services/detectorLiveGates.js` (`checkStandardLiveGates()`), wired into all 3 detectors. Verified: no circular import, module load tests, a direct functional test against real live DB state, server restart clean, live endpoint check, `test_invariants.mjs` byte-identical to baseline, and confirmed via live `journalctl` output that `detectGlobexFlush()` is actively polling through the new code path with zero errors during real Globex hours.
  - **Honest framing, stated explicitly per DeepSeek's caution**: all 3 families are currently real-N=0 and always SHADOW anyway, so this is future-proofing and cross-midnight protection, not an active risk reduction today. `test_invariants.mjs` check `[24]` will likely still WARN on these files for the 2 deliberately-excluded gates — expected, not a regression, matching how `isInRefireCooldown`'s exclusion is already treated.
  - Recorded `RESEARCH_CLAIM detector_live_gates_two_of_four_structurally_inert_20260907` (CONFIRMED). Resolved `OPEN_DECISION detector_service_poller_live_gates_shipped_20260907`.




- **2026-09-08: Session Timeline / Auction Read disambiguation, plus the day's main thread — cluster touch credit's 3 remaining real gaps found, fixed, and repaired historically (see CLAUDE.md's "Cluster touch credit" entry for the full blow-by-blow).** Renamed Session Timeline's "Max DD" label to "Worst Trade" (it was showing the single worst individual trade's P&L, not a running drawdown figure — the old label was actively misleading next to the real "Max Drawdown" stat elsewhere on the page). Blocked `WEEKLY_OPEN` fades from firing in the Sun-evening-through-Monday-RTH-open window (level-set-too-recent, matches the existing IB/OR formation-gate idiom). Added a tap-to-popup per-trade P&L view for the Vol+/Vol++ tags on quick-check.html (mirrors the existing RangeSlope/VolRoll/PitchCatch/StepTrail popup convention). Shipped `server/public/loss-prevention.html` + `GET /api/setups/loss-prevention-summary` (Today/This-Week rollup of how much realized loss each observation-only shadow tag would have prevented, HA-ready `summary_text`) — both added to `~/.cloudflared/config.yml`'s allowlist per the standing rule. Extended the Globex no-trade-at-open window from 5 to 30 minutes (a same-day follow-up test showed the negative effect wasn't confined to the first 5 minutes: N=34/13 days/EV=-$29.36 at 30min vs N=24/12 days/EV=-$27.93 at 5min — the wider window is actually deeper and better-supported, not just more conservative).

- **2026-09-08, continued: cluster touch credit — 3 more real gaps found live (user-caught, pushed past two "looks fixed" answers), fixed, and historically repaired.** Full incident narrative lives in CLAUDE.md's "Cluster touch credit" hard-rule entry (search that file for `case_engine_family_cluster_tagging_gap_20260908`) — condensed here:
  1. RTH's `sortedCandidates` winner never got `cluster_touch_id` when it ALSO failed a later eligibility check and fell into the separate suppressed-audit INSERT branch (that branch's column list simply omitted the column). Fixed.
  2. A 4th real insert path, `EARLY_TOUCH_BACKFILL` (levels already touched by the time the poller catches up, most often right at RTH open), had ZERO cluster-tagging. Fixed live and historically repaired in 2 rounds (round 1's marker under-covered the true population — `historical_avg_pnl IS NOT NULL` misses any THIN_N type with no calibrated EV yet; round 2 used the complete `t1_label LIKE '%(backfilled early touch)%'` marker instead, catching 14 more rows/6 more batches). This gap is what was silently inflating quick-check.html's displayed Net P&L (real -$1,908 shown as +$738 one day) — fixing it plus the frontend filter fix corrected the full gap.
  3. A 5th real insert path, `shadowCandidates` (the file's own-documented "5th `active_setups` INSERT" — where STOP_SWEEP/IB_BEARISH/C_PAIRED/VWAP_MAGNET/TRT/BRACKET_BREAKOUT actually fire from), also had zero cluster-tagging. Fixed.
  - **A real bug in fix #3's first draft**, caught by a same-day self-check: the backfill fix (from #2) generated ONE shared touch id for the ENTIRE backfilled batch unconditionally, without checking entries actually shared a touch moment — different levels can each have their own earliest-touch discovered in the same poll. Fixed by extracting the duplicated "tag a same-poll batch" logic into one shared `tagClusterBatch(items, keyFn)` in `server/services/acdShared.js` (backfill groups by each touch's own `etMin`, `shadowCandidates` by entry price).
  - **Frontend fix, same root cause**: `quick-check.html`'s `computeRangeStats()`/`renderEquityCurve()` summed `actual_pnl` with no `is_cluster_primary` filter at all — extracted both into a shared `getDecidedRows()` that filters `is_cluster_primary !== false`, so the chart and the stats line above it can't silently drift again. Also added a cluster leader/sibling dropdown to the Session Timeline (tap the badge to expand/collapse a touch's real siblings instead of them reading as N independent trades).
  - **A 6th, structurally separate, never-audited insert path was found live the same session and is NOT fixed**: the older "case engine" family (`C_PAIRED`/`C_REVERSAL`/`TRT`/`A_UP_STRONG`/`A_DOWN_WEAK`/`ZONE_EDGE_FADE`/`FAILED_AUCTION`/`FAILED_SWEEP_REVERSAL`, `acd.js` ~line 2400-2600+) builds its own candidates independently of `nearLevels`/`sortedCandidates` and has never had cluster-tagging audited. Confirmed real live (3 same-day instances of 3 types touching within 0.25pt at the identical instant, unlinked), all SHADOW-origin. Tracked as `OPEN_DECISION case_engine_family_cluster_tagging_gap_20260908` — read that before trusting quick-check.html's SHADOW P&L/confluence display again.

- **2026-09-08, continued: a 7th cluster-tagging bug found via code review (not live data) — the `tagClusterBatch()` extraction from the previous entry pre-assigned "primary" by raw array position BEFORE either caller loop's async eligibility gates had run.** Found while independently re-verifying the shipped fix against live `active_setups` data before committing (a pattern of 49 orphaned `CLUSTER_SIBLING_TOUCH_CREDIT` clusters was initially mistaken for this bug manifesting — corrected on closer inspection: those are a separate, legitimate, already-shipped 2026-09-04/07 behavior, a real "no eligible winner this poll" case, not a new bug). The REAL bug: both the `shadowCandidates` loop (risk check / refire cooldown / `isLiveEligible` / cross-direction / opposite-direction gates) and the backfill loop (its own `existing`-row dedup check) have `continue` statements between where `tagClusterBatch()` decided array-position-0 was "primary" and the actual `INSERT` — if that position got gated out for any reason, its primary designation was never written to any row, silently orphaning the group. Not observed live today (both loops' gates rarely reject a group's first member), but structurally confirmed via code reading and reproduced in a synthetic (no-DB-writes) unit test.
  - **Fix**: `tagClusterBatch()` now only returns per-key group membership + a `touchId` (`Map<key, touchId>`) — it no longer decides who's primary. A new `claimClusterRole(assignedKeys, key)` resolves primary/sibling status lazily, called only AFTER a row's own `INSERT` has actually succeeded (`RETURNING id` came back non-empty), mirroring the already-shipped Globex (`globexPrimaryAssigned`) and RTH-winner (`active.clusterTouchId`) post-insert-`UPDATE` pattern exactly rather than reinventing a pre-gate scheme. Applied to both the `shadowCandidates` loop and the backfill loop (which also needed a `RETURNING id` added — it didn't capture the inserted row's id before).
  - Verified: `node --check` + ESLint clean on both files, full diff review, a synthetic unit test of `tagClusterBatch`/`claimClusterRole` covering the exact gated-position-0 scenario (confirms the first actual survivor claims primary, not "no primary"), server restart clean (systemd `trading-journal-server.service` was serving port 3002 directly with no dev nodemon running — restarted it directly), live endpoint check, `test_invariants.mjs` FAIL/WARN counts unchanged from the pre-change baseline (19 vs 20 FAIL — one fewer, unrelated day-to-day OPTIMAL_STOP drift noise — 84 WARN both times). **Honest gap**: RTH closed for the day by the time this shipped, so no new live multi-candidate cluster has been observed forming correctly under the fixed code yet — verified via synthetic test + static checks, not yet by a real observed cluster. Revisit if tomorrow's RTH session produces a cluster group with `n_primary != 1`.
  - Added a new CLAUDE.md convention: never key a per-trade state object by `fired_at`/`fired_at_ms` in an event-driven `active_setups` simulation (12.6% of real trades share an exact `fired_at` with a confluence-cluster sibling) — found the same day in `scripts/backtest_morning_weakness_deepdive_20260908.mjs`'s loss-streak event loop, which inflated its RTH result by 75% ($3615.22 vs the correct $1900.72) before being caught by disagreement against an earlier, correctly-keyed script.

- **2026-09-08, continued: fixed a wrong-key `OPTIMAL_STOP` lookup affecting all 6 live `_TRAIL` (breakeven-then-trail) `CONDITIONAL_VARIANTS`, root-caused from a user-reported live trade.** `PD_POC_FADE_LONG_TRAIL` took an 89pt stop live vs. its base type's correctly-calibrated 24pt. Root cause: 4 `liveStats._opt[type]` lookups in `acd.js` used the POST-`resolveSetupType()` variant name directly, but `update_optimal_stops.mjs` only ever calibrates/stores `OPTIMAL_STOP` under a setup_type's BASE name — every one of these 6 variants' real trades was silently falling through to the crude `mae_p75`/`STOP` fallback instead of a validated stop, which also explains why the breakeven-trail mechanism itself never had a real chance to engage for any of them (the mechanism this codebase's own "leading candidate remedy for risk-management priority" note already flagged as a 5-of-6-broken finding, now root-caused). Fixed via `getOptStopForType()` (`server/services/acdShared.js`), which unwraps to `CONDITIONAL_VARIANTS[type].baseType` before the lookup, used at all 4 call sites. Repaired 139 historical rows (`scripts/resim_trail_variant_correct_stop_20260908.mjs` re-simulates the 64 affected real trades against the CORRECT stop/target using the same bar-by-bar walk and same-bar tie-break convention as the real live resolver — no lookahead, read-only). `OPEN_DECISION breakeven_trail_4_more_variants_lost_calibration_row` is now genuinely worth re-evaluating with a correct stop in place — was previously blocked on this exact bug.

- **2026-09-08, continued: several one-off research threads, all resolved (see `record_claim.mjs --list` for the full text) — no live wiring changes from any of these.**
  - `directional_loss_streak_lockout_20260908` (CONFIRMED): re-tested per user request ("too quick" the first pass) — found and fixed the `fired_at_ms`-keying bug above, then confirmed the original REJECT (RTH)/not-a-viable-mechanism (Globex) verdict with corrected numbers.
  - `pressure_gate_six_angles_20260908` (PROVISIONAL): the already-live wider-target pressure gate's baseline arm is `clustered=true` (top5DayPct>50) — none of 6 candidate alternative angles beat it cleanly.
  - `wider_target_pressure_gate_top_day_exclusion_check_20260908` (PROVISIONAL): the live gate's validated edge does NOT survive excluding its own top days at face value (top5DayPct=184.6%), but the excluded remainder is negative and both chronological halves are still positive — genuinely mixed, not a clean kill.
  - `morning_digs_out_pattern_20260908` (PROVISIONAL): a "busy morning digs out" pattern verified real for that specific subset via a fixed-cohort control, not tested as a universal claim.
  - `cluster_reaction_ideas_20260908` (PROVISIONAL, both ideas effectively rejected): Idea A below the N floor; Idea B chronologically unstable with >100% top-5-day concentration both sessions.
  - `globex_open_30min_no_trade_window_20260908` / `vwap_sigma_chase_vs_fade_20260908` / `confluence_helps_rth_hurts_globex_20260908`: supporting claims for the shipped Globex-window and other same-day changes above.
