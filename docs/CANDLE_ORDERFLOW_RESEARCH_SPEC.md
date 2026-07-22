# Candlestick & Order-Flow Entry-Confirmation Research (2026-07-21)

One consolidated reference for a single long research thread that spans a lot of
`docs/OPEN_THREADS.md` entries and several `RESEARCH_CLAIM`/`OPEN_DECISION` rows.
Read this first before re-deriving any of it; the raw narrative (with full
reasoning, caveats, and incident writeups) is still in `OPEN_THREADS.md` under
the 2026-07-21 entries if you need the blow-by-blow — this doc is the map.

## TL;DR

Tested whether known candlestick reversal patterns, at various levels of
sophistication, improve level-fade entry timing, then followed an Opus
strategic audit into order-flow-magnitude alternatives. **6 tests run, 5
failed cleanly, 1 looked like a real win and was retracted the same day** —
two of the six involved a specific, nameable confound caught before being
trusted (or after, in the retracted case). One genuinely new, reusable piece
of infrastructure came out of it (`computeReplication()`), which was then
immediately exercised correctly on the very next test. Nothing from this
thread is wired live. One follow-up idea remains untested, worth a deliberate
go/no-go before building reflexively given the accumulating negative record.

## The motivating question

User: does the entry-quality mechanism this app already validates (level-fade
touches) improve if you layer in candlestick reversal patterns as a
confirmation filter — and separately, does that generalize into a real,
setup-type-specific edge worth preferentially applying?

## Tests run, in order

### 1. Candle shape at first touch — FAILED, no edge
- **Hypothesis**: a reversal candle pattern (Hammer, Engulfing, Doji, etc.)
  completing right at a level-fade touch predicts the trade's outcome.
- **Built**: `server/services/candlePatternQuality.js` (13 pattern
  families/26 directional variants — see its own header comment for the full
  list and what was deliberately excluded and why), `scripts/pilot_candle_pattern_reversal.mjs`.
- **Result**: pooled corpus-wide (64 setup_types), `NO_PATTERN` (N=1730,
  EV=+$10.68) beat `PATTERN_PRESENT` (N=5477, EV=-$2.99) — the opposite of the
  hypothesis. `TWEEZER` (the highest-frequency match) is a mechanical artifact
  of the level-touch definition itself, confirmed via direct raw-bar spot
  check.
- **`RESEARCH_CLAIM`**: `candle_reversal_pattern_confirmation_no_edge`
  (`PROVISIONAL`). Secondary lead flagged, not built:
  `bullish_bearish_harami_negative_ev_at_level_fade` (Harami showed
  consistent underperformance across 30+ setup_types — a real caution
  signal, never promoted).

### 2. Candle shape at a real overshoot (not just first touch) — FAILED, confounded
- **Hypothesis**: waiting for price to overshoot the level by a real margin
  (past that setup_type's own historical median adverse excursion), then
  requiring a candle pattern at that deeper extreme, beats blind first-touch
  entry.
- **Built**: Gemini-authored `scripts/pilot_overshoot_reversal.mjs` (dispatched,
  later audited line-by-line and confirmed to faithfully implement the spec —
  the confound below was a test-design gap, not a Gemini coding bug), then
  `scripts/pilot_overshoot_control_check.mjs` (Claude-built, the control that
  found the confound).
- **First-pass result looked dramatic**: pooled paired EV -$85.77 → -$5.67,
  improved in 62/64 setup_types with zero exceptions — flagged immediately as
  the "too clean" signal this codebase's history keeps finding bugs behind.
- **The confound**: entering LATER against the SAME FIXED original stop/target
  is algebraically favorable regardless of any pattern (bigger win from a
  cheaper entry, smaller loss from being closer to the same stop). Confirmed
  directly: win/loss OUTCOME matched between a pattern-free blind-overshoot
  entry and the pattern-confirmed entry in 92-100% of trades per setup_type.
- **Corrected numbers** (N=3453 pooled): `ORIG` -$82.56 → `BLIND` overshoot
  entry (no pattern) -$8.99 → `PATTERN`-confirmed entry -$2.96. Pattern's real
  marginal contribution: ~$6/trade, not the ~$77/trade the confounded
  comparison implied.
- **A real, useful negative surfaced from the by-pattern breakdown**:
  `BEARISH_ENGULFING` (N=291, 29 setup_types) makes pattern-confirmed entry
  *worse* than blind entry (-$12.42 vs -$0.77) — a genuine "don't wait for
  this one" finding.
- **Side finding, separately flagged**: "wait for overshoot alone, no pattern"
  took a badly-negative cohort to a much-improved-but-still-negative one
  (-$82.56 → -$8.99). Checked whether this discriminates good setups from bad
  ones — **it doesn't**: every setup_type's overshoot-cohort baseline is
  deeply negative regardless of that setup's real overall quality (the
  corpus's best blended setup, +$32.34, still shows -$48.05 in its overshoot
  cohort). It's pure entry-price repricing, not edge detection.
- **`RESEARCH_CLAIM`s**: `overshoot_reentry_candle_pattern_confound_found`
  (`CONFIRMED`, includes full by-pattern breakdown).
