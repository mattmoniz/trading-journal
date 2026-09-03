# Extreme cumulative-delta "point of no return" — scope (2026-09-03)

**Status: SHADOW-only live build shipped 2026-09-03.** `IB_LOW_PNR_SHORT` -- a new,
standalone-poller setup type -- is wired live (`server/services/ibLowPnrDetector.js`,
polled every 60s from `server/index.js`), always fires SHADOW (real live N=0, this
codebase's own N>=20 floor applies), and its own custom hold-to-close/mark-to-market
resolution lives in `resolveSetupsByPrice()` (`server/routes/acd.js`). Upside (IB High
break, LONG) version is NOT built -- it shows the same effect SIZE but FAILS rigor (not
chronologically stable); revisit only if re-checked with more history. Read this doc
fresh before touching `ibLowPnrDetector.js`, `getCumulativeDeltaBaseline()`
(`touchQuality.js`), `isCrossDirectionFastFlip`, or extending this to the LONG side.

## Origin

User traced real `IB_LOW_FADE_SHORT` stop-outs on confirmed breakdown days (2026-09-02/03)
and hypothesized: these reversal-pairing IB setups (`IB_LOW_FADE_SHORT`, `IB_HIGH_FADE_LONG`)
only work when the market is genuinely trying to break OUT of a balance area — a real fight
between buyers and sellers at the edge, not noise. That led to checking whether cumulative
order-flow delta (running `bid_volume - ask_volume`, i.e. aggressive-selling-minus-aggressive-
buying) shows a detectable "point of no return" — a pressure level beyond which a session is
much less likely to reverse back above/below its Initial Balance boundary.

## What's confirmed so far

### 1. Day-level base rate (market behavior, not setup performance — tested via raw
`price_bars_primary` history, not `active_setups`, per this codebase's own "market behavior
hypotheses go through bar history first" rule)

Scanned full NQ history (2023-01-01 to present, ~451 RTH days with a computable Initial
Balance). On a normal day, **it is extremely rare for price to never close back above the
day's IB Low at some point during the session — under 1% (0.7%) of all days.** Symmetric
finding: under 1% (0.3%) of days never close back below IB High either.

### 2. The "extreme cumulative delta" signal, properly normalized (NOT a fixed dollar amount)

**First version was wrong and was corrected.** A first pass used fixed absolute-point
cumulative-delta thresholds (500 to 15,000) across the full 2023-2026 window and found a
clean-looking monotonic curve (4.5% -> 68% never-recover as the threshold rose) — but this
is confounded: NQ's price level and typical volume/volatility have grown enormously over that
span, so a "9,000" day in 2023 and a "9,000" day in 2026 are not comparable. This is exactly
the kind of static threshold this codebase's own hard rule (no static thresholds, derive from
a rolling distribution) exists to prevent, and it was violated here before being caught.

**Corrected version**: at every bar since the Initial Balance closes (10:30 ET), compute a
z-score for today's *cumulative* delta-so-far against a **90-day trailing, same-bar-index
baseline** (mean/std of what cumulative delta has historically looked like at that exact point
in the session, using only the 90 days *before* today — no lookahead, same convention as
`touchQuality.js`'s existing `getVolumeBaseline()`). Track the first time this z-score reaches
various levels, then ask: after that point, does price ever recover back across the IB
boundary?

**Downside (sell-side pressure vs IB Low), z >= 3.0, N=29 days (2025-07 to 2026-07):**
- 31.0% never recover above IB Low afterward, vs. the 0.7% unconditional baseline (~44x lift)
- **Passes this codebase's own rigor check** (`computeRigor()`): NOT day-clustered (top-5-day
  share only 17.2%), chronologically **stable** across early/middle/late thirds of the
  dataset (all three show the same ~2-to-1 recover-vs-not ratio), `clean: true`.

**Upside (buy-side pressure vs IB High), z >= 3.0, N=26 days:**
- 30.8% never recover below IB High afterward, vs. the 0.3% baseline — nearly IDENTICAL
  effect size to the downside version, a real point in favor of this being a genuine
  structural phenomenon rather than a downside-only coincidence.
- **FAILS the rigor check** (`clean: false`, `stable: false`) — the earliest third of the
  dataset shows ~0% edge (dead even), while later thirds show a real one. Less trustworthy;
  possibly a more recent regime effect rather than a durable structural fact. Do not treat this
  side the same as the downside version until it's re-checked with more history or a different
  cut.

### 3. Two important limitations found before trusting either side

