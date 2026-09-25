# Depth-Absorption ML Pilot — Spec & Build Log

**Status: PAUSED, 2026-09-23. Phase 0 (pre-registration) complete. Phase 1
(reconstruct-and-validate the order book) attempted, FAILED kill criterion #1, root
cause not fully isolated — read §8 before resuming.** Sibling thread to
[docs/TICK_MICROSTRUCTURE_PILOT_SPEC.md](TICK_MICROSTRUCTURE_PILOT_SPEC.md) — same
overall session, same 4-item "build a real system" discipline, but a genuinely separate
research question (per DeepSeek's own analysis: trade-print discovery vs. resting-
liquidity confirmation are different data axes — a result in one doesn't gate the other).
Read this file before touching order-book depth data again.

## 1. Origin and goal

Order-book depth data can answer a question tick/trade data structurally cannot: when
price presses against a level and doesn't break, was it genuinely defended by real
resting size absorbing and refilling, or did it just not get hit hard yet? This connects
directly to 3 live detectors (`majorPivotDefendedBreakDetector.js`,
`minorDefendedLevelDetector.js`, `stallDefendedLevelDetector.js`) that currently infer
"defended" purely from price holding, with zero visibility into why.

Originally scoped by a prior audit (Opus Audit 10, `scratch/opus_audit_10_results.md`
§6) as `OPEN_DECISION run_depth_absorption_poc_stage1`. Re-specced 2026-09-23 after a
DeepSeek design review found real numerical weaknesses in the original feature
definition (see §3).

## 2. Real data inventory

267.5GB of `.depth` files, `/mnt/c/SierraChart/Data/MarketDepthData/`, 100 price levels
per side, per-level resting order counts, real NQ data June 2024 to today. Now backed up
(separate from the source, protects against Sierra Chart's own retention auto-purge —
see `OPEN_DECISION preserve_sierra_chart_depth_archive_irreplaceable`, resolved). Binary
format not yet parsed/verified in this codebase (unlike `.scid`, which was directly
byte-verified this session) — Phase 1's first job.

## 3. The feature, corrected (read before implementing)

**Original design (Opus Audit 10)**: `replenishment_ratio` = volume traded into a level
÷ net decline in resting quantity there, over a swept window T ∈ {15, 30, 60}s.

**DeepSeek's review found 3 real numerical failure modes in that design, all corrected
here — implement the corrected version, not the original:**

1. **Unbounded ratio, infinite variance near a zero denominator** — exactly where the
   "refreshed" signal is supposed to live. **Fixed spec: use a bounded fraction**
   `R = traded / (traded + net_decline)` — lives in [0,1], numerically stable, R→0 means
   consumed, R→1 means refreshed.
2. **Sweeping multiple windows and keeping the best is a multiple-comparisons trap** —
   the same "largest-of-K-from-a-sweep" confound this codebase already has a standing
   rule against, done directly on the outcome. **Fixed spec: compute cumulatively**
   (running traded vs. running net-decline from touch start, integrated over the whole
   episode) rather than sweeping fixed windows — removes the window-choice decision
   entirely.
3. **Order-cancellation churn contaminates the denominator in either direction** — a
   cancel-and-replace during the touch looks like "decline" (biasing R down); a burst of
   new resting orders right after masks real decline (biasing R up). **Fixed spec: add
   an explicit `cancel_rate`/`add_rate` companion feature and condition on low churn**
   rather than assume all "decline" was real consumption.

**Additional companion feature**: `NumOrders` (few large vs. many small resting orders)
— the audit's own "iceberg tell," less sensitive to size-churn than raw resting quantity.

**Additional robustness gate beyond the original 5 kill criteria**: require the same
level-type to show a *consistent* R across multiple independent touches (cross-touch
replication), not trust a single draw — variance reduction, not just a bigger sample.

## 4. The 5 kill criteria (unchanged from the original scoping — still honored as-is)

1. Book reconstruction validation error >1% vs. `.scid`'s own bid/ask-at-trade fields →
   STOP. Validate at the TOUCHED price level specifically, not just top-of-book — a
   reconstructor can be correct at level 1 and silently wrong several levels deep, where
   this feature is actually computed.
2. Effect smaller than the already-confirmed-null `level_agnostic_volume_node` control
   ($0.32/trade).
3. Fails a frozen chronological train/test split.
4. Median signal persistence <30 seconds — unreachable via the live 15-second poll with
   no broker execution (a real kill condition, not a footnote).
5. Effect concentrated in ≤3 trading days.

**Plus** (added by the 2026-09-23 review, on top of the original 5): must clear a
cheap-proxy agreement test against a PRE-SPECIFIED (not searched-for) existing live
feature — `volZ`/`oneSidedRatio`/CVD. High agreement is a valid, useful clean negative
(the expensive depth data is redundant), not a failure to explain away. Searching for
whichever cheap feature happens to correlate on a 3-week window would be feature
selection on a tiny sample — a real overfitting trap, not a shortcut.

## 5. Phased plan (per DeepSeek, 2026-09-23)

- **Phase 0 — pre-register.** DONE. `RESEARCH_CLAIM depth_absorption_replenishment_fraction_20260923`,
  recorded via `recordClaim()` BEFORE any data was touched (see `scratch/register_depth_absorption_claim.mjs`).
- **Phase 1 — reconstruct AND validate the book, alone, on the 20-day pilot window
  (2026-07-13 to 2026-08-20).** NOT STARTED. The single riskiest step — most likely to
  fail on a boring technical bug (a format quirk, a scaling error analogous to the
  `.scid` ×100 price bug already found this session). Do this in isolation before
  spending effort on the feature itself.
- **Phase 2 — extract the corrected feature (§3) + run the 3-way pretest.** Reuse
  `pilot_cvd_divergence.mjs`'s `SIGNAL`/`SAME_SELECTION_NO_SIGNAL`/`NEVER_SELECTED`
  template, don't reinvent it.
- **Phase 3 — Mode A payoff (offline, zero live infra needed).** A calibration artifact —
  a per-level-type "depth-verified defense rate" table feeding the existing
  `performance_audit`/`SETUP_STATUS`/`sizeMultiplier` pipeline. Run the cheap-proxy
  agreement test here.
- **Phase 4 — Mode B fork, ONLY if Phase 3 shows genuinely orthogonal value** (low
  agreement with the cheap proxy). A pre-specified held-out live proxy, or a real
  live `.depth` reader — a materially larger, separately-scoped project.

**Where real trading value can show up**: Phase 3 (trust/size reweighting, no live infra)
and, much later, Phase 4-Option-2 (ongoing live gating, requires real infrastructure).
**Where it can never show up**: as a leading/entry-timing signal — this is structurally
a conditional filter (does this specific level deserve more or less trust right now),
never a timing input, regardless of how the rest of the pilot goes.

## 6. The 4-item "build a real system" discipline, applied to this thread

Same framework as the tick pilot (see that spec's §5) — applied independently here, not
inherited:

- **Recorded claim (done first, not last)**: `depth_absorption_replenishment_fraction_20260923`,
  PROVISIONAL, pre-registered before any data access — the reverse order from the tick
  pilot, deliberately, per DeepSeek's Phase 0 requirement.
- **Discoverability**: this doc + the `docs/OPEN_THREADS.md` entry (added same session).
  Still needed once Phase 1+ produce a real result: `ARCHITECTURE.md` + CLAUDE.md's
  "Where to look" entries.
- **Real consumer**: already concretely specified in §5 (Phase 3's calibration-reweighting
  payoff) — more concrete at this stage than the tick pilot's own consumer chain, since
  DeepSeek's plan named the exact target pipeline (`performance_audit`/`SETUP_STATUS`/
  `sizeMultiplier`).
- **Recheck cadence**: deferred, same reasoning as the tick pilot — premature to schedule
  a rebuild of something not yet proven to have a real result.

## 8. Phase 1 attempt log, 2026-09-23 — PAUSED here, read before resuming

Real code exists: `scripts/depth_absorption/depth_reader.py` (canonical `.depth` parser)
and `reconstruct_and_validate.py` (kill-criterion-#1 check: reconstructed top-of-book vs
`.scid`'s own bid/ask-at-trade fields, at matching timestamps, on a real day).

**Format, confirmed real, not guessed**: fetched Sierra Chart's own docs
(`MarketDepthDataFileFormat`), then verified against real bytes. 24-byte records
(`s_MarketDepthFileRecord`: DateTime i64, Command u8, Flags u8, NumOrders u16, Price f32,
Quantity u32, Reserved u32), 64-byte header (magic `"SCDD"` + header_size + record_size +
version — same convention as `.scid`, empirically confirmed via the header_size field
itself, not assumed). **Same 100× price scaling as `.scid`**, verified against a real
`price_bars_primary` bar at the identical timestamp (raw 3085150.0 → real 30851.50,
sitting correctly just below that minute's real price of 30872.75).

**First validation run: 10.96% mismatch on 2026-09-22** (303,259 real trades checked) —
already far above the 1% kill threshold. Investigated rather than accepted at face value,
since the mismatches showed a suspiciously consistent one-direction offset (a real-result
smell, not random noise):

1. **Real bug #1 found and fixed**: the original merge logic checked a trade's implied
   book state *before* applying any depth record sharing that exact timestamp — making
   every comparison look one update stale. Fixed to apply-then-check. **Result: mismatch
   rate got WORSE (22.5%), with mismatches now going both directions instead of one** —
   ruled out this being the (or the only) real cause.
2. **Investigated whether it was clock-skew** between the two independently-logged
   files by searching for when the book had *actually* shown the expected bid/ask.
   Found it 4 hours earlier the previous evening — a coincidental revisit of the same
   price in a chopping market, not a timing lag. Ruled out.
3. **Real bug #2 found and fixed**: hand-traced one exact mismatch and found it lands
   right at a `COMMAND_CLEAR_BOOK` (a full ~10-minute snapshot resync, exactly as Sierra
   Chart's docs describe). The original `OrderBook.apply()` had no concept of batch
   atomicity — it exposed `best_bid()`/`best_ask()` mid-rebuild, meaning a check made
   during a snapshot refresh could see a half-rebuilt book (e.g. bids restored, no ask
   side yet). Fixed: buffer a `CLEAR_BOOK`→...→`FLAG_END_OF_BATCH` sequence and commit
   atomically. **Empirically confirmed the flag semantics are real** (all ordinary
   incremental records outside a rebuild carry `flags=1`/EOB=True by default — a real,
   non-obvious finding; only records *inside* an active `CLEAR_BOOK` rebuild show
   `flags=0` until a genuine terminator). **Result: literally zero change in the
   aggregate mismatch rate (still 22.5%)** — a real, correct fix, but not the cause of
   the observed failure, or at least not a large contributor to it.

**Status at pause: root cause NOT isolated.** Two real, verified bugs fixed; neither
explains the ~22% mismatch rate. Open, untested hypothesis for whoever resumes this:
check whether mismatches cluster specifically in the seconds immediately following each
snapshot-rebuild boundary (a narrower, more explainable problem — e.g. a subtlety in how
partial updates between two 10-minute snapshots interact with the batch logic) versus
being spread evenly across the whole session (which would point at something more
fundamental — a still-wrong field interpretation, a second undocumented sentinel value
analogous to the unbundled-trade case in `.scid`, or a real per-record ordering
guarantee this codebase is assuming that doesn't actually hold).

**RESEARCH_CLAIM `depth_absorption_replenishment_fraction_20260923` updated** to reflect
this real (if incomplete) Phase 1 attempt — no longer "not yet tested," now carries the
real mismatch-rate finding and the two fixes, still `PROVISIONAL` since root cause isn't
settled. Do not treat the original pre-registration text as current; read the claim's
latest state via `node scripts/record_claim.mjs --list`.

### DeepSeek code-review diagnosis, 2026-09-23 — read before touching this code again

Dispatched the actual current `depth_reader.py`/`reconstruct_and_validate.py` files (not
a summary) for independent review. Real findings, not just a validation of the
investigation above:

1. **The likely real bug, previously unfound**: `OrderBook.best_bid()`/`best_ask()` do
   `max(self.bids)`/`min(self.asks)` — this reads only the dictionary's PRICE KEYS,
   never checking the stored `(quantity, num_orders)` tuple. If the feed ever sends a
   `MODIFY_BID`/`MODIFY_ASK` down to `quantity=0` (rather than a formal `DELETE`), that
   now-empty price level stays in the dict and can still win as "best" — producing
   exactly a widened, wrong spread (bid too high, ask too low simultaneously). Confirmed
   present in the code as of this session. Cheap to test: filter `qty > 0` in both
   functions and re-run.
2. **My own tie-break "fix" (§8 item 1 above) is a real regression, correctly caught**:
   using `<=` folds the trade's OWN book-consuming update (its own `DELETE`/`MODIFY`)
   into the book BEFORE comparing it against `.scid`'s PRE-trade recorded bid/ask —
   guaranteeing a mismatch in a predictable, aggressor-dependent direction (sells make
   `recon_bid` read too low, buys make `recon_ask` read too high). Neither `<` nor `<=`
   is actually correct here — the two files have independent sub-tick sequencing with no
   timestamp comparison that can resolve "did this book update happen before or after
   this trade." The right response is validating only where ordering is unambiguous
   (see diagnostic #3 below), not picking an operator.
3. **A real methodology gap in my own validation, previously unnoticed**: the
   `TICK_SIZE=0.25` comparison tolerance means a genuine 1-tick offset PASSES — so the
   reported 10.96%/22.5% mismatch rates only count trades that are already **≥2 full
   ticks off**. A timing/ordering hiccup between two independently-logged real-time
   streams would only ever produce about 1 tick of noise. This means the tie-break issue
   was **never** the main driver of the *original* 10.96% either — there's a separate,
   larger book-state error that neither fix touched.
4. **The batch-atomicity fix's "zero change" result is expected, not evidence the fix
   was pointless**: the merge loop already applies every same-timestamp record before
   checking (via `<=`), so a whole snapshot batch sharing one timestamp is always fully
   applied regardless of atomicity — atomicity only matters for a trade landing in the
   sub-millisecond gap between a batch's first and last record, a narrow case. Separately
   flagged a real inconsistency in the investigation narrative worth resolving: it
   describes snapshot records as "all at the same timestamp" while also describing a
   trade caught "mid-rebuild" — these can't both be true; print the real timestamps of
   one full snapshot batch to resolve which is actually happening.
5. **Ruled out, confirmed against Sierra Chart's own docs fetched fresh**: struct
   layouts, command enum values, the `FLAG_END_OF_BATCH` bit, and the `.scid`
   `High`=ask/`Low`=bid convention are all correct as implemented. `High`/`Low` are
   confirmed to mean the inside market AT TRADE TIME (top-of-book), not the trade's own
   execution price — so comparing against `best_bid()`/`best_ask()` is conceptually the
   right comparison, not a semantic mismatch. No second undocumented sentinel analogous
   to `.scid`'s unbundled-trade case exists in the depth format per the docs — the one
   loose end is `NO_COMMAND=0` records, silently treated as a no-op with no counter --
   worth auditing their frequency rather than assuming they're harmless.

**Concrete next diagnostics, in order of cost (cheapest/highest-information first) — not
yet run**:
1. Signed-offset histogram (`recon − recorded`, in ticks), cross-tabbed by aggressor
   side (buy/sell, from the `.scid` record's own `bidvol`/`askvol`). This one chart
   separates all 3 live hypotheses: sells-push-bid-low/buys-push-ask-high = the `<=`
   self-consumption bug; both sides shift the SAME direction = feed lag; bid-high-AND-
   ask-low simultaneously = zero-quantity staleness (bug #1). Also record the magnitude
   distribution (±1, ±2, ... ticks) — "exactly 2 ticks" and "5-50 ticks" are different
   diseases.
2. **Zero-quantity probe**: count `MODIFY`/`ADD` records with `quantity==0`, then re-run
   validation with a `qty > 0` filter in `best_bid`/`best_ask`. Three lines, directly
   confirms or kills bug #1.
3. **Quiet-moment sanity check**: pick trades that are ≥1s after the last depth update
   AND ≥1s before the next, in a flat market. If those match cleanly, parsing/scale/
   semantics are all fine and the whole problem is timing/ordering. If they don't match
   either, stop looking at the merge logic entirely — something more basic is wrong.
4. Bucket the mismatch rate by time-since-last-snapshot (0-1s / 1-10s / 10s-10min) —
   distinguishes "clusters right after a rebuild" from "spread evenly across the
   session."
5. **Crossed-book probe**: flag any instant where `best_bid() >= best_ask()`, or a
   single price appearing on both sides — a real state bug, not a timing artifact, and
   would independently explain persistent ≥2-tick errors.
6. Only after the histogram buckets the failure: re-trace the original
   `2026-09-22T00:00:00.027` example against the CURRENT (post-fix) code — this was
   never actually re-checked; only the aggregate rate was re-measured.

### Diagnostics run + fixes applied, 2026-09-23 continued — real progress, still failing

1. **Zero-quantity fix applied** (`_apply_to`/`best_bid`/`best_ask` now treat a MODIFY
   down to `quantity==0` as a removal, and defensively filter any stray zero-qty key).
   **Result: no change to the aggregate rate (still 22.5%)** — confirms this bug class
   wasn't the dominant driver in this dataset, though the fix is real and correct to keep.
2. **Signed-offset-by-aggressor-side histogram run — decisive, matches DeepSeek's
   predicted signature exactly.** On SELL trades, `recon_bid` reads a median of -1 tick
   vs. recorded (74.8% negative, only 6.5% positive). On BUY trades, `recon_ask` reads a
   median of +1 tick vs. recorded (78.3% positive, only 1% negative). This is precisely
   the self-consumption pattern DeepSeek predicted: the trade's own book-depleting update
   was being folded in before comparison.
3. **Fixed the tie-break per DeepSeek's recommended default** (strict `<`, excluding any
   depth record at the exact same instant as the trade, rather than `<=`). **Result: real
   improvement, mismatch rate dropped from 22.5% to 15.85%.** The aggressor-dependent
   directional bias in the offset histogram is now much smaller (BUY/SELL `pct_zero` rose
   to 0.59-0.69 from 0.19-0.56) — confirms the self-consumption bug was real and this
   fix genuinely addressed it.
4. **Still failing badly**: 15.85% is nowhere near the 1% kill threshold, and is actually
   worse than the very first, wholly-unfixed run's 10.96% — meaning something in the
   zero-qty or batch-atomicity changes may have a side effect not yet understood, OR the
   very first run's ordering was coincidentally closer to correct for reasons not yet
   isolated. **Not resolved.** The offset histograms still show a heavy right tail (means
   of 8-10 ticks despite medians at/near 0) — a separate, larger-magnitude error
   mechanism is still present and not yet isolated, matching DeepSeek's own flagged
   distinction between "±1-2 tick" and "5-50 tick" failure modes being different diseases.
   **PAUSED here at user's direction** — next session should look at the magnitude
   distribution directly (not just direction) to isolate whether a distinct subpopulation
   of trades carries most of the remaining error, before further guessing at fixes.

## 9. Final diagnostic and PARK, 2026-09-24 (Opus Audit #14 §4.2)

Per the audit's recommendation (park Track C; if the user wants closure rather than a
dangling thread, run exactly one bounded ≤2h diagnostic first), two checks were run
against the same 2026-09-22 / NQZ6.CME validation day, both read-only, no fixes attempted:

1. **Contract identity (the audit's own suggested cheap hypothesis) — ruled out
   structurally, not just checked.** `reconstruct_and_validate.py`'s `validate_day(contract,
   date_str)` builds BOTH the `.scid` path and the `.depth` path from one shared `contract`
   string argument — a front-month/back-month mismatch between the two files is impossible
   by construction, not merely unlikely. Independently confirmed 2026-09-22 sits outside
   the Sept-2026 NQ roll week (`nq_roll_week_dates()`: 2026-09-10 to 2026-09-14), and both
   `NQZ6.CME.scid` (150MB) and `NQZ6.CME.2026-09-22.depth` (493MB) are large, real files.
2. **The quiet-moment check (the audit's actual primary diagnostic) — run via the new
   `scripts/depth_absorption/quiet_moment_diagnostic.py`.** Splits the exact same
   reconstruction/comparison logic by whether a trade landed in a QUIET moment (≥1s since
   the last depth update on both sides) or a BUSY one. Result is more specific than either
   outcome the audit predicted: **QUIET trades mismatch 99.89% of the time (n=16,729) —
   essentially total failure — while BUSY trades mismatch only 10.94% of the time
   (n=286,530)** — a working reconstruction most of the time. This rules out a fundamental
   parsing/scaling/semantics bug (that would fail everywhere) AND rules out the
   previously-assumed "residual cross-stream ordering ambiguity" explanation (which would
   predict busy moments to be WORSE, not better, since races get more likely as update
   frequency rises). The real, now-localized defect is `OrderBook` losing correct state
   across an update gap ≥1s — most likely staleness/expiration (an old resting price
   surviving past when it should have been cleared or superseded), not sub-tick ordering.

**PARKED**, per the audit's §4.1 reasoning (even a perfect reconstruction is offline-only
today with no live `.depth` reader; the depth-derived priors already tested elsewhere in
this codebase are weak-to-negative; this adds feature dimensions, not independent trading
days, which is the actual bottleneck per §1). Full result: `RESEARCH_CLAIM
depth_absorption_replenishment_fraction_20260923`. `OPEN_DECISION
depth_absorption_park_or_one_diagnostic_20260924` is RESOLVED. If this is ever resumed, the
specific, falsifiable lead is: look at `OrderBook`'s handling of a ≥1s gap with no incoming
depth records, not general parsing.

## 7. Priority note

Does not need to wait for the tick pilot's result (different data axis — see §1). Does
benefit from reusing the tick pilot's plumbing lessons first (the canonical reader
pattern, the memory-safe streaming rewrite) since a `.depth` reader will likely hit
analogous bugs on 267.5GB of raw files. `SUPPRESS_MAX_EV` (a measured, real dollar leak)
remains the top overall priority in this codebase regardless of how either pilot goes.
