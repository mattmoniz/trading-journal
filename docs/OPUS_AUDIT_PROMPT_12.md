# AUTONOMOUS — OPUS STRATEGIC AUDIT (AUDIT #12): base hits + occasional home runs — turn today's runner/momentum research into a concrete build plan

You are Claude Opus 5, running at high reasoning effort. This audit is different in kind from
#1–#11: it is not "find a bug" or "diagnose a collapse," it's a **synthesis and build-plan** request.
A single research session (2026-09-03/09-04) ran ~10 separate tests chasing the user's own explicit
framing, quoted verbatim: **"I want basehit winners (small ones) consistently coming in when the
market is ranging but then i want the occasional breakout homerun. Right now the 1.5 target widener
seems to be working great. Most promising but it still leaves money on the table at times. I want
the system to reward the big [moves]."** The user then asked directly: have Opus review everything
tried, say what it actually thinks, and give concrete, implementable next steps — not more research
for its own sake.

**Deliverable:** `scratch/opus_audit_12_results.md`. Same format as prior audits: real verdicts, not
both-sides-ism; action items specific enough Sonnet can execute cold with exact file/line references
where you have them; **do not generate code for immediate paste** (design/instructions, not a diff).
You ARE explicitly asked for concrete implementation instructions this time (the user said so) —
that means "do X in file Y, gated on Z, in this order," not full function bodies.

---

## Part 1 — what already exists and is LIVE today (verify, don't re-derive from scratch)

**The base-hit engine (fades) is working and is not in question.** `WIDER_TARGET_MULT=1.5`,
`MAX_BARS_TO_T1_FOR_WIDER=4` (`server/services/widerTargetWalker.js`, `stepWiderTarget()`), live on
real capital since 2026-08-24, gated by `WIDER_TARGET_PRESSURE_GATE`
(`performance_audit`, threshold≈0.10005, `method='top_tercile_dirImbalance_at_t1_touch'`,
calibratedOn=445). This is the thing the user said is "working great" — the ask is what sits ON TOP
of or ALONGSIDE it for the home-run half, not replacing it.

**The home-run/breakout half is where the roster is currently weak — confirmed by two independent
sources, read both in full:**
- `scratch/opus_audit_11_results.md` (2026-09-01, "the firehose problem"): zero OR/IB setup_types
  are wired to any trail/runner mechanism; realized OR-family ceiling all-time is $118/trade; six
  live types share one generic `volatility-scaled-default` calibration; `OR10_*`/`OR15_*` fire with
  **no `OPTIMAL_STOP` row at all**. `BREAKEVEN_TRAIL_TEST` machinery exists but **5 of 6 blended
  survivors confirmed non-functional since 2026-08-04** (`OPEN_DECISION
  breakeven_trail_4_more_variants_lost_calibration_row`, HIGH, still open). Also flagged, still
  open: `OPEN_DECISION roster_level_wr_circuit_breaker_scoped` (real ACTIVE win rate collapsed
  68.7%→30.1% Jul-H2→Aug-H2, unrelated to the home-run question directly but relevant context for
  sizing any new mechanism — read it, factor it in if relevant, don't let it derail this audit's
  actual focus).
- `docs/IB_BULLISH_BEARISH_AUDIT_AND_REDESIGN_SPEC.md` (2026-08-31): the CURRENT `IB_BULLISH`/
  `IB_BEARISH` live implementation has zero break-of-boundary check and zero retest logic — it's a
  midpoint-position snapshot at IB close, not the break-and-retest-then-drive thesis the setup name
  implies. Spec'd, not built. Confirmed again independently TODAY: `detectIB()` in
  `scripts/backtest_unified.js` lines 535-568 requires no boundary break at all.

## Part 2 — what today's session (2026-09-03/09-04) specifically tested, in order

