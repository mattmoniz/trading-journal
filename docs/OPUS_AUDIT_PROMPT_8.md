# AUTONOMOUS — OPUS AUDIT 8: STOP LOGIC, TOUCH QUALITY, AND CLUSTERED LOSS DAYS

You are Claude Opus 4.8. This is a focused strategic audit, not a full top-to-bottom review —
prior audits (`docs/OPUS_AUDIT_PROMPT.md` through `_7.md`, results in
`scratch/opus_audit_2_results.md` through `_7_results.md`) already covered code/bugs forensics,
sizeMultiplier discrimination, closed-loop learning, order-flow research, and overall
architecture. Read those results files first — do not re-derive what they already found.

**The user's own framing, verbatim, is the brief**: "trades are great and then we get four huge
losses that wipe out everything. It seems to happen more often than not." They specifically
want your read on whether stop logic, or how the system defines/uses "touches" at levels, could
be tightened to prevent bad trades from firing in the first place — not just sized smaller after
the fact.

**Deliverable**: `scratch/opus_audit_8_results.md` — structured findings + 2-4 concrete,
prioritized recommendations. Same format as prior audits: no code for immediate paste, action
items specific enough Sonnet can execute cold with exact file/line references. Do not implement
anything.

---

## Grounding data (already queried this session, verify independently before trusting)

A same-session query (`active_setups`, `origin_status IN ('ACTIVE','SHADOW')`,
`actual_pnl < -150`, grouped by `trade_date` HAVING `COUNT(*) >= 3`) found this is a real,
recurring pattern, not an isolated bad week:

| Date | Big losses (>-$150) same day | Combined P&L | Types involved |
|---|---|---|---|
| 2026-08-19 | 4 | -$708 | BRACKET_BREAKOUT_SHORT, PD_POC_FADE_LONG_TRAIL, OR10_LOW_FADE_LONG, OR30_LOW_FADE_SHORT |
| 2026-08-18 | 5 | -$886 | 3x 3M_POC_FADE_LONG, FLOOR_S3_FADE_SHORT, OR30_LOW_FADE_LONG |
| 2026-08-07 | 6 | -$1,161 | mixed C_PAIRED/GLOBEX_VWAP/PD_POC/FLOOR_R1/C_STANDALONE |
| 2026-08-06 | 8 | -$1,368 | 6x IB_BULLISH, C_PAIRED_LONG, GLOBEX_VWAP_FADE_LONG |
| 2026-07-31 | 10 | -$1,888 | 5x IB_BEARISH, mixed |
| 2026-07-30 | 12 | -$2,211 | mixed, 3x IB_BULLISH |
| 2026-07-29 | 15 | -$4,241 | 7x IB_BEARISH, mixed |

14 such days found total (3+ losses over -$150 same real day) since late July. This IS
predominantly `SHADOW`-origin (background, not real capital) — confirm the real (`ACTIVE`-only)
subset of this pattern specifically, since that's the population that would have actually hurt
the user's account, and the `SHADOW` population matters only as evidence about the SYSTEM'S edge
logic, not realized damage. Note the recurring cast of characters: `IB_BULLISH`/`IB_BEARISH`
appear in the majority of these clustered days — check whether that's just base rate (they fire
often) or a genuine same-day-conditional clustering (something about certain DAYS makes multiple
IB-family fades all fail together, e.g. a strong trend day where every fade against it loses).

Two things already known and NOT to re-investigate from scratch (read, don't rebuild):
- `server/routes/acd.js`'s Death Sequence / capital-exposure override mechanisms already exist to
  reduce size after a loss same-day — check whether they're actually engaging on these clustered
  days or missing them (a same-day-multiple-loss pattern surviving despite this mechanism
  existing would itself be a finding).
- `OPEN_DECISION hardcoded_stop90_target40_fallback_needs_fix` (this session, 2026-08-19) found a
  bare hardcoded 90pt/40pt stop/target fallback affecting 18+ setup_types with no real
  calibration data — 3 of today's 4 clustered losses (`PD_POC_FADE_LONG_TRAIL`,
  `OR10_LOW_FADE_LONG`, `OR30_LOW_FADE_SHORT`) are THIS bug, not a deeper problem. Don't
  re-discover it; instead ask whether the SAME underlying gap (thin/uncalibrated setup types
  firing with structurally bad risk:reward) explains a meaningful share of the OTHER clustered
  days too, or whether those are a genuinely different, deeper issue.

---

## Part 0 — A concrete, same-day example found while scoping this audit (verify independently)

2026-08-19, `IB_BEARISH` fired SHORT three times as the market reversed against it: session
opened 29696, dropped to a low of ~29382 by 10:14 ET, then reversed and climbed steadily —
back to 29624.75 by 11:00. `IB_BEARISH` entered SHORT at 10:28 (29459), 10:31 (29510, already
51pt higher), and 10:41 (29550, 91pt higher than the first) — each entry chasing the bounce
upward, each stopped out for -$102. Only the FIRST (`id=99900`) was `origin_status='ACTIVE'`
(real capital); the other two were correctly routed to `SHADOW` by an existing 30-minute
same-type re-fire cooldown (`RESEARCH_CLAIM ib_bearish_refire_cooldown_beats_volz_gate`,
`acd.js` ~8681) — so real damage was one -$102 loss, not three. But the underlying THESIS
(short, betting on IB-break continuation) kept re-arming and re-firing directly into an active,
sustained reversal with no apparent trend-awareness override — verify whether this is
setup-type-specific (only `IB_BEARISH`'s own re-fires) or whether OTHER, DIFFERENT setup_types
also fired same-direction (short) candidates during this same 10:14-11:00 window, which would
be the cross-setup-type version of the same gap (see Part 1).

## Part 1 — Is the "four huge losses" pattern actually clustered by DAY (a market-regime
correlation problem), or just base-rate coincidence?

