# Decisions Log

## 2026-08-09 (same day, third pass) — the stop-side origin_status re-baseline: all three built-not-run pieces shipped in one disruption, two real bugs caught before they reached the database, check [5] rewritten to match

Direct follow-up to the two entries below, executing the user's own explicit sequencing for
the Sunday-market-closed window: approve CAM_S2_FADE_SHORT, run the full stop-side
re-baseline (origin_status filter + chronological sweep + real-N/volatility-default gate,
shipped together per "doing them separately means three disruptions instead of one"),
un-shadow the 4 Globex PD types, preflight-check, re-verify checks [8]/[13].

1. **CAM_S2_FADE_SHORT suppression applied** — the exact write blocked by the permission
   classifier two entries below went through this time with explicit user approval.
   Verified: `recommendation='SUPPRESS'` confirmed in the DB.

2. **The re-baseline itself — full snapshot/filter/run/diff/review/re-arm sequence, two real
   bugs found and fixed before either dry-run or real output was trusted.** `rawByType` (the
   stop-sweep's trade population) is now `origin_status IN ('ACTIVE','SHADOW')`-filtered, with
   the candidate MAE percentiles ALSO computed from that same real-only array (a half-fix
   filtering only the trades-being-scored, not the candidate values themselves, would have
   left contamination on the other side). `sweepOptimalStopAndTargetChronological()` is now
   the primary path for any real-N-qualified type, falling back to the order-blind sweep on
   the SAME real population (never back to blended) only when the chronological walk can't
   cover enough trades. The real-N gate correctly decides volatility-scaled-default vs. a
   real sweep, now gated on `realNStop` (this type's own real TARGET_HIT/STOP_HIT count) —
   previously the gate used a differently-scoped population (`rawByTypeExpanded`), a second
   footgun of the same class fixed in the same motion. **Bug #1, caught on the second
   dry-run review**: 6 of 11 types reaching the chronological sweep landed at 1-13pt stops —
   comfortably inside normal single-bar noise, the exact "candidate finer than the data's own
   resolution" failure this codebase already has a named precedent for
   (`backtest_scaleout_runner.mjs`, 2026-07-19). Fixed by adding a noise-floor guard to
   candidate GENERATION (not just a post-hoc check on the final chosen stop) — filters
   candidates below `1.5x` the real trailing-30-day median bar range before either sweep ever
   sees them, applied to the chronological sweep, the order-blind fallback, AND the
   volatility-scaled-default formula itself (belt-and-suspenders, since that default's own
   ratio is built from prior stored stops that could themselves predate this fix). **Bug #2,
   caught mid-execution on the real (non-dry-run) run**: the actual-write print path had an
   unguarded `.toFixed()` on a possibly-null EV — dormant since the volatility-default shipped
   2026-08-05 (rarely triggered under the old unfiltered real-N gate), finally hit once
   today's origin_status fix made vol-default the majority path (104 of 123 types). Crashed
   after writing exactly 1 row (idempotent `ON CONFLICT DO UPDATE`, safe to resume); fixed and
   re-ran clean, all 123 rows. **Full verification chain**: pre-snapshot
   (`optimal_stop_rebaseline_backup_20260809`, 131 rows) → dry-run reviewed twice → real run
   with the circuit breaker bypassed via a dated, one-time-only CLI flag
   (`--bypass-breaker-for-rebaseline-20260809`) → after-snapshot diffed against the reviewed
   dry-run, 0 mismatches → 17 currently-live setup_types reviewed by hand individually,
   including `GLOBEX_VWAP_FADE_LONG`'s 83→32pt correction (the exact type whose 83pt↔8pt
   oscillation motivated building the circuit breaker in the first place) and confirming
   `VWAP_MAGNET_LONG` independently reproduces the exact 29pt/25pt figure already verified by
   hand 2026-08-05 → circuit breaker confirmed re-armed (a subsequent normal, non-bypassed
   dry-run correctly held all 123 types at `ΔN=0<required`, zero trips, zero bypasses).

3. **Un-shadowed the 4 `PAUSED_UNTIL_ORIGIN_FILTER` Globex PD types** in `acd.js`, since the
   fix they were paused pending has now landed. Checked before flipping, not assumed: only
   `PD_VAH_FADE_SHORT` is currently `SETUP_STATUS=ACTIVE` (new stop=32, volatility-scaled-
   default — real N<20 for this type, so a safe default rather than a real sweep, but no
   longer contaminated); the other 3 (`PD_VAL_FADE_LONG`/`PD_POC_FADE_SHORT`/
   `PD_POC_FADE_LONG`) are independently gated `SUPPRESS`/`SUPPRESS`/`THIN_N` by the unified
   `SETUP_STATUS` pipeline regardless of this code-level flag — un-pausing them doesn't put
   them live. `PD_POC_FADE_SHORT` specifically showed a real, computed **negative EV
   (-$19.32)** at its new (82pt) real-data calibration — a useful confirmation the pause is
   being lifted for the right reason (data quality) without blindly trusting every resulting
   number.

4. **Preflighted the two most directly relevant scripts** (`export_row_level_audit_20260805.mjs`,
   `update_optimal_stops.mjs`) via `preflight_backtest_assertions.mjs` — both clean on all 6
   checks. The default broad scan (118 scripts, 77 flagged) was also run in passing; not
   individually triaged today, see `order_blind_pattern_grep_sweep_other_scripts` below.

5. **test_invariants.mjs checks [8]/[13] re-verified clean** — [13]'s noise-floor check
   passes and its week-over-week shift (32pt→37pt, 15.6%) is real and expected, not a
   regression; [8]'s 4 WARNs are the same pre-existing, already-documented hardcode
   signatures from before today's work (`CAM_S4_FADE_LONG`, `GLOBEX_VWAP_MAGNET_LONG`,
   `STOP_SWEEP_LONG`, `VWAP_MAGNET_LONG`), unchanged. **Check [5], however, went from ~7 to
   128 failures the moment the re-baseline landed** — its own header comment had already
   warned this would happen ("if [update_optimal_stops.mjs's population queries] ever change,
   this must change with them") and it did. Not a data regression: check [5] was re-deriving
   against the OLD blended methodology while production had moved to real-only data. Rewrote
   it to match, importing the exact same logic rather than hand-copying a second version —
   extracted `computeStopTargetForType()` as a new exported function from
   `update_optimal_stops.mjs` (verified the extraction itself was behavior-preserving: 0
   mismatches on the 19 real-sweep-based types across the refactor; a later 104/123 shift on
   volatility-scaled-default types was confirmed to be the ratio's own legitimate self-
   referential drift — computed from `priorStoredByType`, which had changed because the real
   run had just written new values — not a bug). `volatility-scaled-default` rows get a
   structural consistency check (floor respected, EV null, positive ratio) rather than an
   exact-match one, since that default's own ratio is a moving target across time by design.
   Two more real gaps found and correctly scoped rather than silently worked around: (a)
   day-type-suffixed rows (`IB_BEARISH_TURBULENT` etc.) are produced by a DIFFERENT,
   never-origin-status-filtered script (`backtest_ib_daytype_stop_target.mjs`) — skipped in
   check [5] rather than mis-verified against the wrong standard, flagged as
   `day_type_alpha_stop_needs_origin_status_filter`; (b) `MONTHLY_VWAP_FADE_LONG/SHORT` and
   similar rows have some blended `active_setups` data but fewer than the `MIN_N=20`
   `update_optimal_stops.mjs`'s own `HAVING` clause requires, so neither the old nor new
   methodology has ever touched their stored row (`run_date` still 2026-07-19) — also
   correctly skipped rather than compared against a standard that was never applied to them.
   Final state: 5 failures, all pre-existing `BREAKEVEN_TRAIL_TEST` gaps, unrelated to
   anything touched today.

6. **OPEN_DECISIONs resolved**: `rawByType_origin_status_filter`,
   `wire_chronological_sweep_into_live_cron` (both fully shipped and verified above),
   `order_blind_evaluation_pattern_sweep`'s fix-and-wire half (its grep-sweep half split out
   as a narrower, still-open follow-up: `order_blind_pattern_grep_sweep_other_scripts`).
   **New decision flagged**: `day_type_alpha_stop_needs_origin_status_filter` (MEDIUM) — the
   day-type IB calibration script needs the identical fix, not done today (separate script,
   out of today's explicitly-scoped work).

**Why this entry exists**: same standing reason as every entry in this file — record not
just what changed but what was checked before trusting it, including the two points where a
"looks done" dry-run or refactor could have shipped a real bug (the sub-floor stop, the
null-crash) had the review stopped one step earlier.

## 2026-08-09 (same day, second pass) — five follow-up items, two structural fixes to the outage's root mechanism, one live-risk revert, one blocked live-risk flip

Direct follow-up to the entry below, after the user listed 5 remaining open items and flagged
2 as "load-bearing for the conversation you want to have next" (a measurement-layer/ingestion
integrity question this file doesn't have full context on — handled on its own factual merits
regardless).

1. **Systemd bind, verified with a log line, not inference.** `journalctl` shows
   `Aug 09 17:04:30 MattsPC node[1880468]: Server running on port 3002` for the current PID,
   stable 1hr+, serving real queries, HTTP 200 in 3.8ms. Confirmed, not assumed.

2. **`./start.sh`'s reproducible defect — actually fixed, not just described, and proven via a
   live failure simulation.** Root cause: `nodemon`'s documented behavior on a crash is
   "waiting for file changes before starting..." — it does not retry on its own, and since the
   EXIT trap only fires on the top-level `start.sh` process exiting (not a grandchild crashing
   independently), an abandoned session with a dead server child looks identical to a healthy
   one in `ps`. Fixed two ways: (a) a background health-monitor loop in `start.sh` that polls
   port 3002 directly (`/dev/tcp`) and self-heals via the same recovery path as the EXIT trap
   if the port goes dark for 45s+ after being up, or never comes up within 90s of a cold start
   — tested end-to-end with `timeout --signal=TERM 70 ./start.sh`, confirmed no false positive
   during 70s of healthy operation and a clean handback on termination; (b) the systemd unit's
   default `StartLimitIntervalSec=10s`/`StartLimitBurst=5` was structurally unreachable given
   `RestartSec=5` (at most ~2 attempts ever fit in any 10s window) — this is *why* the real
   incident produced 114,824 silent retries instead of a detectable `failed` state. Added a
   drop-in override (`~/.config/systemd/user/trading-journal-server.service.d/override.conf`,
   outside the repo, not git-tracked — `StartLimitIntervalSec=60`/`StartLimitBurst=6`) and
   **proved it works by deliberately reproducing the failure mode live**: bound a dummy
   listener on 3002, tried to start the real service against it, watched `NRestarts` climb
   5→6→7→8 over ~40s, confirmed `ActiveState=failed`/`Result=exit-code` — a real, detectable
   failure instead of an infinite silent loop. Cleaned up, reset-failed, restarted, verified
   healthy again before moving on.

3. **Process Health didn't catch this because every existing check is application-layer, not
   infrastructure-identity — fixed with a genuinely self-referential check, not a patch on the
   old one.** `SystemHealthSummary`'s `/api/settings/process-health` checks scheduled-job
   freshness and an in-memory detection heartbeat — both were honestly green the whole 4 days,
   because the orphaned dev session was genuinely, correctly running them; nothing in that
   design can tell "the managed process is serving this" from "an unmanaged stand-in is." Added
   a new check that can: the endpoint now asks systemd for its own `MainPID` and compares it
   against `process.pid` — any process serving the request can correctly answer this about
   itself, unlike the heartbeat checks. Surfaced as a distinct red banner in
   `SystemHealthSummary` (`QuickTradeLog.jsx`), separate from the generic amber dot. **Separately
   found the actual signal for this incident already existed and already fired, twice, and was
   read past both times**: (a) `.claude/hooks/session-start.sh`'s own `SERVER_STATUS` line
   printed `"activating"` (not `"active"`) at the very start of THIS session, as a bare
   unstyled line among dozens of others — not registered as significant until hours into the
   investigation; (b) `trading-journal-watcher.service`'s error watcher logged 10 real
   `SERVER_DOWN`/`SERVER_DOWN_PERSISTENT` alerts during the actual 2026-08-05→08-07 window
   (confirmed by grepping `scratch/gemini_alerts.txt` directly, not assumed) — the detection
   mechanism worked, the alerts just sat buried in a 2,400-line file with only the single most
   recent line ever surfaced. Fixed both: `SERVER_STATUS` now gets an explicit "NOT active,
   see the alert below" flag and a dedicated loud 🔴 block (also carrying the PID-mismatch
   check, bash-side, as a second independent signal even when `SERVER_STATUS` itself still
   reads `active` from a stale earlier start); a new block scans the last 3 days specifically
   for `SERVER_DOWN*` entries and surfaces them as a dedicated, impossible-to-miss list — which
   immediately found a second, real, separate blip at 2026-08-09 06:00 that morning, before
   this session even started.

