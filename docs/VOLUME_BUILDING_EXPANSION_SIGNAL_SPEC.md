# Volume-Building Strength as a Non-Directional Expansion Precursor

## CORRECTION 2026-08-30: `classifyLevelFormation()` had a real bug — fixed, finding survives and strengthens

A full DeepSeek code-review audit found that `classifyLevelFormation()` (added 2026-08-30, see
§6b/§6c below) put 13 real PRIOR_PERIOD setup_types — `PD_IB_HIGH/LOW/MID`, `PD_OR_MID`,
`5D_OR_MID`, `10D_IB_MID` (all literally prefixed "PD_" for Prior Day) — INTO `SAME_DAY_FORMING`,
contaminating ~15% of that headline bucket (74 of ~477 real trades). Worse architecturally: this
duplicated an axis that already existed as an authoritative table —
`setupDefinitions.js`'s `LEVEL_FADE_DEFINITIONS[].rule` field, built 2026-07-20 specifically to be
the single source of truth for exactly this distinction. Skipping that check violated this
codebase's own "check whether an existing column/function already answers this" rule. Fixed by
rewriting `classifyLevelFormation()` as a projection over that canonical table instead of
re-deriving the classification by hand (new shared `stripToBaseLevel()` helper in
`setupDefinitions.js`). **Every affected analysis was re-run on the corrected classifier — the
finding is real and got STRONGER, not weaker**: SAME_DAY_FORMING gap rose from $11.95 to
**$14.40/trade** (N=276), walk-forward gap rose from $12.19 to **$13.38/trade** (N=216, still
stable across all 3 chronological thirds, sign never flips), and both the Initial-Balance-vs-
Opening-Range and session-timing sub-checks still confirm with no hidden split. Full detail:
`RESEARCH_CLAIM momentum_ctx_sameday_corrected_after_deepseek_audit` — cite this one going forward,
not the pre-correction claims below (kept in the ledger, unmodified, as a transparent record of the
mistake rather than silently overwritten).

## Status: informational-only wiring shipped 2026-08-29

Both headline findings (§2 magnitude dose-response, §4/§5c momentum-feeds-momentum) were
independently replicated by Gemini (blind dispatch, own from-scratch script) and re-run locally by
Claude — `RESEARCH_CLAIM volume_building_findings_independently_replicated_by_gemini`. On that
basis, two informational-only (non-gating) pieces were wired the same day:
1. `computeLiveVolumeBuildingSignal()` (`server/routes/acd.js`) now also computes and stamps
   `compositeStrength` and `momentumContext` (`ACTIVE`/`QUIET`) onto `active_setups.vol_building_signal`
   for every real setup fire, across all 5 existing insert sites (single shared function, no
   per-site duplication). This starts accumulating real live N tagged with this signal, superseding
   the retroactively-reconstructed backtest used for all research above.
2. `GET /api/acd/building-strength-live` (read-only) exposes the same measure computed continuously
   from the current session's bars (not gated on any level touch), bucketed into a plain-English
   label from self-recalibrating percentile cutoffs (`scripts/backtest_volume_building_signal.mjs`,
   already on the existing weekly cron — no new schedule entry needed). Surfaced as a non-directional
   "Expand" chip in `quick-check.html`'s pulse bar (bucket + whether it's riding an active or quiet
   backdrop) — a discretionary glance-at-it-while-trading gauge, not a trade trigger.
