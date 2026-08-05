# Compression → Tail-MFE Spec (does pre-trade compression predict outsized moves?)

**Status: RESOLVED 2026-08-05, MIXED — real statistical effects were found at both the cross-day and
same-day level, but a day-type conditioning check found the same-day signal likely predicts the
WRONG behavior (turbulence, not trend) for a naive hold-longer rule. NOT ready to design or wire —
needs day-type as a required second condition first. Full account: `docs/OPEN_THREADS.md`'s
2026-08-05 entry (itself a correction of an earlier 2026-08-04 write-up that filed the underlying
cross-day result as a flat negative — read that entry, it explains all three corrections). Short
version:**
- Parts 1/4-selection built directly by Claude (`scripts/backfill_compression_metrics.mjs`,
  `inferStrategyFamily()` in `server/config/setupTypes.js`), independently verified correct.
- **Part 2/3's first version (`scripts/analyze_compression_tail_mfe.mjs`) was mis-routed** — it
  tested compression against trade-level MFE, which only exists for a fired trade, forcing the
  question through `active_setups` (a thin, ~3-week-old, setup-gated population) instead of raw bar
  history. Kept on record as a real, narrower, correctly-labeled finding about this system's own
  fired trades, not deleted, but superseded as the answer to this spec's actual question.
- **The session-level, non-gated CROSS-DAY version (`scripts/analyze_compression_session_range.mjs`,
  369 real NQ RTH trading days) found a real, Bonferroni-significant effect** — volatility
  clustering (an uncompressed/wide prior day predicts a real lift toward a top-quartile-range day,
  over a verified 32.8% base rate), independently corroborating `RESEARCH_CLAIM
  volatility_squeeze_bigmove_inverted`. `RESEARCH_CLAIM compression_session_range_prediction`.
- **The SAME-DAY (intraday) follow-up this motivated found a real effect, but with a decisive catch**
  (`scripts/analyze_intraday_ib_range_remainder.mjs`): today's own Initial Balance range, known by
  10:30 ET, in the top DECILE of its trailing-60-day distribution → the rest of that session is a
  top-quartile-range day 73% of the time vs 27% otherwise (N=37/332, p=9.6e-9, Bonferroni-clean,
  rigor-clean). **But a day-type conditioning check (`scripts/analyze_intraday_ib_range_daytype.mjs`,
  joined against the real `acd_daily_log.day_type` TREND/TURBULENT/BALANCE classifier) found that
  wide-IB days are disproportionately TURBULENT (52.8% vs a 17.3% base rate), not TREND (16.7%,
  below the 21.6% base rate)** — a wide IB mostly predicts whipsaw, not clean continuation, so
  "hold the runner longer on wide-IB days" as originally framed is likely WRONG, not just
  unvalidated, since it would disproportionately hold into the day-type where holding hurts.
  `RESEARCH_CLAIM intraday_ib_range_predicts_remainder` / `intraday_ib_range_daytype_conditioning`.
  **Not wired live** — `OPEN_DECISION wire_intraday_ib_range_exit_signal` (HIGH), revised: needs
  day-type (or a real-time proxy) as a REQUIRED second condition before any trade-level validation,
  and is hard-scoped to exit timing only, never position sizing.
- Part 4's original pilot (`scripts/pilot_ib_bearish_2of3_target_1of3_trail.mjs`, unconditional —
  no IB-range conditioning) still failed its own plateau check. That's now explainable: it never
  conditioned on the one variable that turned out to matter.
- **Net**: the original hypothesis (compression precedes expansion) is dead, but the underlying
  research surfaced a real, positive, out-of-sample, independently-corroborated signal by inverting
  it — hold runners longer on days that are *already* active, not quiet ones. Historical text below
  is the original spec, kept for the reasoning trail.

**Original status line, 2026-08-04: spec only, not built. Written to be self-contained across a
context clear — read this doc plus `CLAUDE.md` and you should not need the prior conversation.**

## Why this exists — full lineage, so this isn't re-derived from scratch

This is a fresh angle on a question this codebase has tried and rejected twice before under a
different framing. Read this section before building anything, so Part 3 below doesn't repeat a
mistake already made twice.

