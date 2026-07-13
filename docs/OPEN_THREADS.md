# Open Threads / Pending Work

Living continuity tracker — distinct from [KNOWN_ISSUES.md](KNOWN_ISSUES.md) (bugs/tech debt found in code) and [ARCHITECTURE.md](../ARCHITECTURE.md) (structure). This file exists so that clearing context never loses a thread: confirmed-but-unimplemented decisions, proposals awaiting the user's go-ahead, stale stats discovered but not yet refreshed, and multi-session analysis work that isn't finished.

All hardcoded thresholds, suppressed setups, and design rationale: [docs/HARDCODED_CONSTANTS.md](HARDCODED_CONSTANTS.md)

When an item is finished, delete it (don't mark it done — git history is the record of what was fixed and when, same convention as KNOWN_ISSUES.md). When a session confirms a decision, proposes a follow-up, or finds a stats/data-freshness gap and doesn't finish it in the same session, add it here before the session ends.

## Pending decisions / unconfirmed proposals

- **update_optimal_stops.mjs — 2 lower-priority bugs from Opus audit (2026-07-13), not yet fixed.** The urgent one (stop candidates rescuing real losers into simulated wins at p90 — no chronological ordering between mae/mfe check) is fixed (candidates now capped at p75, matching the target-sweep's existing `maxT` cap). Remaining, lower-severity: (1) **unit-scaling inconsistency** — `-stop*2`/`+target*2` assume a flat $2/pt, but real $/pt varies 1.7-4.0x across setup types per the audit (likely from `sizeMultiplier` scaling position size), while the `actual_pnl` fallback branch uses the real, unscaled dollar value — the three EV branches aren't on fully consistent units. (2) **thin effective N at the stop candidate actually chosen** — `MIN_N=20` gates on *total* trades for a setup type, not on how many trades actually tested the chosen stop percentile (e.g. only ~25% of trades test a p75 stop by definition, so a type with N=20 total has only ~5 trades informing that specific choice). Neither is urgent-live-risk the way the p90 bug was, but both should be fixed before trusting the sweep fully. Proper fix for (1) likely needs the real per-trade $/pt from `active_setups`/`trades` rather than an assumed constant.

- **Pattern scanner (`patternScannerService.js`) — 3 bugs found via Opus review (2026-07-13), not yet fixed.** (1) `MIN_N = 8` for flagging a "discovery" — violates the project's N≥20 hard rule; many of the 128 currently-ACTIVE `pattern_discoveries` rows are statistically thin (e.g. N=8-12) and shouldn't be trusted as-is. (2) `pattern_discoveries.notified` is never set to `true` anywhere in the server (confirmed via grep) — the proactive-notification path was never wired up, not just broken. (3) Hardcoded cost model `{ target: 20, stop: 25 }` and `MIN_WR = 0.65` inside the scanner — same "no static thresholds" violation as (1), should derive from `active_setups` MAE/MFE per pattern like `update_optimal_stops.mjs` does. Also: `pattern_discoveries` has zero frontend consumers (grep of `src/` confirms) — the mining engine runs nightly and its findings are currently invisible except a passing mention in `morningBrief.js`. See the live-pattern-learning proposal (2026-07-13) for the fix-first-then-build plan: raise MIN_N to 20 + derive the cost model (½ day) → weekly "what I learned" digest wired through the dead notify path (~1 day) → live session anomaly watch on the minute bar stream (~2-3 days, bigger design, not yet scoped in detail).

- **WPP_FADE_SHORT_GAP_UP — monitor at N=50 (live 2026-07-09).** Gap-up subset (historical/retrospective): WR=59.3%, EV=+$8.7, N=27. **Checked 2026-07-13: live N=0** (zero rows with `setup_type='WPP_FADE_SHORT_GAP_UP'` in `active_setups` since going live — only 2 trading days have passed). Re-check when live N reaches 50; suppress via pipeline if EV drops below -$5.

- **90-day degradation watch (flagged 2026-07-09).** Three setups with alarming 90d EV vs prior history (not suppressed — all-time EV still positive, auto-suppression will catch them if it continues):
  - `OR_HIGH_FADE_SHORT`: prior=$90/trade → 90d=-$18/trade (N=20).
  - `PD_VAH_FADE_SHORT`: prior=$48 → 90d=-$68/trade (N=15).
  - `CAM_S2_FADE_LONG`: prior=$85 → 90d=-$13/trade (N=11). Monitor on next weekly run (Sun 9:20 PM).

- **IB_BEARISH all-stop sweep negative (2026-07-09).** Best EV at 20pt stop = -$21 (all-day-type blended, BALANCE drag). On TURBULENT IB_BEARISH is elite. Monitor: if TURBULENT-only IB_BEARISH shows negative EV via DAY_TYPE_ALPHA, consider removing from candidates entirely.

- **Pulse score — revisit at N≥100 live setups.** Demoted to informational 2026-07-08 (too many false negatives on strong days). Score chip visible in setup cards. `scripts/backtest_pulse_score.mjs` accumulates data weekly. Revisit: if BALANCE_SCORE_0 false-negative rate <40% on non-TURBULENT days at N≥100, consider re-enabling -0.10× penalty only.

- **sizeMultiplier re-audit at N≥100 (~2026-08-20).** `size_multiplier` column added 2026-07-06. Re-run `SELECT ROUND(size_multiplier,1), COUNT(*), ROUND(AVG((resolution='TARGET_HIT')::int)*100,1) AS wr FROM active_setups WHERE size_multiplier IS NOT NULL GROUP BY 1 ORDER BY 1` when N≥100. Freeze policy: no new ±0.10 factor tweaks until capture ratio improves or audit completes.

- **AI_SETUP_AGG accumulating — monitor (~2026-08-07).** `scripts/aggregate_ai_setup_reviews.js` flags NEEDS_ADJUST when avg < 3.5⭐ and N≥20. Currently N=1 for all 8 setups — need ~4 weeks of daily reviews.

- **HomeAssistant hosting (future, no timeline).** Access journal from HA sidebar via Cloudflare Tunnel (already running). Easiest: add `panel_iframe` to HA `configuration.yaml` pointing at tunnel URL — no backend/frontend changes. Prerequisite: verify tunnel URL is stable (not ephemeral trycloudflare.com free tier).

## 30-day shadow validation

- **IB_MID_SCALP_FADE_SHORT and OR_MID_AFTER_IB_FADE_SHORT** — both flip positive with tight stops but currently suppressed pending live validation. Check ~2026-08-05.