Verify these independently (spot-check 2-3 of the more surprising numbers against the live DB /
`performance_audit` / the actual saved scripts in `scratch/` and `/tmp/` before trusting them, per
this project's standing audit discipline) rather than assuming they're correct:

1. **4 initial "catch runners" ideas tested** (`scratch/run_4_tests.mjs`, Gemini-authored,
   Claude-verified): structural-level target (aim the runner at a real price level instead of a
   fixed multiple), pressure-sized first widening, an "early commitment" entry flag, bank-majority
   + let-remainder-ride. Results recorded as `RESEARCH_CLAIM`s
   `wider_target_structural_level_vs_flat_15x`, `wider_target_pressure_sized_first_widening`,
   `wider_target_early_commitment_entry_flag`, `wider_target_bar6_volbuilding_remainder_runner` —
   `node scripts/record_claim.mjs --list | grep wider_target` for current status/numbers.

2. **Order-flow delta-flip continuation signal**: real raw forward-price edge on a fresh-20-bar-high
   + 10-bar-cumulative-delta-flip pattern, but **failed across 4 different exit shapes tested**
   (fixed target, factor-conditioning, SMA trail × 16 param combos, EMA cross × 8 combos) — every
   single one showed the same within-test chronological decay pattern (strong early in the test
   window, flat/negative later). Settled negative as a tradeable mechanism; recorded STALE
   (`orderflow_delta_flip_sma_trail_exit_negative`, `orderflow_delta_flip_ema_cross_exit_negative`).
   **This recurring decay signature across 4 unrelated exit shapes is itself worth your opinion on**
   — is this evidence the underlying signal is not real (just noise that looked real in-sample), or
   evidence of a genuine but non-stationary edge that needs adaptive (not fixed) parameters?

3. **Early-commitment entry flag**: tested properly as a leading indicator (capture-rate test, not
   just correlation) — 23.8%/29.8% capture rate, near-zero forward edge. Settled negative as a
   *leading* signal — it's lagging, confirming a move already underway, not predicting one.

4. **Volume-building `compositeStrength` signal**: fully settled dead this session — both the live
   informational sum AND a previously-thought-validated AND-gate construction (`agreesP60`) were
   found to be retracted findings (bugfix reversal + walk-forward failure, both already known before
   today but the code comment describing them was stale/misleading until fixed today in
   `server/services/touchQuality.js` ~line 60-70). `computeReplication()` was run for the first time
   on the per-type sweep and failed (`volume_building_pertype_replication_check_20260903`, STALE,
   replicates=false). **This directly closes off one path the user's own framing gestured at** (the
   "volume-building signal, used correctly, aimed at a real structural level" idea from earlier in
   the session) — the signal itself doesn't have a real edge to aim anywhere. Confirm you agree this
   is fully closed, not just quiet.

5. **Step-trail runner extension** (the most-developed idea this session, three iterations):
   crosses the existing 1.5x target → snaps stop to a ratchet level → trails forward in
   fixed-fraction steps instead of banking at a flat target. v1 had a catastrophic bug (stop frozen
   at original level until a full extra step past arming — ~91pt average giveback found and fixed
   same session). v2 (bug fixed): all 3 step-fraction candidates (15/25/40%) beat baseline
   ($79.63-$81.50 vs $72.03), first time train/test agreed in sign. v3 (after a DeepSeek code review
   caught 3 more issues — stale baseline not using the real live pressure gate, a silent
   direction-inference null bug, an inert absolute step-size floor — all three fixed): with the
   REAL live pressure gate applied to both arms, N dropped 484→164 (correctly pressure-filtered),
   WR jumped to 97.5% both arms (population now skews to "safe" continuations only), EV delta
   shrank to +$2-4/trade, but **real tail-widening**: trades over 100pt went from ~1/164 to ~14/164.
   Net: modest mean improvement, meaningfully fatter right tail, on the correctly-gated population.
   Scripts: `/tmp/step1_ratchet_v3.mjs` (or `scratch/step1_ratchet_v3.mjs` if present) — read it, this
   is the most fleshed-out mechanism from today and the one closest to being buildable.