4. **Ingestion-path integrity — resolved with real evidence, not reassurance.** Grepped for
   every actual call site, not just the `SierraWatcher` instantiation `docs/KNOWN_ISSUES.md`
   had previously (wrongly) marked "re-verified fixed." It's still genuinely dead code —
   `.start()` is never called anywhere, confirmed by a full grep of both `server/index.js` and
   `server/routes/sierra.js` (the router only reads `.getStatus()`). But this does NOT put the
   measurement layer at risk: (a) personal trade-log (Sierra Chart TAL) import runs via a real,
   working, separate mechanism — the `AUTO_IMPORT_4PM` cron, whose own comment says
   "replaces setInterval below," calling the identical `importSierraTrades()` function
   `SierraWatcher._scan()` would have called, just once/day instead of continuously (a real,
   narrower gap — no intraday trade visibility — not "trade import is broken"); (b) price bar
   (market data) ingestion — the actual floor under setup detection, MAE/MFE, and everything
   the live system depends on — runs via two independent `setInterval` file-scanners
   (`server/index.js`'s unconditional 60s poll, `priceBars.js`'s RTH-gated 60s poll), both
   confirmed live and running via the same `./start.sh` end-to-end test above ("📊 Ingesting
   price bars: NQU6.CME-BarData.txt" in the real startup log). There is no DTC-protocol
   connection anywhere in the running app — `scripts/archive/dtc_phase0_test.cjs` remains a
   standalone, never-integrated prototype, confirmed by `docs/KNOWN_ISSUES.md` item 4, which
   was already accurate. Corrected the stale note in `KNOWN_ISSUES.md` — the exact same class
   of mistake ("instantiated and passed to a router" mistaken for "started") this file's own
   `fired_status`/`origin_status` correction made a few hours earlier, now caught a second time
   in a different session's prior work.

5. **Invariant checks `[12]`/`[13]` — actually investigated and acted on, not left as
   descriptions.** `FLOOR_R1_FADE_LONG` (check `[13]`, noise floor): full history pull showed
   stop=70-75pt through 2026-07-13, a drop to 14/15pt on 2026-07-14 (predating the circuit
   breaker by 3 weeks, so it was never evaluated as a fresh transition, only ever rubber-stamped
   `min_delta_n_not_met`), stuck there 3.5+ weeks. This is a real, live-firing setup (3
   `ACTIVE`-origin trades exist) — reverted to 36pt, the last pre-drop value that genuinely
   cleared the floor, backed up first
   (`optimal_stop_noise_floor_revert_backup_20260809`, catalogued). **Trade-off, stated
   plainly**: this fixes check `[13]` (the noise-floor safety property) but now trips check
   `[5]` on the same setup_type (stored 36 vs. a fresh sweep's 15) — expected and correct: check
   `[5]` is accurately detecting that a manual override now deviates from what the still-
   contaminated automated pipeline would compute on its own, the same "manual seed, self-heals
   once the real pipeline produces a trustworthy value" convention already used elsewhere in
   this codebase (`update_optimal_stops.mjs`'s `THIN_N` placeholder rows). Net: 7 failures
   before, 7 after, but a different, better-understood 7 — one real live-risk stop fixed, one
   deliberate and explained override flagged instead of a silent drift.
   `CAM_S2_FADE_SHORT` (check `[12]`, circuit breaker): investigated fully — real population is
   92 rows, 76% `BACKFILL` (zero real `ACTIVE`-origin trades at all, only `SHADOW`), the sweep's
   attempted 16pt stop is very likely contaminated by that synthetic data
   (`rawByType_origin_status_filter`, still pending), AND independently, `SETUP_STATUS`'s own
   `recent_90d` window (mostly real data) shows -$8.02 EV against the all-time blended +$1.37
   that's the only thing keeping it `ACTIVE`, with `rigor.trend='AMBIGUOUS'`. Attempted the
   well-evidenced fix (flip `recommendation` to `SUPPRESS`) — **blocked by the Claude Code
   permission classifier** (a live-trading-behavior-altering write, correctly treated with more
   caution than the numeric stop revert above, which went through). Per the classifier's own
   guidance, did not attempt to route around it. Verified the blocked attempt left zero partial
   state (no backup table created, `recommendation` unchanged) before flagging
   `OPEN_DECISION cam_s2_fade_short_suppress_pending_review` (HIGH) with the full evidence,
   pending explicit user sign-off — affects zero currently-open real positions either way
   (zero real `ACTIVE`-origin trades exist right now), only new fires starting 2026-08-10.

**Why this entry exists**: same reason as the entry below it — this is what actually happened
when 5 specific follow-up items got investigated with real data instead of accepted or deferred
generically, including where the investigation changed the plan (item 5's check-`[5]`-vs-`[13]`
trade-off) and where it hit a hard boundary that needed surfacing rather than working around
(item 5's blocked `CAM_S2_FADE_SHORT` write).

## 2026-08-09 — user pushback on a shipped fix caught a real redundant-column mistake, corrected the 10am-flood root cause, and cleared a 4-day-old outage nobody had noticed

Shipped a fix for a user-reported "ton of trades firing" around 10am (Live/All toggle,
6PM session-reset bug, MAE/MFE display, commission/drawdown display) and reported it done.
User pushback caught four real gaps before the loop actually closed — each independently
verified against real data, not just accepted:

1. **The orphaned dev session wasn't "harmless" — investigated properly instead of just
   killing it.** `journalctl --user -u trading-journal-server.service` showed the managed
   systemd service was in an **unbroken crash loop from 2026-08-05 11:36:58 through
   2026-08-09 16:09:46** — 114,824 consecutive `EADDRINUSE` failures, zero successful binds
   in that entire window, confirmed by grepping the full log. `./start.sh`'s own documented
   behavior (`systemctl --user stop trading-journal-server.service` on takeover) is exactly
   why: a prior session ran `./start.sh` in the background, it correctly stopped the managed
   service once, and then nothing ever stopped the dev session itself — its `nodemon`-spawned
   child held port 3002 alone, unmonitored, for 4 straight days, exactly the incident CLAUDE.md
   already documents as a known risk, now with a concrete real instance. **This means only ONE
   server process could have been writing during the flood window, not two** — checked directly
   (a self-join for same-`setup_type`/same-`trade_date` rows within 5 seconds of each other in
   the 08-05→08-07 window) and found zero near-duplicate pairs, confirming no dual-writer
   corruption occurred. Separately confirmed the Sierra Chart watcher was never actually a risk
   either way — `SierraWatcher.start()` is never called anywhere in `server/index.js` (a real,
   separate, still-open gap, not investigated further this session). The dev session was killed
   directly by PID (not `./stop.sh`, which would have also killed the now-correctly-running
   systemd service on the same port) — its own `EXIT` trap fired correctly on the kill
   ("Dev session ending -- handing port 3002 back to trading-journal-server.service"), confirming
   that mechanism works; it just has a blind spot the incident exposed — it only fires on the
   *top-level* `start.sh` process exiting, not on a `nodemon`-spawned child crashing independently
   while the supervisor lingers, which is what let this run undetected for 4 days.
2. **The original root-cause framing overstated the 2026-08-05 cascade-breaker gate removal's
   role — corrected with real counts, not re-asserted.** Queried `origin_status='ACTIVE'` (real,
   live-shown) vs `'SHADOW'` fire counts in the 9:30-11:30am ET window for every day back to
   2026-07-01. Result: ACTIVE counts on the three "flood" days (08-05: 0, 08-06: 9, 08-07: 3) are
   **not elevated** versus comparable pre-08-05 sessions (07-29: 10, 07-30: 11, 07-31: 15) — if
   anything lower. The SHADOW/total volume that actually spiked (`cascade_audit` rows: 92 on
   07-31, 51/71/61 on 08-05/06/07) has been building since **2026-07-28**, when the
   cascade-breaker audit-logging mechanism itself (as opposed to its gate, removed 08-05) started
   generating rows — a full week before the gate-removal change I'd originally blamed. Per the
   user's own stated test ("if Live-filtered counts are still elevated, the gate decision needs
   revisiting") — they are not, so the display fix (the Live/All toggle) is the right and
   sufficient primary resolution; the cascade-breaker gate-removal decision does not need
   revisiting on this evidence.
3. **The `fired_status` column shipped in the original fix was genuinely redundant — found,
   admitted, and reverted, not left in place.** Re-reading the actual INSERT SQL at all 8
   live-firing sites (not just the column's stated purpose) found `origin_status` (added
   2026-07-17) was *already* bound to the identical ACTIVE/SHADOW value as `status` at insert
   time in every one of them — confirmed further by `scripts/export_row_level_audit_20260805.mjs`,
   written the very session that built the cascade-breaker logic, already using
   `origin_status==='ACTIVE'` this exact way. `fired_status` was pure duplication, and a strictly
   worse one: it would only have been populated from 2026-08-09 forward, while `origin_status`
   already covers all of history back to 2026-07-17. Reverted from all 8 INSERT sites, the
   `range-summary` endpoint, and both frontend consumers (`App.jsx`, `quick-check.html`) the same
   session — the Live/All toggle now reads `origin_status` instead, which directly and
   retroactively answers point 2 above using existing data rather than needing to wait for new
   fires. The DB column itself is still present (empty, zero rows ever populated) —
   `DROP COLUMN` was attempted and blocked by the Claude Code permission classifier (a genuinely
   destructive schema change); flagged as `OPEN_DECISION drop_redundant_fired_status_column`
   rather than worked around.
4. **This also exposed a real, standing gap, not just this one mistake — flagged, not just
   fixed once.** Nothing in `test_invariants.mjs` verifies that `origin_status` and `status` stay
   bound to the same value at every `active_setups` INSERT site — the exact property this whole
   incident depended on, and the property a future careless edit could just as easily break again
   with nothing catching it. Not built this session (a naive text-based SQL-block parser risks
   being wrong in a way that gives false confidence, and deserved more design time than was
   available) — flagged as `OPEN_DECISION no_invariant_checks_origin_status_matches_status_at_insert`.
   The 7 pre-existing `test_invariants.mjs` failures checked this session (5×missing
   `BREAKEVEN_TRAIL_TEST` rows for TRAIL variants, `CAM_S2_FADE_SHORT`'s circuit breaker tripped,
   `FLOOR_R1_FADE_LONG` below the noise floor — confirmed identical with/without this session's
   diff via `git stash`) are all in the stop/target-calibration domain, not the alert-status
   domain — none of them were masking this class of bug, because no check in that domain
   currently exists at all, which is a different (and arguably worse) problem than a check
   quietly failing.

**Why this entry exists**: every one of these four corrections came from the user pushing back
on a "solid shipment" summary rather than accepting it — a direct, current-session instance of
this file's own standing purpose (verify a claim against real data before trusting it, including
Claude's own claims from earlier the same session). The original fix (Live/All toggle, 6PM reset,
MAE/MFE display) was directionally right the whole time; what needed correcting was the causal
story behind it and one piece of unnecessary, duplicate infrastructure — worth recording
precisely because "the feature works" and "the story I told about why it was needed is accurate"
turned out to be two different claims.

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

## 2026-08-10: IB day-type OPTIMAL_STOP origin_status fix (backtest_ib_daytype_stop_target.mjs)

Third instance of the origin_status-contamination class fixed this week (after `update_optimal_stops.mjs`'s main stop-side and the 2026-08-09 re-baseline) — this one specific to `IB_BULLISH`/`IB_BEARISH`'s per-day-type `{setup_type}_{day_type}` sub-key rows (`IB_BEARISH_TURBULENT` etc.), user-flagged as "probably first" priority since IB_BULLISH is most of this system's live surface.

**Composition audit before touching anything**: real-N (`origin_status IN ('ACTIVE','SHADOW')`) share ranged 5%–85% across the 6 (setup_type, day_type) cells — none of the non-real rows were `BACKFILL` (only `UNKNOWN`, since IB has been live since before the `BACKFILL`-era synthetic seeding), a different contamination *source* than the main population had, same *class* of problem.

**Fix**: both trade-fetching queries got `origin_status IN ('ACTIVE','SHADOW')`; the manual `sweepOptimalStopAndTarget()` call was replaced with the shared `computeStopTargetForType()` (already exported from `update_optimal_stops.mjs` for exactly this kind of reuse), called with `canComputeVolDefault: false` — day-type buckets deliberately never get a synthetic volatility-scaled default, they fall back to the blended (whole-system) `OPTIMAL_STOP` row when thin, matching the script's own pre-existing skip convention. `computeVolatilityDefaultRatios()` was extracted from `update_optimal_stops.mjs` as a new export — this was its 3rd hand-copy (main script, `test_invariants.mjs` check [5], about to become a 3rd copy here) before being centralized, caught before a 4th.

**Result of the real run**: 3 of 6 cells cleared `MIN_N=20` real touches —
- `IB_BEARISH_TREND`: real_n=84, stop=45/target=50, EV=+$18.91 (chronological-sweep-real)
- `IB_BEARISH_TURBULENT`: real_n=37, stop=24/target=30, EV=+$3.04
- `IB_BULLISH_BALANCE`: real_n=49, stop=40/target=10, EV=-$3.79

3 skipped for real_n below floor (`IB_BEARISH_BALANCE` real_n=11, `IB_BULLISH_TREND` real_n=10, `IB_BULLISH_TURBULENT` real_n=1) — these now fall back live to the **blended** IB_BULLISH/IB_BEARISH row from the 2026-08-09 re-baseline instead of their old stale day-type-specific values:
- `IB_BULLISH` blended: stop=50/target=35, EV=+$8.62 (was serving `IB_BULLISH_TREND`'s old stop=30/target=50 before this fix — a real, live-risk-relevant change: **tomorrow's IB_BULLISH TREND-day fire uses a wider stop and tighter target than it did yesterday**, because the thin day-type cell it was reading from turned out to be 76% unverifiable data)
- `IB_BEARISH` blended: stop=51/target=50, EV=+$15.40

**Hand-reviewed both large movers before trusting them** (per the session's established discipline): `IB_BULLISH_BALANCE`'s target dropping 50→10 and `IB_BEARISH_TURBULENT`'s dropping 60→30 both checked out against the real MAE/MFE distributions — in both cases real MAE p50 sits almost identical to real MFE p50 (heavy whipsaw: price often gives back a favorable move before a wide target is reached), so the chronological (order-aware) sweep correctly picks a tighter EV-optimal target than a naive percentile match would. EV moved in the same direction (less negative / more positive) in both cases, no sign flips — consistent with a real methodology improvement, not a bug.

**test_invariants.mjs check [5] extended** to verify day-type sub-keys with real data against this same shared function, instead of unconditionally skipping all of them (the necessary prior state, since before today there was no shared methodology to re-derive against). Added a real, `origin_status`+`day_type`-joined population query; gated the day-type branch on "has any real touches" rather than the blended `MIN_N` gate the non-day-type branch still uses; forced `canComputeVolDefault: false` for day-type rows in the check too (otherwise the two thin-but-nonzero cells — `IB_BEARISH_BALANCE` real_n=11, `IB_BULLISH_TREND` real_n=10 — would get a spurious vol-default mismatch against their correctly-stale, unwritten-today stored rows).

**Verified**: same 5 pre-existing `FAIL`s before/after (all unrelated `BREAKEVEN_TRAIL_TEST` gaps, `docs/OPEN_THREADS.md`'s known 2026-08-04 finding), check [5] now shows "all 5 OPTIMAL_STOP rows match" (up from 0 immediately post-re-baseline), lint/build clean on all 3 touched files. Resolved `OPEN_DECISION day_type_alpha_stop_needs_origin_status_filter`.

**Not done, deliberately out of scope**: `ib_bullish_daytype_alpha_stale_realn_floor_fix` (HIGH, still open) is a *different* pipeline — `backtest_day_type_alpha.js`'s `DAY_TYPE_ALPHA` signal_type, not this script's `OPTIMAL_STOP` day-type sub-keys — don't conflate the two when triaging the open queue.

**Next per the user's own explicit sequencing** ([[project-risk-management-priority-20260729]]): the uncensored MAE candidate grid from bar history — "the one that breaks the self-referential loop... the last structural defect in the measurement layer."
