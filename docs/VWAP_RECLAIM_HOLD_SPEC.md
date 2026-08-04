# VWAP Reclaim-and-Hold — trend-continuation entry spec (not yet built)

**Status: spec only, 2026-08-04. Not built. DeepSeek infra-risk critique + Gemini pre-build bug scan both in progress before any code is written — see the bottom of this doc once they land.**

## Why this exists

Session context: after 8+ risk-management wrapper ideas came back negative, and a genuine attempt at a non-mean-reversion strategy family (rolling-slope/volume pivot detection, DeepSeek-critiqued 2026-08-03 — see `docs/GEOMETRIC_SLOPE_VOLUME_PIVOT_SPEC.md`) turned out to still be reversal-detection at heart, 4 candidate ideas were brainstormed and blind-critiqued by both Gemini and DeepSeek. Two are now closed:
- **Permission Slip as a standalone trade**: built and tested (`scripts/backtest_permission_slip_standalone.mjs`). Confirmed negative — the 65-82% headline win rate collapses to 47-58% once real entry timing (not the 9:30 open) is used, 0/10 buckets EV-positive and rigor-clean. `RESEARCH_CLAIM permission_slip_standalone_real_entry_timing`.
- **Globex→RTH momentum carryover**: deprioritized by both models without a full build — fights a well-supported gap-fill base rate.
- **Post-flush continuation**: real archived finding but the original scripts (`scripts/archive/backtest_post_flush.js`, `backtest_flush_balance.js`) have confirmed lookahead in the balance-detection logic (scans forward to find the "best" balance window) — needs a full causal rewrite before it's trustworthy. Not started.

**VWAP reclaim-and-hold is the one candidate both models rated as genuinely worth building**, and the only one of the four with zero existing red flags from either critique.

## The idea

