# Scale-Out + Trailing Runner Execution — Build Spec

Status: **SCOPED, NOT STARTED.** Written 2026-07-19 per user request ("scope it out all of it and document it for the next context") after `promote_scaleout_runner_cam_r4_fade_short` was bumped to HIGH priority (user confirmed intent to wire this up soon). This doc is the handoff — read it before writing any code for this feature.

## 1. What's being built and why

The 2026-07-19 scale-out research thread (full account: [TARGET_CALIBRATION_SPEC.md](TARGET_CALIBRATION_SPEC.md), [OPEN_THREADS.md](OPEN_THREADS.md) "START HERE") found that partial-exit-at-T1 + trailing-stop-on-the-remainder beats a single fixed target for exactly one setup, cross-validated and rigor-clean:

**`CAM_R4_FADE_SHORT`**: exit 10% of the position at the existing T1 (40pt), let the remaining 90% ride a 63.8pt trailing stop instead of a second fixed target. Baseline (100% at T1) OOS EV = -$0.58/trade; scale-out OOS EV = +$16.87/trade. N=39. Independently corroborated by `LEVEL_CONTINUATION` (61.9% of this level's failed fades continue 50pt+, avg 84.3pt) and `POST_RES_SEQ` (43.1% favorable-first). `PW_HIGH_FADE_LONG` also clears every guardrail but N=16 is thin — treat as a second candidate once the mechanism exists, not equally confirmed.

**Why this needs real engineering, not a config change**: every setup live in this codebase today resolves via a single fixed stop and a single fixed target — `resolveSetupsByPrice()` (`server/routes/acd.js` ~line 180) walks bars from `fired_at` and stops the instant either level is touched. There is no partial-exit concept, no path-dependent trailing level, and no notion of "this position now has two legs with different remaining risk." This is a genuinely new resolution model, not a parameter tweak.

## 2. RESOLVED 2026-07-19: the user trades 1 MNQ micro contract max, live

Confirmed directly: "I have no idea how to mathematically decide on sizing. Because it seems like i can only trade 1 micro without blowing out the prop account." This is a **portfolio-stacking constraint, not a single-trade risk constraint** — sanity-checked live: `CAM_R4_FADE_SHORT`'s current calibrated stop is 16pt = $33/contract risk (`$2/pt × 16pt + $1 commission`) against a $400 default DLL, so a single trade at 1 contract is nowhere near the DLL edge in isolation. The real threat is cascading stop-outs across *many different setups* stacking in one session (CLAUDE.md's cascade-breaker note: worst historical days saw 17-18 stop-hits across 20-29 setups). Not relitigated — the user's own account risk tolerance stands as-is.

