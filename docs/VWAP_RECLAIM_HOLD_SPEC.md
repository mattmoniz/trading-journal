# VWAP Reclaim-and-Hold — trend-continuation entry spec

**Status: Phase 1 (backtest-only) DONE for BOTH RTH and Globex, 2026-08-04, per CLAUDE.md's standing rule to test both windows before calling anything complete. RTH: one real survivor (K=2 SHORT). Globex: clean negative, does NOT replicate — 0 of 6 cells pass rigor. Not yet built as a live setup — that's Phase 2/3, not started, and the Globex result argues against building a Globex variant at all. See "Phase 1 results" section at the bottom.**

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

## Phase 1 results (2026-08-04) — real backtest, honest negative on 5/6 cells, K=2 SHORT survives

Built `scripts/backtest_vwap_reclaim_hold_phase1.mjs` per the design above (NQ RTH only, 1-min bars
rolled into 5-min in-memory, `computeRunningVwapSeries()` reused directly, K∈{1,2,3}×{LONG,SHORT},
no-lookahead entry at the open of the bar following the Kth confirming close, structural
cross-back-through-VWAP stop, session-close cap).

**Dispatch note, for future reference on this thread**: Gemini's first build had two real bugs
Claude's code review caught before trusting anything — (1) the "blind control arm" wasn't actually
independent of the candidate population (every full K-bar hold trivially also satisfied the raw
2-bar "control" check, so the control was a superset containing 100% of the candidates, not a
separate counterfactual), and (2) `sweepOptimalStopAndTarget()` was imported but never called — a
hand-rolled, unguarded EV-max grid search was used instead, the exact "isolated spike" failure mode
this codebase has hit before. One correction round was sent; Gemini's own report of the "fixed" run
was not trusted at face value (the response file was corrupted by a file-collision bug a second
time despite explicit instruction to avoid it, and the reported numbers looked suspiciously
identical to the pre-fix numbers) — Claude independently re-ran the corrected script directly and
got the same numbers, which turned out to be genuine, not fabricated: for K=1 the control correctly
collapsed to a real, distinct population (N=0, since a full 1-bar hold *is* the raw cross — no
separate control population can exist for K=1 by construction), and for K=2/3 the candidate
population is apparently a small enough fraction of the raw-cross population that excluding it
barely shifted the pooled control EV. Lesson for future dispatches on this codebase: always
independently re-execute a script yourself when a "corrected" report's numbers look too similar to
the pre-fix ones — don't assume a coincidence is fabrication OR assume a report is honest without
checking; this one turned out to be real.

**Results** (N = candidate count, structural VWAP-cross-back stop, target swept via the real
`sweepOptimalStopAndTarget()`):

| K | Dir | N | WR | EV (cand) | Target | Rigor clean | Control EV | Beats control? |
|---|-----|---|----|-----------|--------|--------------|------------|-----------------|
| 1 | LONG  | 1384 | 45.3% | $0.87  | 35pt | NO  | $0.00 (N=0, degenerate — see above) | n/a |
| 1 | SHORT | 1351 | 37.9% | $1.36  | 50pt | NO  | $0.00 (N=0, degenerate — see above) | n/a |
| 2 | LONG  | 1000 | 62.0% | $2.21  | 20pt | NO (thirds: -0.51, 2.87, 4.26 — sign-unstable) | -$0.22 | yes, but not rigor-clean |
| 2 | SHORT | 919  | 37.0% | **$5.96** | 70pt | **YES** (thirds: 8.83, 8.13, 0.95 — all positive) | $2.02 | **YES** |
| 3 | LONG  | 807  | 35.6% | -$0.59 | 80pt | NO  | -$3.95 | negative EV regardless |
| 3 | SHORT | 725  | 39.0% | $4.58  | 70pt | NO (thirds: 7.94, 8.97, -3.11 — collapses late) | -$2.19 | yes, but not rigor-clean |

**Only K=2 SHORT survives every gate**: N≥20, `computeRigor` clean (stable sign across all 3
chronological thirds), and beats its properly mutually-exclusive control arm ($5.96 vs $2.02).
Additionally ran `computeReplication()` (per CLAUDE.md's confound checklist item 4 — required
whenever reporting the single best cell out of a sweep) treating the 6 (K,dir) cells as units: the
held-out pool of the other 5 cells is $1.54/trade (N=5267, 4/5 favorable) — same sign as the
selected cell, and K=2 SHORT ($5.96) stands clearly above that pool rather than just riding a
universally-positive family. `replicates: true`.