**Attempt 1 — `docs/REGIME_INTELLIGENCE_SPEC.md` (v2.0, rejected 2026-07-31).** Proposed classifying
price as "Mid" (25th-75th percentile) or "Edge" of its own N-day range across 7 lookbacks, then
gating setup_types by which Mid/Edge combination they historically performed best in (a "Grand
Unified Theory": mean-reversion thrives at short-term Edge + macro Mid, trend-following thrives the
opposite way). Audited before implementation: found and fixed 2 real bugs (ES-price contamination
via a missing `symbol='NQ'` filter corrupting a full month of regime labels; a hardcoded UTC-4
timezone offset). Re-ran on corrected data — **the core theory reversed** (the EMA-overnight trend
claim lost money at every stop width once fixed). The one piece that looked real —
`IB_BEARISH`'s Mid60/Edge60 split, a real $64.95/trade gap on real data — **failed
`computeRigor()`'s chronological-stability check**, and `computeReplication()` showed the true
population-wide effect across all 108 tested setup_types was only marginal ($1.24/trade, 56%
favorable) — meaning `IB_BEARISH`'s number was very likely a cherry-picked outlier from a
~100-setup × 7-lookback search space, not a real broad effect. Not implemented. Full account:
`docs/OPEN_THREADS.md`'s 2026-07-31 entry, `RESEARCH_CLAIM balance_area_regime_grand_unified_theory_debunked`.

**Correction found the same day**: everything in Attempt 1 was tested against the spec's own
"balance area" — a plain `MAX(high)/MIN(low)` range percentile — which is **not** this codebase's
real, established value-area methodology (the volume-weighted `computeProfile()`/
`computeVolumeProfileForRange()`, `server/services/developingValueService.js`, already used for
every real `PD_VAH`/`PW_VAL`/`CAM_R1`-style level). Different input entirely.

**Attempt 2 — the value-area measurement layer (live since 2026-08-01/02, tagging only).** Rebuilt
using the *real* value area: `value_area_regime_snapshots` table (7 lookbacks: 10/20/30/45/60/90/180
trading days, computed via the real `computeVolumeProfileForRange()`, never reimplemented) +
`regime_pos_Nd`/`regime_label_Nd` columns on `active_setups` (`Mid` if inside the value area, `Edge`
if a genuine extension beyond it). Wired into all 7 `active_setups` INSERT sites. **Deliberately
tagging-only — no gating, no suppression, no sizing.** `scripts/scan_regime_combinations.mjs`
(built 2026-08-02) is the read-back half: groups real (`origin_status IN ('ACTIVE','SHADOW')`)
resolved touches by `setup_type × regime_label_Nd`, requires N≥20, runs `computeRigor`/
`computeReplication` before trusting anything, records every real cell via `recordClaim()`, and
`flagDecision()`'s any cell that clears the full gate. As of the last check (2026-08-02), 0
qualifying cells — only 2 real regime-tagged resolved rows existed at that point (tagging had only
been live for hours). **This is still slow-accumulating background infrastructure with no result
yet** — real forward N will take months to reach anything testable.

**A real, separate bug found while researching this doc (2026-08-04), not yet fixed**:
`scripts/validate_balance_area_regime.mjs` (the Attempt-1 audit script) computes
`x.actual_pnl * 2` when `active_setups.actual_pnl` is already a real dollar value (verified
directly: a real `IB_BEARISH` stop-out at 37pt distance shows `actual_pnl=-75.00`, matching
`-(37×$2+$1)` exactly — no additional ×2 belongs anywhere in that math). This means the cited
"$64.95/trade gap" for `IB_BEARISH` Mid60/Edge60 in the 2026-07-31 writeup is double the real
figure — the real gap is closer to **$32/trade**. Does not change Attempt 1's rejection (the
rigor/replication failures are unaffected by a uniform 2× scaling applied to both buckets equally),
but the absolute number in the docs is wrong and should be corrected if that script is ever reused.

**Why this new spec is different, not a third attempt at the same thing** (this distinction matters
— read it before building): both prior attempts tested whether *market position* (Mid/Edge of a
range) predicts *mean* EV, pooled across all setup_types together. This spec tests whether
*pre-trade compression* (a genuinely different input — value-area width, consecutive-day overlap,
IB range, none of which Attempts 1-2 measured) predicts the *probability of an outsized move*
(a genuinely different outcome — tail MFE, not mean EV), analyzed *separately within
strategy families* (not pooled). All three changes are direct, reasoned responses to specific
documented failure modes of the prior attempts (see Part 2 and Part 3 below for exactly which
failure each change addresses) — not a hopeful re-run of the same test.