- **`OPEN_DECISION`**: `overshoot_only_entry_worth_dedicated_pilot` (downgraded
  MEDIUM→LOW after the good/bad-setup discrimination check — still technically
  open, not recommended as a near-term priority).

### 3. Candle shape + order-flow volume confirmation — INITIALLY LOOKED REAL, RETRACTED
- **Hypothesis** (user's insight: "candles are indicative of orderflow"): a
  pattern backed by real volume (touchQuality.js's already-validated z-score
  baseline) is more credible than one on thin volume.
- **Built**: `scripts/pilot_candle_volume_confirmed.mjs`, combining
  `candlePatternQuality.js` (shape) with `touchQuality.js`'s
  `getVolumeBaseline()` (order flow) — two already-validated modules, neither
  reimplemented.
- **First pass**: pooled, `HIGH_VOL_PATTERN` was *worse* than `LOW_VOL_PATTERN`
  corpus-wide (-$8.91 vs -$0.19) — matches `touchQuality.js`'s own
  `HIGH_VOL_OVERRUN` precedent (heavy volume can mean a losing fight, not
  absorption). But picking the 6 largest-effect-size setup_types and
  rigor-checking THOSE found a clean, stable, well-powered result: pooled
  `HIGH_VOL_PATTERN` N=218 EV=+$25.08 (stable, not clustered) vs `LOW_VOL`
  N=433 EV=-$12.77 (stable). Recorded as `PROVISIONAL` the same day.
- **Retracted the same day, by Opus Audit #4** (see below): a fair test
  (full 64-setup corpus + held-out replication excluding the selected 6)
  reverses it. Corpus-wide, `HIGH_VOL_PATTERN` is the WORST bucket (-$5.00);
  only 13/48 setup_types even favor `HIGH_VOL` at all, and the selected 6
  were entirely drawn from that minority. Held-out (the other 42): only 7/42
  favor `HIGH_VOL`, pooled -$10.26 vs `LOW_VOL`'s +$3.69 — the opposite sign.
  A double selection-bias artifact (minority direction + largest-effect tail
  of a sweep).
- **`RESEARCH_CLAIM`**: `volume_confirmed_candle_pattern_low_vol_trap` — kept
  `PROVISIONAL`, `rigor_status` updated in place to record the full
  retraction (not deleted — this file's own convention). **Do not wire an
  `ACDView.jsx` badge for this.**

### 4. Intrabar CVD divergence — FAILED, same confound family as #1's TWEEZER issue
- **Hypothesis**: price making a new adverse extreme while net delta
  (ask_volume vs bid_volume on that bar) is already favorable predicts a
  reversal (classic technical-analysis divergence, at single-bar resolution).
- **Built**: `scripts/pilot_cvd_divergence.mjs` — deliberately includes a
  3-way control split from the start (`CVD_DIVERGENCE` /
  `EXTREME_NO_FAV_VOL` / `NEVER_EXTREME`) to isolate the delta condition's
  real marginal contribution, anticipating the same tautology already found
  in test #1.
- **First pass looked striking** (-$32.20 vs +$15.46 pooled, uncontrolled) —
  but the controlled comparison (both buckets already "made a new extreme,"
  differing only in delta) showed the delta condition adds essentially
  nothing: `CVD_DIVERGENCE` N=2294 EV=-$32.20 (stable) vs
  `EXTREME_NO_FAV_VOL` N=2418 EV=-$23.93 (stable) — delta only -$8.27/trade.
- Run dispatched to Gemini for execution (script already correct and
  built) — its output independently reproduced this session's own earlier
  partial run byte-for-byte, real confidence it wasn't fabricated.
- **`RESEARCH_CLAIM`**: `intrabar_cvd_divergence_no_edge_confounded`
  (`CONFIRMED`).

### 5. Opus Audit #4 — strategic review, corrected the meta-pattern, caught #3's flaw
- **Prompt**: `docs/OPUS_AUDIT_PROMPT_4.md`. **Full results**:
  `scratch/opus_audit_4_results.md`. Run as a background Opus 4.8 agent with
  real DB access (not a hypothetical — this repo's actual mechanism for
  strategic review, same lineage as Audits 1-3).
- **Q1 corrected the framing**: "order-flow generalizes, price-action
  doesn't" is real but overstated. The true distinction is **magnitude vs.
  direction**: `touchQuality.js`'s volume z-score (magnitude) is the one
  feature that's actually generalized and is live; every DIRECTIONAL
  order-flow signal tested in this codebase's history has failed (daily CVD
  direction, intrabar CVD divergence, 3σ volume-spike continuation,
  session-pulse delta — 4 failures). GARCH and `CVD_DAILY`, cited earlier the
  same day as order-flow wins, are corrected: GARCH is a modest,
  not-wired-live minority effect; `CVD_DAILY` explicitly found no directional
  power.
- **Q2**: ranked next ideas — see "What's next" below.
- **Q3**: ran the fair test that retracted test #3 above (this is where that
  retraction came from).
- **Q4**: recommended `computeReplication()` + a documented confound
  checklist — both built same day, see "Infrastructure" below.