Every cell persisted via `recordClaim()` regardless of outcome (slugs
`vwap_reclaim_hold_k{K}_{long|short}_phase1`, `PROVISIONAL` status — this is a real backtest result,
not yet independently re-verified or live-forward-validated, so it doesn't earn `CONFIRMED` yet).

**Not yet done — the honest gap**: this is Phase 1 (does the thesis have any real edge at all) —
Phase 2 (an actual code review of a would-be live implementation) and the real build (the "genuinely
new plumbing" + the mutual-exclusion gate against `RTH_VWAP_FADE`, both flagged as must-haves in the
pre-build review above) have not started. One surviving cell out of six, on one instrument, RTH-only,
backtest-only, is a real result worth building on — not yet a validated live setup.

## Phase 1 results, Globex/overnight window (2026-08-04) — clean negative, does not replicate

Per CLAUDE.md's standing rule ("Any new setup, signal, or calibration finding must be evaluated for
BOTH the RTH window and the Globex/overnight window before being considered complete"), the RTH
result above is not "done" on its own. Built `scripts/backtest_vwap_reclaim_hold_globex_phase1.mjs`
— a close adaptation of the already-audited RTH script (identical candidate/control/target/rigor
logic, both previously-found bugs already fixed in the template it was built from), changing only
the session window: NQ bars from 6:00 PM ET through 8:30 AM ET the following calendar day, grouped
into one Globex session per night (evening bars pulled forward to join the following morning under
that morning's date, matching `active_setups.trade_date`'s own convention for overnight fires,
verified directly against real data), with the developing VWAP resetting at 6:00 PM instead of RTH
open. This time Gemini's build correctly reused the mutually-exclusive control arm and the real
`sweepOptimalStopAndTarget()` call from the start — no correction round needed — and the response
file wasn't corrupted (kept in its own file as instructed this time). Independently re-ran the
script directly and reproduced identical numbers before trusting the result.

| K | Dir | N | WR | EV (cand) | Target | Rigor clean | Control EV |
|---|-----|---|----|-----------|--------|--------------|------------|
| 1 | LONG  | 2490 | 38.5% | $0.43  | 20pt | NO | $0.00 (degenerate, same as RTH K=1) |
| 1 | SHORT | 2458 | 33.4% | $0.60  | 25pt | NO | $0.00 (degenerate) |
| 2 | LONG  | 1818 | 33.9% | -$0.25 | 30pt | NO | -$1.01 |
| 2 | SHORT | 1702 | 37.5% | **-$0.08** | 25pt | NO | -$0.88 |
| 3 | LONG  | 1486 | 33.6% | $1.79  | 40pt | NO | -$1.46 |
| 3 | SHORT | 1370 | 37.7% | $1.07  | 30pt | NO | $0.11 |

**The RTH survivor does not transfer**: K=2 SHORT is slightly negative overnight (-$0.08/trade,
vs +$5.96 in RTH) and, like every other Globex cell, fails the chronological-stability gate (thirds:
-0.49, -1.82, 2.07 — sign-unstable). Zero of the 6 Globex cells pass every gate the way RTH's K=2
SHORT did. This is a clean, honest negative, not a thin/inconclusive one — real N (1370-2490/cell,
larger than the RTH cells since the overnight window is ~14.5hrs vs RTH's 6.5hrs) and a uniformly
unstable/near-zero pattern across all 6 cells, not a borderline miss on one or two.

All 6 Globex cells persisted via `recordClaim()` (slugs
`vwap_reclaim_hold_globex_k{K}_{long|short}_phase1`, `rigorStatus='UNSTABLE'` for all, `PROVISIONAL`).

**Conclusion**: this idea does not generalize across sessions — RTH's K=2 SHORT edge looks like a
real, RTH-specific phenomenon (plausibly tied to RTH-only structural features like the opening
range, IB, or session-anchored order flow that don't exist the same way overnight), not a universal
VWAP-continuation effect. Building a live Globex variant of this setup is not supported by this
data. Whether the RTH-only finding is still worth building (Phase 2/3) given it's one cell out of
six, on one instrument, is the open question left in `OPEN_DECISION
vwap_reclaim_hold_phase1_build_next_or_not`.
