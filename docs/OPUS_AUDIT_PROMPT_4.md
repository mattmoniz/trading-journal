# AUTONOMOUS — OPUS STRATEGIC AUDIT (AUDIT #4): what actually generalizes, and what's the highest-value next research thread?

You are Claude Opus 4.8. **Audits 1-3 covered code/data integrity, strategy alignment, and closed-loop learning.** This audit answers a narrower question that fell out of a single long session, 2026-07-21: **a repeated pattern showed up across four independent tests run the same day, and this audit exists to check whether that pattern is real across this codebase's whole history, or a small-sample coincidence from one session.**

Deliverable: `scratch/opus_audit_4_results.md` — structured findings + a concrete recommendation for the next 1-2 research threads worth building. Same format as prior audits. No code for immediate paste — action items specific enough that Sonnet can execute cold.

---

## What triggered this audit (read this first, it's the whole point)

A single session tested whether candlestick reversal patterns improve level-fade entry timing, in four escalating passes:

1. **Plain candle shape at first touch** (`server/services/candlePatternQuality.js`, 13 pattern families, corpus-wide across 64 setup_types) — no entry-confirmation edge. `RESEARCH_CLAIM candle_reversal_pattern_confirmation_no_edge`.
2. **Candle shape at a real overshoot past the level, not just first touch** — a Gemini-run corpus-wide pass initially looked dramatic (pooled paired EV -$85.77 → -$5.67, improved in 62/64 setup_types with zero exceptions). That zero-exception uniformity was the tell: a dedicated control script (`scripts/pilot_overshoot_control_check.mjs`) proved it was almost entirely algebraic — entering LATER against a FIXED original stop/target mechanically pays more on a win and costs less on a loss, independent of any pattern. Corrected: `ORIG` -$82.56 → blind-overshoot-entry -$8.99 → pattern-confirmed -$2.96 (pattern's real marginal contribution ~$6/trade). Further found this mechanism doesn't even discriminate good setups from bad ones — every setup_type's overshoot-cohort baseline is deeply negative regardless of overall setup quality, because the "overshot" selection discards each setup's clean winners equally. `RESEARCH_CLAIM overshoot_reentry_candle_pattern_confound_found`.
3. **Candle shape combined with real order flow** (bid_volume/ask_volume, reusing the already-validated `server/services/touchQuality.js` baseline) — the one real survivor. Pooled, high-volume-confirmed patterns underperformed low-volume ones corpus-wide (-$8.91 vs -$0.19, matching `touchQuality.js`'s own pre-existing `HIGH_VOL_OVERRUN` finding — heavy volume at a level can mean a losing fight, not absorption). But a targeted rigor check on the 6 largest-effect-size setup_types found 4 that pass this codebase's full bar (N≥20, not clustered, 3-way chronologically stable): a pattern firing on THIN/unconfirmed volume is a real, stable, negative signal (-$12.77/trade, N=433 pooled). `RESEARCH_CLAIM volume_confirmed_candle_pattern_low_vol_trap` — still `PROVISIONAL`, not blind-OOS-verified, selection-biased (picked the biggest movers from an exploratory pass, then rigor-checked them).
4. **Intrabar CVD divergence** (drop candle shape entirely — does price making a new adverse extreme while net delta is already favorable predict a reversal?) — looked striking uncontrolled (-$32.20 vs +$15.46 pooled), but a proper 3-way control (`scripts/pilot_cvd_divergence.mjs`) showed it was the exact same tautology as pattern #2: "made ANY new adverse extreme" is already a bad sign on its own; controlling for that, the order-flow condition added nothing (-$8.27/trade delta, likely noise). `RESEARCH_CLAIM intrabar_cvd_divergence_no_edge_confounded`.

**The pattern across all four**: pure price-action/shape signals (#1, #4's uncontrolled framing) failed; a signal combining shape with an already-validated order-flow baseline (#3) survived rigor-checking. This echoes something already documented before this session — `docs/REGIME_DETECTION_SPEC.md` found the same split for volatility-regime classification (z-score/tercile constructions failed a placebo/permutation/changepoint test), and `docs/OPEN_THREADS.md`'s 2026-07-15 "Touch-quality" thread found the identical split (price-action-only classification didn't generalize, order-flow classification did, corpus-wide, zero day-clustering).

**Three sessions, three independent tests, same split.** That's either a real, important meta-pattern about what kind of signal this specific market/dataset rewards — or a coincidence from a small number of attempts, or a bias in how these tests happened to get constructed. This audit's job is to tell which.

## Questions this audit must answer

### 1. Is "order-flow-based signals generalize, price-action-only signals don't" actually true across this codebase's FULL research history, or cherry-picked from 3 sessions?

Pull every `RESEARCH_CLAIM` row (`node scripts/record_claim.mjs --list`, or query `performance_audit WHERE signal_type='RESEARCH_CLAIM'` directly — do not trust a prior session's summary of this, re-derive it) and every `SETUP_STATUS`/`TOUCH_QUALITY`/other signal_type that represents a tested hypothesis. Categorize each as order-flow-based (uses `bid_volume`/`ask_volume`/CVD/volume z-scores), price-action-only (candle shape, pure price levels, z-scores of price itself), or other (day-of-week, session-type, day-type conditioning — categorically different, not price-action-vs-orderflow at all). Report the real win rate of each category — not just the 3 examples above, the whole ledger. If the pattern holds up on the full history, that's a real, load-bearing finding for where to spend research time going forward. If it doesn't (e.g., `DAY_TYPE_ALPHA`, `CONTEXT_ANALYSIS`, session-bias findings are real and don't fit either bucket cleanly), say so plainly rather than forcing the framing.

### 2. What's the highest-value UNTRIED order-flow idea, given what's already been tried and what's already validated?

Already exist and validated: `touchQuality.js` (single-touch volume z-score, absorbed/overrun/quiet), `CVD_DAILY` (daily-aggregate order flow vs next-session range), GARCH vol-scaled stops (modest, real, minority effect), the volume-confirmed candle trap from this session (still provisional). Already tried and failed: intrabar CVD divergence as defined in test #4 above (single-bar new-extreme + favorable delta).

Consider and evaluate (don't just list — for each, say whether it's worth building given what's already known, and why):
- Cumulative session delta trend (not single-bar, not daily-aggregate — running CVD *within* a session, checked for divergence against price at multiple points, not just at the reaction-window level) — is this meaningfully different from the failed test #4, or the same idea restated?
- Bid/ask imbalance *persistence* (does a favorable delta bar need to be followed by 2-3 more favorable bars to mean anything, vs. a single-bar spike that reverses immediately)?
- Absorption at volume nodes independent of any specific level-fade setup — i.e., is there a real, general "this price is being defended by real size" signal detectable in `price_bars_primary` that doesn't require first classifying the price as near a known MGI level at all? This is a bigger question than incrementally improving level-fade entries — it asks whether the whole level-fade paradigm this app is built around is the right frame, or whether a level-agnostic order-flow signal would be a more fundamental edge. Be honest if this is out of scope for a reasonable build vs. a genuine research direction worth flagging as its own multi-session project.

### 3. Is the volume-confirmed pattern trap (`RESEARCH_CLAIM volume_confirmed_candle_pattern_low_vol_trap`) ready for anything beyond `PROVISIONAL`, or does it need a real blind test first?

It clears the same rigor bar (N≥20, not clustered, stable) that `touchQuality.js`'s `HIGH_VOL_OVERRUN` cleared before going live as an informational badge. But it was found via a selection-biased process (picked the 6 largest-effect-size setup_types from an exploratory pass, then rigor-checked only those) — `touchQuality.js`'s original validation checked all 47 N≥50 setup_types, not a pre-selected subset. Design a fair test: either check ALL setup_types (not just the 6) for this same pattern, or hold out a subset never used in selection and see if the effect replicates there. Give a concrete verdict on whether this is ready to become a live informational badge (matching `touchQuality.js`'s existing `ACDView.jsx` badge pattern) or needs more work first.

### 4. Should there be a standing "confound checklist" applied to new comparison-style backtests, given how many were caught by hand this session?

Three separate times this session (overshoot-entry-price arithmetic, the TWEEZER tautology, the CVD-divergence "made an extreme" tautology), a striking-looking result turned out to be explained by something other than the hypothesis being tested — caught by manual reasoning and a follow-up control script each time, not by any existing automated check. `computeRigor()` (`server/services/rigorDiagnostics.js`) already catches day-clustering and chronological instability — it does NOT catch "does this comparison have a structural/selection advantage baked into one arm regardless of the hypothesis." Is this common enough (search git history / `docs/OPEN_THREADS.md` for other instances beyond this session — the target-sweep baseline-mismatch incident from 2026-07-19 is the same family) to justify building a lightweight, generic check into the standard backtest-pilot pattern (e.g., a documented checklist item, or an actual function alongside `computeRigor` that flags "these two buckets differ in population-selection-criteria X, verify X isn't doing the work")? Or is manual vigilance genuinely sufficient given how few backtests get built per week? Give a concrete recommendation, not just "yes this would be nice."

---

## Hard rules (same as prior audits)

1. N≥20 before citing any stat as meaningful. Below that, say "N=X (thin)" and do not recommend action.
2. No lookahead — any reconstruction or new test design must only use data that existed as of the historical moment being evaluated.
3. Never fabricate a stat. Query the DB / read the actual `RESEARCH_CLAIM` rows and scripts, cite exact numbers.
4. Check `docs/OPEN_THREADS.md` before raising anything already tracked there.
5. Do not implement anything. Do not generate code for immediate paste. Write action items specific enough that Sonnet can execute cold, including exact file/line references where relevant.
6. Per this codebase's own standing rule: audit any surprising or too-clean-looking number yourself before including it in the report — this whole audit exists because that exact discipline caught three real confounds in one session already.

## Read first (in this order)

1. `CLAUDE.md` — hard rules, especially the two new entries added 2026-07-21 about backtest confounds (search "structural/algebraic advantage" and the touch-quality/candle-pattern hard rules)
2. `docs/OPEN_THREADS.md` — search "candle", "CVD", "overshoot", "volume_confirmed" for the full 2026-07-21 session writeup, plus the 2026-07-15 "Touch-quality" thread and `docs/REGIME_DETECTION_SPEC.md` for the two earlier instances of the same shape/order-flow split
3. `ARCHITECTURE.md` — service table, especially `touchQuality.js` and `candlePatternQuality.js` entries
4. `server/services/touchQuality.js`, `server/services/candlePatternQuality.js` — the two real modules from this thread
5. `scripts/pilot_overshoot_control_check.mjs`, `scripts/pilot_cvd_divergence.mjs` — the confound-catching control-script pattern, reusable methodology for question 4
6. `node scripts/record_claim.mjs --list` — the full, current `RESEARCH_CLAIM` ledger, the primary data source for question 1