- **Mostly a LAGGING signal relative to the *initial* IB break, not a leading one.** At a
  representative threshold, cumulative delta crosses the extreme level *after* price has
  already broken the IB boundary 69.4% of the time (avg lag ~69 min, median 39 min) — only
  21.4% of the time does it cross first. Session-average max cumulative delta (6,399) is more
  than double a mid-range threshold (3,000), meaning the threshold-crossing point is usually
  NOT near the day's own eventual extreme — there's typically much more accumulation still to
  come after crossing.
- **Doesn't show up in the first 2.5 hours of the session.** Checked minute-by-minute (every
  10 minutes from 10 to 150 minutes post-IB-close) — extreme z-score readings in that early
  window are both rare (single digits to high teens out of ~295 days) and show close to 0%
  edge. The real "point of no return" reads mostly emerge in the early-to-mid afternoon (2-4pm
  ET), based on tracing actual crossing times. This means the signal, if used, gives a
  significantly shorter runway to act than a full session would — this is an afternoon-window
  mechanism, not a morning one.

## Trade simulation + dynamic-exit test (resolved this session, before the build)

**Bar-by-bar trade simulation** (entry at the crossing bar's close, price already below IB
Low — matching `maeMfeReplay.js`'s `replayBars()` convention, not just a price-level
pass/fail): N=15 real-population trades (2023-2026, z>=3.0 crossings with price below IB
Low). WR=66.7%. Stop sweep found **stop=150-170pt with NO fixed target (hold to session
close) as the best config, EV=$276-281/trade** — every fixed-target variant tested
underperformed hold-to-close.