**Unrelated, for the avoidance of doubt**: this session separately did work today on
`update_optimal_stops.mjs`'s stop/target calibration sweep (a chronological order-blindness bug,
confirmed real, fix attempted and reverted after a dry-run test showed harm — see
`docs/OPEN_THREADS.md`'s 2026-08-04 entries and `RESEARCH_CLAIM
structural_conservative_fallback_worse_ev_reverted_20260804`). **That work does not need to be
finished, retested, or waited on before building anything in this spec.** Verified directly:
`scan_regime_combinations.mjs` and `validate_balance_area_regime.mjs` both compute their numbers
from real, already-realized `active_setups.actual_pnl` — never from `computeEvAtStopTarget()`/
`sweepOptimalStopAndTarget()`, the specific function with the order-blindness bug. The two threads
are structurally independent: one is about how a setup's stop/target gets *chosen*, this one is
about whether a setup's real outcomes differ by pre-trade market condition, using whatever
stop/target was actually live at the time.

---

## The proposal (4 parts)

### Part 1 — Backfill compression metrics onto historical trades

**The problem this solves**: the live `regime_pos_Nd` tagging layer accumulates forward from
2026-08-01 and has ~0 usable real N today — a genuine "wait months" problem. But compression is
computable retroactively from historical bars using machinery this codebase already has, validated,
and uses for every real level in the system. This turns "wait months" into "run tonight."

**Three metrics, backfilled onto every resolved `active_setups` row** (`origin_status IN
('ACTIVE','SHADOW')`, matching every other real analysis in this codebase — do not include
`BACKFILL`-origin rows, ~80% of the table, per the standing caveat):

1. **Value area width (VAH−VAL) as a percentile of its own trailing 60-session distribution.**
   For each historical trade's `trade_date`, compute that day's value area via
   `computeVolumeProfileForRange(queryFn, { startDate: tradeDate, endDate: tradeDate })` (import,
   do not reimplement), and independently compute the same for each of the 60 trading days
   *strictly before* `tradeDate`. Rank the trade day's own width against that trailing distribution
   to get a percentile (0-100). No lookahead: only ever uses days before or on `tradeDate`, and
   value area for the trade's own day is fully formed by end-of-session — for an intraday trade,
   consider whether to use the DEVELOPING (as-of-fired_at) value area for that day instead of the
   final one, to avoid a same-day lookahead leak; this is an open implementation decision, resolve
   it explicitly before running, don't default silently.

2. **Count of consecutive prior sessions with overlapping value areas.** Walk backward from the day
   before `tradeDate`: a "compressed" streak continues as long as each day's `[VAL, VAH]` range
   overlaps the previous day's `[VAL, VAH]` range (standard interval-overlap check: `dayA.VAL <=
   dayB.VAH AND dayA.VAH >= dayB.VAL`). Count how many consecutive days back this holds. This is a
   genuinely different signal from metric 1 (a narrow-but-drifting value area is not the same thing
   as a narrow-and-stationary one) — do not treat them as redundant.

3. **IB range as a percentile of trailing 60-session IB ranges.** IB (Initial Balance) high/low is
   **not currently persisted anywhere** — confirmed via direct check of `acd_daily_log`'s schema
   (`server/schema.sql`) and every live computation site (`server/routes/acd.js`, e.g. line ~2624:
   `SELECT MAX(high) AS ib_high, MIN(low) AS ib_low FROM price_bars_primary WHERE ...` computed
   fresh on every poll, never written to a table) — this metric needs a fresh per-day query against
   `price_bars_primary`, not a read from an existing column. Use this codebase's own established IB
   window (60-minute IB, confirmed as the deliberate convention over a since-superseded 30-minute
   version — see CLAUDE.md's "New setup type checklist" item 10 for the git-history-backed reasoning
   if this needs re-verifying). All three metrics are knowable either pre-trade (1, 2 — prior days
   only) or by ~10:30 ET (3, IB closes at 60 min post-open) — genuinely no lookahead as long as the
   implementation respects the same-day boundary noted in metric 1.

**Storage**: new columns on `active_setups` (matching the existing `regime_pos_Nd` naming
convention — e.g. `va_width_pctile_60d`, `va_overlap_streak`, `ib_range_pctile_60d`), populated by a
dedicated one-time backfill script (`scripts/backfill_compression_metrics.mjs`, matching the
naming/structure of prior backfill scripts like `scripts/compute_value_area_regime_snapshots.mjs`).
This is explicitly a **backfill**, not a live per-poll tag — Part 1 does not require any change to
`acd.js`'s live insert paths. (Whether to *also* wire live tagging going forward, so future trades
get these columns automatically, is a natural follow-up once Part 2 shows whether this is worth
tracking at all — don't build that until Part 2 has an answer.)

### Part 2 — Test tail probability, not mean EV

**Primary outcome**: `P(MFE ≥ 2 × that setup_type's own median MFE)`, conditional on compression
state (from Part 1's backfilled columns). **Secondary outcome**: conditional median MFE.

**The specific failure mode this fixes**: Attempt 1's population-wide result was $1.24/trade,
essentially indistinguishable from zero — but that number is a *mean*, and if a real expansion
effect only fires on ~20-30% of sessions (compression resolving into a genuine breakout, not every
compressed session), a working signal changes almost nothing about the other 70-80% of trades, so
averaging dilutes a real, useful signal toward zero **by construction**, independent of whether the
signal is real. Attempt 1's $1.24/trade number is therefore consistent with *both* "no real effect"
and "a real tail effect diluted by an outcome metric that can't see it" — mean EV cannot
distinguish these two cases. Tail probability can, because it's not diluted by the (large) fraction
of trades where compression correctly predicts nothing unusual will happen.

Needs Part 1's backfilled columns (compression state) and each setup_type's own real median MFE
(already computable from existing `active_setups.mfe_points`, real-origin only).

### Part 3 — Replication runs within families, not pooled

**Pre-register every setup_type as `MEAN_REVERSION` (fade-type: level-touch setups betting on
reversion — the large majority of this system's ~130 setup_types, e.g. every `*_FADE_LONG/SHORT`)
or `CONTINUATION` (breakout-type: betting price keeps moving the direction it's already moving —
currently a much smaller family, e.g. `STACK_VOL_BREAK_LIVE_LONG/SHORT`, `OPEN_DRIVE_LONG/SHORT`,
`BRACKET_BREAKOUT_LONG/SHORT`) *before looking at any Part 2 results*, using `server/config/
setupTypes.js`'s existing type-name conventions as the classification basis (do not invent a new
naming scheme). Note this family split will be heavily imbalanced (this codebase is documented
elsewhere — memory `user-trading-style-breakout-preference` — as ~97% mean-reversion by
construction) — this is a real, known constraint on `CONTINUATION`-family N, not a design flaw to
fix here; report it plainly rather than papering over it with a rebalancing trick.**

**Run `computeReplication()` (`server/services/rigorDiagnostics.js` — import, do not reimplement)
separately within each family, never pooled across both.** The reason this is a correctness fix, not
an attempt to weaken the test: the underlying hypothesis predicts *opposite signs* across families —
compression resolving into expansion should plausibly help a `CONTINUATION` setup (rides the move)
and plausibly hurt or be neutral for a `MEAN_REVERSION` setup (a real breakout blows through a fade's
stop). Pooling both families into one `computeReplication()` call would let a true bidirectional
effect cancel itself into apparent noise — the exact same shape of dilution Part 2 already fixes for
mean-vs-tail, just at the family-mixing level instead of the trade-averaging level. The same pooled
test that produced Attempt 1's $1.24/trade would produce a similarly muted number even under a
genuinely true theory, for this same reason.

**Reporting requirement**: report effect size and confidence interval **regardless of whether
`computeRigor()` passes**, and report the gate (clean/unclean) result as a separate, additional
field — never let the binary pass/fail be the only output. `computeRigor()`'s all-three-
chronological-thirds-must-agree rule is a real, useful guard against overfitting, but it also
rejects a meaningful share of genuinely real effects at the N this system can realistically reach
(this specific claim about `computeRigor()`'s false-negative rate was raised by the same external
reviewer as the rest of this spec, in a separate conversation this session did not directly verify
— treat it as informing *why report-effect-size-regardless matters as a practice*, not as an
independently-confirmed statistic to cite elsewhere without its own check).

**Multiple-comparison budget, declared up front**: 3 metrics (value-area-width percentile, overlap
streak, IB-range percentile) × 3 threshold levels (e.g. tercile cuts — pin the exact cut points
before running, not after seeing results) × 2 families (`MEAN_REVERSION`/`CONTINUATION`) = **18
tests**. Deflate the significance bar accordingly (a standard correction — e.g. Bonferroni,
`α/18` — or an equivalent FDR control; pick one explicitly in the build script and state which, don't
leave the correction implicit). This budget should be treated as a hard ceiling declared before any
result is seen, not a number chosen after the fact to justify whatever came back significant.

### Part 4 — Runner pilot, independent of Parts 1-3

This is the **same pilot DeepSeek's design critique already recommended earlier this session**
(2026-08-04, reviewing a different, since-rejected 3-parameter asymmetric-exit proposal): "pilot a
2D version (trail width only, fixed scale-out/runner percentiles) on one setup_type first, not a
full 3D sweep." This spec adopts that exact recommendation as Part 4, now concretized:

- Keep the setup_type's own calibrated target on **2/3 of the position**.
- Trail the remaining **1/3** using the existing breakeven-trail machinery (`scripts/
  lib/breakevenTrailCore.mjs` — confirmed this session, via DeepSeek's review, to be real, reusable
  bar-walk infrastructure with its own guardrail suite: thin-tail gate, plateau check, chronological
  IS/OOS split, baseline comparison, `computeRigor()` — import and reuse, do not reimplement).
- **One free parameter**: trail width. This deliberately stays a 2D search (trail-width candidates
  × the existing target-hit population), not the full 3D sweep (scale-out %, trail width, runner %)
  DeepSeek flagged as needing overfitting guards this codebase doesn't have yet (Bonferroni/FDR
  correction, a candidate-density constraint, a much higher `MIN_N` floor) — those guards are still
  not built, so a 3D version remains out of scope until they are.
- **Setup selection**: pick the setup_type with the best combination of real N and a genuinely
  fat right tail in its MFE distribution — "a VAH type is the natural candidate" per the external
  review (a value-area-high fade/level family plausibly has more right-tail room than a tighter
  intraday level) — confirm this with real data (`p90_mfe`/`p75_mfe` vs `p50_mfe` spread, real
  `origin_status` population) before committing to a specific `setup_type`, don't assume the VAH
  framing is correct without checking.
- **Independent of Parts 1-3** — does not need compression data, can start immediately.

---

## Sequencing

- **Parts 1 and 4 can run in parallel, starting immediately** — neither depends on anything else in
  this spec or on any other open thread in this codebase.
- **Part 2 needs Part 1's backfilled columns** — cannot start until the backfill completes and is
  spot-checked (verify a handful of backfilled rows by hand against a direct value-area/IB query for
  that specific day, same discipline as every other backfill in this codebase's history).
- **Part 3 is the analysis discipline applied *within* Part 2**, not a separate sequential phase —
  build Part 2's analysis script with the family pre-registration and per-family replication from
  the start, not as a bolt-on afterward.
- **Nothing in this spec touches live behavior.** No `acd.js` changes, no new setup_type, no
  sizeMultiplier or suppression changes. This is entirely backtest/analysis work until a result
  exists to make a live-wiring decision about.

## The payoff framing (why this is worth building even though it might come back null)

**If Part 2's tail test comes back positive**: compression state becomes an input for deciding
whether to hold the Part-4 runner longer, not for gating entries. This is a **much lower statistical
bar** than an entry gate — it only needs to be right often enough to justify holding a third of a
position a bit longer, not right often enough to justify taking the trade at all. This is a
deliberate, load-bearing design choice in this spec — do not let a positive Part 2 result get
reframed into an entry-gating decision without a fresh, separate design pass, since the statistical
bar for that use case is materially higher and hasn't been argued for here.

**If it comes back null**: that's a real, useful answer — it means compression doesn't predict
tails in this system's actual data, closing the question properly (with real effect sizes and CIs
on record, not just a pass/fail) instead of leaving it as an untested intuition that resurfaces every
few months in a new framing. Record via `recordClaim()` either way, per this codebase's standing
"never leave a tested hypothesis as unrecorded prose" rule — positive or negative.

## What's not decided yet (flag explicitly when building, don't guess silently)

- Exact tercile/threshold cut points for the 3 compression metrics (Part 3's "3 threshold levels")
  — must be pinned before running, not chosen post-hoc.
- Same-day lookahead handling for Part 1's value-area-width metric on an intraday trade (developing
  vs final value area for the trade's own day) — resolve explicitly.
- Which multiple-comparison correction method exactly (Bonferroni vs FDR vs another) for Part 3's
  18-test budget.
- Whether Part 1's backfilled columns should *also* be wired into live tagging going forward (only
  worth deciding once Part 2 has an answer).
- The specific `setup_type` for Part 4's pilot (needs a real-data check of N and right-tail MFE
  spread before committing, not assumed from the "VAH type" framing alone).