6. **Daily ADX(14,14) regime filter** (Sierra Chart formula, source-verified via WebFetch against
   `sierrachart.com`'s own docs, not memory — Welles Sum smoothing for DM/TR then a separate Wilder's
   Moving Average of DX into ADX): tested against real fade performance at N=1453/277 evenly-balanced
   days — **flat, no relationship** (an earlier N=481/41-day result had looked like "trend hurts
   fades" but was an artifact of uneven day-counts per quartile, corrected). Tested against
   `BRACKET_BREAKOUT` specifically (the only genuinely-tested breakout-shaped setup_type in
   `backtest_unified.js`, confirmed via direct code read that `detectCStandalone()` requires a real
   `close > orH`/`< orL` break while `detectIB()` does not): thin (N=55) but **direction-consistent
   across a proper chronological TRAIN(N=27)/TEST(N=28) split** — TRAIN high-ADX beats low-ADX
   (-$8.76 vs -$34.13, both negative), TEST high-ADX beats low-ADX ($170.70/WR76.2%/N=21 vs
   -$77.49/N=7). The N=21 bucket (the only one clearing this project's own N≥20 floor) passed a
   3-way chronological decay check (EV $239/$129/$144 across thirds, no single-trade domination).
   Recorded PROVISIONAL, not built, not shipped
   (`bracket_breakout_daily_adx_level_gate_clean_20260904`). A prior pooled Gemini dispatch had
   called ADX-for-breakouts "NOT BUILDABLE" across all 3 tested variants (hard gate, size-scaling,
   slope) — that verdict is **known-contaminated**: it pooled in `IB_BULLISH`/`IB_BEARISH`, which do
   not require a real boundary break, alongside genuine breakouts, and the pooled negative was
   substantially those two types dragging the average. On the clean population the level-gate
   direction holds up better than that pooled verdict implied, but total N is still thin.
   **The "ADX-rising" variant (matching how professional/Wilder-convention DI+/DI- + rising-ADX
   systems actually use this indicator, as opposed to a flat static level) was never properly
   tested — TRAIN only had N=3 "rising" cases, nowhere near usable.** This is a real, explicit gap,
   not a tested negative — flag it as such if you address ADX further.

7. **Live Globex same-direction stacking**: found the RTH engine has a same-direction-stacking
   protection (`_lfSameDirCounts`/`_lfSameDirN >= 7 → mult=0.10`, `acd.js` ~8466-8467) that
   `detectGlobexSetup()` (~line 1851) has NO equivalent of — confirmed via grep, root-caused as "a
   real trend night, not a bug" but a real missing protection. `OPEN_DECISION
   globex_same_direction_stacking_no_sizedown` (MEDIUM) — not yet resolved, tangential to the
   home-run question but touches the same code paths a breakout mechanism would need.

## Part 3 — the actual ask

Given ALL of the above — what already lives, what today specifically tried and found, and what's
still genuinely open (not what's already been tested and killed) — answer with real conviction, not
a survey:

1. **Of everything tested today, what is actually the strongest, most buildable candidate for the
   "occasional home run" half of the user's framing — and why that one over the others?** Consider
   the step-trail runner extension (closest to done, modest+real effect, needs live wiring
   decisions), the `BRACKET_BREAKOUT` ADX-gate (thin but the only genuinely home-run-shaped
   candidate that's also directionally validated), and the pre-existing spec'd-not-built options
   (IB break/retest/drive redesign, repairing the other 5 `BREAKEVEN_TRAIL_TEST` variants, the
   `sizeMultiplier` composite redesign). Rank them by (a) how close to actually shippable they are,
   (b) how directly they serve "occasional home run" specifically rather than a general edge
   improvement, (c) real blast radius / risk if wrong.

2. **Give a concrete, sequenced build plan for your top pick(s)** — not everything at once. What's
   the FIRST concrete change, in what file, gated how, shadow-logged for how long before it can gate
   anything real, what's the pre-registered kill/promote criterion. If your top pick is the
   step-trail mechanism, be specific about what SHADOW-parallel wiring looks like given it already
   reuses live `stepWiderTarget()` internals. If it's the ADX gate, be specific about whether N=55
   real `BRACKET_BREAKOUT` fires is even a realistic path to N≥100+ on any sane timeline, and if not,
   whether there's a cheaper way to get more ADX-vs-breakout signal (a different, higher-volume
   breakout-shaped setup_type; expanding to `C_STANDALONE` despite its opposite-signed thin result;
   building the real break/retest/drive redesign FIRST since it would generate more genuine breakout
   volume than the current thin roster does).

3. **Is there a connection between the step-trail mechanism and the ADX regime read that's more
   powerful than either alone?** The user's framing implies base hits when ranging (low ADX) +
   home runs when trending (high ADX) as a single coherent regime-aware system, not two unrelated
   mechanisms. Does gating the step-trail's "keep extending" decision on daily ADX (instead of, or
   in addition to, the pressure gate it currently uses) make mechanical sense given what each one
   actually measures? Say concretely whether this is worth building as a combined mechanism or
   whether that's over-engineering two thin, barely-validated things together.

4. **Is there anything in the existing, ALREADY-SPEC'D-BUT-UNBUILT documents this session's testing
   should change the priority of?** Specifically: does today's confirmation that daily ADX has zero
   relationship to fade performance (Part 2.6) resolve anything about the `dtClass`-null-all-day bug
   (`OPEN_DECISION dtclass_null_all_day_neuters_multiple_live_gates`) or the "TREND day hurts fades,
   size down" live rule this was meant to eventually replace? Does today's volume-building-fully-dead
   finding (Part 2.4) mean `docs/VOLUME_BUILDING_EXPANSION_SIGNAL_SPEC.md`'s remaining open threads
   should be deprioritized?

5. **Be willing to say some of today's session was the right instinct pursued down the wrong
   channel.** If you think the real lever for "occasional home run" isn't any of the mechanisms
   tested today but is actually the IB break/retest/drive redesign (which would generate an entirely
   new, larger population of genuine breakout trades rather than squeezing more out of the thin
   existing roster), say so plainly and explain why layering ADX/step-trail onto the CURRENT thin
   breakout roster is or isn't worth doing before that redesign exists.

## Hard rules (same as prior audits)

1. N≥20 before citing any stat as meaningful, or say "N=X, thin" explicitly and don't lean on it —
   this audit's own source material has several N<20 cells (TRAIN buckets in Part 2.6 especially).
2. Spot-check surprising/too-clean numbers against the live DB or the actual saved scripts before
   trusting them — don't just accept this prompt's own citations.
3. Do not re-test anything Part 2 already settled (order-flow delta-flip exit shapes, early
   commitment as a leading signal, volume-building compositeStrength, daily-ADX-vs-fades). Build on
   these as established facts.
4. Do not re-litigate anything Audit #11 already closed (see its own "Things the next session should
   NOT redo" section: volume-building-as-chop-gauge, per-setup rolling health gate, EWMA/SPC
   throttle, hard fire-count cap, "throttle harder after N losses").
5. Do not implement anything. Do not generate code for immediate paste — concrete instructions with
   file/line references are wanted (the user explicitly asked for this), full diffs are not.
6. Give a real, ranked opinion. The user explicitly said "see what it thinks" — hedged
   both-sides framing without a concrete recommendation is not what was asked for.

## Read first (in this order)

1. `CLAUDE.md`'s Hard rules + Collaboration sections (asymmetric payoff not win rate; no static
   thresholds; N≥20; no dead ends)
2. `scratch/opus_audit_11_results.md` in full — do not skip, it's the direct predecessor to this
   question
3. `docs/IB_BULLISH_BEARISH_AUDIT_AND_REDESIGN_SPEC.md`
4. `docs/VOLUME_BUILDING_EXPANSION_SIGNAL_SPEC.md`
5. `server/services/widerTargetWalker.js` — the live mechanism this all builds on
6. Whichever of `scratch/step1_ratchet_v3.mjs`, `scratch/breakout_adx_direct.mjs`,
   `/tmp/breakout_adx_clean.mjs` are present — the actual scripts behind Part 2.5/2.6's numbers
7. `node scripts/record_claim.mjs --list | grep -E "wider_target|orderflow|volume_building|bracket_breakout"`
   and `node scripts/flag_decision.mjs --list` for current, un-stale status of everything cited above