- For the 14 flagged days, is there a shared market condition (day_type from `acd_daily_log`,
  regime classification, a specific structural_state) that predicts a cluster? If multiple
  independent-looking fade setups (different levels, different setup_types) all fail on the same
  day, that's evidence they're not actually independent bets — they're correlated exposure to
  "today is a trend day" dressed up as diversification across setup_types.
- Check `daily_performance_log`/`acd_daily_log.structural_state` for these 14 dates. Is
  `TRENDING_UP`/`TRENDING_DOWN` (vs `BALANCE`) over-represented on cluster days vs. all days?
- If correlated-on-trend-days is the real mechanism, the fix isn't "tighter stops on individual
  setups" — it's a same-day, cross-setup-type circuit breaker (has N fades already failed today
  in the same directional lean → suppress further same-direction fades for the rest of the
  session, regardless of setup_type). Check whether anything like this exists today
  (`isS2DoubleCounter()`, the Death Sequence logic) and whether it's scoped narrowly enough to
  miss this cross-setup-type version of the same problem.

## Part 2 — Stop logic: are stops the actual lever, or a symptom?

- For setup_types NOT already known to be the `STOP=90` fallback bug, are their stops
  genuinely calibrated (`OPTIMAL_STOP` real `EV-sweep-real`/`corrected-resim` method) or
  volatility-scaled-defaults standing in for missing data? Quantify: of the setup_types that
  appear in the 14 clustered days, what fraction are running on a real sweep vs. a default?
- Independent of calibration quality: is there a structural reason fade-style setups
  (`*_FADE_*`, the dominant family in this list) have systematically worse tail risk than
  breakout-style setups, given this user's own stated preference for breakouts (see
  `user_trading_style_breakout_preference` in project memory if accessible, or infer from
  `docs/` if not)? A fade's thesis is "price rejects this level" — when it's wrong, price often
  doesn't just clip the stop, it runs, because the fade was fighting a real move. Check MAE
  distribution shape (not just mean) for FADE-family STOP_HIT rows vs. BREAKOUT-family
  STOP_HIT rows — is the fade family's loss tail fatter (MAE overshoots the stop by more,
  more often) even after the stop itself is hit?

## Part 3 — "Touches" at levels: is the entry trigger itself too permissive?

- How does this codebase currently define a level "touch" that triggers a fade candidate — is
  it a bare price cross (`Math.abs(currentPrice - lv.level) <= 15` or similar proximity check,
  confirm the actual live threshold in `acd.js`'s `nearLevels` filter), or does it require any
  confirmation (rejection candle, volume/order-flow signature, a minimum time-at-level)? Compare
  against `touchQuality.js`'s `getVolumeBaseline()`/`volZ`/`oneSidedRatio` — is that
  machinery actually gating entry for the fade family, or is it informational-only (check the
  live insert-gate code path directly, don't assume from the function's existence)?
- For the setup_types in the clustered-loss list specifically: what fraction of their STOP_HIT
  resolutions show LOW touch-quality signatures at entry (thin volume, no rejection, one-sided
  order flow AGAINST the fade thesis) vs. genuinely well-formed touches that just didn't work?
  If bad-quality touches are disproportionately represented in the loss population, that's a
  concrete, checkable argument for tightening the entry gate rather than (or in addition to)
  the stop.
- Is there a cheap, checkable "second touch is safer than first touch" or "touch after N minutes
  of consolidation is safer than an immediate touch off a sharp move" pattern in the real
  resolved data? This codebase already has a "first touch + AM = proven filters" finding from
  earlier level-audit work (`project_level_audit_results.md`) — does that finding generalize to
  the setup_types actually appearing in the clustered-loss list, or is it specific to the levels
  it was originally tested on?

## Part 4 — Synthesis

Rank your findings by how directly they'd address "four huge losses wipe out everything, more
often than not": is the highest-leverage fix a same-day cross-setup-type circuit breaker (Part
1), better-calibrated/family-aware stops (Part 2), a stricter touch-quality gate on entry (Part
3), or some combination? Be concrete about WHICH setup_types and WHICH mechanism, not a generic
"do more risk management" recommendation — the user has plenty of infrastructure already built
(sizeMultiplier, Death Sequence, capital-exposure overrides); the question is what's actually
missing or misfiring, not whether risk management exists at all.

---

## Hard rules (same as every prior audit)

1. N≥20 before citing any stat as meaningful. Below that, say "N=X (thin)" and do not recommend
   action on it alone.
2. No lookahead — any pattern must be detectable before the trade is taken, not just visible in
   hindsight.
3. Never fabricate a stat. Query the DB, cite the count.
4. Check `docs/OPEN_THREADS.md` and today's flagged `OPEN_DECISION`s (`node scripts/flag_decision.mjs --list`)
   before raising anything already tracked.
5. Distinguish `origin_status` populations explicitly in every number you report — `BACKFILL` is
   synthetic, `UNKNOWN` is unrecoverable-origin real-or-synthetic, `ACTIVE`/`SHADOW` are real.
   Never present a blended sum as if it were realized account history.

## Read First

1. `CLAUDE.md` — conventions, hard rules
2. `docs/OPEN_THREADS.md` + `node scripts/flag_decision.mjs --list` — pending work, including
   several new findings from today's session (hardcoded stop fallback, TRT_V2/C_REVERSAL zero
   fires, an unreconciled OPTIMAL_STOP N-count drop)
3. `scratch/opus_audit_5_results.md`, `_6_results.md`, `_7_results.md` — don't re-derive what's
   already found
4. `ARCHITECTURE.md` — route/service/table inventory