**Dynamic z-score-based exit tested and REJECTED.** A 10-bar rolling-window delta z-score
(re-scored against the same 90-day baseline) was tried as an alternative to the fixed
stop. Clearly worse (best result EV=$82 vs the fixed stop's $276) — it fires on ordinary
counter-trend noise and kills real continuation moves early (concrete case: 2026-06-05
went from a $1,212 winner without it to a -$95 loser with it). Do not chase a longer
window variant; this sub-thread is closed, logged as "tried, didn't work."

**Placebo control (DeepSeek's recommended check, run before building):** does the z>=3
filter add anything beyond "price below IB Low in the same afternoon window"? Built the
control population -- same window, same stop=150pt, same hold-to-close, but NO z-filter:
N=207, WR=39.6%, EV=**-$0.22/trade** (flat/negative after commission). The z>=3 filtered
population's $276.27 EV against that flat baseline is a decisive separation -- the
z-score is doing the real work, not the time-window or the IB Low condition alone.

**Honest caveat found by the same check's day-concentration pass:** the top 2 of 15 days
(2025-11-20, 2026-06-05) carry 71% of the total $ edge; top 3 carry 87%. Not a red flag on
its own (a continuation/tail-capture trade is supposed to look like this — usually
roughly breakeven, occasionally captures a big day), but it means the exact EV number is
unconfirmed until real forward N firms up the shape of the edge, not just its sign.

## What is NOT yet known (do not skip before extending this further)

1. **Retest-specific timing, still unanswered.** `IB_LOW_FADE_SHORT` enters at the RETEST
   (after the initial break), not at the initial break itself. "Lags the initial break by
   ~69min" does not necessarily mean it lags the retest, since the retest is itself downstream
   of the initial break. Need to check z-score specifically AT the retest moment, not the
   initial break moment. Not required to ship IB_LOW_PNR_SHORT (it's a standalone
   momentum entry, not a filter on IB_LOW_FADE_SHORT — see mechanization decision below),
   but still open if option (B) below is ever revisited.
2. **Upside version's instability is unresolved**, not just noted. Don't build anything
   symmetric until re-checked with more history or a different cut.
3. **DeepSeek design review done (2026-09-03, scratch/deepseek_response.md); no Gemini
   mine-and-run pass yet.** DeepSeek's critique is incorporated into the build (see below);
   a heavier independent Gemini pass (re-verify the baseline construction and the N=15
   trade sim from scratch, blind to this session's methodology) has not been run.

## How this is mechanized

Four genuinely different ways to use a validated "point of no return" signal were
considered, not mutually exclusive. **(A) is BUILT** (2026-09-03); B-D remain design
sketches only, not started.

**(A) BUILT — a new, standalone momentum-continuation setup type, `IB_LOW_PNR_SHORT`**,
distinct from `IB_LOW_FADE_SHORT`. `server/services/ibLowPnrDetector.js` (polled every
60s from `server/index.js`, alongside the other standalone-poller setups). Trigger:
cumulative sell-side-delta z-score (90-day trailing, same-bar-index baseline,
`touchQuality.js`'s `getCumulativeDeltaBaseline()`) crosses 3.0 AND price is below today's
IB Low. Entry: immediate, at the crossing bar's close. Stop: 150pt (the best backtested
config at N=15 — a literal pending real OPTIMAL_STOP-based recalibration once real forward
N accumulates, same caveat `pocRotationJoinDetector.js`'s own stop literal carries). No
fixed target — holds to session close (early-close aware), resolved via a custom
hold-to-close/mark-to-market branch in `resolveSetupsByPrice()`. Registered its own
`bet_class` (`IB_LOW_PNR`, `BET_CLASS_STAGE: SHADOW`) rather than folded into
`CONTINUATION_LEGACY`, matching the `FAILED_SWEEP_REVERSAL`/`OPENING_DRIVE_15MIN`
precedent — and deliberately NOT named `*_FADE_*` so `getBetClass()` doesn't misclassify
it as mean-reversion (DeepSeek review). Real live N=0 — **always fires SHADOW** regardless
of any future SETUP_STATUS row, per this codebase's own N>=20 floor.

**Gating**: calls `isCrossDirectionFastFlip`/`isPostWinOppositeFamilyBlocked` itself
(both newly exported from `acd.js` for this) using the *`IB_LOW_FADE` family key*, not its
own setup_type name — DeepSeek's review found this is the same underlying "did IB Low
reclaim" event `IB_LOW_FADE_LONG` bets on (for reclaim), and both shipped gates are
string-keyed off setup_type, so they'd otherwise be structurally blind to two
opposite-direction bets on the same event.

**Not yet done from this build**: a real, promoted `scripts/backtest_ib_low_pnr_short.mjs`
(the trade-sim logic still lives in scratch, not wired through `record_claim.mjs`); a
Gemini independent re-verification pass; the retest-timing question (open question #1
above, only relevant if option B is revisited later).

**(B) A filter/gate on the EXISTING `IB_LOW_FADE_SHORT` (and symmetric `IB_HIGH_FADE_LONG`)
retest entries.** At the moment of the retest, check whether the z-score has ALREADY crossed
a threshold; if not, suppress the trade to SHADOW (or size it down); if yes, allow/size up.
Directly depends on resolving open question #1 above (is the signal present AT the retest,
not just "eventually, later in the day").

**(C) A post-entry management signal** for any open RTH short (mirroring the existing,
already-live `deltaConfirmation.js` informational badge, and its already-documented failure
history: post-entry confirmation has been tested 3 separate times as target-widening,
early-exit, and unconditional signal — ALL THREE failed to be actionable, remaining
informational-only). Given that track record, this option should be treated skeptically by
default, not assumed to work just because the descriptive fact is real.

**(D) A suppression gate on the OPPOSITE-direction setups roster-wide** — once the extreme
sell-side pressure threshold crosses, actively force-SHADOW any LONG-side fade setups that bet
on a bounce, similar in spirit to today's `isCrossDirectionFastFlip`/`isPostWinOppositeFamilyBlocked`
gates but triggered by a market-wide pressure signature rather than "another same-family trade
is open." Broadest blast radius of the four options — would need the most caution.

B-D remain unbuilt design sketches. Do not start any of them on the assumption the day-level
pattern alone justifies it — this project's own standing rule is that a validated descriptive
fact is not automatically an actionable one, and this exact signal family (cumulative delta)
has a real, documented history of failing to translate into anything tradeable despite being
real (see `cumulative_delta_confirms_fades_stronger_than_breakout` and its 3 failed downstream
uses, `docs/OPEN_THREADS.md`/RESEARCH_CLAIM history). Option A above got the placebo-control
treatment before being built; B/C/D would need the same discipline before any of them ship.

## Scripts used this session (scratch, not yet promoted to `scripts/`)

The exploratory/backtest work (day-level base rate scan, the N=15 trade sim, the stop
sweep, the dynamic-exit test, the placebo control) still lives in the session's
scratchpad, not `scripts/` — only the LIVE poller (`server/services/ibLowPnrDetector.js`)
and the shared baseline function (`touchQuality.js`'s `getCumulativeDeltaBaseline()`) are
real, committed code. Before the next session extends this further, the trade-sim/backtest
logic should be promoted into `scripts/backtest_ib_low_pnr_short.mjs` and wired through
`record_claim.mjs`, per this codebase's own "every tested claim gets recorded" rule — not
yet done as of this build.