Every VWAP variant currently live in this codebase (`RTH_VWAP`, `WEEKLY_VWAP`, `MONTHLY_VWAP`, developing session VWAP) is wired ONLY as a fade magnet — `VWAP_MAGNET_LONG`/`SHORT` bets that price approaching VWAP will revert toward it. This is the opposite bet: price *crosses* VWAP and *holds* on the new side for K consecutive bars (doesn't immediately snap back) → treat that as a trend/regime confirmation and trade the continuation *away* from VWAP.

## Design, per both models' converged critique (2026-08-03)

- **Population**: RTH only for the first pass (per this codebase's own hard rule to test Globex separately, never assume RTH findings transfer).
- **VWAP source**: `computeRunningVwapSeries()` (`server/services/developingValueService.js:79`) — already a real, causal, per-bar function (confirmed by both models to have zero lookahead risk). Reuse directly, never reimplement.
- **Cross-and-hold definition**: price closes on the new side of developing RTH VWAP for K consecutive 5-minute bars. Sweep K ∈ {1, 2, 3} — don't hand-pick one value.
- **Entry**: open of the 1-minute bar immediately following the Kth confirming 5-minute bar's close. (Not the close of the confirming bar itself — that would be same-bar lookahead.)
- **Exit**:
  - Stop = price closes a 5-minute bar back on the *wrong* side of VWAP (a structural stop tied to the thesis itself: the regime-confirmation premise breaking is the invalidation).
  - Target = data-derived (percentile of favorable excursion, matching this codebase's own `sweepOptimalStopAndTarget()` convention — never a hand-picked point value) or session close, whichever the sweep prefers.
- **Kill criterion**: N≥20 per (K, tier) cell, `computeRigor()` clean (day-clustering + 3-way chronological stability), and — given this codebase's confound checklist — a check that the "hold" mechanic isn't just a structural/entry-price artifact (compare against a blind K-bar-delay control with no VWAP-side condition, same shape as the `pilot_overshoot_control_check.mjs` precedent that caught exactly this failure mode for a different idea).
- **Explicitly NOT reusing** `structural_breakout_phase0_retest_test`'s fractal-pivot ground truth (already tested negative, unrelated definition) or the `weakness_confirmation_entry_delay` control structure directly (different thesis — trend-continuation confirmation, not fade confirmation — but the *general* "add a confound control arm" discipline from that family of tests still applies).

## What's NOT decided yet

- Whether a survivor gets wired live via `CONDITIONAL_VARIANTS` as a brand-new setup_type family (`VWAP_RECLAIM_LONG`/`SHORT`), or some other integration point. No existing wiring pattern in this codebase currently supports a "cross-and-hold" trigger condition (`resolveSetupType()` and the `nearLevels` proximity-trigger convention are built for level-touch setups, not a multi-bar hold condition) — this may need real new plumbing, not just a `CONDITIONAL_VARIANTS` entry. Flag this explicitly to both reviewers.
- Stop/target sweep grid specifics (deferred to the build script itself, informed by real data).

## Pre-build reviews (2026-08-04) — both landed, key claims independently spot-checked against the code

### Must-fix / must-include before or during the build (both models converged, or independently verified)

1. **Retrofit `earlyVwap` first.** `acd.js:5436-5439`'s inline RTH VWAP loop weights by `(b.ask_vol||0)+(b.bid_vol||0)`; the canonical `computeRunningVwapSeries()` weights by `b.volume`. Verified directly — both lines match exactly as reported. If the new build calls the canonical function without retrofitting this old one, the live poll ends up computing two silently-divergent RTH VWAP values from different volume sources, with nothing to detect the drift. Fix the old call site first (~3 lines), then the new consumer reuses the same result.
2. **New mutual-exclusion gate required — HIGH severity, DeepSeek-only finding, verified real.** `RTH_VWAP_FADE` (`acd.js:6096`, part of `keepLevelsAll`/`nearLevels`, fires within 15pt of VWAP) and the new VWAP_RECLAIM setup would both trigger near VWAP at the same time, and can bet **opposite directions** — RTH_VWAP_FADE bets reversion toward VWAP, VWAP_RECLAIM bets continuation away from it. Verified directly: `approachDir` (`acd.js:5555`) and `isLong = approachDir === 'FROM_ABOVE'` (`acd.js:6176`) confirm RTH_VWAP_FADE's direction is a real, independent function of approach side — nothing in `nearLevels`, the cascade breaker, or `resolveSetupType()` checks for a contradictory concurrent signal. Without an explicit gate, the system could insert two directly-contradicting rows into `active_setups` on the same poll. (VWAP_MAGNET, by contrast, cannot collide — it only fires ≥1.5σ from VWAP, physically incompatible with a just-crossed price.)
3. **Confirmed, not just asserted: this is genuinely new plumbing, not a `CONDITIONAL_VARIANTS` entry.** `resolveSetupType()` and `nearLevels` are single-point-in-time checks (name rewriting, static proximity) with zero multi-bar/temporal logic anywhere in that path. Needs its own detection block (same shape as `vwapMagnetSetup`/`ibSetup`), its own candidate object, and the full 10-item setup-type checklist from CLAUDE.md — not a lighter-weight variant registration.
4. **Bar-resolution mismatch**: the spec defines the hold condition on 5-minute bars, but the live poll's native RTH bar source (`allRthBarsRow`) is 1-minute. Needs either a second 5-min query or in-memory rollup — minor but real added surface.
5. **Lookahead trap already known elsewhere in this codebase, worth restating**: `level_prices`' `RTH_VWAP` row is an end-of-session snapshot, already excluded from `backtest_confluence_globex.js`/`pilot_structural_stop_placement.mjs` for exactly this reason. Never read it live — `computeRunningVwapSeries()` (or the retrofitted `earlyVwap`) is the only correct live source, matching what the spec already says.
6. **New-setup-family precedent, worth reading before naming anything**: the one prior non-level-touch setup family in this codebase, `MOMENTUM_60m_60m` (`server/services/minuteBarSignalDetector.js`), has several variants that got a `SETUP_STATUS` row but never a live poller and sit as half-wired dead weight (`ARCHITECTURE.md:636`). Follow the CLAUDE.md checklist's items 6/7 (integration verification, standalone-poller promotion gap) deliberately, not just items 1-4.

### Contained, not a blocker

- Performance: negligible (K≤3 bar scan against an already-390-bar-per-poll workload with 14s of a 15s budget to spare).
- `liveStats` block-scoping footgun: avoidable by placing the new detection block inside the existing `if (currentPrice && allRthBarsRow.rows.length >= 3)` block, same as the other VWAP/level blocks already do.
- The `Promise.all` positional-destructuring footgun (CLAUDE.md) lives in `antigravityEdges.js`, not in this part of `acd.js` — not a risk for this specific build.

Full reviews: `scratch/antigravity_response.md` (Gemini), `scratch/deepseek_response.md` (DeepSeek, ANSI-noisy but complete — cleaned copy easier to read).