Neither piece gates, sizes, or suppresses anything. Reviewed by DeepSeek (code correctness only —
the statistics were Gemini's job and are already confirmed) before being considered done.

Consolidated write-up of a research thread started 2026-08-29 from a user question: does
volume-building/pace fire "out of nowhere," away from any known level, and is there a pattern in
that population? All tests reuse the live `computeVolumeBuildingMeasures()`
(`server/services/touchQuality.js`) unchanged — nothing here is a new definition of "building."
Every finding below is a bar-level scan over `price_bars_primary`, not routed through
`active_setups` (no live setup fires without a level touch, so there is no trade-level population
this could have been tested on anyway) — the one exception is the fade-outcome connective test,
which does use real `active_setups` trades. Nothing in this document is wired live.

## Headline finding

**Volume-building strength is a real, confound-checked, NON-DIRECTIONAL volatility-expansion
precursor.** Stronger building predicts a bigger swing coming soon — in either direction. It does
not predict which way, by any angle tested so far (price momentum, order-flow imbalance).

## 1. The phenomenon is real and level-independent

`RESEARCH_CLAIM volume_building_no_level_initiative_test` — of 5,517 "building" bars (pass/fail vs
roster-wide medians) over 60 days, 49.5% sat >8pt (sample median) from every known level. Building
fires constantly, independent of level proximity.

## 2. Magnitude dose-response (the core, actionable finding)

`RESEARCH_CLAIM volume_building_no_level_initiative_test` (same claim, magnitude section) — using a
continuous composite building-strength score (`avgVolZ + volZTrend + avgDayVolZ + dayVolZTrend`,
N=58,338 eligible bars), 20-minute max-excursion-in-either-direction rises monotonically:
Q1(weakest)=42.6pt → Q5(strongest)=57.1pt, top decile 44% larger than bottom decile (61.96 vs
42.98pt). **Confound-checked**: the strongest quintile is *underrepresented*, not overrepresented,
at the naturally-volatile RTH open (1.9% vs 4.0% share), and the same monotonic pattern holds
independently within RTH-only (55→78pt) and Globex-only (34→54pt) — clears the RTH+Globex-both bar.

## 3. Direction is absent — checked two different ways

- **Price momentum**: forward-move-matches-recent-10-bar-direction rate = 48.6-51.3% across all
  groups/horizons, indistinguishable from the 49.7% unconditional coin-flip baseline.
- **Order flow imbalance** (`RESEARCH_CLAIM building_strength_orderflow_direction_negative`): net
  `ask_volume - bid_volume` over the trailing 20 bars — a genuine buy/sell-aggressor delta, not
  price action — also fails. Unconditional match rate 48.7-49.4% (N=58,190); restricted to
  top-quintile spikes, 48.5-48.8%; conditioning on imbalance *conviction* (|imbalance| tercile)
  shows no dose-response either (47.1% / 50.8% / 48.6%, noisy not monotonic).
- **Conclusion**: treat this signal as magnitude-only. Two independent directional proxies both
  came back at coin-flip levels — this isn't a thin miss, it's a clean negative on direction.

## 4. Momentum feeds momentum, not a coiled spring

`RESEARCH_CLAIM building_strength_momentum_feeds_momentum` — tested the "quiet before the storm"
intuition directly: does a strength spike following a QUIET prior-30-bar stretch predict a bigger
move than one following an ALREADY-ACTIVE stretch? **Result is the opposite of the folklore.**
Active-then-spike beats quiet-then-spike cleanly: bottom-half prior activity=50.44pt vs
top-half=62.85pt; truly-quiet quartile=49.45pt vs truly-hot quartile=69.39pt (N=11,448 spike bars).
Confound-checked against session mix — the quiet group is actually *more* RTH-weighted (16.9% vs
4.4% full-RTH share), which should push its excursion up, not down, so the effect is understated
by session mix, not created by it — and confirmed independently within RTH-only (62.6→88.7pt, +41%)
and Globex-only (47.9→60.6pt, +27%). Consistent with `docs/COMPRESSION_TAIL_MFE_SPEC.md`'s
wide-IB-days-predict-TURBULENT (not TREND) finding from a completely different instrument.

## 5. Lead time and persistence — the "early warning" framing was retracted, not confirmed

`RESEARCH_CLAIM building_strength_leadtime_and_persistence_refined` first found: for the biggest
realized moves (top decile, N=5,866), scanning back 45 minutes for the first top-quintile crossing,
79% show at least one crossing, with median lead=37min. **This looked like genuine early warning
but was NOT** — `RESEARCH_CLAIM building_strength_leadtime_is_base_rate_artifact` decomposed it by
counting distinct elevated episodes (flickers) in the 60min before each big move and found the
count (avg 2.28) is essentially identical to a random, unselected sample of bars (avg 2.19), and
the gaps between flickers do NOT shrink as a move approaches (17.0min avg gap closest to the move
vs 16.7min avg gap for the oldest pair — flat, no acceleration). **Conclusion: the 37min median lead
was mostly a base-rate coincidence** — elevated building already occurs in ~1 of 5 bars, so a
45-minute backward scan will almost always turn up *some* flicker whether or not a big move
follows. This does NOT touch the CONTEMPORANEOUS dose-response in §2 or the momentum-feeds-momentum
result in §4 — those measure the same-moment relationship, which stands. It specifically means:
**treat this as a real-time expansion gauge, not a predictive alert with meaningful lead time.**
Persistence itself (once elevated, how long does it stay elevated) is genuinely short regardless:
median run length 4 minutes (mean 5.6), heavily right-skewed (513 of 2,083 episodes are a single
bar; only ~16% last 10+ minutes). Lead time (when real crossings do occur) also does not predict
eventual move size — flat across lead-time quartiles (126/123/125/136pt).

## 5b. The dose-response SHAPE differs by day-type

`RESEARCH_CLAIM building_strength_doseresponse_shape_differs_by_daytype` — joined the §2 dose-
response to `acd_daily_log.day_type` (end-of-day RTH classification, distinct from the live
intraday `dtClass` column CLAUDE.md already flags as structurally null all day). **BALANCE days**
(N=42,258) reproduce the clean, gradual staircase from §2: 38.75→39.84→42.58→44.85→51.39pt. **TREND**
(N=10,720) and **TURBULENT** (N=5,360) days instead show a flat-then-jump shape — Q1-Q4 are
statistically indistinguishable from each other (TREND: 53.36/53.06/51.93/53.92pt; TURBULENT:
62.28/58.05/58.41/61.14pt), and only Q5 breaks out (TREND +27%, TURBULENT +19% vs their own Q1-Q4
average). On calm days this signal is a dial with real information across its whole range; on
already-active days it behaves like a near-binary threshold — only the most extreme reading adds
anything. Also note TREND/TURBULENT days simply run hotter everywhere (their Q1 floor already
exceeds BALANCE's Q5 ceiling) — day-type alone explains most of the magnitude variance, and this
signal adds incremental information mainly at its extreme. Day-level N is thin (8 TREND, 4
TURBULENT days) — re-check as more days classify.

## 5c. Momentum-feeds-momentum is the more robust finding — holds (and strengthens) across every day-type

`RESEARCH_CLAIM momentum_feeds_momentum_robust_across_daytype` — re-ran §4's active-vs-quiet split
separately per day-type. Unlike the raw magnitude dial (§5b), this one does NOT flatten on already-
active days — it holds in all three, and is actually **strongest on TREND days**: BALANCE 1.18x
(47.22→55.87pt), **TREND 1.43x (54.94→78.57pt)**, TURBULENT 1.24x (61.31→76.25pt). **This is the
single most generally-useful piece of intel in this whole thread**: "is this spike riding on an
already-elevated recent backdrop" stays informative — and gets more informative — exactly where
the simple "how strong is this reading right now" question stops helping (TREND/TURBULENT days).

## 6. Connective test to the existing fade roster — rejected as a blanket rule

`RESEARCH_CLAIM building_strength_as_fade_filter_mixed_negative` — does firing an existing
level-fade at high building-strength (predicting more incoming volatility) predict worse fade
outcomes than firing at low building-strength, since a fade wants a clean, low-volatility reversion
against its fixed stop/target? N=1,080 real fade trades matched to bars. **Rejected as a blanket
rule** — roster-wide EV by quintile isn't monotonic ($3.50/-$2.38/-$1.04/-$6.51/-$3.55), and the
within-family control splits opposite-signed again: `INITIAL_BALANCE_HIGH_LOW` and the `OTHER`
bucket get meaningfully worse at high building (matches the hypothesis), but `PD_VALUE_AREA_EDGE`
and `GLOBEX_VWAP` get *better* (reverses it). Per-family N is thin (22-174) — not fully decisive per
family, but rules out a single roster-wide stop/target-width modifier. `OPEN_DECISION
test_volume_building_strength_as_fade_stop_target_modifier` was flagged and resolved with this
result. If revisited, scope to `INITIAL_BALANCE_HIGH_LOW`/`OTHER` specifically once N grows.

## 4b. Momentum-feeds-momentum has its own dose-response, not just a switch

`RESEARCH_CLAIM momentum_feeds_momentum_has_own_dose_response` — the original finding only tested
a 2-way active/quiet split. Re-tested the same top-quintile spike population (N=11,193) with the
preceding-30-bar backdrop split into quintiles instead. Result: a clean, monotonic staircase, not a
threshold — 49.2pt → 50.3pt → 54.3pt → 59.3pt → **70.7pt** from quietest to most-active backdrop.
This is a genuine dial: the more active the recent backdrop, the bigger the eventual move, smoothly
throughout the range. Strengthens the already-confirmed two-bucket version further.

## 6b. WHY do families disagree? A structural distinction explains it cleanly

`RESEARCH_CLAIM momentum_ctx_effect_concentrated_sameday_levels` — the fade-filter's per-family
split (§6, later refined via momentum-context in a separate test) showed 4 of 6 families agreeing
and 2 reversing. Tested whether this tracks a real structural distinction: **SAME-DAY-FORMING**
levels (Initial Balance, Opening Range — established fresh THIS session) vs **PRIOR-DAY-ANCHORED
OR DEVELOPING** levels (prior-day value area, POC, VWAP — fixed from yesterday or a slow
running average). Result: yes, cleanly. Same-day-forming levels show the effect at MORE than
DOUBLE strength ($10.72/trade gap, N=237) vs the pooled roster-wide $4.54. Prior-day/developing
levels pooled together show essentially NO effect ($0.83 gap, N=295) — not a clean reversal like
the two components looked individually, closer to a wash once PD_POC is folded in properly.
**Mechanism**: for a level that formed today, whether the last 30 minutes showed real
participation is directly diagnostic of whether today's structure is being genuinely tested — a
much more informative question than for a level anchored to yesterday's data, where 30 minutes is
a small slice of what the level even represents.

**Sharpened same day** (`RESEARCH_CLAIM momentum_ctx_sameday_effect_sharpened_full_reclassify`):
the first pass's classifier had a real gap (only caught `OR*_MID`, missed `OR*_HIGH`/`OR*_LOW` —
same family, same mechanism) and left a large, still-contaminated `OTHER` bucket (N=459). Rebuilt
to properly cover the full roster (all OR/IB length+edge variants into SAME_DAY_FORMING; floor
pivots, camarilla, prior-week/year, 3-month, VWAP variants, overnight H/L, session-open references
into PRIOR_DAY_OR_DEVELOPING). Result is sharper AND better-powered: **SAME_DAY_FORMING now
$11.95/trade gap on N=324** (up from $10.72/N=237) — real weight on both sides (129/195).
PRIOR_DAY_OR_DEVELOPING: $2.17/trade on N=618 — small but not quite zero, ~5.5x weaker. True
`OTHER` shrank from 459 to 49 trades (21 rare types, mostly overnight variants) with a near-zero
gap — now a genuinely small heterogeneous residual instead of a bucket still hiding signal. This is
the clearest, best-powered version of the finding in the whole thread: **if this filter is ever
wired live, Initial Balance / Opening Range levels (any length) are the correct, well-motivated
scope** — not the whole roster.

**Walk-forward-confirmed** (`RESEARCH_CLAIM momentum_ctx_sameday_walkforward_stable`) — re-ran the
same no-lookahead expanding-window check that found the pooled roster-wide version unstable
(§ below), scoped this time to SAME_DAY_FORMING only. Result: gap=$12.19/trade walk-forward
(closely matches the $11.95 pooled figure — no lookahead inflation), and — unlike the roster-wide
version — **directionally stable across all three chronological thirds** ($7.94 → $21.90 → $7.70,
magnitude wobbles but never reverses). This is now the strongest, most trustworthy version of this
finding in the whole thread and the leading candidate for a future scoped live test, once real N
grows further past the current ~1 month of history. Promoted the classifier itself
(`classifyLevelFormation()`, `server/config/setupTypes.js`) to a shared, exported function so
future scripts import it instead of re-deriving the regex — the first ad hoc version had a real gap
(missed `OR*_HIGH`/`OR*_LOW`) that diluted the finding until caught.

**Due diligence, one level deeper** (`RESEARCH_CLAIM momentum_ctx_sameday_consistent_ib_and_or`) —
split SAME_DAY_FORMING itself into its two components (Initial Balance vs Opening Range) to check
for a hidden split, the same test that caught trouble everywhere else in this thread. This time it
didn't find one: Initial Balance ($11.69/trade, N=181) and Opening Range ($12.74/trade, N=143)
both closely match the pooled figure in direction and magnitude. One individual setup_type
(`IB_HIGH_FADE_SHORT`, N=19/20, below this project's own N≥20 floor) reverses but stays strongly
positive on both sides — not a real concern yet. This strengthens rather than complicates
confidence in the finding.

**Two more due-diligence checks, both requested directly** (`RESEARCH_CLAIM
momentum_ctx_sameday_holds_across_session_timing`): does the SAME_DAY_FORMING effect degrade near
session boundaries (late RTH / the 4-6pm dead zone)? No — mid-session gap=$11.59 (N=272) vs late
gap=$12.70 (N=52, thinner since IB/OR touches concentrate in the morning), consistent in both
direction and magnitude. Another check that strengthened rather than complicated the finding.

Separately (`RESEARCH_CLAIM vapos_rescoped_to_prior_day_levels_weak_partial`): if same-day
momentum-context doesn't help PRIOR_DAY_OR_DEVELOPING fades, is there a DIFFERENT predictor that
does? Re-tested the earlier-rejected vaPos idea (distance from prior-day POC) scoped this time to
ONLY its conceptually natural population (PRIOR_DAY_OR_DEVELOPING, N=782) rather than pooled with
unrelated same-day levels. Result: weak, not a clean win — CLOSE=-$4.62, MID=-$3.83 (actually the
best, not CLOSE), FAR=-$9.37. Not monotonic, contradicts the simple "closer is better" hypothesis.
One real partial signal (FAR is meaningfully worse than the other two) but not the clean
alternative predictor being searched for. **This specific open question — what, if anything,
predicts inherited-level fade outcomes — remains genuinely unanswered.**

## Related, rejected sibling idea

`RESEARCH_CLAIM vapos_prior_poc_distance_family_artifact` — a separate idea from the same broader
session (distance from prior-day POC as a general "structural backing" filter) was tested and
rejected the same way: a pooled roster-wide positive turned out to be a family-composition
artifact under a within-family control (`INITIAL_BALANCE_MID` and `GLOBEX_VWAP` both reversed the
pooled direction). Listed here because it's part of the same research arc, not because it's about
volume-building.

## Open threads if this continues

- ~~Decompose the lead-time result into episode count~~ — done (§5): retracted as a base-rate
  artifact, not real anticipatory clustering.
- ~~Test whether the magnitude effects differ by day-type~~ — done (§5b): shape differs
  (staircase on BALANCE, threshold on TREND/TURBULENT). Day-level N still thin — recheck later.
- ~~Does momentum-feeds-momentum also show a day-type-dependent shape?~~ — done (§5c): no, it's
  robust across all three, strongest on TREND. This is the most generally-useful finding here.
- If the `INITIAL_BALANCE_HIGH_LOW`/`OTHER` fade-filter subgroup grows past N≥20 per side, revisit
  a narrowly-scoped version of the stop/target modifier rather than the rejected blanket one.
- Nothing here is wired live. Any of the above would need the full new-setup-type or
  live-wiring checklist in `CLAUDE.md` before touching `acd.js`.

## Untouched angles noted for a future session (not started, no code written)

- **Interaction with time-to-close/time-to-session-boundary** — does either effect (magnitude or
  momentum-feeds-momentum) behave differently in the last 30-60 minutes of RTH or right before the
  5-6PM maintenance gap, vs mid-session? Not tested.
- **Interaction with specific setup families beyond the blanket fade test in §6** — the fade-filter
  test was roster-wide with a family-level control; it was never tried as a filter on the two
  families that DID match the hypothesis direction (`INITIAL_BALANCE_HIGH_LOW`, `OTHER`) at their
  own, narrower N. Worth revisiting once those families' real N grows past ~20/side, and using the
  momentum-feeds-momentum effect (the more robust finding) specifically, rather than the
  already-rejected raw-magnitude version.
- **Does momentum-feeds-momentum predict move SIZE with a dose-response of its own** (i.e., does an
  even-more-active prior backdrop predict an even-bigger move, beyond the simple two-bucket split
  used in §4/§5c)? Only a halves/quartiles split has been run so far, not a full quintile staircase
  on the prior-activity measure itself.
- **A live, informational-only dashboard/alert wiring** — if any of this is ever promoted past pure
  research, the natural first step (per CLAUDE.md's own convention) is an informational-only tag on
  `active_setups` (matching how `bar6_checkpoint`/`BIGMOVE_LIVE_SIGNAL` were introduced), not a
  live gating change — and only after the day-type-conditioned versions are re-verified with more
  TREND/TURBULENT days (currently 8/4, thin at the day level).
