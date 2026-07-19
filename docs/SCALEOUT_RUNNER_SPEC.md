# Breakeven-Then-Trail Execution — Build Spec

Status: **SCOPED, NOT STARTED, methodology finalized.** Originally written 2026-07-19 as a fractional scale-out spec; **fully revised the same day** after the user confirmed a 1-contract execution constraint invalidated the fractional design, and a corrected backtest (2 Gemini rounds, both audited) landed on a different, simpler mechanism with different survivors. This is the current, durable version — the fractional-split design (partial-exit columns, two-leg P&L blending, `_SCALEOUT` variant naming) is fully superseded and should not be built.

## 1. What's being built and why

Every setup live in this codebase today resolves via a single fixed stop and single fixed target — `resolveSetupsByPrice()` (`server/routes/acd.js` ~line 180) walks bars from `fired_at` and stops the instant either level is touched. This spec adds one new, genuinely 1-contract-compatible mechanism: **breakeven-then-trail** — stay on the normal stop until price reaches the setup's existing calibrated target; instead of taking profit there, snap the stop to breakeven (worst case from that point becomes a scratch, not a full loss) and trail the stop forward from the running peak-favorable price using a data-derived trail width. No partial exit anywhere — the whole 1-contract position moves together.

**Origin**: started as a fractional 10%-at-T1/90%-trailing design for `CAM_R4_FADE_SHORT` (see §2 for why that's dead). Reframed the same day once the user confirmed a hard 1-contract live-trading constraint (portfolio-stacking risk, not single-trade risk — sanity-checked: `CAM_R4_FADE_SHORT`'s 16pt stop is only $33/contract against a $400 DLL, nowhere near the edge in isolation; the real risk is many different setups' stops cascading in one session). A fraction can't be executed on 1 contract, so the mechanism had to change from "split the position" to "change how the stop moves."

## 2. RESULT (2026-07-19, final): 6 survivors, `CAM_R4_FADE_SHORT` is NOT one of them

Backtested via Gemini, 2 dispatch rounds, both audited by Claude directly against the DB (not trusted from Gemini's own text — its response file was garbled/truncated both times):

- **Round 1** (initial dispatch): found 6 survivors including `CAM_R4_FADE_SHORT` (baseline OOS -$0.58 → mechanism OOS +$24.15). Audited before trusting: the population query used `WHERE status = 'RESOLVED'`, silently excluding all `TIME_EXPIRED` trades — the same population-exclusion bug class found and fixed 3 times earlier this session in `update_optimal_stops.mjs`. Confirmed directly: this excluded ~12% of `CAM_R4_FADE_SHORT`'s and `PD_LOW_FADE_LONG`'s trades. Also found the EOD/session-close approximation used UTC-calendar-day rollover instead of the real 4PM ET convention.
- **Round 2** (correction, both fixes applied and verified on disk): re-run, and independently re-executed the corrected script directly (not just trusted Gemini's re-run) to confirm reproducibility — exact same 6 survivors both times, 0 stale rows. **`CAM_R4_FADE_SHORT` and `PD_LOW_FADE_LONG` no longer survive** — `CAM_R4_FADE_SHORT` specifically fails the 2D-grid plateau-robustness check once the population is complete (its T1-reach count went 39→40, but the surviving trail width's neighbors no longer both hold up). Two new setups qualify: `DAILY_OPEN_FADE_LONG` and `PD_POC_FADE_LONG`.

**Final 6 survivors** (all rigor-clean — day-clustering under ~4-12%, chronologically stable; all cross-checked directly against `LEVEL_CONTINUATION`/`POST_RES_SEQ`, not just trusted from the backtest's own claim):

| Setup | Tier | N (T1 reaches) | Baseline OOS EV | Mechanism OOS EV | Trail width | Scratch rate | LEVEL_CONTINUATION corroboration |
|---|---|---|---|---|---|---|---|
| `FLOOR_R1_FADE_SHORT` | A (snug) | 77 | $8.03 | **$11.69** | 15.5pt | 2.7% | 62.5% big-continuation, avg 106.2pt |
| `DAILY_OPEN_FADE_LONG` | B (wide) | 46 | $7.72 | $10.28 | 18.8pt | 0.0% | 76.1% big-continuation, avg 161.5pt |
| `FLOOR_S1_FADE_LONG` | B | 44 | $2.61 | $6.57 | 20.3pt | 0.0% | 68.1% big-continuation, avg 167.8pt |
| `CAM_S2_FADE_LONG` | B | 31 | $0.23 | $2.93 | 40.3pt | 3.6% | 72.3% big-continuation, avg 167.4pt |
| `PD_POC_FADE_LONG` | B | 30 | $2.00 | $3.58 | 17.3pt | 0.0% | 62.7% big-continuation, avg 180.9pt |
| `PW_HIGH_FADE_LONG` | B | 16 (thin) | $4.71 | $11.39 | 39pt | 0.0% | none found | 

**Read this correctly — it's a different kind of finding than the retracted one.** Every survivor here already has a *positive* baseline OOS EV without the mechanism — this is a modest, consistent incremental improvement (+$1.60 to +$4/trade OOS on the 5 non-thin setups) layered on already-decent setups, not a dramatic loser-to-winner transformation. The original `CAM_R4_FADE_SHORT` claim (-$0.58 → +$16-24) was more dramatic and more exciting, and it didn't hold up. This is real but modest — size expectations accordingly. `FLOOR_R1_FADE_SHORT` is the strongest candidate to build first (largest N by a wide margin, consistent full/OOS behavior). `PW_HIGH_FADE_LONG` stays thin (N=16, below this codebase's own N≥20 floor) in every version of this analysis run today — treat as suggestive only.

Recorded: `RESEARCH_CLAIM` `breakeven_then_trail_single_position_2026_07_19` (CONFIRMED). The original `RESEARCH_CLAIM` `scaleout_runner_cam_r4_fade_short` is RETRACTED (full account in its own notes). `OPEN_DECISION` `promote_scaleout_runner_cam_r4_fade_short` updated to reflect this — the slug is now stale-named (kept for history/traceability rather than renamed) but its content points to `FLOOR_R1_FADE_SHORT` as the actual candidate.

Raw data: `performance_audit` `signal_type='BREAKEVEN_TRAIL_TEST'`. Backtest script (real, working, audited): `scripts/backtest_breakeven_trail.mjs` (moved from `scratch/` the same session it was built — not yet added to `run_weekly_backtests.sh`, that's still step 1 of §10).

## 3. Proposed data model — much simpler than the original fractional design

No partial-exit bookkeeping needed. Extend `active_setups` with:

| Column | Type | Purpose |
|---|---|---|
| `runner_trail_width` | `numeric` | Trail width in points (setup-specific — 15.5 for `FLOOR_R1_FADE_SHORT`, etc.), sourced live from `performance_audit`, never hardcoded. |
| `breakeven_armed_at` | `timestamp` | When price first reached the calibrated target and the stop snapped to breakeven. NULL = still on the original stop. |
| `runner_peak_price` | `numeric` | Best favorable price since arming — the anchor the trail is measured from. Ratchets one direction only, never loosens. |
| `runner_trail_price` | `numeric` | Current computed stop level (`max(entry, peak - trail)` long / `min(entry, peak + trail)` short — never worse than breakeven once armed). Persisted so it survives across polls without recomputation drift. |

`resolution_method` gets one new value: `BREAKEVEN_TRAIL_HIT` (or `BREAKEVEN_TIME_EXPIRED` if still open at session close — §6). `actual_pnl` is just the normal single-leg formula against wherever the (possibly-ratcheted) stop or target closed the trade — no blending, no fraction math. This is a genuinely simpler build than the original fractional design: no `'PARTIAL'` status needed (the row stays `ACTIVE`/`SHADOW` the whole time, just with a dynamically-moving stop), no two-leg P&L formula, no new setup_type variant naming scheme (see §4).

## 4. Naming/tracking convention — reconsider whether a variant name is even needed

The original fractional design needed a new setup_type name because it changed the setup's own P&L distribution enough to corrupt its existing SUPPRESS/PROMOTE calibration if mixed in-place. This mechanism is milder — it only changes the OUTCOME once the trade is already a winner (better exits on wins, same losses on losses) — so mixing it into the base setup_type's own live history is a smaller distortion than the fractional version would have caused, but it's still a real distortion (the EV distribution genuinely changes). **Recommend still using a distinct name** (e.g. `FLOOR_R1_FADE_SHORT_TRAIL`) via the existing Conditional Variant Setup pattern (`resolveSetupType()`/`CONDITIONAL_VARIANTS` in `server/config/setupTypes.js`), same reasoning as before: keep the base setup's calibration history clean, track the new mechanism's own live performance independently, SHADOW-first until it proves itself. Both firing on the same touch should be mutually exclusive (the trail variant supersedes the base once promoted), not shown as two parallel rows.

## 5. Resolution engine changes

Extend `resolveSetupsByPrice()` (`acd.js` ~line 180) — this is now a single-phase extension of the EXISTING per-bar loop, not two separate phases:

- Walk bars from `fired_at` exactly as today, checking `stop_level` vs `t1_level`, same conservative same-bar-stop-first tie-break.
- On a `t1_level` touch (where today's code would resolve `TARGET_HIT`): if the setup_type is trail-eligible, instead of resolving, set `breakeven_armed_at = bar.ts`, `runner_peak_price = bar.high/low` (the touch bar's extreme), `runner_trail_price = entry` (breakeven). Row stays `ACTIVE`/`SHADOW`, keep walking.
- On every subsequent bar (once armed): update `runner_peak_price` (ratchet only), recompute `runner_trail_price = max(entry, peak - trail)` / `min(entry, peak + trail)`, ratchet `runner_trail_price` forward only (never loosen). If the bar's low/high crosses `runner_trail_price`, resolve `BREAKEVEN_TRAIL_HIT` with `actual_pnl` from entry to `runner_trail_price` — standard single-leg formula, no blending.
- **Match the backtest's own same-bar edge case**: if the same bar that first touches the target ALSO breaches the fresh breakeven stop (a sharp same-bar reversal), resolve immediately as a scratch (`BREAKEVEN_TRAIL_HIT` at breakeven) rather than letting it ride — this exact case is in `scratch/backtest_breakeven_trail.mjs` (lines ~216-225) and materially affects the reported scratch rates; the live engine must reproduce it exactly or live results won't match the backtest's own numbers.

## 6. EOD / session-close handling

If still open (armed or not) at session close, force-resolve at the last close price — reuse the existing `sessionEndET` (4:00 PM ET) convention already in `acd.js`, exactly as the corrected backtest does (§2's round-1→round-2 fix). `resolution_method='BREAKEVEN_TIME_EXPIRED'`.

## 7. Live wiring — config source and rollout

- **Never hardcode trail widths.** Read `runner_trail_width` live from `performance_audit` `signal_type='BREAKEVEN_TRAIL_TEST'` for each specific setup_type (15.5 for `FLOOR_R1_FADE_SHORT`, 18.8 for `DAILY_OPEN_FADE_LONG`, etc.) — same convention as `liveStats._opt[setup_type]`. Move `scratch/backtest_breakeven_trail.mjs` into `scripts/` and add it to `run_weekly_backtests.sh` so this stays current automatically.
- **SHADOW-first**, N≥20 live-resolved trades before promotion, same standing rule as every other new setup type — the backtest's own N (77 for `FLOOR_R1_FADE_SHORT`) is historical/OOS, not live-forward; live promotion needs its own count.
- **Display**: `SETUP_DISPLAY_LABELS` entry, `AlphaEngineOverview.jsx` line describing the mechanism, and the trade-brief text needs to say "target reached → stop moves to breakeven, trailing Npt" instead of the current single-target sentence once armed — a real UI state change (the setup's own card should visibly show "armed, trailing" vs "at risk").

## 8. Live health instrumentation

Per CLAUDE.md's standing rule: a weekly recheck comparing realized live mechanism EV against the backtest's own OOS expectation per setup — flag if live diverges meaningfully. Register in `ARCHITECTURE.md` once built.

## 9. Cross-reference: New Setup Type Checklist (CLAUDE.md)

Same as the original spec's §9, condensed: (1) needs its own `SETUP_STATUS`-equivalent tracking per variant name — not built; (2) trail width already backtest-derived, needs the live recheck in §8; (3) SHADOW until N≥20 live, not inherited from backtest N; (4) never hand-type the trail width, read live; (5) already satisfied — the backtest simulates the real bar-by-bar mechanism, not a raw label; (6) integration (`dropToTimeline()`, display label, direction inference) not yet done; (7) confirm the standard candidates-array `_suppressedSetups` re-check applies, or build a `getLiveStatus()` if this ends up wired as a standalone poller; (8)-(9) N/A / no new dependency; (10) population/window match — confirmed via the round-1→round-2 correction in §2, this is the one item that got directly, concretely verified this session rather than assumed.

## 10. Suggested build sequence

1. `scripts/backtest_breakeven_trail.mjs` already exists (moved from `scratch/` already) — clean it up and add to `run_weekly_backtests.sh` so it stays current automatically.
2. Schema migration: 4 new `active_setups` columns (§3), no new status value needed (per `docs/DB_MIGRATION_PROTOCOL.md`).
3. Resolution engine: single-phase extension to `resolveSetupsByPrice()` (§5) — verify it reproduces the backtest's own `FLOOR_R1_FADE_SHORT` trade-for-trade P&L before trusting it on new data, same discipline as `test_invariants.mjs` check `[5]`.
4. `CONDITIONAL_VARIANTS`/`resolveSetupType()` wiring for `FLOOR_R1_FADE_SHORT_TRAIL` (start with just this one setup, not all 5 at once), SHADOW-only.
5. Display/UI (§7).
6. Let SHADOW accumulate to N≥20, promote, THEN consider adding the other 4 non-thin survivors the same way.
7. Build the §8 recheck script once there's live data.

Smaller build than the original fractional design (no two-leg P&L, no partial-exit state), but still real engineering — a dynamic, path-dependent stop is new to this codebase's resolution engine regardless of mechanism. Start with `FLOOR_R1_FADE_SHORT` alone (largest, cleanest N) before generalizing to the other 4.
