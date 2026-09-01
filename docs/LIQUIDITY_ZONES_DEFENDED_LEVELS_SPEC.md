# Liquidity Zones & Defended Levels — Detection and Strategy (design round, 2026-08-26)

**Status: DESIGN ONLY. Nothing here has been run. No DB access was used for this document** —
every factual claim is a file/line citation, verifiable by `sed -n`.

Question asked: *"how can you spot liquidity zones and defended levels, and how do you trade
them?"* Answered as two separate questions, §2 (detection) and §3 (strategy), because the second
one has genuinely never been asked in this repo and it changes what the first one is even for.

---

## 0. Ground already burned — read this before §2, three corrections to the framing

The dispatch brief pointed me at idea 2 (negative) and idea 5 (never built). Both are accurate.
But there are **three more pieces of already-settled ground** that the brief didn't mention, and
all three constrain the answer heavily. I found them by searching the repo, not by being told.

### 0.1 "Defended level" has already been built and tested once — `RESOLVED NEGATIVE`

`docs/DEFENDED_LEVEL_RETEST_SPEC.md` exists and is closed. It is *literally* a defended-level
detector: count failed bounce attempts at a retest, require a "weakening" metric, enter when the
signature completes. Full 8-way sweep (window 4/6/8/10 × variant 1/2), N=3657 RTH level-fade
touches, 2023-11 to 2026-08, `scripts/backtest_defended_level_retest.mjs`
(`DEFENDED_LEVEL_RETEST_SPEC.md:195-219`). Result: `DEFENDED_CONFIRMED` negative EV in **all 8
combinations** (-$0.23 to -$8.97/trade), never beat blind immediate entry.
`RESEARCH_CLAIM defended_level_retest_confirmation_entry_negative`.

**But read the failure mode carefully, because it is not "defense is meaningless":**

> "The dominant effect across the whole exercise: **waiting AT ALL underperforms blind entry**"
> — `DEFENDED_LEVEL_RETEST_SPEC.md:209-211`

Against the timing-matched control (`WAITED_SIGNATURE_TIMING`, which isolates the pattern from the
entry-delay confound) the result was **4 of 8 combos better, 4 worse** — a genuine null on the
signal itself, but a null measured *inside* a design where the signal could only be obtained by
paying for bars. The spec's own design required the signature to *complete* before entry
(`DEFENDED_LEVEL_RETEST_SPEC.md:71-75`: "the completion bar — the anchor for everything downstream
(entry, forward-return measurement)"). So the test conflated *detection* with *delayed entry*, and
the delay term dominated.

This is the third independent confirmation of that same delay effect in this codebase:

| Finding | Where | Result |
|---|---|---|
| `globex_level_confirm_entry_signal_real_delay_too_costly` | `TOUCH_QUALITY_SIGNAL_IDEAS_SPEC.md:30-36` | Signal real (+$21.83 to +$41.35 selection value), delay cost larger (-$32.93 to -$56.96). Net negative everywhere. |
| `engagement_confirmation_entry_timing` | cited `DEFENDED_LEVEL_RETEST_SPEC.md:210`, `OPEN_THREADS.md:430,438` | Same shape. (Caveat: its own population is now flagged `OPEN_DECISION engagement_entry_timing_backfill_contam` — `OPEN_THREADS.md:438`.) |
| `defended_level_retest_confirmation_entry_negative` | `DEFENDED_LEVEL_RETEST_SPEC.md:195-219` | Waiting underperforms blind entry, all 8 cells. |

Three independent negatives on one mechanism is about as settled as anything in this repo.
**Consequence, and it is the spine of everything below: a defended-level feature is only worth
building if it is computable from bars strictly BEFORE the touch bar's close, so it costs exactly
zero bars of delay.** Anything that needs to watch the level get defended *at* the touch has
already been tested and lost, twice, on entry-timing grounds alone.

### 0.2 The naive absorption story is already tested — and it runs BACKWARDS

`hivolLopace` is live: heavy volume in the trailing 5 bars *without* correspondingly large price
movement, measured strictly before/at the entry bar
(`server/routes/acd.js:7461-7489`; `_hlMaxVolZ >= 0.5 && _hlPaceZ < 1.0` at line 7488). That is
textbook absorption — big size trading, price not moving. The intuitive read is "absorption defends
the level, good fade."

The measured result is the opposite:

> "heavy volume WITHOUT correspondingly large price movement in the trailing 5 bars before a touch,
> predicting a **WORSE** fade outcome (the opposite of the 'absorption defends the level' story
> that motivated testing it; it reads as a headwind instead)"
> — `docs/AIR_POCKET_SIGNAL_SPEC.md:13-22`, `RESEARCH_CLAIM hivol_lopace_precursor_confirmed_negative`, CONFIRMED 2026-07-29

And the mirror quadrant (low volume + high pace = "air pocket", the thin-book/undefended read) was
computed in the same run and **already failed its stability check** —
`AIR_POCKET_SIGNAL_SPEC.md:24-30`, which is why that spec is closed without mining.

So: the *volume-shaped* readings of both "defended" (absorption) and "undefended" (air pocket) are
spent. Volume-near-a-level has now failed three separate ways in this repo — `hivolLopace`
(absorption, confirmed negative), air-pocket (mirror, failed stability), and idea 2's
`depletion_frac` (confirmed negative, `RESEARCH_CLAIM touch_quality_ideas_1_2_3_4_negative`). Any
new detector that is fundamentally a volume-magnitude measure near a level should be assumed dead
on arrival. **§2's ideas are deliberately structural/geometric, not volume-magnitude.**

### 0.3 The architecture is *not* "everything is a fade" — and the existing continuation branch already failed at levels

The brief says "this codebase's entire existing architecture — everything is a fade." That isn't
quite right, and the exception matters enormously for §3.

`BRACKET_BREAKOUT_LONG` / `BRACKET_BREAKOUT_SHORT` are live, non-fade, continuation setups
(`server/routes/acd.js:5422-5460`). They fire on a 5-session bracket boundary being exceeded, with
an NL30 regime agreement condition (`acd.js:5430-5431`). Their real performance, from the code's
own comment:

> "real live SETUP_STATUS shows `BRACKET_BREAKOUT_LONG` is SUPPRESS (N=37, WR=29.7%, EV=-$16.84)
> and `BRACKET_BREAKOUT_SHORT` is THIN_N (N=16, WR=6.3%, EV=-$104.75)"
> — `acd.js:5434-5437`

Meanwhile the *un-anchored*, purely bar-structural volume-confirmed breakout — 30-bar RTH high/low
break plus `volZ >= 1.0` vs a 90-observation same-minute-of-day rolling baseline
(`scripts/backtest_compression_volume_breakout.mjs:103-152`, arm selection at line 220) — is the
strongest, most stable finding of the 2026-08-25/26 thread: **+$11.13/trade at stop=138/target=102,
N=1516, `+++ (STABLE)`** (`reports/compression_breakout_stop_target_sim.md`,
`NO_COMPRESSION_CONTROL` grid; context in `scratch/claude_request.md:14-17`).

Read those two facts together, because I think this is the single most useful observation in this
document: **continuation trades in this repo work when anchored on rolling bar structure and have
failed when anchored on a named level.** That is the exact bar any "undefended level → trade the
breakout instead" proposal has to clear, and §3.1 proposes the cheapest possible way to test it
without building a new engine.

---

## 1. The one hard constraint every idea below obeys

Entry convention is the touch bar's own close — `entry: currentPrice` live
(`acd.js:7566`), `entry: b.close` in the canonical backtest harness
(`scripts/backtest_unified.js:504,750,783`). Therefore:

> **Every feature in §2 is computed from bars with `ts` strictly before the touch bar, or from the
> touch bar's own already-closed OHLCV. No feature requires bar t+1. No feature requires waiting
> for a pattern to "complete."**

This is the same rule the prior spec held itself to (`TOUCH_QUALITY_SIGNAL_IDEAS_SPEC.md:125-128`)
and it is now doubly load-bearing given §0.1.

Two additional house rules I'm holding every idea to, both from `docs/ANTIGRAVITY_CONSTRAINTS.md`:
no static thresholds — every cutoff comes from a rolling distribution or an existing calibration
(rule 1, lines 18-24); and N≥20 before anything is called decisive (rule 3, line 45). Plus the
economic floor from the prior spec: **the bar to clear is $4-5/trade, not $0**
(`TOUCH_QUALITY_SIGNAL_IDEAS_SPEC.md:297-299`).

---


## 2. QUESTION 1 — How to spot a liquidity zone / defended level

Five buildable ideas (A–E) plus one that is genuinely order-book-shaped and therefore blocked (F).
A and B advance idea 5; C, D, E are alternatives that are not repackagings of idea 2 or idea 5.

Shared notation, all defined from bars strictly prior to the touch bar:
- `medRange` = median `(high - low)` over the trailing 30 bars (the same construction idea 1 used,
  `TOUCH_QUALITY_SIGNAL_IDEAS_SPEC.md:136-137`, and already implemented as
  `trailingMedianBarRange` in `scripts/pilot_touch_quality_features_deepseek.mjs:306`).
- A **touch** of level `L` = a bar whose close is within 15pt of `L`, matching the live band
  (`nearLevels`, `acd.js:7167`).
- **Formation gating is mandatory.** `level_prices` rows exist for the whole `trade_date`, so
  same-day-forming levels (OR5/OR10/OR30/IB) leak future prices if used before they form. This is
  not hypothetical — DeepSeek's own prior review found it as a live bug in idea 3: "54 trades fired
  before their OWN anchor level finished forming, ~30% of all touches have a contaminated
  `otherPrices` set" (`OPEN_THREADS.md:262-266`). The fix already exists as
  `SAME_DAY_FORMING_MINUTE` in `pilot_touch_quality_features_deepseek.mjs:331-334` — reuse it,
  don't re-derive it.

### Idea A — Session hold-rate, with the free parameters removed (idea 5, made actually buildable)

Idea 5's blocker was never the concept, it was that "did price revert k×medRange before continuing
X×medRange through" has three undetermined knobs (k, X, and a horizon H), and this codebase's own
classifier rule says a newly-invented classifier with swept cutoffs needs independent predictive
power demonstrated before any EV split it produces is trusted — a rule that exists because *three*
EV splits passed rigor once and all three classifiers behind them later failed independent
validation (`TOUCH_QUALITY_SIGNAL_IDEAS_SPEC.md:256-261`). So the way to advance idea 5 is not to
guess k and X better. It is to **make them not be free parameters at all.**

**The classifier, stated exactly.** For each formation-gated level `L` and each prior touch `t_i` in
the session, walk forward bar by bar from `t_i`, first-to-trigger wins:

- `HELD` if price moves `R` away from `L` on the *approach side* (the side price came from) before
  ever trading `B` beyond `L` on the far side.
- `RUN` if price trades `B` beyond `L` on the far side before moving `R` back.
- `UNRESOLVED` if neither happens within `H` bars.

Then `holdRate = HELD / (HELD + RUN)`, pooled over all resolved prior touches in the session.

**`UNRESOLVED` is excluded from BOTH numerator and denominator.** This is the trap in the naive
version: folding unresolved into `RUN` makes the metric read "trend night" during quiet periods
purely because nothing resolved, which is close to the opposite of the truth.

**Removing k/X/H — the important part.** Set them from the trade construction that already exists,
not from a sweep:

> `R` = the level family's own calibrated `targetPts`, `B` = its calibrated `stopPts`, both read
> from `performance_audit signal_type='OPTIMAL_STOP'` (the live read is at `acd.js:1405-1407`,
> loaded into `liveStats._opt` at `acd.js:6857-6864`). `H` = the family's own reaction window (the
> same "p25 of its bars-to-resolution" quantity `touchQuality.js:28-29` already uses).

With that substitution, `HELD` is definitionally *"a standard fade at this level would have reached
T1"* and `RUN` is *"it would have hit its stop."* Three benefits, in order of importance:

1. **k and X stop being invented numbers.** They inherit an already-validated, per-setup_type
   calibration, so the classifier-validation objection largely dissolves — there is no swept
   surface to `computeReplication()` over, because nothing was swept.
2. **The feature becomes interpretable**: "of the level touches that have already resolved tonight,
   what fraction would have paid a normal fade." That is exactly the discretionary read idea 5 was
   trying to capture ("levels are holding beautifully tonight" vs "everything's getting run").
3. It is mechanically a **shadow-simulation of every touch tonight whether or not anything fired** —
   precisely idea 5's stated point of difference from the existing streak factor
   (`lfConsecWins`/`lfConsecLosses`, real at `acd.js:6026-6032`, which is fired-only and therefore
   thin and selection-biased).

A pure bar-geometry fallback exists if the calibration route proves awkward (`R = B = 1.0 ×
medRange`, `H = 10`, with `{0.75, 1.0, 1.5}` reported as a robustness table only and the 1.0/1.0/10
cell pre-registered as the headline) — but the calibration-anchored version is strictly better and
should be the primary.


**Denominator hygiene.** Emit `null`, never 0.5, below `minObs = 3` resolved prior touches (idea 5's
own estimate was 5-15 observations/night, so a floor of 3 keeps most of the population). Also emit a
second variant where each level contributes **at most its first resolved touch**
(`holdRateDistinctLevels`) — repeat touches of one level are correlated, and if the two variants
disagree, the pooled number is being driven by a single level getting hammered.

**Lookahead safety.** Every `t_i` used must satisfy: `t_i`'s own resolution bar closed strictly
before the current touch bar. This is the subtle one — a touch from 3 bars ago that has not yet
resolved must be treated as unresolved-so-far and excluded; you cannot use its eventual outcome.
Cleanest implementation is to build the session's touch list incrementally and only admit a touch to
the denominator once its own resolution bar has closed.

**Redundancy risk — this is where I think A is most likely to die, and it should be tested for
first, not last.** The live stacking factor is:

> `if (_lfSameDirN >= 7) mult = 0.10;` — "7+ same-dir setups = 62.4% WR -$15.7 EV (N=1922) — trend
> day, fades dead." (`acd.js:7690-7692`, computed at `acd.js:6036-6037`)

"Many same-direction setups fired tonight" and "levels are getting run tonight" are close to the
same fact wearing a different hat. That is this codebase's documented recurring failure mode, and I
think the risk here is high, not theoretical. So the pre-registered question is **not** "does
`holdRate` split EV" — it is **"does `holdRate` add anything after conditioning on `_lfSameDirN`?"**
Run it as a 2×2 (holdRate tercile × sameDirN bucket) from the start. Secondary cross-tabs against
`day_type`/NL30 bucket (both already live in the sizing block, `acd.js:7683-7699`) and against
`lfConsecLosses`. Kill A if the effect lives entirely inside the `_lfSameDirN >= 7` cell.

### Idea B — Directional hold asymmetry (the real advance on idea 5, not a restatement)

Idea 5 collapses the whole night into one scalar: "rotation night or trend night." I think that is
its actual weakness, separate from the parameter problem, and it is worth fixing in the same build.

A real session is usually **asymmetric**: touches from below are holding (supply is defended) while
touches from above are getting run (demand is gone). A single pooled `holdRate` averages those two
populations together, so a strongly one-sided night — the most tradeable kind — can score a bland
0.5 and look like noise. The pooled metric is *structurally biased toward looking flat* exactly when
the information is richest.