**Consequence for this spec**: a literal "exit 10% at T1, let 90% ride" is not executable on a 1-lot position — you cannot sell 0.1 of a futures contract, and there is no near-term plan to trade more than 1 contract. Of the three options originally listed here (whole-contract split / blended-price bookkeeping / ask the user), the answer eliminates option 1 entirely (needs 2+ contracts) and makes option 2 the wrong frame too (a "manual decision point" reintroduces discretion into a system built to be mechanical). **The real reframe: with 1 contract, "what fraction to scale out" isn't a sizing question at all — it's a binary per-trade exit-timing decision (take profit at T1, or don't).** That turns this into a new single-position exit-mechanism design problem, not a position-sizing problem.

**New candidate mechanism, dispatched to Gemini for backtesting 2026-07-19**: "breakeven-then-trail" — stay on the normal stop until price reaches the existing calibrated target; instead of exiting, snap the stop to breakeven (worst case becomes a scratch, not a full loss) and trail it forward from there using the same data-derived trail-width methodology already built for the (now-moot) fractional version. Full request in `scratch/claude_request.md` as dispatched (may be overwritten by a later task — this doc is the durable record). Everything below this section (§3-10) describes the ORIGINAL fractional-scale-out design and is now superseded pending this new backtest's result — do not build the fractional-split schema/resolution-engine changes described below; they assumed an achievable partial fill that doesn't apply here. Once Gemini's result comes back (audit it first, per standing Gemini-output-audit rule), this section will be replaced with the actual single-position mechanism design (likely much simpler than §3-9 below — no partial-exit columns, no two-leg P&L blending, no `CAM_R4_FADE_SHORT_SCALEOUT` two-leg bookkeeping, just a dynamic stop-ratchet on the existing single-position model).

## 3. Proposed data model

Extend `active_setups` (not a new table — this setup still needs to flow through the existing resolution/display/timeline pipeline) with:

| Column | Type | Purpose |
|---|---|---|
| `scaleout_fraction` | `numeric(4,3)` | Fraction exited at T1 (e.g. `0.1`). NULL = normal single-exit setup, unchanged behavior. |
| `runner_trail_width` | `numeric` | Trail width in points (e.g. `63.8`), sourced live from `performance_audit`, never hardcoded. |
| `partial_exit_at` | `timestamp` | When T1 was touched and the partial fired. |
| `partial_exit_price` | `numeric` | Price of the partial exit (= `t1_level` under `PRICE_CLEAN`). |
| `partial_pnl_contribution` | `numeric` | This leg's weighted P&L contribution (`fraction * (t1_level - entry) * $/pt`), pre-commission-split — see open question in §2 on whether commission is charged once or twice. |
| `runner_peak_price` | `numeric` | Best favorable price since the partial — the anchor the trail is measured from. Ratchets one direction only, never loosens. |
| `runner_trail_price` | `numeric` | Current computed stop level for the runner leg (`runner_peak_price ∓ runner_trail_width`). Persisted so it survives across polls without recomputation drift. |

`resolution_method` gets two new values: `SCALEOUT_TRAIL_HIT` (runner leg closed on trail) and `SCALEOUT_TIME_EXPIRED` (runner leg still open at session close — see §6 EOD handling). `actual_pnl` becomes the blended total (partial leg + runner leg) once fully resolved.

**Why extend the existing table instead of a new one**: `dropToTimeline()`, the frontend trade-brief renderer, `SETUP_DISPLAY_LABELS`, and every downstream `performance_audit`/backtest query already key off `active_setups`. A parallel table would need its own version of all of that — direct violation of the single-source-of-truth rule.

## 4. Naming/tracking convention — new setup_type variant, not an in-place change

`CAM_R4_FADE_SHORT` already fires live today under the single-fixed-target model with its own `SETUP_STATUS` calibration. Silently changing its resolution behavior in place would corrupt that setup's own live-performance history (mixing single-exit and scale-out outcomes under one name) and make the existing SUPPRESS/PROMOTE pipeline meaningless for it.

**Follow the existing Conditional Variant Setup pattern** (CLAUDE.md convention, already used for GAP_UP/direction variants): introduce `CAM_R4_FADE_SHORT_SCALEOUT` as its own `setup_type`, added to `resolveSetupType()` and `CONDITIONAL_VARIANTS` in `server/config/setupTypes.js`, tracked with its own `SETUP_STATUS`/`OPTIMAL_STOP`-equivalent calibration. The base `CAM_R4_FADE_SHORT` keeps firing unchanged; the scale-out variant is a genuinely separate, independently-monitored setup that happens to share a detection trigger. This also means: **both could theoretically fire on the same touch** — needs a decision (mutually exclusive, one suppresses the other? or genuinely parallel, e.g. shown as two rows?). Recommend mutually exclusive (once scale-out variant is live/promoted, it replaces the base type's live firing, same as how any other conditional variant supersedes its base) — but flag this as a decision point, not settled here.

## 5. Resolution engine changes

Extend `resolveSetupsByPrice()` (`acd.js` ~line 180) with a scale-out branch, reusing its existing conventions (raw-text `fired_at`/bar-ts handling per the documented ET/UTC landmine, the shared-bars-fetch-once optimization, the conservative same-bar-stop-first tie-break):

**Phase A (pre-partial)**: identical to today's walk — for a scale-out row with `partial_exit_at IS NULL`, walk bars checking `stop_level` (full-position stop, unchanged from today) vs `t1_level` (now the partial trigger, not final). Same-bar tie-break: stop wins (conservative), exactly as today — a full stop-out before partial means no scale-out ever happened, resolve as a normal `STOP_HIT` for the full position.
  - On `t1_level` touch: don't resolve. Instead `UPDATE ... SET partial_exit_at=$, partial_exit_price=$, partial_pnl_contribution=$, runner_peak_price=t1_level, runner_trail_price = t1_level ∓ runner_trail_width`, row stays `status='ACTIVE'` (or a new intermediate status — see below).

**Phase B (post-partial, runner active)**: for rows with `partial_exit_at IS NOT NULL` and still unresolved, continue the bar walk **from `partial_exit_at` forward** (not from `fired_at` — the runner's own MFE/trail state only depends on price action after the partial fired):
  - Each bar: update `runner_peak_price = max(runner_peak_price, bar.high)` (long) or `min(..., bar.low)` (short) — ratchet only.
  - Recompute `runner_trail_price` from the new peak each time it moves favorably.
  - Check if the bar's low/high crosses `runner_trail_price` → resolve `SCALEOUT_TRAIL_HIT`, blended `actual_pnl = partial_pnl_contribution + (1-fraction) * (runner_trail_price - entry) * $/pt - commission_share`.

**Status field**: recommend adding `'PARTIAL'` as a new valid `active_setups.status` value (alongside `ACTIVE`/`SHADOW`/`RESOLVED`/`EXPIRED`) rather than overloading `ACTIVE` — the frontend and every `WHERE status IN (...)` query needs a clean way to distinguish "still fully at risk" from "partial locked in, runner active," and this also makes the live UI state (§7) trivial to drive.

## 6. EOD / session-close handling for an open runner

If the runner is still open at session close (no live overnight-hold convention exists for level-fade scalps today — confirm this is still true for `CAM_R4_FADE_SHORT` specifically), it needs a terminal resolution, same as `expireStaleSetups()`'s `TIME_EXPIRED` path does for normal setups today. Recommend: at the same cutoff the existing session-end cap uses (`sessionEndET`, currently 4:00 PM ET per the 2026-07-17 fix), force-resolve the runner leg at the last available close price, `resolution_method='SCALEOUT_TIME_EXPIRED'`. **This must be included in the live-vs-backtest health check (§8)** — the backtest's own trailing-stop simulation should already reflect how often this happens and at what average P&L, so a live rate wildly different from the backtest's own EOD-exit rate is itself a signal something's off.

## 7. Live wiring — config source and rollout

- **Never hardcode `0.1`/`63.8`.** Read `scaleout_fraction`/`runner_trail_width` live from the `performance_audit` row that validated them (`SCALEOUT_TIERED_TEST`, `signal_name='CAM_R4_FADE_SHORT'`) — same convention as `liveStats._opt[setup_type]` for normal stops/targets. If a future recheck (§8) revises the trail width, live picks it up automatically, no code change.
- **SHADOW-first**, matching the standing New Setup Type Checklist (CLAUDE.md): insert `CAM_R4_FADE_SHORT_SCALEOUT` as `status='SHADOW'` (well, `'PARTIAL'`-eligible-but-shadow — the PARTIAL status and SHADOW/ACTIVE origin are orthogonal, both need to compose) until N≥20 live-resolved trades clear the same promotion bar the base pipeline uses (WR/EV floor). Since this setup lives inside the standard level-fade candidates array (not a standalone poller), it can likely reuse the existing dynamic `_suppressedSetups` re-check rather than needing its own `getLiveStatus()` — confirm this once `CAM_R4_FADE_SHORT_SCALEOUT` has its own `SETUP_STATUS` row-generating script (a new `scripts/backtest_setup_status_scaleout.mjs`, or an extension of the existing one — TBD at implementation time).
- **Display**: `SETUP_DISPLAY_LABELS` needs an entry; `AlphaEngineOverview.jsx` needs a line describing the mechanism (this is new enough behavior that a generic label isn't self-explanatory); the trade-brief text needs to render the two-leg structure explicitly (partial target, then "trailing Npt runner" instead of a second fixed target) rather than the existing single-target sentence template — a real UI/copy change, not just a new field.

## 8. Live health instrumentation (closing the "no dead ends" loop)

Per CLAUDE.md's standing rule, this can't just go live and sit — needs:
- A recheck script (weekly, alongside `run_weekly_backtests.sh`) comparing realized live scale-out EV (once N is large enough to say anything) against the backtest's own OOS expectation — same pattern as `RESEARCH_CLAIM`'s 30-day recheck, but specifically flagging if live EV diverges meaningfully from the +$16.87/trade backtest figure (execution slippage on a trailing stop is a real, not-yet-tested risk — OHLC bar data can't fully validate whether a real trail would have triggered at the exact modeled price, same caveat as the bar-noise-floor finding earlier this thread).
- Register in `docs/ARCHITECTURE.md` once built (new resolution columns, new script) — not yet done since nothing is built.

## 9. Cross-reference: New Setup Type Checklist (CLAUDE.md) applied to this specific build

1. `backtest_setup_status.mjs`-equivalent → needs a new script (or extension) since this is tracked as a distinct variant (§4).
2. `update_optimal_stops.mjs`-equivalent → N/A in the traditional sense (trail width isn't a stop/target sweep) — the existing `SCALEOUT_TIERED_TEST` backtest already serves this role; needs a live-vs-backtest recheck instead (§8).
3. N<20 → SHADOW only (§7) — currently N=39 in backtest, but that's historical/OOS, not live-forward; live promotion still needs its own N≥20 per the standing rule, not inherited from the backtest sample.
4. Never hand-type stop/target/trail as a literal → §7, read from `performance_audit` live.
5. Simulate the real stop/target as an actual bar-by-bar trade → already done (`backtest_scaleout_runner_tiered.mjs`), this is the one item already satisfied going in.
6. Verify integration (`dropToTimeline()`, display label, direction inference) → explicitly called out in §7, not yet done.
7. Dynamic SHADOW→ACTIVE promotion → §7, likely reuses the standard candidates-array mechanism (not a standalone poller), confirm at implementation time.
8. Register any new `SETUP_STATUS` recommendation vocabulary in the Unified Signal Table status-mapping → applies if the new tracking script introduces any new recommendation string.
9. Fire-gate vs. data-availability timing → N/A, same detection trigger as the existing base setup, no new dependency.
10. Backfill/backtest population must match live firing window → the tiered backtest already used the TIME_EXPIRED-inclusive, unrestricted population (confirmed during that thread) — should already be consistent, re-verify once live.

## 10. Suggested build sequence

1. **Resolve §2 with the user** (contract-count reality) — this determines whether §3-7 need adjusting before any code is written.
2. Schema migration: new `active_setups` columns + `'PARTIAL'` status (per `docs/DB_MIGRATION_PROTOCOL.md`).
3. Resolution engine: Phase A/B bar-walk logic in `resolveSetupsByPrice()`, tested against the existing tiered backtest's own historical trades first (does the live engine's bar-walk reproduce the backtest's own N=39 P&L exactly, trade for trade, before trusting it on new data — same discipline as `test_invariants.mjs` check `[5]`'s re-derivation approach).
4. `CONDITIONAL_VARIANTS`/`resolveSetupType()` wiring for `CAM_R4_FADE_SHORT_SCALEOUT`, SHADOW-only.
5. Display/UI (§7 third bullet).
6. Let SHADOW accumulate to N≥20, then promote per §7.
7. Build the §8 recheck script once there's enough live data for it to say anything.

This is realistically its own multi-session build, not a single sitting — step 3 in particular (getting the resolution engine's bar-walk to exactly match the backtest, including the EOD/session-close edge case in §6) is where most of the real risk lives.