## Infrastructure built (reusable, not one-off)

- **`server/services/candlePatternQuality.js`** — 13 candlestick pattern
  families, data-derived thresholds (90-day trailing body/wick/range
  distribution), `barsAdjacent()` gap guard (prevents pairing bars across the
  daily maintenance halt / weekend reopen — a real bug caught before it could
  contaminate results). Not wired live; available for reuse by any future
  pattern-shape test.
- **`server/services/rigorDiagnostics.js`'s `computeReplication()`** — a
  held-out/permutation guard for "top-K selected from a sweep, then
  rigor-checked" findings, sitting alongside the pre-existing `computeRigor()`
  (day-clustering + chronological stability). Self-tested against this
  thread's own real retraction (test #3) — correctly flags `replicates:
  false`. **Use this before recording any `RESEARCH_CLAIM` that came from
  picking the biggest movers out of a larger set.**
- **`CLAUDE.md`'s 4-item confound checklist** (Conventions section) —
  documents when to reach for `computeReplication()` (item 4, selection bias,
  automatable) vs. manual reasoning (items 1-3: structural/algebraic
  advantage in one compared arm, baseline computed differently, missing a
  same-selection-minus-signal control bucket — all domain-specific, not
  auto-detectable by design).
- **Pilot scripts** (all in `scripts/`, all exploratory/not-persisted by
  themselves): `pilot_candle_pattern_reversal.mjs`, `pilot_overshoot_reversal.mjs`
  (Gemini-authored), `pilot_overshoot_control_check.mjs`,
  `pilot_candle_volume_confirmed.mjs`, `pilot_cvd_divergence.mjs`,
  `generate_overshoot_report.mjs` + `tweezer_check.mjs` (Gemini-authored
  investigation helpers).

## Open / pending (not yet decided or built)

- **`OPEN_DECISION` `overshoot_only_entry_worth_dedicated_pilot`** (LOW) —
  "wait for overshoot, no pattern" is real but doesn't discriminate setup
  quality; technically open, not recommended as a near-term priority.
- **`OPEN_DECISION` `level_agnostic_absorption_multisession_research`**
  (MEDIUM) — Opus Q2's highest-ceiling idea (a level-agnostic order-flow
  "this price is being defended" signal, questioning the level-fade paradigm
  itself) — correctly scoped as its own multi-session project, not a build.

### 6. Volume z-score trajectory across the reaction window — FAILED, cleanly
- **Hypothesis** (Opus Audit #4's top-ranked next idea): does the SHAPE of
  participation over the reaction window (z-score rising, size arriving to
  defend, vs. fading, an initial spike nobody follows) separate outcomes
  better than `touchQuality.js`'s existing single peak-z snapshot?
- **Built with `computeReplication()` baked in from the start** (per the
  confound checklist above, not bolted on after finding a problem this time)
  — dispatched to Gemini, which used the new helper correctly AND caught its
  own boundary case: a top-6-selected subset technically returned
  `replicates: true` but Gemini flagged unprompted that the held-out effect
  size was functionally zero (-$0.03) with a coin-flip 50% favorable
  fraction — not a real win despite passing the strict boolean.
- **Pooled result** (N=6912 across RISING+FADING): `RISING` N=3019 EV=-$3.02
  (stable) vs `FADING` N=3893 EV=-$1.33 (not stable) — essentially identical,
  no meaningful separation. `TOO_SHORT` (<2-bar windows) shows a striking
  WR=90.2%/EV=+$55.36 but isn't actionable — a trade resolving in 1-2 bars is
  definitionally an immediate clean winner, nothing knowable about that
  before the fact.
- **`RESEARCH_CLAIM`**: `volume_zscore_trajectory_no_edge` (`CONFIRMED`).

## What's next

Of Opus's 3 ranked Q2 ideas, 2 are now tested and failed (trajectory above;
CVD divergence direction, tested earlier as test #4, is the same delta-family
idea in different clothing). One remains:

1. **Level-anchored volume-node/absorption**, reusing
   `developingValueService.js`'s `computeProfile()` (the correct volume-profile
   reference implementation) — classify a touch by whether it sits at a real
   high-volume node vs. a low-volume gap, instead of by z-score alone. Not
   started. Given the accumulating string of negative results in this thread
   (5 of 6 tests failed, 1 retracted), worth pausing to ask whether this is
   still the highest-value next move before building it reflexively.
2. Bid/ask imbalance persistence (k≥2 consecutive favorable-delta bars) — low
   priority, capped by the delta-direction family's now-5-for-5 failure
   record (daily CVD, intrabar divergence, 3σ spike continuation,
   session-pulse delta, and — arguably — trajectory above, though trajectory
   is magnitude-shape not delta-sign). Probably not worth building without a
   real reason to expect this one differs.

## How to keep this file current

Same convention as this codebase's other `*_SPEC.md` docs: when a new test in
this thread runs, add it to "Tests run" above with its `RESEARCH_CLAIM` slug,
not just to `OPEN_THREADS.md` — this file is the fast index, `OPEN_THREADS.md`
keeps the full narrative. Update "What's next" as ideas get tried or dropped.