**Construction.** Same classifier as A, partitioned by approach side:
- `holdRateFromAbove` over prior touches approached `FROM_ABOVE` (candidate LONG fades),
- `holdRateFromBelow` over prior touches approached from below (candidate SHORT fades),
- Feature for the current touch = `holdRateSameSide` (matching *this* touch's own approach side),
- Plus `holdSpread = holdRateSameSide − holdRateOppSide`.

**Why this fits the live engine structurally, not just conceptually.** Direction is already assigned
purely by approach side — `const isLong = approachDir === 'FROM_ABOVE'` (`acd.js:7229`), the same
symmetric rule `DEFENDED_LEVEL_RETEST_SPEC.md:9-11` describes. So `holdRateSameSide` is already in
the engine's own coordinate system. It also has an exact structural precedent in the sizing block:
every NL30 factor is a `(bucket × dir)` pair (`acd.js:7693-7699`, e.g. `MILD_BULL && dir === 'SHORT'
→ −0.20`), which is the same shape as `(holdRate bucket × side)`. A drop-in fit, not a new mechanism.

**Cost, stated honestly.** This halves N per side. So: `minObs = 2` per side, and B must be run as a
**secondary split only after A shows a pooled effect** — the pre-registration discipline from
`TOUCH_QUALITY_SIGNAL_IDEAS_SPEC.md:293-296` ("Pool first, split only after a pooled effect
appears"). If A is flat and B looks great, that is a 2-cell fishing expedition and should be treated
as such, not as a discovery.

**Redundancy risk.** Moderate and specific: `holdSpread` will correlate with NL30 bucket × direction,
because a persistent one-sided regime produces both. The control is the same 2×2 as A, using NL30
bucket instead of `_lfSameDirN`.

### Idea C — Acceptance, not absorption: how long has price already LIVED on the other side?

This is not hold-rate and not volume. It is the cheapest structural measure of "is this still a
level at all," and it has no forward horizon, so it has no `H` parameter and no unresolved
population.

For level `L`, over the session up to the bar before the touch:
- `pierceBars` = bars where `low <= L <= high` (the level sits inside the bar's range).
- `acceptedBars` = bars whose **close** is on the far side of `L` from the current approach side.
- **`acceptedTimeFrac` = `acceptedBars` / (bars elapsed in session so far)** ← the primary feature.
- `rejectionRatio` = (pierce bars that closed back on the origin side) / `pierceBars` ← secondary.

The intuition is the one a discretionary trader applies instantly: a level price has already spent
40 minutes being traded *through* is not a wall, it's a memory. Fading it is fading nothing.

**Why this is genuinely not idea 2.** Idea 2 (`depletion_frac`) measured *volume mass* transacted in
a `±1×medRange` band, normalized by session volume, attributing a bar's **entire** volume whenever
the bar merely overlapped the band (`pilot_touch_quality_features_deepseek.mjs:305-321` — the test is
`b.low <= bandHigh && b.high >= bandLow`). That is a magnitude measure. `acceptedTimeFrac` is a
**sign** measure: where did the bar *close* relative to `L`. Two bars with identical volume score
identically under idea 2 and oppositely here. This is the same axis of distinction that made idea 4's
path efficiency legitimately different from `paceZ` (`TOUCH_QUALITY_SIGNAL_IDEAS_SPEC.md:226-230`).

**Why it is not idea 5 either.** A/B measure what price did *after* a touch over a multi-bar horizon.
C measures what the bars *themselves closed like*, with zero forward window. Every bar is
classifiable immediately, so there is no `UNRESOLVED` bucket and no `H` — C's parameter count is
zero, which is its main advantage over A.

**Honest redundancy disclosure.** Idea 2 had a *stated but never-emitted* secondary feature: "count
of prior bars that closed inside that band" (`TOUCH_QUALITY_SIGNAL_IDEAS_SPEC.md:166-167`). Reading
the pilot script directly, only the volume-overlap fraction was ever computed
(`pilot_touch_quality_features_deepseek.mjs:305-321`) — the bar-count/closing-side family was never
actually tested. So C is **adjacent to a failed idea, not identical to it**, and it should be
described that way rather than sold as fully novel. My honest prior: lower probability than A/B, but
it is a handful of lines riding along in the same extraction pass, so the marginal cost is ~zero.

**Tautology hazard, and the escape.** `rejectionRatio` has exactly the shape
`DEFENDED_LEVEL_RETEST_SPEC.md:31-43` warns about — "price kept getting rejected" is definitionally
near "the level held," i.e. a restatement of the outcome rather than a separate signal. That spec's
own escape was to measure the side that moves *against* the eventual fade. `acceptedTimeFrac` is that
side: it is an **undefended** indicator, anti-correlated with the fade thesis rather than entailed by
it. **So lead with `acceptedTimeFrac` and treat `rejectionRatio` as a diagnostic only.** If only
`rejectionRatio` shows an effect, assume tautology until proven otherwise.

**Lookahead safety.** Bars strictly `< ` the touch bar. Note the pierce test uses `high`/`low`, which
is fine for closed bars but must never be applied to the in-progress bar.

### Idea D — Cluster integrity: the confluence factor is currently blind to whether the cluster was already consumed

This one doesn't invent a signal. It repairs a live factor whose weakness is visible in the code, and
it is the cheapest idea in this document to falsify.

**What's live now.** `confluenceCount = nearLevels.length` (`acd.js:7396`) — a static count of how
many levels sit within 15pt. It feeds real sizing decisions: the MARGINAL-tier discount is gated on
`lv.ev < 30 && confluenceCount < 2` (`acd.js:7650-7651`), and a verified pair partner adds +0.15
(`acd.js:7677`, sourced from real `_pairBonus` data, `acd.js:7549-7551`).

**The gap.** `confluenceCount` is entirely blind to whether those co-located levels have already been
visited or violated tonight. Three levels stacked at 27,900 is only a wall if the market hasn't
already walked through the zone. If price spent the last 30 minutes above all three,
`confluenceCount` is still 3 and the setup still collects full confluence treatment.

**And it is not covered by revisit latency.** The live revisit-latency computation is anchor-only:

```js
const _barsNearLevel = allRthBarsRow.rows.filter(b =>
  b.et_min < etMinNow && Math.abs(b.close - lv.level) <= 10
);      // ← lv.level, the ANCHOR level only
```
(`acd.js:7556-7558`)

So a *fresh anchor sitting inside an already-swept cluster* collects the full first-visit bonus
(`minutesSinceVisit === null → +0.15`, `acd.js:7697`) while every level around it has already been
picked off. That is a specific, checkable claim about live behavior, and it is exactly the
"undefended zone" the user is asking about — currently invisible to the engine.

**Construction** (reusing the existing computation verbatim, per level in the cluster):
- `clusterFreshCount` = # cluster members with `minutesSinceVisit === null`.
- `clusterFreshFrac` = `clusterFreshCount / confluenceCount`.
- `clusterMaxAccepted` = `max(acceptedTimeFrac)` across members (idea C, applied per member).

**Cheap gate before any mining — run this first, it is nearly free.** Among fired setups with
`confluenceCount >= 2` and `minutesSinceVisit === null`, what fraction had at least one cluster
partner already visited? If that's a low-single-digit percent, D is N-starved and dies for free.
This is exactly the census `DEFENDED_LEVEL_RETEST_SPEC.md:112-119` mandates. **It is answerable from
already-stored data plus bars** — cluster membership is persisted on the row
(`confluenceLevels: nearLevels.map(l => l.name.replace(/_FADE$/, ''))`, `acd.js:7782`, also written at
`acd.js:7891`), so no re-detection is needed. Note the naming caveat the code itself flags at
`acd.js:7885-7891` (stripped vs unstripped `_FADE` suffix) — join on the stripped form.

**Lookahead safety.** Inherited from the existing computation, already correctly gated on
`b.et_min < etMinNow` (`acd.js:7557`). Cluster membership itself must be formation-gated like
everything else in §2.

**Redundancy risk.** Low, and that's the point: by construction it is the *conjunction* of two live
features (`confluenceCount`, `minutesSinceVisit`) that the engine currently treats as independent.
The right control is a 2×2 of `confluenceCount` bucket × `clusterFreshFrac` bucket, restricted to
`minutesSinceVisit === null` anchors so the anchor's own freshness is held constant.

**Second application, already flagged in-repo and still open.** `DEFENDED_LEVEL_RETEST_SPEC.md:185-193`
proposed feeding a real defense signal into cluster candidate *selection* — prefer the level showing
defense over the one merely ranked highest by historical EV — and deliberately scoped it out of that
first test. `clusterFreshFrac` is a natural input there. Keep it out of the first pass for the same
reason that spec did: validating a signal and a new application in one pass makes a negative
ambiguous.



### Idea E — Structural volume-node context of the level price itself (from a COMPLETED prior profile)

The user asked specifically about `computeProfile()`'s volume-node/gap classification. Honest read of
what's actually there: `computeProfile()` (`server/services/developingValueService.js:27-57`) returns
`{ poc, vah, val, maxVol, totalVol, entries }`, where `entries` is a full per-tick spread-volume
histogram (each bar's volume spread across its high-low tick range, lines 33-38). **It does NOT
classify HVN/LVN** — I grepped `volumeNode|LVN|HVN|gap` in that file and got nothing. The histogram
exists; the node/gap classification would need writing. It's small and purely additive, and `entries`
has everything required.

**The feature.** Score the level's price against a **completed prior** volume histogram (prior
session, or a trailing multi-session range via `computeVolumeProfileForRange`,
`developingValueService.js:99-110`):

> `nodeZ` = (histogram volume summed over `L ± 1×medRange`) ÷ (mean per-bucket volume across the
> whole profile), expressed as a z-score against the profile's own bucket distribution.

No static threshold — it's normalized against its own distribution, satisfying
`ANTIGRAVITY_CONSTRAINTS.md:18-24` rule 1.

**The hypothesis, falsifiable and directional.** A level sitting on an **HVN** has real historical
two-sided business transacted at that price — genuine liquidity, fades hold. A level sitting in an
**LVN / profile gap** has nobody there — price traverses it fast, fades get run. This is the standard
Market-Profile read, and it is the one genuinely *structural* "is there liquidity here" measure
obtainable in this system without depth-of-market.

**Why this is NOT idea 2, and the distinction is the whole point.** Idea 2 measured *tonight's* volume
near the level normalized by *tonight's* session-volume-to-date — a consumption measure that
mechanically climbs as the session progresses and as price loiters, carrying a session-progress
confound. E measures the level price's **standing structural context from a completed prior profile**:
known before the session even opens, zero session-progress dependence. Opposite sign of information,
too — idea 2 says *"liquidity has been used up,"* E says *"liquidity was never there in the first
place."* A level can be a pristine first visit (idea 2 and revisit-latency both maximally favorable)
and still sit squarely in an air pocket.

**Lookahead safety — treat this as the highest-risk item in §2.** Must use only sessions strictly
before the trade date, or (for a developing intraday profile) only bars `< ` the touch bar. This repo
has already been bitten here: `level_prices_3m_va_lookahead_backup_20260719` exists in the schema
(`server/schema.sql:3205`), a backup table whose name records a real value-area lookahead incident.
`computeVolumeProfileForRange` takes explicit `startDate`/`endDate`
(`developingValueService.js:99-108`) so bounding it is trivial — but **the caller must bound it; the
function will not.**

**Redundancy risk — real, specific, and fatal if uncontrolled.** Several level families *are* profile
artifacts by definition: `PD_POC`, `PD_VAH`, `PD_VAL`, `*_POC` are derived from the same histogram, so
a `PD_POC` touch has near-maximal `nodeZ` **by construction**. Without a control, this test will
"discover" that PD_POC fades are good — already known, already priced into per-setup_type EV. The
control is the identical one idea 6 needed for new-session-extremes
(`TOUCH_QUALITY_SIGNAL_IDEAS_SPEC.md:274-280`): test **within `setup_type`**, or restrict to
non-profile families (floor pivots, camarilla, OR/IB, PD_HIGH/LOW, weekly/monthly opens). Kill E if
the effect vanishes once conditioned on `setup_type`.

**One more disclosure.** E shares *motivation* with `docs/AIR_POCKET_SIGNAL_SPEC.md` (§0.2) — both ask
"is there liquidity here." But air-pocket inferred thinness from a **volume-vs-pace** relationship in
the 5 bars before the touch (`AIR_POCKET_SIGNAL_SPEC.md:36-43`), and its quadrant already failed
stability. E infers it from **where the level sits in a historical volume-at-price distribution** — a
different measurement on different data. Adjacent motivation, genuinely different measurement. Worth
saying out loud rather than letting someone discover the resemblance later and distrust the whole
proposal.

### Idea F — Resting-depth / iceberg detection: BLOCKED, not buildable, do not proxy it

The honest order-book answer to "is this level defended" is resting bid/ask size, absorption of
aggressive flow into a static price, and iceberg refills. **This system does not have that data and
nothing above pretends otherwise.**

`price_bars_primary` does expose `bid_volume` and `ask_volume` (`server/schema.sql:5489-5490`,
`5501-5502`), and it is tempting to read those as depth. **They are transacted volume at bid vs at
ask — the delta family, not resting depth.** Two independent reasons not to build a proxy:

1. Delta-sign variants are **already 5-for-5 failed** in this codebase
   (`TOUCH_QUALITY_SIGNAL_IDEAS_SPEC.md:106-108`).
2. `DEFENDED_LEVEL_RETEST_SPEC.md:91-94` explicitly dropped "bid/ask resting size (distinct from net
   delta)" from its own first pass for exactly this reason — no measurement or threshold defined, and
   it would have been an unaccounted third free parameter.

So: genuinely order-book-shaped, **blocked on data this system does not have**, and the available
bid/ask columns are not a substitute — building a proxy from them is re-running the already-failed
delta family under a new name. Flag it as a future thread contingent on a depth-of-market feed, and
leave it there.

---

## 3. QUESTION 2 — How to trade a liquidity zone / defended level

§2 answered *detection*. This section answers *what you do with it*, and the answer is not one
answer — it is three, because this engine has three structurally different decision surfaces and a
defense signal is worth different amounts at each:

| Surface | Live site | What a defense signal could do there |
|---|---|---|
| **Fire / don't fire** | cluster candidate loop, `acd.js:7354-7372` | hard skip, and *reroute to another cluster member* |
| **How big** | `sizeMultiplier` IIFE, `acd.js:7647-7745` | one more multiplicative factor in a ~20-factor stack |
| **How much risk / how far** | `stepWiderTarget()`, `widerTargetWalker.js:48-90`; `t2`, `acd.js:7569` | gate the runner / wider-target arm |

The whole of §3 is about picking between these, and my headline conclusion is that the third one is
the most valuable and the least obvious, for a reason specific to §0.1 that I'll get to in §3.3.

### 3.1 Does "undefended" mean fade-the-other-way, breakout-instead, or don't-trade?

**Recommendation: don't-trade (a suppression / size-down signal on the EXISTING fade). Not a
directional flip. The breakout-instead branch gets exactly one cheap test, in a form that never
creates a level-anchored setup_type — and if it fails, that branch closes permanently.**

**Why the directional flip (a) is rejected outright, not just deprioritised.** Fade direction is
assigned purely by approach side — `const isLong = approachDir === 'FROM_ABOVE'` (`acd.js:7229`).
Flipping it does not produce "the same trade backwards"; it produces a trade wearing a fade's
calibration. Stop and target come from `liveStats._opt?.[type]` (`acd.js:7393-7395`), i.e. the
`performance_audit signal_type='OPTIMAL_STOP'` row for that *fade* setup_type — calibrated on the
reversion MAE/MFE distribution. A flipped trade inherits stop/target derived from the outcome
distribution of the opposite bet. Every other keyed artifact has the same problem: `SETUP_STATUS`,
DOW suppression, the `DAY_TYPE_ALPHA` row, `_pairBonus`, and the p80-of-winners stop note
(`acd.js:7577-7578`) are all keyed to the fade type. So a flip needs a **new setup_type with its own
calibration** — which is precisely the `BRACKET_BREAKOUT_*` shape §0.3 documented failing
(`acd.js:5434-5437`: SUPPRESS N=37 EV=-$16.84 / THIN_N N=16 EV=-$104.75). A flip is not a cheaper
version of (b); it *is* (b), with worse hygiene.

**Why "undefended" logically licenses (c) and not (b).** This is the argument I'd lead with if
challenged. "Undefended" is a *negative* claim: no counter-party is present at this price. That
directly negates the fade's own thesis (something here will push price away), which is exactly what
a suppression signal needs. It does **not** assert continuation, and it certainly does not assert
continuation *to any particular distance*. A continuation trade needs a target, a target needs an
MFE distribution, and nothing in §2 measures one — ideas A–E all measure the level's state, none
measures how far price travels after passing through it. Reading "nobody is here" as "therefore it
runs" is an unlicensed inference, and it is the same inference `BRACKET_BREAKOUT_*` made.

**The cost asymmetry, which is the practical reason.** A suppression signal inherits all existing
calibration, adds no setup_type, no stop/target derivation, no resolution path, and its failure mode
is foregone trades — which this codebase already measures, because skipped candidates are logged
through `logGatedCandidate()` (`acd.js:384`, called at `acd.js:7370`). A continuation branch needs
all of that machinery built before the first honest number exists. Same information, one to two
orders of magnitude difference in the cost of being wrong.


#### The one cheap test of the breakout branch — invert the direction of inference

Do **not** build "level → find a continuation trade." Instead take the continuation population that
already works and ask whether level context adds anything. §0.3 established the asymmetry; this is
the cheapest way to actually test it:

`scripts/backtest_compression_volume_breakout.mjs` already emits every volume-confirmed 30-bar RTH
breakout event with `{idx, dir, isCompressed, volZ, ts_str, mod, date}` (lines 147-157), arms them
via `getArm()` (lines 210-218) with `NO_COMPRESSION_CONTROL = allBreakoutVolConfirmed` (line 224),
and `reports/compression_breakout_stop_target_sim.md` already carries the full stop/target grid with
a 3-way stability flag — **N=1516, best `+++ (STABLE)` cells $11.59 (250/102) and $11.13 (138/102)**.

The test is one added column and one added split:

1. For each of those 1516 breakout bars, compute — from bars strictly before it, formation-gated via
   `SAME_DAY_FORMING_MINUTE` (`pilot_touch_quality_features_deepseek.mjs:331-334`) — whether a
   `level_prices` level sits within 15pt of the breakout bar's close (the live `nearLevels` band,
   `acd.js:7167`), and if so that level's idea-C `acceptedTimeFrac`.
2. Re-run the **same** grid, split three ways: (i) no level nearby, (ii) level nearby and *defended*
   (bottom `acceptedTimeFrac` tercile), (iii) level nearby and *undefended* (top tercile).
3. Terciles, not literals — `ANTIGRAVITY_CONSTRAINTS.md:18-24` rule 1.

**Pre-registered kill condition, written before the run:** the headline cell is 138/102 (chosen
because §0.3 already cited it, so it cannot be picked post-hoc). If arm (iii) does not beat arm (i)
by at least the standing economic floor — **$4-5/trade**, `TOUCH_QUALITY_SIGNAL_IDEAS_SPEC.md:297`
— while holding `+++` stability, then **"undefended level → trade the breakout instead" is closed
permanently** and "undefended" is a fade-suppression signal only. Report all three grids either way.

Two properties make this the right test rather than merely a cheap one. It **cannot promote anything
to live on its own**: a positive result says "level context is a useful filter on the bar-structural
breakout," and the only wiring that licenses is a filter on the existing breakout candidate — never a
new level-anchored type. And it is **capable of closing a branch**, which is worth more than another
marginal sizing factor.

**One pre-existing data point worth reading before getting excited about (b).** The same report
already contains a fade-the-failed-break arm — `FADE_CONTROL` (compressed, `volZ <= 0.0`, i.e. the
break came without volume): best cell **$13.43 at 162/118, N=316, `++- (MIXED)`**. So the closest
existing analogue to "the break isn't real, trade back against it" is real on the mean but **not
stable, on a fifth of the N**, while the continuation arm is stable on 1516. Directionally that is
another mark against reading an undefended level as a tradeable flip.

### 3.2 Where defense-strength would slot into the existing fade — and where it can't

**Stage 1 — do this regardless of any EV result, at zero execution risk.** Emit the feature into
`sizeFactorsAtDetection` (`acd.js:7624-7645`) and into the description string, wired to **nothing**.
This is not a placeholder, it is this codebase's own documented pattern twice over:

- `hivolLopaceNote` (`acd.js:7603-7605`) is a *CONFIRMED* signal that is still deliberately
  informational-only — "never gates entry or `sizeMultiplier` per this app's standing 'no execution
  capability' convention" (`acd.js:7598-7602`).
- `sizeFactorsAtDetection` exists precisely so a future joint model is buildable without
  reimplementing the context pipeline — `OPEN_DECISION sizemultiplier_needs_per_factor_instrumentation`
  (`acd.js:7609-7619`).

Stage 1 starts accumulating real live forward data on the feature immediately while risking nothing.
It should ship before any backtest finishes.


**Stage 2 — if a pooled effect survives §2's redundancy controls: a multiplicative factor in the
IIFE, and the slot is not arbitrary.**

The IIFE is order-dependent and contains **three absolute assignments** that erase everything before
them, not clamps:

| Line | Statement | Shape |
|---|---|---|
| `acd.js:7683` | `mult = 0.25` (DAY_TYPE_ALPHA `SUPPRESS`) | absolute set |
| `acd.js:7689` | `mult = 0.10` (`_lfSameDirN >= 7`) | absolute set |
| `acd.js:7739-7743` | `mult = Math.min(mult, 0.10 / 0.25)` (loss streak) | ceiling, documented "applied LAST — hard ceiling nothing else can override" |

So the constraints are hard: **after line 7689, before line 7741.** A defense factor placed anywhere
above 7689 is silently annihilated on every trend day — which is exactly the population where a
defense signal is most likely to be informative, so the bug would be invisible in aggregate and
maximally costly in the cases that matter. This is CLAUDE.md:92's overwrite footgun
(`active.sizeMultiplier` overwrite incident — "any future code that sets a field a candidate object
already sets in its own construction must merge/cap, never blindly overwrite") reappearing *inside*
the IIFE rather than at its boundary. The IIFE's own instrumentation comment already flags the same
hazard in its own words: "the IIFE below is order-dependent with absolute sets (SUPPRESS → mult=0.25,
stacking>=7 → mult=0.10, loss-streak ceilings), so a before/after delta per factor would be
non-monotonic and misleading" (`acd.js:7613-7617`).

**The specific slot I'd recommend: immediately after the revisit-latency block,
`acd.js:7696-7698`.** Three reasons, in order:

1. It is past both absolute sets (7683, 7689) and well before the loss-streak ceilings (7741).
2. Revisit latency *is* the existing "has this liquidity already been picked off" factor
   (`minutesSinceVisit === null → +0.15`; `>= 180 → -0.25`). A defense factor is its nearest sibling,
   and §2's idea D is explicitly a repair of that exact factor's cluster blind spot. The code should
   read as one block so the next reader sees the relationship without hunting for it.
3. Co-locating them makes the double-count visible. **This is a real sizing bug risk, not just a
   research artifact:** line 7697 already pays +0.15 for a fresh anchor, and `clusterFreshFrac` is
   correlated with that by construction, so stacking them independently pays twice for one fact. The
   two must be **jointly** calibrated — which is what §2 idea D's `confluenceCount × clusterFreshFrac`
   2×2 (restricted to `minutesSinceVisit === null`) exists to establish.

**Form: clamped, never absolute.** `Math.max(mult - X, 0.25)` for undefended, `Math.min(mult + X, 1.5)`
for defended — matching every other factor's convention (e.g. 7697-7698, 7702, 7711, 7719-7720).
Adding a *fourth* absolute set to this IIFE would compound the ordering problem for every future
factor, and the next person to add one would have no way to know.

**What `sizeMultiplier` structurally cannot reach.**

**(i) Hard suppress before the candidate is built — and this does something sizing genuinely
cannot.** If the finding is strong enough that the trade shouldn't fire at all, the correct site is
the cluster candidate loop's gate conjunction:

```js
if (!candRecentlyFired && !candSuppressed && !candDowSuppressed && !s2Double && !trendCounterFadeFlag) {
```
(`acd.js:7359`)

with a new branch in the `skipReason` ladder at `acd.js:7365-7369` so it flows through
`logGatedCandidate()` — no silent drops. The reason this is not merely "the same thing but harsher":
**a skip here lets the loop continue to the next candidate in the same cluster** (`for (const cand of
sortedCandidates)`, `acd.js:7354`, with `break` only on `winnerFound`). An undefended level gets
*replaced by a better-defended cluster member* rather than sized down. That is exactly the
second-phase application `DEFENDED_LEVEL_RETEST_SPEC.md:185-193` scoped out of its own first test —
"prefer a candidate showing real defense over one just ranked by historical EV when multiple levels
are clustered" — and it is **unreachable from the IIFE**, because selection is already final by
then (`winnerFound` gate at `acd.js:7391`, IIFE at `acd.js:7647`).

Two rules this must respect. CLAUDE.md:116 — all level-fade suppression flows through
`backtest_setup_status.mjs` → `SETUP_STATUS`, never a hardcoded list in `acd.js`. A per-touch,
live-computed defense skip is not a type-level suppression list, so it doesn't violate that rule —
but it must not be implemented as one, and its cutoff must be a rolling/within-session percentile,
not a literal (`ANTIGRAVITY_CONSTRAINTS.md:18-24`). And per §2 idea D, keep signal validation and this
new selection application in **separate** passes — validating both at once makes a negative ambiguous,
the same reason `DEFENDED_LEVEL_RETEST_SPEC.md:185-193` deferred it in the first place.

**(ii) Stop/target — §3.3.**


### 3.3 Does defense-strength change RISK, not just whether/how big to fire?

**Yes — and this is the single most attractive use of a defense signal in this document, for a reason
that is specific to §0.1 and that I don't think has been noticed in this repo yet.**

**The structural argument.** All three negatives in §0.1 share one shape: the signal is real, but you
must *pay bars* to obtain it, and the delay cost exceeds the selection value. Every one of those tests
spent its delay budget on the **entry** decision — `DEFENDED_LEVEL_RETEST_SPEC.md:71-75` required the
signature to *complete* before entry, and `:209-211` concluded "waiting AT ALL underperforms blind
entry."

The runner / wider-target decision spends nothing, because its decision point is **after entry**.
`stepWiderTarget()` (`server/services/widerTargetWalker.js:48`) evaluates at the T1-touch bar:

```js
const pressureGateOk = pressureThreshold == null || pressureReading == null
  || pressureReading >= pressureThreshold;
if (barCount <= maxBarsToT1 && !isSessionEnd && pressureGateOk) {
  newState = { widening: true };
```
(`widerTargetWalker.js:75-79`; `WIDER_TARGET_MULT = 1.5` line 25, `MAX_BARS_TO_T1_FOR_WIDER = 4`
line 26, the wider target itself computed at `acd.js:994`)

At that bar the trade is already open and already at T1. Therefore:

- A defense reading computed per §1's rule (bars strictly before the touch bar) is **already known
  there, free**.
- A *realized* defense reading — did the level actually hold over the bars the trade has been open —
  is **also free there**, because those bars elapsed as part of the trade, not as a pre-entry wait.

**That is the one decision surface where the exact thing §0.1 proves you cannot afford to wait for
costs literally nothing, because the wait is already sunk.** If a defended-level feature is worth
building at all, this — not sizing — is the sharpest reason.

**Why it should be true mechanically.** A defended level means a real counter-party is present and
absorbing at that price. The fade's thesis is that this counter-party pushes price away. If it is
real, the push has *size* behind it and should carry past T1. If the level was undefended and price
reverted anyway, the reversion is drift, not displacement — nothing is sponsoring it, so it has no
reason to extend. Prediction: **defended-level winners have a fatter MFE right tail; undefended-level
winners reach T1 and stall.** Note this predicts a *tail* difference, not a mean one — and note it is
falsifiable in the useful direction, because the opposite (a defended level *caps* the move, since the
same size that pushed price off will also fade the extension) is equally plausible a priori. That is
what makes it a test rather than a story.

**The outcome metric has to be a tail statistic, per this codebase's own convention.**

- **Primary**: `P(MFE ≥ 2 × that setup_type's own median MFE)` conditional on defense state — the
  exact form `COMPRESSION_TAIL_MFE_SPEC.md:177` mandates. Computable from `active_setups.mfe_points`
  (`server/schema.sql:354`), real-`origin_status` only.
- **Not** mean EV, and that spec's reason transfers verbatim: a near-zero mean is "consistent with
  *both* 'no real effect' and 'a real tail effect diluted by an outcome metric that can't see it' —
  mean EV cannot distinguish these two cases" (`COMPRESSION_TAIL_MFE_SPEC.md:184-188`). If a real
  counter-party is present on only ~20-30% of touches, the mean reads ≈$0 **by construction** whether
  or not the effect exists. This is the specific way this test would produce a false negative, and it
  is the most likely way to get a wrong answer here.
- **Secondary**: `p90_mfe`/`p75_mfe` vs `p50_mfe` spread by defense bucket — the same real-data
  right-tail check `COMPRESSION_TAIL_MFE_SPEC.md:252-256` requires before committing a setup_type to a
  runner pilot.
- **Precedent that the engine already reasons this way**: the only existing T2 runner is `eliteZone`
  (`t2` at `acd.js:7569`, condition at `acd.js:7495`), and its live justification is a tail statistic,
  not a mean — "p75 MFE on confirmed TURBULENT winners is 157pt" (`acd.js:7579`). A
  "defended → wider target" gate would be the second member of an existing family, argued identically.


**Two build options, cost-ordered.**

- **R1 (recommended first) — a second condition in the existing gate.** Add an optional
  `defenseReading`/`defenseThreshold` pair to `stepWiderTarget()`'s params, in the same shape as
  `pressureReading`/`pressureThreshold` (both already default to `null` with documented
  pre-2026-08-24 fallback behaviour, `widerTargetWalker.js:36-38`) — purely additive, no behaviour
  change for any caller that doesn't pass it. Threshold read from `performance_audit` via the same
  cached pattern the pressure gate already uses (`acd.js:703-714`,
  `signal_type='WIDER_TARGET_PRESSURE_GATE'`), never hardcoded. **Needs its own distinct `method`
  string** alongside `BANKED_LOW_PRESSURE` (`widerTargetWalker.js:87`) so the two gates' decisions
  never get conflated in later analysis — that string exists for exactly this reason.
- **R2 (only if the effect changes the whole risk shape, including the stop)** — a
  `CONDITIONAL_VARIANTS` entry (`server/config/setupTypes.js:387`) routed by `resolveSetupType()`, the
  pattern the six `_TRAIL` variants use. `SCALEOUT_RUNNER_SPEC.md §4` gives the reason: changing a
  setup's exit changes its own P&L distribution and corrupts its existing SUPPRESS/PROMOTE calibration
  if mixed in place. **Do not inline-modify `stop`/`target` on the base type at `acd.js:7567-7569`.**

R1 first: it extends a mechanism already live to `ACTIVE` with a real track record — 53 armed, 47
`WIDER_TARGET_HIT`, 5 `WIDER_STOP_HIT`, **+$1,071.75** vs a plain-bank-at-T1 counterfactual over 19
SHADOW days (`OPEN_THREADS.md:1159`) — needs no new setup_type, and produces its own labelled
population for free.

**Honest N problem, stated up front.** The armed population is thin: the gate only sees trades
reaching T1 within 4 bars (`MAX_BARS_TO_T1_FOR_WIDER`), and live armed N was 53
(`OPEN_THREADS.md:1159`). A defense split on 53 rows is two cells of ~26 — at
`ANTIGRAVITY_CONSTRAINTS.md:46`'s N≥20 floor for a *mean*, and nowhere near enough for a **tail
probability**, which needs far more N than a mean to estimate at all. So R1 must be tested on the
**backtested** armed population first (via `scripts/lib/breakevenTrailCore.mjs`, described in
`COMPRESSION_TAIL_MFE_SPEC.md:245-249` as real reusable bar-walk infrastructure with its own guardrail
suite — import it, don't reimplement), not on live rows. Live wiring waits on that.


### 3.4 Build sequence — ordered by decision value, not idea quality

§2 ranked A/D as cheapest and most likely *in isolation*. That is the wrong ordering for building,
because two steps here can either delete work for free or unlock a test that closes a whole branch.
Revised order, with the reason each position is what it is:

**Step 0 — idea D's free census.** Among fired setups with `confluenceCount >= 2` and
`minutesSinceVisit === null`, what fraction had at least one cluster partner already visited? Pure
query against the persisted `confluence_levels_at_detection` (`acd.js:7782`, also `7891` — join on the
stripped `_FADE` form per the caveat at `acd.js:7885-7891`) plus bars. Low single digits ⇒ D is
N-starved and dies at zero cost. **First because it is the only step that can delete work.**

**Step 1 — idea C, then idea A, in ONE extraction pass. C first, and specifically because §3 needs
it.** C (`acceptedTimeFrac`) is the only §2 feature with zero parameters, zero forward horizon and no
`UNRESOLVED` population — which means it is **the only one computable on an arbitrary bar rather than
only on a level touch.** §3.1's breakout test needs exactly that: it must score the level context of
1516 *breakout* bars, which are not level touches and have no fade to resolve. A's `holdRate` cannot
do that without a forward walk per event. **So C is promoted above A not because it's more likely to
work as a fade filter, but because it is the enabling feature for the one test in this document that
can close a strategy branch.** A rides along in the same pass — same bar walk, same formation gate —
and A's pre-registered `holdRate × _lfSameDirN` 2×2 (§2 idea A) must run in that same script, not be
deferred to a later one.

**Step 2 — §3.1's breakout-context test**, as soon as C exists. Reuses
`backtest_compression_volume_breakout.mjs` wholesale. Highest decision value per unit of work in the
document, because *either* outcome is actionable: positive ⇒ level context filters an already-stable
population; negative ⇒ the entire continuation reading of "undefended" is closed and never has to be
revisited.

**Step 3 — §3.3's tail split** on the *backtested* armed wider-target population, using whichever of
A/C survived Step 1. **Deliberately before any IIFE wiring.** If defense-strength is a risk signal
rather than a size signal, wiring it into `sizeMultiplier` first spends the finding in the wrong place
*and* hides it: a size factor averages over the whole population, while the effect (if it exists)
lives in a subset and in a tail. The ordering matters here for a real reason, not tidiness.

**Step 4 — idea B**, only if A showed a pooled effect — §2's own pre-registration rule
(`TOUCH_QUALITY_SIGNAL_IDEAS_SPEC.md:293-296`, "pool first, split only after a pooled effect appears").
A flat A plus a great B is a 2-cell fishing expedition, not a discovery.

**Step 5 — idea D's full build**, only if Step 0's census showed real N, and necessarily after C (D's
`clusterMaxAccepted` is *defined* in terms of C's `acceptedTimeFrac`).

**Step 6 — idea E last.** Three independent reasons: highest lookahead risk in §2 (the repo has a real
prior incident recorded in a table name, `level_prices_3m_va_lookahead_backup_20260719`,
`server/schema.sql:3205`); it needs an HVN/LVN classifier that doesn't exist yet (`computeProfile()`
returns a histogram, no node classification); and it needs the within-`setup_type` control or it will
just rediscover that `PD_POC` fades are good. Decisive reason for last place though: **E does not
inform §3 at all.** Nothing in §3.1/§3.2/§3.3 changes based on E's result — it is a pure detection
feature with no bearing on which decision surface to use.

**Step 7 — idea F: never**, absent a real depth-of-market feed. Do not proxy it from
`bid_volume`/`ask_volume` (§2 idea F).


### 3.5 What this document must NOT be used for

**Nothing in §2 or §3 has been run.** No query, no backtest and no DB read produced any part of this
file — the header's claim is still true of §3. Every number appearing anywhere in this document is a
**citation of a pre-existing finding**, verifiable by `sed -n` at the cited line. Not one is a result
of this document's own proposals.

Explicitly **not** findings, and having no N, no EV, no rigor and no stability result anywhere:
`holdRate`, `holdRateDistinctLevels`, `holdRateSameSide`, `holdSpread`, `acceptedTimeFrac`,
`rejectionRatio`, `pierceBars`, `clusterFreshCount`, `clusterFreshFrac`, `clusterMaxAccepted`,
`nodeZ`, `defenseReading`, `defenseThreshold`. **None of these exists in code.** If a future session
encounters one of these names in a doc, a variable, a commit message or another scratch file, it
originated *here*, as a proposal, and must be treated as unvalidated until it has its own real run.

Also design-only, and specifically **not** licensed by this document:

- The §3.2 Stage-2 slot recommendation (after `acd.js:7698`, before `acd.js:7741`) and the §3.2(i)
  candidate skip at `acd.js:7359`. Both are contingent on a positive result that does not exist. **Do
  not wire either on the strength of this file.** The only part of §3.2 that is safe to ship
  unconditionally is Stage 1 (instrumentation wired to nothing), and that is safe precisely *because*
  it changes no behaviour.
- §3.3's R1 (`stepWiderTarget()` second gate condition) and R2 (`CONDITIONAL_VARIANTS`). Same status.
  R1 in particular reads as small and additive, which makes it the most likely thing in this document
  to get shipped ahead of its evidence — it must not be.
- §3.1's recommendation itself. "Undefended = suppression, not a directional flip" is an **inference
  about where to spend test budget**, drawn from two real cited findings (`acd.js:5434-5437`'s
  bracket-breakout numbers; `reports/compression_breakout_stop_target_sim.md`'s N=1516 stable arm).
  The cited findings are real. The inference is a judgement call and could be wrong — which is exactly
  why §3.1 specifies a falsifiable test with a pre-registered kill condition rather than just
  asserting the conclusion.
- The §3.4 ordering. It is a reasoned build plan, not a result, and its premises (C is cheap, D's
  census is nearly free) are code-reading estimates, not measured costs.

**No `RESEARCH_CLAIM` should be written from this file. No `OPEN_DECISION` should be marked resolved by
it.** The only legitimate artifacts this document can generate are `OPEN_DECISION`-shaped entries
recording that these tests are *unrun*, each carrying a pointer back to the pre-registered kill
condition stated in §2 or §3 — so that a later session cannot quietly relax a threshold after seeing
results. The pre-registered conditions that matter most, restated in one place so they are hard to
lose: A dies if its effect lives entirely inside the `_lfSameDirN >= 7` cell (§2 A); C's
`rejectionRatio` is assumed tautological unless `acceptedTimeFrac` also moves (§2 C); D dies if the
Step-0 census is low single digits (§2 D / §3.4); E dies if the effect vanishes conditioned on
`setup_type` (§2 E); §3.1's breakout branch dies if arm (iii) fails to beat arm (i) by $4-5/trade at
the 138/102 cell with `+++` stability.

**One prior-art hazard to carry forward.** §0.1's `defended_level_retest_confirmation_entry_negative`
already closed one defended-level design, negative in 8 of 8 cells. Nothing in §2/§3 reopens that
claim — everything here routes around it by refusing to pay entry delay (§1), and §3.3 goes further by
moving the decision to a point where the delay is already sunk. **If any future implementation of these
ideas reintroduces a wait-for-confirmation-before-entry step, it is re-running a test that has already
failed three independent times (§0.1's table), and it should be stopped rather than re-scoped.**

---

## 4. Results — Steps 0-2 have now actually been run (2026-08-26, follow-up session)

**The "nothing has been run" claim in §3.5 above is now stale for Steps 0-2 of §3.4's build
sequence — it still holds for Steps 3-7.** Three real runs happened in the same-day follow-up
session, each independently audited (not taken at face value from a single Gemini pass), plus one
adjacent real-world pattern the user identified from their own market intuition mid-session that
connects directly to this document's core question. Full narrative, every number, and both
`RESEARCH_CLAIM`/`OPEN_DECISION` slugs: `docs/OPEN_THREADS.md`'s 2026-08-26 entries (search
"liquidity zones"). Summarized here for this spec's own record:

### 4.1 Step 0 (idea D's free census) — SURVIVES

Among real fired FADE touches with a fresh anchor inside a confluence cluster, **11 of 12 (92%,
N=12) had at least one cluster partner already visited earlier that session** — an intermediate,
bug-corrected run found 49% at N=75. Both are nowhere near the "low single digits" kill threshold
this doc's §2 idea D pre-registered. **Idea D clears Step 0 and is worth building**, though N=12 is
too thin to be decisive on its own (below this codebase's N≥20 floor). Two real bugs had to be
found and fixed to get here — a query-design mistake (filtering on a DB column only 6 days old)
and, more importantly, a genuine 2-week `level_prices` staleness bug for all same-day-forming
levels (`OR5/10/15/30_HIGH/LOW/MID`, `IB_HIGH/LOW/MID`) caused by both automated refresh crons
running before market open — fixed with a new post-IB-close cron. Confirmed NOT live-impacting
(live `acd.js` computes these from bars directly, never from `level_prices`).

### 4.2 Step 1 (idea C `acceptedTimeFrac` + idea A `holdRate`) — DEAD

Built a session-wide touch-ledger extraction (`scratch/pilot_liquidity_zones_idea_c_a.mjs`, N=1045
real fired FADE touches). The FIRST rigor check run (a 2×2 of `holdRate` × the live `sameDirN`
stacking factor, looking for sign-consistency across the split) was **the wrong test** — caught by
the user mid-review: demanding a signal behave identically across every possible regime split is
not how real backtesting validity works; real interaction effects are allowed to flip sign by
regime. **Corrected test**: this codebase's own shared `computeRigor()` (chronological 3-way
stability + day-clustering) applied to each quartile bucket of all 3 metrics
(`acceptedTimeFrac`/`holdRate`/`holdRateDistinctLevels`). Result: **all 12 buckets failed the
chronological stability check** (sign never held across early/mid/late thirds), and 9 of 12 were
also day-clustered. A clean, legitimate kill — for a different and better-grounded reason than the
first check gave. No `RESEARCH_CLAIM` recorded (never cleared the bar to be one, per this doc's own
instruction).

### 4.3 Step 2 (§3.1's breakout-context test) — a REAL positive, opposite of this doc's own hypothesis

§3.1 asked whether "undefended" licenses trading the breakout THROUGH a level (continuation). It
doesn't. But splitting the already-validated compression-volume-breakout population
(`scripts/backtest_compression_volume_breakout.mjs`, N=1516, `+++` STABLE, +$11.13/trade) by idea
C's `acceptedTimeFrac` produced a real, decisive **filter**, via
`scripts/backtest_compression_breakout_level_context.mjs`:

| Arm | N | EV/trade | Stability |
|---|---|---|---|
| No level within 15pt | 313 | **+$26.76** | `+++` |
| Level nearby, DEFENDED (bottom tercile) | 394 | **+$23.20** | `+++` |
| Level nearby, UNDEFENDED (top tercile) | 393 | **-$11.34** | `+--`, negative in all 27 tested cells |

Confound-checked (time-of-day, `isCompressed` fraction — both similar across arms, undefended
actually slightly *earlier* on average, ruling out the obvious elapsed-session-time artifact). Per
this doc's own pre-registered kill condition, "undefended → trade the breakout" is **closed
permanently** — but the entire original average edge turns out to be concentrated in the
no-level/defended cases, with undefended actively losing. `RESEARCH_CLAIM
compression_breakout_undefended_level_filter` (PROVISIONAL). `OPEN_DECISION
wire_undefended_level_filter_into_compression_breakout` — the base breakout signal isn't live yet
either, so wire together, not separately.

### 4.4 A real-world "defended level" instance the user identified independently — the post-flush resumption pattern

Mid-session, the user described this pattern from their own market read, before seeing any of the
above: *"if the market moves a great deal 100+pts in one direction without stopping and then
eventually finds footing and shoots back up but then stalls and shoots back in the original
direction… it's being defended. We should usually be able to recognize and catch that second
move."* That is exactly this document's core question in a concrete, named shape — the footing/stall
point is a defended level, and the tradeable signal is the resumption. It turns out this system
already has a real, once-computed, then-**orphaned** answer:

`scripts/archive/backtest_post_flush.js` (June 2026): a "flush day" (>200pt move from the open in
the first 60 min of RTH) forms a consolidation ("balance") that **85% of the time resolves in the
ORIGINAL flush direction** — the pause is usually just a pause, not a reversal, matching the user's
description precisely. A specific entry rule ("Strategy A": enter in the resolution direction the
moment the balance breaks, hold to the RTH close) backtested at 54.7% WR / $50.63/trade / N=64.
**This was never persisted to `performance_audit`, never wired live, and the script was archived** —
a real no-dead-ends gap, sitting unused for 2 months while new data kept accumulating.

Re-verified 2026-08-26 (`scratch/backtest_post_flush_reverify.mjs`) — fixed a stale hardcoded $1
commission (real value is `LIVE_INSTRUMENT.commissionPerRoundTrip=$2`) and applied `computeRigor()`
for the first time:

- **Population claim: clean and solid.** 85.4% close in flush direction, N=103 flush days (up from
  78 with 2 more months of data), not day-clustered (top5=4.9%), chronologically stable across all
  3 thirds (0.71/0.82/0.60).
- **Strategy A: real but weakening.** Full history +$41.79/trade (N=86, corrected commission,
  54.7% WR), clean on `computeRigor()` — but its own chronological thirds are $48.00 → $63.68 →
  $15.57, a real declining-magnitude trend even though the sign never flips.
- **Held-out (post-2026-06-25, the data that didn't exist when the original claim was made): N=23,
  52.2% WR, +$12.67/trade** — directionally consistent, but too thin to independently confirm on
  its own; a Gemini-generated summary called this "VALIDATED," which overstates what N=23 can show
  — corrected before recording.
- **A striking side-finding while auditing whether N=23 reflected missing data (it doesn't — 44
  real, gap-free trading days confirmed directly against `price_bars_primary`): the last 2 months
  have seen a 56.8% flush-day rate (25 of 44 days) vs. a 23.1% full-history base rate — roughly a
  6x spike.** Down-flushes specifically (>200pt drops) are accelerating year over year: **4 in
  2024, 23 in 2025, 40 already through August 2026** (67 down-flushes total out of 102 flush days
  across the full ~446-trading-day history — down-moves outnumber up-moves roughly 2:1). This
  connects to the existing, never-built `flush-prediction-research` memory thread on overextension
  cycles — not pursued further in this session, flagged here for whoever picks it up next.

`RESEARCH_CLAIM post_flush_resolution_breakout_reentry` (PROVISIONAL — real, not CONFIRMED; the
declining trend and thin held-out N are open questions). `OPEN_DECISION
post_flush_resolution_breakout_wiring_decision` — also flags that this system has no execution
capability to force a close-of-day exit, so "hold to RTH close" as tested needs a realistic
exit-rule substitute before any live wiring.

### 4.5 Flush precursor signals — what's visible before and during a flush (volume, price action, level proximity)

Direct follow-on to §4.4: does the market show a detectable signature *before* a flush happens, or
during its own trigger moment? User asked directly (volume vs 5/10-day baseline, price action,
proximity to known support/resistance) — this revives `flush-prediction-research`, a June 2026
memory thread with the same 3 priorities that was never built out.

**Full history recount at the time of this test: 102-105 flush days (methodology-dependent) out of
~446 clean RTH trading days, 96 on the strictest complete-session filter (>=380/390 bars).**
Direction split, full history: **67 DOWN-flushes vs 35 UP-flushes** (down outnumbers up roughly
2:1). Year-over-year down-flush count, a real and sharp acceleration: **4 in 2024, 23 in 2025, 40
already through August 2026.** Last 2 months (since 2026-06-25) alone: 25 of 44 trading days
(56.8%) were flush days — a ~6x spike over the 23.1% full-history base rate — confirmed as a real
volatility regime, not a data gap (44 real, calendar-gap-free trading days verified directly
against `price_bars_primary`).

**First dispatch (Gemini) had real, confirmed bugs — caught by independent re-verification, not
accepted at face value:**
- Test A (daily volume vs trailing average): produced a nonsensical control-group mean of 5.52x
  and `NaN` z-scores — an unguarded ratio division against a thin/outlier trailing-volume baseline
  (a handful of low-volume days, likely from a known real data-quality gap, exploded the ratio for
  those specific days and dragged the whole average).
- Test C part 1 ("does the flush open near a known level?", claimed 72.4% flush vs 84.5% control):
  did not reproduce — true rate is 99.7-100% for BOTH groups. With ~68 tracked levels, almost any
  price is within 15pt of *something*; this specific question is saturated and uninformative by
  construction, not a real signal either direction.
- Test B (price action) was initially accepted as a dead end on Gemini's say-so ("looked internally
  sane" was treated as good enough) — **this was wrong methodology, not a real negative.** It used
  a ~100-*minute* ATR ratio evaluated right at the open (mostly overnight bars), when the actual
  question is a multi-*day* one. Caught only after direct user pushback ("none of this is a dead
  end, you're not looking close enough") — a real instance of this codebase's own standing rule
  (a too-clean or too-quick negative is a lead to root-cause, not a stopping point).

**What survived independent re-verification (`scratch/verify_flush_precursors.mjs`,
`scratch/verify_flush_priceaction.mjs`), N=96 real flush days vs 292 control days, all
`computeRigor()`-clean (not day-clustered, chronologically sign-stable):**

1. **Elevated recent-vs-longer-term daily range precedes a flush — NOT compression.** Consistent
   across 4 lookback pairs: `ATR(3)/ATR(10)` z=2.53, `ATR(5)/ATR(20)` z=2.34, `ATR(5)/ATR(30)`
   z=3.08, `ATR(10)/ATR(50)` z=3.04. Flush days sit ~7-12% above their own longer-term baseline
   range vs control days sitting at parity. Magnitude is fading over time (thirds: 0.22→0.11→0.04)
   — same declining-edge pattern as §4.4's Strategy A.
2. **Gap size (open vs. prior RTH close) is real and larger before a flush**, and does NOT show
   the same decay: flush mean=203.7pt vs control mean=133.4pt, z=3.02; chronological thirds
   59.05→13.13→**138.85** — dipped then recovered, not a straight decline.
3. **Trigger-price level-proximity, independently reconfirmed** (§4.3's compression-breakout
   finding's twin): flush trigger points land near a known level significantly LESS than a
   permutation-test null predicts (my clean rerun: 67.7% real vs 77.6% null, z=-2.61, left-tail
   p=0.0084 — Gemini's original 52.4%/66.7%/z=-3.56 differed in magnitude but matched in direction
   and significance). **Flushes ignite in the gaps between levels, not at them** — the same
   structural story as §4.3's undefended-breakout finding, now observed independently twice in one
   session.

**Confirmed genuinely dead (checked directly, not assumed):** gap *direction* does not predict
flush *direction* (47.7% continuation, fails its own rigor check); prior-momentum *direction* does
not predict flush direction either (44.8-52.1% across 3/5/10-day lookbacks, coin-flip); streak
length shows no real difference (1.85 vs 2.19 days).

**Net read:** market state (elevated volatility, bigger gaps, price sitting away from known levels)
predicts THAT a big directional move is brewing — a preparation signal, matching the original June
memory's own framing ("widen stops, prepare for directional day") — but nothing found so far
predicts WHICH direction. Direction resolves from the flush's own first 60 minutes, not from
anything visible beforehand. `RESEARCH_CLAIM flush_precursor_volatility_and_gap` (PROVISIONAL).

### 4.6 Structural stop (behind the balance zone) + Globex extension — user's design requirement, tested and validated

User specified an explicit design constraint for the resumption entry: the stop must sit BEHIND THE
BALANCE ZONE'S STRUCTURE (the opposite boundary of the post-flush pause), not at a fixed point
distance — and asked for both RTH and Globex to be covered, not RTH-only. First dispatch (Gemini,
`scratch/evaluate_globex_flush.mjs`) reported this stop **collapsing** RTH from +$41.79 to
+$4.80/trade and Globex staying negative regardless — **both numbers were wrong**, caught by
independent re-verification rather than trusted:

1. Its P&L function returned raw **points**, never multiplied by `dollarsPerPoint`, but was
   labeled and reported as a dollar figure.
2. It reimplemented the balance/resolution detection with different constants than the
   already-validated `scratch/backtest_post_flush_reverify.mjs`, so the "with stop" vs. "without
   stop" comparison wasn't even the same underlying strategy.

**Rebuilt in `scratch/verify_structural_stop.mjs`, reusing the exact validated construction
verbatim** — confirmed correct by exactly reproducing the known baseline (RTH hold-to-close: N=86,
WR=54.7%, EV=$41.79, chronological thirds 48.00/63.68/15.57 — a bit-for-bit match to §4.4, after
fixing one more off-by-one found in the process: the "first 60 minutes" flush-detection window is
**61 bars inclusive**, not 60 — this single-bar boundary flipped the resolution direction on at
least one real date, 2026-01-29, before being caught).

**Real, corrected result:**

| | RTH (N=86) | Globex (N=24, threshold=174.75pt) |
|---|---|---|
| Hold-to-close (original) | EV=$41.79, `clean` | EV=**-$71.00**, thirds 34.81/-176.19/-71.63, **NOT clean** |
| Structural stop (behind balance) | EV=$42.71, `clean` | EV=**+$36.79**, thirds 60.75/26.31/23.31, **clean** |

**The structural stop costs nothing on RTH** (essentially unchanged, both rigor-clean) — the
original hold-to-close finding was never actually threatened by adding a real stop. **On Globex,
it's the difference between broken and working**: hold-to-close is genuinely bad overnight (wildly
unstable, deeply negative), but the exact same stop-behind-structure rule the user specified turns
it into a real, clean, stable positive. N=24 is thin (barely past this codebase's N≥20 floor) —
promising, not proven, but directionally validated on both a design-preference and an
econometric basis. `RESEARCH_CLAIM flush_structural_stop_rth_vs_globex` (PROVISIONAL).
**Globex threshold (174.75pt) is inherited from Gemini's Part 0 percentile-matching derivation
(matching RTH's 200pt own 76th-percentile position in the RTH 60-min-move distribution onto
Globex's own distribution) — not independently re-derived this pass, worth a spot-check before
leaning on it further.**

**Status: clears the bar to start designing the live "Flush Watch" dashboard card** (RTH + Globex,
informational-only, entry = balance-zone break, stop = behind the balance zone) — the next step in
this thread, not yet built.

### 4.7 Replacing the arbitrary 200pt threshold with real percentiles — and answering "when does a wider target make sense"

User challenged the 200pt/174.75pt anchors directly: they were never actually derived from data,
just inherited from the original 2026-06 backtest. Asked two things: what does the real percentile
distribution of a slide/run-up look like (RTH and Globex), and — mirroring the existing
`eliteZone`/`stepWiderTarget()` live pattern (`server/routes/acd.js`/
`server/services/widerTargetWalker.js`, which widens targets to `targetPts*2` once a condition
suggests a bigger move is likely, justified by a real percentile of a conditional distribution, not
an arbitrary multiplier) — at what point should this system consider a wider-target modifier.

Built `scratch/move_distribution.mjs` (unconditional max-move-from-open, first-60-min-inclusive
per §4.6's fixed 61-bar convention, RTH and Globex, UP and DOWN separately) and, within the same
script, the conditional question ("given the move already reached checkpoint X, how much further
does it tend to go"). Independently spot-verified (recomputed the most decisive claim — the
Globex-DOWN elbow — directly from the persisted raw event JSON, exact match).

**Part A — where 200pt/174.75pt actually sit** (N=446 RTH days, N=821 Globex sessions):

| Regime | p50 | p75 | p90 | p95 | Old threshold's real percentile |
|---|---|---|---|---|---|
| RTH-UP | 67.13 | 130.13 | 190.63 | 259.88 | 200pt = **p92.2** |
| RTH-DOWN | 71.63 | 142.81 | 242.50 | 298.81 | 200pt = **p84.8** |
| Globex-UP | 22.00 | 58.75 | 148.50 | 225.25 | 174.75pt = **p92.0** |
| Globex-DOWN | 18.75 | 59.00 | 119.50 | 184.50 | 174.75pt = **p94.3** |

200pt wasn't arbitrary in effect, even if never derived — it landed in the top 8-16% either way. But
the four regimes' SHAPES differ enough that one shared cutoff was always going to be a blunt
instrument.

**Part B — the actual wider-target answer, and it's not one universal rule:**

- **RTH-DOWN: exhausts.** Conditional median remaining distance SHRINKS as the move extends (72pt
  remaining at the p50 checkpoint → 57pt at p90). Extension here is a sign of running out, not
  building — argues against widening targets on RTH downside at all.
- **RTH-UP: flat, then a late, modest elbow at p90** (~190pt) — median remaining jumps 45pt→73pt
  only past that point.
- **Globex-UP: no elbow — smoothly increasing.** The more it's already moved, the more it keeps
  moving, continuously, from p50 through p85. A continuously-scaling multiplier would fit this
  shape better than a single trigger threshold.
- **Globex-DOWN: a real, sharp elbow at p90 (119.50pt).** Flat through p85, then conditional p75
  remaining distance jumps from 105pt to 168pt, p90 remaining jumps to 300pt — a genuine regime
  change once a Globex down-move exceeds ~120pt. Structurally the same shape as `eliteZone`'s own
  justification (a real percentile of a conditional distribution, not an invented multiplier).

**Net: no single "wider target past X points" rule serves all four regimes.** Globex-DOWN gets a
real, data-backed trigger point (~120pt) worth designing a widen-target rule around; Globex-UP
would need a continuous scaling factor instead; RTH doesn't support widening on extension in either
direction. `RESEARCH_CLAIM flush_move_distribution_percentiles_wider_target` (PROVISIONAL — a
distributional characterization, not yet rigor-tested for stability over time the way §4.5's
findings were).

**Follow-up, user's own question: what structure is actually being broken right at that ~120pt
Globex-DOWN elbow — prior-day value, a specific support/resistance level, or something else?**
Checked directly (`scratch/globex_down_structure_at_elbow.mjs`, N=83 sessions reaching the
checkpoint exactly reproducing the number above, N=62 checkable once dates predating
`level_prices`' 2023-11-13 start are excluded). **Answer: no single dominant structure.** 54.8%
(34/62) have NEITHER a named/computed level (the full 68-level universe) NOR a raw prior swing low
(3/5/10/20-day trailing lows) within a real 15pt band — genuinely open space. Of the rest, no
family dominates — floor pivots/camarilla lead only because they're the densest, most numerous
level types (7-8 per day each), not because of real significance; prior-day value area ties them
in the real-proximity tally. Raw swing lows are essentially never nearby either (1.6%, checked only
after a real bug — an exact-date-match lookup silently failing on a known, already-documented
`price_bars_primary` data gap — was caught by a suspiciously flat 0.0% and fixed via the same
dense carry-forward pattern used for `level_prices` elsewhere in this thread).

**This is the third independent piece of evidence in this same session pointing the same
direction**: §4.3's undefended-level breakouts beat defended ones, §4.5's flush trigger points
land away from known levels more than chance predicts, and now the Globex-DOWN acceleration point
itself has no structure to break through either. The mechanism looks like pure momentum/distance
already traveled, not a structural break — "what level gets broken to trigger the cascade" is not
the right mental model for this specific inflection point. `RESEARCH_CLAIM
globex_down_elbow_no_dominant_structure` (PROVISIONAL).

**Correction, same question, different reference point — user's follow-up: "I was asking when
price is before it started accelerating. The original starting zone."** The above analyzed
structure at the ACCELERATION point (120pt into the move); the user wanted the STARTING zone (the
Globex open, before the move began) instead. Re-run with both reference points side by side
(same script, same N=62): **at the start, PRIOR-DAY VALUE is the single most common real
structure** — 38.7% of sessions have a prior-day value level (PD_VAH/VAL/POC/HIGH/LOW/CLOSE)
within 15pt of the open, well ahead of camarilla (25.8%) or floor pivots (19.4%), and higher than
prior-day value's own showing at the eventual acceleration point (21.0%). Genuinely open space is
still common at the start too (51.6%, similar to the 54.8% at the acceleration point). **Net
picture**: these moves most often begin anchored near yesterday's value, then travel into
progressively emptier space as they extend — consistent with §4.3/§4.5's "moves happen in gaps,
not at levels" finding, refined to "moves *begin* near real structure, then leave it behind."

### 4.8 When does this actually happen — time-of-night profile (user's direct question)

User asked the natural next question: how do we approach this as a trade, and what time does price
typically hang around value vs. accelerate? Built across the **full overnight session**, not the
first-60-minutes-from-open window every earlier script in this thread used — a deliberate check on
whether that inherited RTH-style windowing convention was hiding the real timing.

**A real, significant bug surfaced and was fixed in the process** (found only because this was the
first script to look past the first 60 minutes): calendar-date bucketing of Globex bars silently
merged two unrelated chunks under one key — the early-morning tail of one night's session and the
start of a completely different session hours later on the same calendar date — producing
impossible 20+ hour "sessions" and accelerations timestamped mid-afternoon. Fixed via real
session-boundary detection (RTH-transition based, with a 3-hour gap-break for weekends) instead of
calendar-date keys. **Confirmed this bug did not affect any earlier finding in this document** —
every prior script only ever examined the first 60 minutes of a session, well before reaching the
erroneous tail.

**Corrected result** (`scratch/globex_value_departure_timing.mjs`, N=241 sessions checked, N=126
with a real ≥119.50pt move after leaving value):

- **Departure from prior-day value usually isn't an overnight event at all.** Median time price
  first closes below `PD_VAL` is **4:15 PM** — right as RTH closes. 40% of sessions (51/126) leave
  value within 2 hours of the close. Most of the time, the overnight session *inherits* an
  already-broken value area from the regular session rather than breaking it itself.
- **The real acceleration is bimodal, not a single window**: it clusters both shortly after the
  evening session opens (**8-10 PM ET**) and right before RTH reopens (**8-10 AM ET**, the single
  largest 2-hour bucket, N=25) — with real, non-trivial activity through the middle of the night
  too (2 AM N=13, 4 AM N=12).
- **Median wait from leaving value to the real move: ~5 hours** (306.5 min), but this varies
  enormously (p25=94min, p75=612min) — no single reliable "wait this long" rule.

**Stability check, prompted directly by the user ("I'm surprised it happens at midnight/2am/5am —
maybe I'm not seeing the full picture over 2-3 years")**: the deep-overnight (10PM-6AM)
acceleration share is **stable across the full ~2.75-year history** — 35.7% / 31.0% / 28.6% across
chronological thirds, 30.0% / 36.8% / 29.5% year-by-year (2024/2025/2026), and the 40 underlying
dates are spread evenly across the whole period, not clustered into a handful of weeks. The
overnight-hour activity is real, not a recent-period artifact. `RESEARCH_CLAIM
globex_down_value_departure_and_acceleration_timing` — **CONFIRMED** (the only claim in this
document to clear that bar, specifically because the stability question was checked directly
rather than assumed).

**Practical read, tying §4.6-§4.8 together**: the setup condition is price already below (or near)
yesterday's value as the regular session ends — not something to wait for overnight. Don't chase
the first break (it often happens immediately and the wait afterward is highly variable); real
acceleration activity spans the whole night (8-10 PM, the 2-6 AM hours, and 8-10 AM — a watcher
needs to run continuously, not just check two "convenient" windows). Once price clears roughly
120pt from the open, §4.7's elbow finding says that's the real "this is a genuine cascade" signal,
and §4.6's structural stop (behind the balance zone) is what turned this trade from broken
(-$71/trade, unstable) to real (+$36.79/trade, clean) in backtest — refined further in §4.9.

### 4.9 Reconciling the two Globex thresholds, real MAE, and a data-derived target instead of hold-to-close

Direct follow-up questions: how much MAE does this trade actually carry, does it really need to
hold all the way into RTH, and — since §4.6 tested the structural stop using the RTH-borrowed
174.75pt threshold while §4.7 later found the REAL, data-derived elbow at 119.50pt — which number
should actually govern the entry population going forward?

`scratch/globex_mae_mfe_target_test.mjs` reuses §4.6's exact validated construction verbatim
(confirmed by exactly reproducing the recorded 174.75pt/N=24/EV=$36.79 baseline bit-for-bit before
trusting anything new), adds real bar-by-bar MAE/MFE tracking, and tests both thresholds side by
side.

**Real MAE, both thresholds agree closely**: p25≈36pt, p50≈77-82pt, p75≈135-138pt, p90≈167-168pt
(a real max outlier at 409pt). **MFE (119.50pt threshold)**: p25=50pt, p50=107pt, p75=191pt,
p90=276pt.

**Switching to the real elbow (119.50pt) roughly doubles the sample (N=49 vs. 24) and surfaces a
real problem the smaller sample wasn't powered to catch**: the current hold-to-close design looks
fine on average ($46.22/trade) but **fails chronological stability** (thirds
20.78/-2.63/116.15 — one period actually negative). Replacing "hold to close" with a **fixed
point target at the trades' own 75th-percentile MFE (~191pt)** fixes this and improves the
number: **N=49, WR=63.3%, EV=$58.79/trade, `computeRigor()`-clean and stable across all three
periods** — better and better-supported than either the raw hold-to-close version or the
originally-recorded $36.79 figure on the thinner borrowed-threshold sample.

**Revised recommendation**: use **119.50pt** (the real, derived elbow) as the Globex-DOWN entry
threshold going forward, not the RTH-percentile-matched 174.75pt borrow — and give the resumption
entry a **real ~190pt target**, not an open-ended hold to the next RTH close. Both changes are
supported by more N and better rigor, not just a marginally higher headline number.
`RESEARCH_CLAIM globex_down_mae_mfe_and_real_target` (PROVISIONAL — a real improvement over the
prior design, still single-pass, not yet independently re-reviewed).

**Answering "does this continue into RTH" directly**: under the ORIGINAL hold-to-close design, yes
— the position was designed to ride through the Globex/RTH boundary to the following day's regular
close. Under this section's revised design (a real ~190pt target), the trade is now more likely to
resolve on its own before RTH even opens, given the acceleration itself commonly happens well
before the 8-10 AM window (§4.8) — reducing, though not eliminating, how often the position
actually needs to carry into the regular session.

**Design decision, user's own words (2026-08-27): "We're going to fire trades and shadow this, not
badge. It can be 'GLOBEX_FLUSH'."** This moves the plan from an informational dashboard card to a
real SHADOW-status `setup_type`, which means it needs to go through this codebase's standard
new-setup-type checklist (CLAUDE.md "New setup type checklist") before it fires live: real
`SETUP_STATUS`/`OPTIMAL_STOP` calibration rows, SHADOW-only until real N≥20, and — since this
detector doesn't fit the existing level-touch candidate loop (it's a multi-hour, whole-session
pattern, not a proximity check) — its own standalone poller replicating the dynamic
SHADOW→ACTIVE promotion logic manually. Not yet built; tracked as the next concrete engineering
step once §4.10's RTH-side parity work below is folded in.

### 4.10 RTH parity — the same questions, asked properly instead of assumed to transfer

User's direct challenge: "What have we found about RTH flushes? Similar questions and patterns
asked as before?" Fair — §4.6-§4.9's deep-dive (starting-zone structure, MAE/MFE, real target) was
built entirely on the Globex side. Re-run in full on RTH's own 200pt/first-60-minute population
(`scratch/rth_flush_full_parity.mjs`, N=103 sessions / N=86 real balance-resolved entries, reusing
the exact validated construction — confirmed by exactly reproducing the already-recorded
$42.71/N=86 hold-to-close-with-structural-stop baseline before trusting anything new).

**Starting-zone structure — even stronger than Globex.** Prior-day value sits within 15pt of the
RTH open in **62.1%** of flush sessions (vs. Globex-DOWN's 38.7%). Genuinely open space (nothing
within 15pt) is **0.0%** for RTH vs. ~52% for Globex — RTH flushes essentially always start near
real structure. (`DAILY_OPEN` shows 92.2% but is a tautology — the session's own open is trivially
close to itself — not a real finding, noted so it isn't mistaken for one.)

**Timing — a single, tight, predictable window, not an all-night spread.** Entries cluster hard
around **11 AM** (median 11:39 AM, p25=11:04 AM, p75=12:28 PM, the 11 AM hour alone holding 36 of
86 entries). Unlike Globex, RTH doesn't need round-the-clock monitoring — a mid-morning watcher
covers nearly all of it.

**MAE/MFE and target — RTH wants a SMALLER target, the opposite of Globex.** MAE: p25=48, p50=86,
p75=157, p90=229 (a bit wider than Globex's 77-82pt median). MFE: p25=51, p50=123, p75=216,
p90=350. Testing fixed targets off this distribution: **target=p50 MFE (~123pt) gives N=86,
WR=60.5%, EV=$46.47/trade, clean and stable** — beats hold-to-close ($42.71) while staying stable.
Critically, **pushing the target out to p75 (~216pt, the width that worked best for Globex)
BREAKS stability here** (`clean=false`). The two sessions need genuinely different target widths —
confirms this should not be built as one shared "GLOBEX_FLUSH-style" rule applied uniformly to
both; RTH and the overnight version need separately tuned parameters even though the underlying
mechanism (structural stop + MFE-derived target beating hold-to-close) is the same shape for both.
`RESEARCH_CLAIM rth_flush_full_parity_vs_globex` (PROVISIONAL).

### 4.11 A pace-based target widener — the initial hypothesis was backwards for Globex

User's request: find a target-widener mechanism triggered by pace speeding up, matching the design
shape of the existing live `stepWiderTarget()`/`eliteZone` runner (widen when a real signal
suggests a bigger move). Defined pace as points/minute from the session's own open through the
balance-breakout entry — known entirely at entry time, no lookahead.

**The "faster pace → bigger move" hypothesis was wrong for Globex, and the user correctly
anticipated this before the numbers came back** ("I feel like we need a similar target modifier
for Globex because it's slower but still extends sometimes but slower"). Pace-vs-MFE correlation
for Globex is **-0.142 (negative)**. Standalone tercile breakdown: FAST pace is the worst bucket
(median MFE=95.5pt, hold-to-close EV=-$57.03, N=16) while SLOW (averaging 568 minutes — 9.5 hours
— just to reach entry) and MID are both strong (EV $93.88 and $98.84). SLOW and MID's own p75 MFE
are nearly identical (192.8pt vs 193.0pt) — the real split is NOT-FAST (bottom two-thirds) vs. FAST
(top third), not a smooth 3-way gradient.

**Final tuned design**: NOT-FAST (slow+mid pace) gets a wide **~193pt** target; FAST gets its own
tighter **~96pt** target (both derived from each group's own MFE distribution). Result: **N=49,
WR=65.3%, EV=$61.68-61.94/trade, `computeRigor()`-clean and stable** — beats §4.9's flat
single-target-for-everyone version ($58.79/trade) on the identical population. `RESEARCH_CLAIM
globex_flush_pace_based_target_widener` (PROVISIONAL).

**RTH tested in parallel — weaker, don't over-trust it.** Pace-vs-MFE correlation is weakly
positive (+0.168, the direction originally hypothesized), but the tercile breakdown is
hump-shaped (MID bucket best, both SLOW and FAST worse) and **none of the 3 RTH tercile buckets
individually clears `computeRigor()`** at their N=28-29 each. The RTH pace-widener improvement
found ($46.47→$50.89) is real on paper but sits on much noisier ground than the Globex result —
treat it as a lead, not a settled design choice, until it has more N.

**Design implication for the eventual GLOBEX_FLUSH build**: pace is now a validated, real input for
sizing/targeting — not just distance-from-open (§4.7) or timing (§4.8). A fast approach to the
balance-breakout entry is a genuine warning sign for Globex (tighten the target, or size down), not
a green light to widen — the opposite of the naive intuition and of how `eliteZone` currently uses
a comparable "this looks like a bigger move" signal elsewhere in the app.

### 4.12 Volume behavior — a spike says exhaustion, sustained/building volume says continuation

User's hypothesis: does a volume spike combined with breaking the overnight range predict a much
bigger move (target near a multiple of 1-minute ATR)? **First test, checked as literally stated,
failed and reversed** — a single-bar volume z-score spike (2-3 bars around the flush or the later
balance-breakout entry) combined with an overnight-range break predicted a SMALLER eventual move in
both markets. Breaking the two conditions apart: volume-spike-alone predicted a smaller move in RTH
(82.4pt vs. 162.3pt without one) — **consistent with this codebase's own already-confirmed
`hivolLopace` finding** that a single-bar volume spike without matching price movement is a real
exhaustion/climax signal here, not a continuation one.

**User refined the hypothesis precisely — not a spike, sustained volume that "keeps building and
pushing past."** Rebuilt as: average volZ over the continuation push (flush bar through 200pt of
further travel) AND a rising trend (correlation between bar position and volZ over that window),
both above their own population medians — a genuinely different signal from a one-bar snapshot.
**This version confirms the hypothesis cleanly in both markets**: RTH BUILDING bucket (N=16) median
total move 140.5pt vs. 84.5pt for everything else (+66%); Globex BUILDING bucket (N=11) median
243.8pt vs. 120.0pt (+103%, more than double). Both N are thin (below the N≥20 floor) — a real,
consistent-across-both-markets lead, not yet a fully validated signal; needs day-clustering/
chronological-stability checking and more real N before informing live sizing.
`RESEARCH_CLAIM flush_building_volume_predicts_bigger_move` (PROVISIONAL).

**Net picture across §4.11-§4.12**: a single-bar spike (of volume, or of pace/speed) reads as
exhaustion in this market's data, not confirmation — the real "this one's bigger" signal is
*sustained* behavior over the continuation (slow-but-steady pace per §4.11, building volume per
this section), not a single dramatic bar.

### 4.13 Reconciling pace and building-volume, and the final combined target design

**Are pace and building-volume the same signal wearing two names, or genuinely separate?** Real
suspicion: the building-volume window is measured by distance (200pt), not time, so a slow-pace
session mechanically gets more bars/more time in that window — easy for a "rising trend" to appear
without carrying any real independent information. Checked directly
(`scratch/reconcile_pace_vs_building.mjs`): **correlation between pace and the building-volume
metrics is low in both markets** (0.06-0.23), and even the suspected mechanical link (pace vs. how
many minutes the push window actually took) is only moderate for RTH (0.33) and essentially zero
for Globex (-0.02). Overlap is low too — only 31% of RTH's "building" sessions are also
slow-pace, just 20% for Globex. Conditional test (does building still separate outcomes within a
single pace group): **RTH's building effect lives almost entirely in the non-slow group** (no real
difference within the slow-pace tercile itself); **Globex's building effect holds within both pace
groups**. All subgroup Ns here are small (3-56) — directionally clear these are separate, additive
signals, not statistically closed. `RESEARCH_CLAIM
flush_pace_and_building_volume_are_separate_signals` (PROVISIONAL).

**The actual combined design, tested rather than assumed** (`scratch/combined_pace_building_target.mjs`,
a 3-tier score = count of {not-fast pace, building volume} present, each tier's target from its own
p75 MFE) — **the answer differs by market, which is itself the finding**:

| | GLOBEX (N=47) | RTH (N=85) |
|---|---|---|
| Combined design | EV=$59.95, WR=66.0%, **clean, stable**, thirds RISING (24→73→80) | EV=$50.88, WR=56.5%, **NOT clean, not stable**, most recent third negative |
| vs. simpler baseline | pace-only: EV=$58.59, also clean/stable — combined is a real, modest upgrade | flat target (§4.10): EV=$46.47, clean/stable — simpler design is MORE trustworthy despite the lower headline number |

**Final recommendation, and it's asymmetric by design, not an oversight**: wire the 3-tier
graduated target (score-based on not-fast-pace + building-volume, roughly 126pt/207pt/195pt for
Globex) into `GLOBEX_FLUSH`. For `RTH_FLUSH`, **do not** add pace or building-volume — neither
signal is individually clean enough there yet, and the combined version's higher number is not
more reliable, just louder. Keep RTH at the simpler flat ~123pt target until pace/building show
real, independently rigor-clean signal on the RTH side specifically. `RESEARCH_CLAIM
flush_combined_pace_building_target_final` (PROVISIONAL).

### 4.14 Replacing the RTH trigger itself — a structural break beats the arbitrary 200pt threshold

User's question: since this whole thread is about defended/structural levels, why trigger RTH on
an arbitrary 200pt move at all — what about triggering on a real structural break instead, like the
day's own Initial Balance (IB) high/low, or the overnight high/low (ONH/ONL)? Tested directly
(`scratch/rth_ib_onh_break_trigger_test.mjs`), reusing the exact validated
balance/resolution/target construction downstream of the trigger — only the trigger definition
changes:

| Trigger | N | WR | EV/trade | Total $ | Rigor |
|---|---|---|---|---|---|
| 200pt move (original) | 86 | 60.5% | $46.47 | ~$3,996 | clean, stable |
| IB break | 268 | 62.7% | $27.03 | ~$7,244 | clean, stable |
| ONH/ONL break | 315 | 64.4% | $28.30 | ~$8,915 | clean, stable |

Both structural triggers are far more frequent (3-4x) than the 200pt threshold, and despite a
smaller per-trade edge, produce meaningfully more total dollars — the 200pt threshold was only
ever catching the rare, extreme version of a pattern that's real and tradeable at a much more
common, smaller scale too.

**Overlap check** (`scratch/rth_ib_vs_on_overlap.mjs`) — are these the same days or genuinely
different opportunities? **Mostly the same move**: 387 of 447 RTH days (87%) trigger both
conditions, 69% of those in the same direction (one continuous move), 31% in opposite directions
(two real, separate events). ON fires first 87% of the time when both fire — but this is **partly
a construction artifact**, not a pure speed finding: the IB trigger structurally cannot fire before
10:30 ET while ON can fire as early as 9:30, so "ON wins the race" is partly expected by design.

**Best RTH design found in this entire thread: stack them as ONE unified trigger** (whichever
structural break — IB or ONH/ONL — happens first each day), not two separate trades on the same
move: **N=336, WR=66.1% (highest RTH win rate found anywhere in this research arc), EV=$34.31/trade,
total $11,528.50** — beats the 200pt design, and beats either structural trigger alone, on every
axis (total $, rigor, AND win rate). `computeRigor()`-clean and stable, with chronological thirds
actually **rising** (24.29→27.38→51.25) rather than decaying like nearly everything else found in
this thread. `RESEARCH_CLAIM rth_ib_on_break_stacked_trigger_best_design` (PROVISIONAL).

**Revised RTH_FLUSH recommendation**: replace the arbitrary 200pt threshold entirely with this
unified structural trigger (first of IB-break or ONH/ONL-break) as the actual `RTH_FLUSH`
definition — best-supported design found for RTH across this whole thread.

### 4.16 Wired live (2026-08-27) — and a real Globex session-boundary bug found in the process

User's direct instruction: wire in RTH_FLUSH and GLOBEX_FLUSH as real `SHADOW`-status setup
types (per the earlier §4.9 design decision — "fire trades and shadow this, not badge"), holding
off on the separate touch-quality/level-roster wiring for now. Built `server/services/
flushMechanics.js` (shared balance/resolution mechanism, imported by both live detectors and the
new calibration script, per the "export the real function" convention), `scripts/
backtest_flush_patterns.mjs`, and `server/services/rthFlushDetector.js` / `globexFlushDetector.js`
— both modeled on `minuteBarSignalDetector.js`'s own-poller shape, wired into `server/index.js`'s
existing 60s cycle.

**A real, previously-unnoticed bug was found and fixed while building the calibration script.**
Every Globex mechanism-simulation script this session (`verify_structural_stop.mjs` and everything
built on it — §4.6 through §4.13) bumped the session date at `mod>=960` (4PM ET, RTH close) — but
real CME trading continues until the 5-6PM maintenance halt, so that boundary silently reassigns
the CLOSING day's own 4-5PM hour to the FOLLOWING day's Globex session, contaminating that
session's "open" reference and its first-60-minute window with an hour of data that isn't really
its own. Confirmed directly: for shared nominal dates, max-down-move values differed 2-4x between
the two boundaries (e.g. one date: 24pt vs 77pt) — not noise. Separately, §4.7's own elbow
citation (119.50pt, `move_distribution.mjs`) used the correct `mod>=1020` boundary but applied no
session-completeness filter, letting sparse/holiday-shortened sessions inflate the upper
percentile with noise from a single wide intrabar range.

**Consequence: the corrected Globex numbers no longer look like a real edge.** Recomputed elbow:
~81pt (N=413 complete sessions), not 119.50pt. Recomputed mechanism: `GLOBEX_FLUSH_LONG` WR=38.5%,
EV=$0.62/trade, N=26, NOT clean, NOT stable; `GLOBEX_FLUSH_SHORT` WR=31.3%, EV=-$24.13, N=16,
`THIN_N`. This is a dramatic reversal from the previously-believed WR=65%+, EV=$58-99/trade
figures throughout §4.6-§4.13 — strongly suggesting the apparent Globex edge in this thread was
substantially an artifact of the boundary bug, though this has NOT been independently confirmed
via a full re-derivation (the percentile/target shortcuts used to fix this were not re-run through
every earlier section's own specific tests). `OPEN_DECISION
globex_session_boundary_4to5pm_misattribution_bug` (HIGH) has the full writeup and re-derivation
status. **RTH_FLUSH is unaffected** (RTH sessions never cross a date boundary) and remains solid:
`RTH_FLUSH_LONG` WR=67.3%, EV=$30.66/trade, N=162; `RTH_FLUSH_SHORT` WR=64.4%, EV=$34.69/trade,
N=174 — both clean and stable.

**Wired anyway, per this session's own "don't gate experimental wiring on full rigor" standard**
(see the user's 2026-08-27 correction, memory `feedback_experimental_wiring_rigor_bar`) — SHADOW
status costs nothing and lets real forward data decide, rather than holding for a full
re-derivation. GLOBEX_FLUSH's target design also deliberately uses ONLY the pace-based 2-tier
target (§4.11, lookahead-clean), not the 3-tier pace+building-volume design from §4.13 — the
building-volume feature's push window was found to extend past the entry bar in some trades (a
real lookahead leak), never re-tested with a corrected window (`OPEN_DECISION
globex_flush_building_volume_needs_lookahead_safe_retest`).

**What's NOT done**: a full re-derivation of §4.6-§4.13's specific numbers under the corrected
boundary (only the elbow/target/pace-cutoff shortcuts needed for live wiring were recomputed); the
Globex-UP direction (deliberately out of scope, `OPEN_DECISION
globex_flush_up_direction_not_built`); and tomorrow's flagged follow-up (`OPEN_DECISION
apply_volume_building_signal_to_existing_level_roster`).

### 4.17 DeepSeek code review — a real BLOCKER found (neither detector had ever actually fired), plus 5 more confirmed bugs

Dispatched a code-review-only pass to DeepSeek immediately after §4.16's wiring, per the user's
explicit request. It came back with 6 lettered findings (F1-F6 detailed; F7-F10 summarized before
the response was cut off near its 20-minute budget) — all independently verified against the
actual code before acting on any of them, per this codebase's standing "audit before trusting"
rule. All were real:

- **F1, BLOCKER**: the INSERT statement bound a 9th parameter (`resolutionBar.close`, for
  `price_at_detection`) that was never referenced anywhere in the query's `VALUES` clause — the
  column count and highest placeholder happened to still match (16 values, `$16` max), which is
  exactly why this wasn't obvious on inspection. Postgres cannot determine a data type for an
  unreferenced parameter and fails the query at `Parse`, before it ever reaches the database. Net
  effect: **`active_setups` had received zero rows for either setup type since being wired** —
  both detectors were silently retrying and error-logging every 60 seconds instead of firing.
- **F2, CRITICAL**: `fired_at` was built with local JS date getters (`.getHours()`/`.getDate()`)
  on a bar timestamp that `server/db.js`'s type parser deliberately mislabels as UTC (a documented,
  intentional trick — see `db.js`'s own header comment — that only round-trips correctly through
  UTC getters). Using local getters wrote `fired_at` 4-5 hours early, which would have corrupted
  the entire downstream stop/target resolution walk (`resolveSetupsByPrice()` has no
  entry-touch requirement, so it would score the trade against bars from hours before it existed).
- **F3, HIGH**: `entryPrice` was set to the bare threshold (`balanceHigh+50`/`balanceLow-50`), a
  price the resolution bar's own close has, by construction, already passed. This is a one-sided
  optimistic fill assumption on every single trade. Fixed (`flushMechanics.js`) to use the
  resolution bar's actual close instead — this alone dropped RTH_FLUSH's backtested EV by roughly
  30-55% (see corrected numbers below), confirming the bias was real and material, not
  theoretical.
- **F4, HIGH**: the Globex session-boundary fix in §4.16 stopped the 4-5PM ET hour from
  contaminating the FOLLOWING session, but never removed it — so it sat as a temporally-discontiguous
  orphan block glued onto the tail of the PRECEDING session's own bar array, corrupting any MFE/exit
  walk for a trade still open near the RTH open (scored against the wrong afternoon, skipping the
  whole RTH session in between). Fixed by excluding that hour entirely.
- **F5, HIGH**: the Globex trigger (both in the backtest and, independently, in the live detector)
  picked the argmax of the down-move over the whole available 60-minute window — future
  information for any entry resolving before minute 60, and a permanent live/backtest population
  divergence (live could only ever see a running max as bars arrive). Fixed both to a causal
  definition: the first bar whose cumulative down-move crosses the elbow threshold, identical live
  and historically.
- **F6, MEDIUM**: the live RTH detector's overnight-high/low query only ever looked at today's own
  post-midnight bars (`ts::date=$1`), missing the entire prior evening — a strictly narrower, and
  differently-triggering, range than the `level_prices`-based ONH/ONL the calibration script
  actually used. Fixed to read `level_prices` live, matching the calibration exactly.
- **F7-F10** (dedup edge cases, calibration cache never refreshing without a restart, in-sample-only
  parameter fitting, and minor session-date/labeling nits) were summarized in a table before the
  response was cut off near its time budget. F8 (calibration cached for the process lifetime,
  never re-fetched on a date/session rollover) was independently confirmed by reading the code and
  fixed. F7/F9/F10 were not independently deep-dived — flagged as open, lower-severity items rather
  than assumed fixed.

Every fix was verified by direct code reading (not just trusting the review), and both detectors'
exact INSERT statements were dry-run tested inside a rolled-back transaction with fabricated
values, confirming every column receives the intended value — chosen after manually re-deriving
the parameter mapping produced a SECOND real off-by-one (`t1_level` bound to the wrong parameter)
while writing the fix, underscoring why a real execution check beats counting placeholders by eye.

**Corrected numbers, post-F1-F6 fixes** (re-run `scripts/backtest_flush_patterns.mjs`):

| | RTH_FLUSH_LONG | RTH_FLUSH_SHORT | GLOBEX_FLUSH_LONG | GLOBEX_FLUSH_SHORT |
|---|---|---|---|---|
| N | 162 | 174 | 24 | 18 |
| WR | 66.7% | 64.9% | 41.7% | 38.9% |
| EV/trade | $13.45 | $23.63 | -$38.09 | -$31.13 |
| Rigor | clean, stable | clean, stable | NOT clean, NOT stable | N<20 |
| SETUP_STATUS | ACTIVE | ACTIVE | SUPPRESS | THIN_N |

RTH_FLUSH is still real and still positive after the honest fill-price correction — smaller than
first reported ($13-24/trade vs the original $30-35), but clean and stable. GLOBEX_FLUSH's
first-60-minute-window design was net negative — see §4.18 for why that design was itself wrong,
and its full replacement.

### 4.18 GLOBEX_FLUSH redesigned entirely — the "first 60 minutes" trigger never matched what the user asked about or what sec 4.8 already found

User caught this directly (2026-08-28), after being shown the corrected-but-still-negative §4.17
numbers: *"I feel like I had you look for trades around midnight, 2am and 5am... Not sure where
5pm came in. Feel like we're talking apples and oranges."* They were right. §4.8's own (CONFIRMED)
finding — price leaves prior-day value by RTH close (median ~4:15 PM), then the real acceleration
happens a median of ~5 HOURS later, anywhere from 9 PM to past 2 AM — was never actually turned
into the mechanism. §4.9 onward quietly built and calibrated a completely different, narrower
"biggest move in the first 60 minutes of session open" trigger instead, and the two threads were
never reconciled. Every bug found and fixed in §4.16-4.17 was inside a mechanism that was never
aimed at the hours the user actually described in the first place.

**Redesign, keeping the SAME balance/resolution/structural-stop mechanism** (the user's own
"footing, then second move" description — unchanged, still the validated core of RTH_FLUSH too):

- **Trigger, screening step**: checked at RTH close through 30 minutes into the extended session
  (matching sec 4.8's median ~4:15 PM finding) — has price already closed below `PD_VAL` (or above
  `PD_VAH`)? If yes, that bar's own close is the departure price/trigger.
- **No magnitude filter on the trigger itself.** An elbow-threshold version (require some minimum
  further move before counting, matching the old design's shape) was tried first and left only 5-7
  usable trades — "left value by close" is already a real, binary, meaningful flush-defining event
  here, unlike the old 60-min-window design where a size filter was needed to separate a genuine
  flush from ordinary first-hour noise.
- **Continuous watch, no 60-minute cap**: balance forms over the 30 bars after the departure bar,
  resolution is watched through the ENTIRE rest of the overnight session (up to the next RTH open),
  matching sec 4.8's own "a watcher needs to run continuously" conclusion.
- **Both directions tested fresh** (`scratch/validate_value_departure_globex.mjs`, then
  integrated into `scripts/backtest_flush_patterns.mjs`) rather than assuming the old DOWN-only
  scope transfers — it doesn't need to, since the old scope limit was itself an artifact of the
  abandoned 60-minute-window design (sec 4.7's "no elbow for Globex-UP" finding was specific to
  that window).
- **Target**: flat p50 MFE (pooled). A pace-tiered target was tested first (matching RTH_FLUSH's
  IB/ON design) but pace-vs-MFE correlation was too weak (0.04-0.14) in this population to
  support it.

**Result — real, and split cleanly by direction**, bucketed by which way the balance actually
resolves (matching the "Strategy A" design throughout this thread — direction-agnostic entry,
whichever way the consolidation breaks):

| | GLOBEX_FLUSH_LONG (resolves UP) | GLOBEX_FLUSH_SHORT (resolves DOWN) |
|---|---|---|
| N | 167 | 152 |
| WR | 58.7% | 50.0% |
| EV/trade | $19.69 | -$34.75 |
| Rigor | clean, stable, thirds all positive (21.0/16.6/21.4) | clean, stable, thirds all negative (-57.5/-4.6/-41.9) |
| SETUP_STATUS | ACTIVE | SUPPRESS |

This is a materially better-supported result than anything the old mechanism produced at any
stage — real N (167+152=319, from 366 qualifying value-departure days), both directions clean and
stable (not just directionally positive), and — importantly — a real, honest SUPPRESS finding on
the SHORT side rather than an ambiguous "not clean" one. `RESEARCH_CLAIM
globex_flush_value_departure_redesign` (CONFIRMED — both directions individually clear
`computeRigor()`'s clean+stable bar with real N well past the decisive floor).

**Wired live** (`server/services/globexFlushDetector.js`, full rewrite): departure check runs at
RTH close through 4:30 PM; once armed, the detector watches continuously (its own poll window now
runs 4:00 PM through 9:30 AM, not the old 6PM-8:30AM Globex-hours gate) until resolution or the
next RTH open. `trade_date` on the resulting row is the DEPARTURE day, not the calendar day the
resolution bar happens to land on (which can be past midnight). Both `OPEN_DECISION
globex_flush_up_direction_not_built` and the original session-boundary-bug decision are now moot
— the entire mechanism they were about no longer exists.

### 4.19 Pooling by resolution direction alone hid a much stronger effect — mode-aware pace+volume tiering (same day, same user review)

User pushed back a third time on §4.18's design: pooling all trades by final resolution direction
(LONG = resolves UP, SHORT = resolves DOWN) still mixes two structurally different bets together —
a departure that CONTINUES in its own direction, and a departure that REVERSES. A raw pace-vs-MFE
correlation check on the pooled population (0.04-0.14, "too weak") was also the wrong test — a
correlation coefficient cannot see a real non-linear/threshold effect, which is exactly the shape
sec 4.11's original pace finding had (FAST uniquely bad, not a smooth gradient). Both corrections
were right.

**Split by MODE** (does departure direction agree with resolution direction — CONTINUATION — or
disagree — REVERSAL) and re-ran pace as a proper tercile split (matching sec 4.11's exact method)
instead of a correlation:

| Departure → Resolution | Mode | N | WR | EV (pooled) | Pace SLOW tercile EV |
|---|---|---|---|---|---|
| DOWN → DOWN | Continuation | 66 | 57.6% | -$3.00 | $22.02 |
| **DOWN → UP** | **Reversal** | **75** | **62.7%** | **$37.06** | **$105.96** |
| UP → DOWN | Reversal | 86 | 44.2% | -$58.63 | -$78.58 (worst tercile) |
| UP → UP | Continuation | 92 | 55.4% | $5.53 | $21.77 |

The DOWN-departure-then-reversal-UP mode is the real signal in this entire GLOBEX_FLUSH thread —
a classic "failed breakdown, reclaim" pattern — and its slowest-pace tercile alone is worth nearly
3x the mode's own pooled average. UP-departure-then-reversal-DOWN is a confirmed, clean, stable
structural loser regardless of pace. The two continuation modes are weak/near-breakeven either way.

**Final design, per user's explicit direction to wire this using the same pace+volume-building
methodology as sec 4.11-4.13** (not gated on further rigor checks given the short — 6-week —
data history; see `feedback_experimental_wiring_rigor_bar` for the standing reason this app
doesn't hold experimental SHADOW wiring to the same bar as live capital): each of the 4
(departure × resolution) combinations gets its own setup_type and its own 3-tier combined score
(sec 4.13's exact design — count of {NOT-fast pace, building volume}, each score 0/1/2 targeted
at its own p75 MFE), calibrated on that mode's own population, not pooled:

| setup_type | Mode | N | WR | EV/trade | Rigor | SETUP_STATUS |
|---|---|---|---|---|---|---|
| `GLOBEX_FLUSH_REVERSAL_LONG` | DOWN→UP reversal | 75 | 60.0% | **$99.93** | clean, stable | ACTIVE |
| `GLOBEX_FLUSH_LONG` | UP→UP continuation | 92 | 53.3% | $14.98 | not clean | ACTIVE |
| `GLOBEX_FLUSH_SHORT` | DOWN→DOWN continuation | 66 | 40.9% | -$16.84 | not clean | SUPPRESS |
| `GLOBEX_FLUSH_REVERSAL_SHORT` | UP→DOWN reversal | 86 | 39.5% | -$46.84 | clean, stable | SUPPRESS |

`GLOBEX_FLUSH_REVERSAL_LONG` is the best-supported single number in this entire research thread —
clean, stable, real N, and its own internal score tiers are monotonic-ish and all strongly positive
(score 0: $77.22, score 1: $90.68, score 2: $185.61/trade, N=19/46/10). Volume-building's window is
capped at the entry bar this time (departure exclusive through entry inclusive) — the original
lookahead bug (window could extend past entry) does not apply to this construction.
`GLOBEX_FLUSH_REVERSAL_LONG`/`GLOBEX_FLUSH_REVERSAL_SHORT` are classified `MEAN_REVERSION` in
`bet_class` (they trade a reversion back toward value, matching `C_REVERSAL_LONG/SHORT`'s existing
classification), not `CONTINUATION_LEGACY` like the plain `GLOBEX_FLUSH_LONG/SHORT` types.
`RESEARCH_CLAIM globex_flush_mode_pace_volume_tiered_final` (CONFIRMED). Wired live in
`server/services/globexFlushDetector.js` — reuses `getVolumeBaseline()` from
`server/services/touchQuality.js` (per "export the real function," not reimplemented).

### 4.15 Applying the approach-quality lens to the ENTIRE existing fade roster (not just flush)

Separate thread, applied to every currently-firing level-fade `setup_type` (`WHERE setup_type LIKE
'%FADE%'`, real `origin_status IN ('ACTIVE','SHADOW')` resolutions only): does HOW price approaches
a touch — fast/no-volume-build ("sliced through", SLICE) vs. slow/rising-volume ("genuinely tested
the level", TEST) vs. ambiguous (MIDDLE) — predict fade outcome? This is a zero-delay-cost filter,
knowable the instant the touch bar closes (no wait-and-see, unlike the already-3x-failed
confirmation-entry shape in `DEFENDED_LEVEL_RETEST_SPEC`/`TOUCH_QUALITY_SIGNAL_IDEAS_SPEC`/
`engagement_confirmation_entry_timing`).

**A real methodology bug was found and fixed mid-investigation.** The first pass anchored the
10-bar approach window on `fired_at`. Cross-checking the resulting day-clustering against the
session's own `LATENCY_CRITICAL` alerts showed several of the exact setup_types clustering on
2026-08-27 (a day flagged with 20 CRITICAL-lag fires) — meaning `fired_at` can lag the real
triggering touch by minutes to tens of minutes, so the "approach" window was sometimes sampling
bars from AFTER the real touch, not the actual approach into it. A naive fix (anchor on the FIRST
bar of the day within 15pt of the level, matching `audit_setup_latency.mjs`'s own query) turned out
to be **worse**, not better — for persistent levels (prior-day/week/month value, VWAP, pivots)
price can sit within 15pt for hours before the specific touch that triggered this specific fire,
producing a median "lag" of 63 minutes, clearly not real detection latency. The correct anchor,
confirmed by a sane resulting lag distribution (median 24s, p90 55s, matching genuine live-poll
latency): the LAST touch bar at-or-before `fired_at`, not the first touch of the day and not
`fired_at` itself. `scratch/fade_slice_test_real_touch_time.mjs` is the corrected script; treat any
future touch-approach feature on this table as needing this same anchor.

**Result, on the corrected anchor (N=1044 usable, real-touch-anchored)**:

| Population | Bucket | N | WR | EV/trade | vs. own-group baseline |
|---|---|---|---|---|---|
| CURRENTLY ACTIVE (N=293) | overall | 293 | 56.7% | $17.50 | — |
| | SLICE | 95 | 55.8% | $15.70 | ≈ baseline |
| | **TEST** | **28** | **75.0%** | **$49.94** | **+185% over baseline** |
| | MIDDLE | 170 | 54.1% | $13.16 | slightly below baseline |
| CURRENTLY SUPPRESSED/THIN_N (N=751) | overall | 751 | 48.5% | -$5.77 | — |
| | SLICE | 246 | 52.0% | -$4.85 | ≈ baseline (still negative) |
| | TEST | 61 | 52.5% | $0.85 | directionally better, not a real edge |
| | MIDDLE | 444 | 45.9% | -$7.19 | worse than baseline |

**Reading this**: TEST is a real, consistent refinement **on top of already-good (ACTIVE) setups**
— not a rescue mechanism for currently-suppressed ones. This directly answers the earlier open
question ("we might need to wire suppressed setups back in, gated on this filter") — the answer is
no, at least not via this filter: TEST touches on suppressed setup_types are roughly breakeven, not
a hidden edge worth reversing a SUPPRESS/THIN_N call over.

**Caveats, honestly**: N=28 for the actionable ACTIVE-TEST cell clears this codebase's N≥20 floor
but not `computeRigor()`'s clean bit — 53.6% of it sits in its top-5 dates (`2026-07-28`,
`2026-08-21`, `2026-08-19`, `2026-08-13`, `2026-08-18`). It IS chronologically **stable** (thirds
+$8.38 / +$104.56 / +$38.20 — no sign flip, consistently positive, just noisy in magnitude), which
is the more important of the two rigor checks for a thin sample. `RESEARCH_CLAIM
fade_touch_quality_test_slice_filter_active_setups` (PROVISIONAL).

**Wired live 2026-08-27.** User's explicit call: this app isn't trading real money at the
research-decision level and shouldn't be gated on full `computeRigor()` clean+stable before trying
an experimental signal — try it now rather than hold for more real N. Shipped in `acd.js`:
`touchQualityTest`/`touchQualitySlice` computed live off the last 10 RTH bars into each touch
(reusing `getTouchQualityBaseline()` for the volume z-score and a newly-generalized
`getPaceBaseline(tradeDate, lag)` — parameterized from its previous hardcoded 5-bar lag so the
existing `STACK_VOL_BREAK_LIVE`/`hivolLopace` 5-bar callers are unaffected — for a 10-bar pace
z-score), added as a **+0.15 `sizeMultiplier` factor gated to ACTIVE-status setup_types only**
(`!liveStats._suppressedSetups.has(type)`), matching the finding's own scope — no edge was found on
SUPPRESS/THIN_N types, so this does not extend to them. Cutoffs are zero (z-score sign / correlation
sign), not the backtest's sample median, so nothing here is a static literal that goes stale as real
data accumulates. `AlphaEngineOverview.jsx`'s Size Multiplier Stack lists it. `OPEN_DECISION
fade_touch_quality_test_sizeup_wiring` resolved.

---

*End of §3/§4. §0-2 written and independently spot-checked (three most load-bearing citations verified
verbatim by Claude: `DEFENDED_LEVEL_RETEST_SPEC.md`'s 8-way sweep, `AIR_POCKET_SIGNAL_SPEC.md`'s
status, `BRACKET_BREAKOUT_LONG/SHORT`'s live EV in `acd.js`). §3 written in a follow-up pass; its own
new citations — the `sizeMultiplier` IIFE's three absolute-assignment lines, the cluster candidate
loop's gate conjunction, `stepWiderTarget()`'s pressure gate, and
`COMPRESSION_TAIL_MFE_SPEC.md`'s tail-vs-mean argument — are all `sed -n`-verifiable at the lines
cited. §4 added in a same-day follow-up session once Steps 0-2 were actually run — see §4 for what
changed from "still a proposal, in full" to a mix of one survival, one clean kill, one real filter,
and one revived orphaned finding. Steps 3-7 remain unrun proposals exactly as §3.5 describes.*

### 4.20 Reconciliation — what actually survives from §4.4-4.14 after the redesign (2026-08-28)

User's direct ask, after §4.16-4.19's whole redesign arc: don't let the original findings quietly
become dead just because the MECHANISM they were built for (the "first 60 minutes of session open"
trigger) turned out to be wrong. Going through each one honestly:

**§4.4 (the user's own original pattern description, "100+pt move → footing → second move")** —
**fully preserved, this is the mechanism's core and never changed.** The specific "85.4% resolve
in flush direction" statistic was measured against the old 200pt/60-min population and doesn't
transfer as a literal number (the new design finds resolution direction is genuinely mixed — the
best trade is specifically when it DOESN'T resolve in the departure direction), but the underlying
balance→resolution→structural-stop mechanism is identical in both `RTH_FLUSH` and every
`GLOBEX_FLUSH` variant today. `OPEN_DECISION post_flush_resolution_breakout_wiring_decision`
(PENDING since 2026-08-26) is now resolved by this whole build — it asked for exactly this: a real
SHADOW-status setup_type, a real exit rule beyond hold-to-close, and RTH-vs-Globex coverage. All
three are done.

**§4.5 (flush precursor signals — elevated volatility, larger gaps, flushes ignite in gaps between
levels not at them)** — **not re-tested against the new trigger, but plausibly still real.** These
were about what precedes ANY big 200pt RTH move, a market-behavior question mostly independent of
which specific downstream mechanism consumes the move. Worth a real re-test before trusting it
applies to value-departure days specifically (they may not be the same population — a 200pt move
and a value-departure are correlated but not identical events), not yet done.

**§4.6 (structural stop behind the balance zone)** — **fully preserved, unchanged, the load-bearing
piece of the whole mechanism.** Every one of today's 6 setup_types (`RTH_FLUSH_LONG/SHORT`,
`GLOBEX_FLUSH_LONG/SHORT/REVERSAL_LONG/REVERSAL_SHORT`) uses this exact stop rule.

**§4.7 (percentile distributions, the 119.50pt Globex-DOWN elbow, and its follow-up on structure at
the starting zone)** — **the elbow-as-trigger idea is retired** (the new design doesn't use a
magnitude threshold at all — "left value by close" is itself the trigger). But the follow-up
finding — *"at the start, PRIOR-DAY VALUE is the single most common real structure (38.7% of
Globex-DOWN sessions), and these moves most often begin anchored near yesterday's value"* — was
essentially a direct, un-acted-on preview of §4.8/4.18's entire redesign, found a full session
before §4.8 made the value-area framing explicit. Worth noting for the record: the answer was
already sitting in this document before it got built.

**§4.8 (time-of-night profile — CONFIRMED)** — **this is what the whole redesign is actually built
on**, not a retired precursor. Nothing to reconcile here; it's the foundation.

**§4.9 (Globex real MAE/MFE, target methodology)** — **the specific numbers (119.50pt elbow, ~190pt
target) are retired along with the elbow trigger**, but the METHOD — measure real MAE/MFE off the
actual population rather than guessing a target, and check chronological stability before trusting
a "looks fine on average" number — carried forward directly into the new per-mode p75 MFE tiers.

**§4.10 (RTH parity — 11 AM clustering, 62.1% starting-zone value-proximity, RTH wants a SMALLER
target than Globex)** — **the starting-zone finding (prior-day value dominant, even more so than
Globex) is the same underlying phenomenon §4.7/4.8 found for Globex — RTH_FLUSH's own trigger
(IB/ONH-ONL break) is a different structural break, so this specific 62.1% figure hasn't been
re-measured against it, but the market-structure story is consistent.** The load-bearing decision
that DID carry forward unchanged: RTH gets a flat target while Globex gets a richer, tiered one —
exactly what §4.13 recommended and what's live today (`RTH_FLUSH` stayed flat; only `GLOBEX_FLUSH`
got the mode+pace+volume tiering). The 11 AM timing-clustering claim was specific to the old
200pt-trigger population and hasn't been re-checked against the new IB/ONH-ONL trigger.

**§4.11 (pace-based widener, "FAST pace is uniquely bad")** — **the core insight is CONFIRMED and
now more precisely located.** The original correlation (-0.142, Globex, pooled) undersold how
strong this actually is — §4.19 found that inside the `GLOBEX_FLUSH_REVERSAL_LONG` mode
specifically, the SLOW tercile is worth nearly 3x the pooled average ($105.96 vs $37.06/trade) and
decays cleanly as pace increases. This is the same underlying phenomenon as the original finding,
just correctly re-located to the sub-population where it's strongest, using the exact original
tercile methodology (a raw correlation on the new pooled population had missed it entirely).

**§4.12 (volume-building, "sustained volume predicts bigger continuation")** — **directionally
consistent but weaker and mode-dependent, not a clean carryover.** Pooled across the new design,
building volume was actually mildly WORSE, not better (an apparent inversion) — but inside
`GLOBEX_FLUSH_REVERSAL_LONG` specifically, building beats not-building ($66.81 vs $53.46/trade),
matching the original hypothesis. The lookahead bug in how the original version measured this
(window could extend past the entry bar) is fixed in the current live implementation (window
capped at the entry bar), so this is now a genuinely different, more trustworthy measurement, not
just a re-run of the old one.

**§4.13 (the combined pace+volume 3-tier score design)** — **the exact methodology is what's wired
live today**, applied per-mode instead of pooled (the one structural change from the original
recipe, and the change that made it work).

**§4.14 (RTH's stacked IB/ONH-ONL trigger)** — **fully preserved, unchanged, this is `RTH_FLUSH`'s
live trigger today**, the one piece of the whole 200pt-era design that turned out not to need any
redesign at all.

**Net picture**: nothing from §4.4-4.14 was wasted, even though the specific "first 60 minutes of
session open" packaging around it was wrong. The mechanism (§4.4/4.6), the RTH trigger (§4.14), the
RTH-vs-Globex target-width asymmetry (§4.10/4.13), and the pace/volume methodology (§4.11-4.13) all
carried forward and are live today. What didn't carry forward was specifically the Globex TRIGGER
definition (§4.7/4.9's elbow) — replaced by §4.8's own already-confirmed finding, which had been
sitting one section earlier the whole time.

### 4.21 RTH_FLUSH gets its own volume-building refinement — checked directly rather than assumed to still not apply

Direct follow-up to §4.20's reconciliation: §4.13's original "RTH pace/volume too weak" call was
made POOLED, against the OLD 200pt-trigger population — the exact shape of test that hid the real
Globex signal (§4.19) until it was split by mode. Re-checked RTH_FLUSH's CURRENT live trigger
(stacked IB/ONH-ONL break) both pooled and split by continuation-vs-reversal mode
(`scratch/rth_mode_pace_volume_retest.mjs`, N=337, tercile methodology matching sec 4.11 exactly,
not a raw correlation).

**Mode-splitting does NOT help RTH — the pooled result is actually the cleanest one found.**
Splitting by continuation/reversal made every sub-bucket noisier (thinner N, non-monotonic
tercile shapes, none rigor-clean pooled), the opposite of what happened with Globex. **Pace still
doesn't hold** — confirmed unchanged from the original finding: positive-direction correlation
(0.335, opposite sign from Globex, consistent with §4.11's original +0.168 direction), but every
tercile split (pooled or by mode) comes out hump-shaped or inconsistent, never a clean monotonic
pattern worth targeting.

**But volume-building holds up cleanly on the plain pooled population** — no mode split needed:

| | N | WR | EV/trade | Rigor |
|---|---|---|---|---|
| Building volume | 68 | 66.2% | **$40.79** | clean, stable |
| Not building | 249 | 65.5% | $14.72 | clean, stable |

Both buckets individually clear `computeRigor()` — this isn't a thin slice propped up by a few
days. **Wired as a 2-tier target** (matching the plain, non-mode-split shape of the finding):
`RTH_FLUSH`'s baseline stays the existing flat p50 MFE (~77pt) for non-building touches; when
volume is genuinely building through the approach (`avgVolZ`/`volZTrend` both above their pooled
medians, window capped at the entry bar — no lookahead), the target widens to the building group's
own p75 MFE (~190pt). `RESEARCH_CLAIM rth_flush_volume_building_tiered` (CONFIRMED). Wired in
`server/services/rthFlushDetector.js` (reuses `getVolumeBaseline()` from `touchQuality.js`, same
as `GLOBEX_FLUSH_*`'s volume-building signal).

**§4.5's precursor signals were re-checked against the new trigger — see §4.22, a clean negative.**

### 4.22 Precursor signals re-tested against the new trigger — a clean negative

§4.5's precursor findings (elevated recent-vs-longer-term ATR ratio, larger gaps, precede a flush)
were found on the OLD 200pt-first-60-min flush population — a rare, dramatic event (~23% of RTH
days). Re-tested against the CURRENT value-departure-by-close trigger
(`scratch/verify_precursors_value_departure.mjs`, reusing the exact validated ATR-ratio/gap-size
methodology from `verify_flush_priceaction.mjs` and the level-proximity test from
`verify_flush_precursors.mjs`) — a much more common event, 335 of 389 complete-session RTH days
(~86%).

**Neither signal clearly transfers.** ATR ratio direction is actually reversed and not
significant: departure days show slightly LOWER relative volatility than the 54 non-departure
control days across all 4 lookback pairs (z=-0.77 to -1.34, nowhere near a real significance bar).
Gap size is directionally consistent with the old finding (departure mean=155.4pt vs control
mean=123.3pt) but not significant either (z=1.63), and the control group is now thin (N=54) since
departure is the majority case rather than a rare event. Level proximity at the open is saturated
at ~100% for both groups — the same known dead end from §4.5, still a dead end.

**Also checked the more actionable version**: within departure days, do these signals predict the
single best-known segment (a DOWN departure that reverses UP, N=70 of 299)? Weak, non-significant
hints in the OPPOSITE direction from the old intuition — smaller gaps and lower volatility precede
the best trades, not bigger/higher ones (z=-1.5 to -1.8, still short of significance).

**Honest read**: the old precursor findings were real for a genuinely rare, dramatic 200pt move —
that kind of event plausibly needs a real volatility/gap buildup to happen at all. Closing below
yesterday's value is a much more ordinary, frequent event that doesn't need special preconditions
to occur, so there's no advance signal here for which of tonight's departures are worth watching
closely. `RESEARCH_CLAIM globex_flush_precursor_signals_do_not_transfer` (CONFIRMED — a genuine
negative, not a thin/inconclusive one; every check ran on real, adequate N). Nothing wired from
this finding, and nothing it found contradicts anything already live.

## 5. DeepSeek design critique on Idea E (2026-08-29) — refinements before it's testable

Dispatched as a phase-0, read-only design critique (no code, no execution) after the user recalled
this idea from a prior session and asked how to refine it. Full context read: this section's own
Idea E (§2, lines 371-430), `developingValueService.js`, `RUNNER_OPTIMIZATION_NOTES_20260814.md`,
the flush mechanism files, and `touchQuality.js`.

**Before testing `nodeZ` at all — the phenomenon it's meant to explain might not be real yet.** The
IB-vs-POC/VAH/VAL/VWAP family split (§4) has N=9-13 per side. A cheaper, non-structural competing
explanation: only 9/124 IB touches ever clear the ROSTER-WIDE p60 cutoff, because IB's volume
profile is structurally different early in a session — the roster-wide yardstick may simply be
wrong for IB, with nothing left to explain once judged fairly. **Gate 0, run before anything else:
re-score IB against its own family-specific cutoff.** [Update: this was run same day — the IB
reversal SURVIVED (got slightly cleaner, not weaker) under its own cutoff, so this alternate
explanation is ruled out and Idea E is better-motivated, not worse. See `docs/OPEN_THREADS.md`'s
2026-08-29 entry.]

**Three measurement fixes to `nodeZ` before it's testable:**
1. The formula as originally specified (line 385-386) is dimensionally inconsistent — numerator is
   a window SUM, denominator is a per-bucket MEAN, so an average location scores ≈100 not 0. Fix:
   compare against the distribution of equal-width rolling window sums and report a **percentile
   rank**, not a z-score.
2. Percentile over z-score for a second reason: volume-at-price histograms are severely
   right-skewed (POC dominates) — a z-score squashes the LVN side (the side that actually matters)
   into a narrow band.
3. `OFF_PROFILE` (a level entirely outside the prior profile's range — gap days, trend days) must
   be its own category, not scored as "extreme LVN" — that smuggles a regime variable in wearing a
   volume-structure label.

**A real, verified data-quality risk found along the way**: `computeVolumeProfileForRange`
(`developingValueService.js:104`) selects raw `volume::float` with no COALESCE, while every other
signal in this codebase (`touchQuality.js`, `rthFlushDetector.js`, `backtest_flush_patterns.mjs`)
uses `COALESCE(bid_volume,0)+COALESCE(ask_volume,0)`. Independently verified against the live DB:
0 NULL `volume` rows currently (no active crash risk), but **186 real rows where `volume` and
`bid_volume+ask_volume` genuinely disagree** — meaning `nodeZ` (built from raw `volume`) and the
volume-building signal (built from bid+ask) could measure subtly different things on the same bar.
Check before trusting any cross-comparison between the two.

**The cheapest possible test, and it spends no P&L**: a pure census (Gate 0) checking whether
`nodeZ` varies *within* family before ever looking at outcomes. Pre-registered pass criterion:
≥25% of IB touches must land in the pooled top tercile AND ≥25% of PD_POC touches outside it — if
IB's `nodeZ` distribution barely overlaps the profile-derived families', `nodeZ ≈ f(family)` by
construction and the idea dies for free. **Globex VWAP is the single most decisive/falsifying test
case** — unlike PD_POC/VAH/VAL (near-maximal `nodeZ` by definition, since they're read directly off
the histogram), Globex VWAP has no such guarantee. If it scores middling/low `nodeZ` and still
shows the positive building split, the "profile-derived → real volume → building works" story is
broken at exactly the case supposed to carry it.

**An even cheaper competitor to test in the same pass**: `vaPos` = signed distance from the prior
completed POC, normalized by that profile's VA width — needs no new histogram at all, since
`PD_POC`/`PD_VAH`/`PD_VAL` are already in `level_prices` per trade_date with a lookahead-safe
accessor already written (`backtest_flush_patterns.mjs::loadLevels()`). If `vaPos` explains the
split as well as `nodeZ`, don't build the histogram scorer at all. **Caveat needing verification**:
whether `developing_value_log`'s row for a date is the EOD-completed profile or a mid-session
snapshot — if the latter, `level_prices`' PD_* values are the safer "prior completed profile"
source, not `developing_value_log`.

**What falsifies Idea E**: Gate 0's within-family overlap fails; Globex VWAP scores middling/low
`nodeZ`; family survives conditioning on `nodeZ` but not vice versa; the family-specific-cutoff
re-check makes the split disappear (it didn't — see above); or `vaPos` matches/beats `nodeZ`.

**Redundancy-with-the-known-failure-mode check**: this repo has 3 independent confirmed negatives
on "wait to watch a defense/structure signal complete before entering" (§0.1). Idea E as specified
never delays entry — `nodeZ`/`vaPos` are functions of (level price, prior COMPLETED profile), known
before the session opens, same information class as `setup_type` itself. Two specific ways this
could accidentally reintroduce the failure: (1) using a DEVELOPING (not complete) intraday profile
— keep the hypothesis test strictly prior-session; (2) phrasing a future finding as "at high-nodeZ
levels, wait for building to confirm" — that IS the already-failed mechanism again. The interaction
must be evaluated at the same instant as the touch, never as an additional wait.

Full DeepSeek response: `scratch/deepseek_response.md` as of 2026-08-29 (ephemeral, will be
overwritten by the next dispatch — this section is the durable copy).

### 4.23 Idea D census contradiction reconciled (2026-09-01) — Step 0 genuinely SURVIVES at N=20

A Gemini-dispatched Step 0 re-run this same day (`scripts/pilot_idea_d.mjs`, see
`docs/OPEN_THREADS.md`'s 2026-09-01 "audited 3 Gemini scripts" entry) reported the OPPOSITE of
§4.1's 92%/N=12 finding: 0.0% partner-visited at N=766, after fixing 2 real bugs (a too-wide
anchor-freshness window, an uncast `fired_at` timezone bug). Flagged as `OPEN_DECISION
liquidity_zones_idea_d_census_contradiction`, investigation interrupted mid-session by a context
clear before root-causing it.

**Root cause, found by diffing the two scripts line by line and reproducing directly against the
live DB**: `pilot_idea_d.mjs`'s bar-window query had a THIRD, previously-undiscovered bug — it used
the same `$1` parameter both cast `::date` (for the day boundary) and compared bare against a
`timestamp` column (`ts < $1`). Postgres unifies a parameter's type across every appearance in one
query; the explicit `::date` cast made `$1` resolve to `date` everywhere, silently truncating the
time-of-day off the bare comparison too — confirmed directly via `SELECT $1 as raw_param` in a
mixed `::date`/bare-usage query, which returned `'2026-08-20'`, not the full timestamp. That
collapsed `ts < $1` to `ts < <midnight of that day>`, which can never be true together with the
script's own `time >= 570` (9:30am) filter — so **the bar-window query was unconditionally EMPTY
for every single row**, mechanically forcing both `anchorVisited` and `anyPartnerVisited` to false
regardless of the real data. The 0.0%/N=766 result was a pure SQL artifact, not a real negative —
neither the 2 already-documented bug fixes nor the true underlying phenomenon had anything to do
with it.

**Fixed** (two separate query params instead of one dual-cast param). The corrected script now
returns **1/6 (16.7%)** — N-starved, not decisive either way, and using a narrower/less rigorous
construction than §4.1's script (`setup_type LIKE '%_FADE_%'` only, `entry_zone` midpoint as an
anchor-price proxy instead of a real `level_prices` lookup, no same-day-forming-level formation
gate on anchor or partners).

**Re-ran §4.1's original, more rigorous construction** (`scratch/census_idea_d_cluster_freshness.mjs`
— real per-anchor `level_prices` lookup, same-day-forming-level formation gating on both anchor and
partners, RTH-vs-Globex-conditional session-start) fresh against 6 additional days of data: **N grew
12→20** (clears this codebase's N≥20 decisive floor for the first time) and **the rate held stable,
92%→90%**. Per the spec's own pre-registered rule (§2, single digits ⇒ dead, double digits ⇒ worth
building), **idea D genuinely clears Step 0 and is worth building.**

`RESEARCH_CLAIM liquidity_zones_idea_d_free_census_rigorous_construction` (CONFIRMED, N=20, 90%) is
now the load-bearing number for this thread; `RESEARCH_CLAIM liquidity_zones_idea_d_free_census`
(the `pilot_idea_d.mjs` result, N=6) is kept only as a directional data point, not weighed against
it. `OPEN_DECISION liquidity_zones_idea_d_census_contradiction` resolved with this writeup.
**Step 5 (idea D's real EV/WR-tested build) is now live remaining work** — flagged as
`OPEN_DECISION liquidity_zones_idea_d_step5_build_needed` — note N=20 is only the descriptive-census
floor, a real EV comparison needs its own N≥20 per arm (already-visited-partner vs. genuinely-fresh
cluster), which may still be thin; that decision's text scopes a SHADOW-tagging-first path as the
likely near-term shape rather than a full live wire on day one.

