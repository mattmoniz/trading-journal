# Tick-Microstructure ML Pilot — Spec & Build Log

**Status: IN PROGRESS, 2026-09-24.** Phase 1 (hand-feature baseline, no neural encoder)
carries a real, statistically significant result as of today: logistic regression on
direction-signed tick features cleared a 200-permutation day-block null at p=0.025 (Opus
Audit #14 Step 1, see `docs/OPEN_THREADS.md`'s 2026-09-24 entry for the full comparison
matrix, including the equally important finding that a much cheaper bar-level-only
feature set does almost exactly as well — AUC 0.5481 vs 0.5480). The canonical model is
now FROZEN (`scripts/tick_microstructure/artifacts/`) and the daily recheck script no
longer treats its own sliding-window retrain as evidence — see
`recheck_tick_trend_fade_finding.mjs`'s own header. Still PROVISIONAL, not CONFIRMED: real
prospective evidence only accumulates from here (`>=20` new distinct days needed before
the frozen model's score means anything). This doc exists so the thread survives a context
reset — read this before re-deriving anything below, and update it as the pilot
progresses rather than letting it go stale (per this codebase's own standing
documentation-maintenance rule).

## 1. Origin and goal

User's own motivating example (2026-09-23): "this morning we had a solid 30 minutes of
stopouts in all trades" — the goal is not abstract pattern-hunting, it's a concrete,
checkable question: can ML detect a genuinely bad stretch (choppy, two-sided, no
follow-through) in something close to real time, distinct from a genuine directional
move, using data the existing ~180-setup hand-built roster has never looked at (real
trade-tick order flow)?

Broader framing (session-long back-and-forth, see chat history for the full reasoning):
Track A (`scripts/ml_meta_labeling/`, already live) is an *exploitation* application — it
filters trades from a hypothesis space a human already wrote down. It can subtract bad
trades from existing setups; it cannot discover new structure. This pilot is the
*discovery* half DeepSeek's design review (`scratch/deepseek_response.md`, 2026-09-23,
"fresh eyes" section) said neither Track A nor an earlier bar-level design actually
represented.

## 2. Real data inventory (verified by directly parsing files + fetching real Sierra
## Chart docs, not assumed)

- `.scid` files (`/mnt/c/SierraChart/Data/`): genuine per-trade tick data. NQ (full-size)
  alone: 26.9GB, ~671M records across 20 quarterly contract files back to Nov 2024.
- Record format confirmed via Sierra Chart's own docs, not guessed: 40-byte records, a
  variable-size header (read the real `header_size` field, don't assume 56 bytes), one
  logical trade per record (`Open==0.0`) or a merged pair for large "unbundled" trades
  (`Open` holds one of two documented sentinel values).
- **A real, silently-wrong scaling bug found and fixed 2026-09-23**: raw `.scid` prices
  are NQ points × 100, not points directly — confirmed empirically against
  `price_bars_primary`'s own bar at the identical timestamp (2915775.0 raw vs 29157.75
  real, an exact 100× match). Baked into `scid_reader.py` as `SCID_PRICE_SCALE`.
- Order-book depth data (267.5GB, `.depth` files) is a SEPARATE archive (now backed up
  per `OPEN_DECISION preserve_sierra_chart_depth_archive_irreplaceable`) — this pilot
  does NOT use it. Per DeepSeek's review: "depth" is aspirational language to avoid here;
  this pilot can only ever learn an order-FLOW microstructure representation from trade
  prints, not a depth/liquidity representation.

## 3. Architecture — `scripts/tick_microstructure/`

| File | Role |
|---|---|
| `scid_reader.py` | Canonical `.scid` parser — extracted from 2 pre-existing hand-copies (`backtest_mnq_structural_trailing.py`, `backtest_poc_realtick_convergence_pilot.py`), neither of which correctly handled the unbundled-trade sentinel. Single source of truth now. |
| `roll_calendar.py` | NQ quarterly roll-week dates — a verified Python copy of `server/services/acdShared.js`'s `getNqRollWeekDates()` (can't import cross-language; matches this codebase's existing precedent for this exact constraint, see the file's own header). |
| `atr.py` | ATR20 lookup — reuses `server/services/levelProximityService.js`'s exact existing definition (trailing 20-session RTH range average), verified byte-identical against the live JS query. NOT a different/invented ATR. |
| `multiday_stream.py` | Stitches individual contract files into one continuous trade stream using `price_bars_contract_calendar` (this codebase's own authoritative day→contract mapping) and excludes roll weeks. |
| `bucketize.py` | Event-triggered (volume-based) bucketing — empirically chosen over fixed-time buckets (see §4). |
| `features.py` | Hand-engineered, trailing-only, multi-timeframe features (see §4). |
| `survival_target.py` | "Time until the next ±K×ATR20 move" — memory-bounded streaming version (see §4) plus a small-scale list-based version for ad hoc single-day checks. |
| `build_dataset.py` | The end-to-end driver — real trades → buckets → features → survival targets → CSV. |

## 4. Real corrections made this session, in order (read before re-deriving any of these)

1. **Grain**: fixed-time buckets tested and rejected — on a real trading day, a 10-second
   bucket ranged from 1 to 3,533 trades, meaning the order-flow-imbalance feature was
   being computed over wildly non-comparable amounts of real activity. Volume=100 tested
   against 500/1,000 and won empirically — 500/1,000 mostly degenerated into noisy
   ~60-second time-capped buckets (56-83% of the time) rather than real volume bars;
   100 actually hit its own volume target 90%+ of the time across 3 different real days
   (a quiet day, a documented high-volatility flush day, and an ordinary recent day) —
   with one honest caveat: on a genuinely thin day (2026-09-15, 69k trades vs. ~400-420k
   on the other two test days), volume=100 degrades toward a time-capped bucket ~60% of
   the time. Not treated as disqualifying — `elapsed_seconds` is carried as an explicit
   feature specifically to capture this pace information either way.
2. **Memory — the OOM incident.** The original `build_dataset.py` materialized full
   Python lists at every stage (`list(stream_trades(...))`, `list(bucketize(...))`, a
   list-returning `compute_features()`) and crashed the host WSL VM (6.2GB total RAM)
   attempting a real 6-month run — confirmed via the kernel log (`dmesg -T` showed a
   genuine unclean-shutdown/reboot signature, not just a killed process). **Fixed by
   rewriting the entire pipeline as chained generators** — `compute_features()` now
   yields one row at a time; `stream_survival_targets()` (new) only ever holds
   `max_horizon_hours` worth of buckets "in flight" (bounded, ~2 trading days' worth, not
   the dataset), resolving and discarding each row as its outcome becomes known. Verified
   directly: a 9-day test run held steady at 65-71MB peak RSS regardless of how long it
   ran, versus the unbounded growth that crashed the VM before. **Rule going forward for
   this module: never materialize a full multi-day list anywhere in this pipeline again**
   — chain generators end to end, always.
3. **Multi-timeframe features.** User's own catch: the feature set was multifaceted
   (several different signal types — order-flow imbalance, price impact, arrival pace,
   realized volatility, run persistence) but every one of them was computed at only ONE
   lookback window (20 buckets) — no way to compare a short-term read against a longer
   backdrop. Fixed: `trailing_ofi_mean`/`trailing_elapsed_mean`/`realized_micro_vol` are
   now each computed at short/medium/long windows (20/100/500 buckets), using an O(1)
   rolling-sum per scale (not a naive re-sum per bucket, which would be too slow at the
   500-bucket scale). Verified the three scales produce genuinely different values on
   real data before trusting it (e.g. order-flow reading -0.09/+0.05/+0.01 at
   short/medium/long on the same row — a real divergence, not a bug).

## 5. Making this a system, not a one-off — the 4 items, in full

Per this codebase's own standing "no dead ends" discipline (CLAUDE.md's four-part
checklist: persisted queryably, has a recheck path, wired to a real consumer or
explicitly flagged if not, discoverable) — applied here explicitly rather than assumed.

### 5a. Recheck / recalibration cadence

**Not yet built. Real plan, not yet scheduled anywhere.** Once Phase 1 (this dataset +
the downstream survival model + validation harness) produces a result worth keeping —
positive OR a clean, well-audited negative — this needs to re-run periodically as real
new trading days accumulate, the same way `backtest_setup_status.mjs` reruns weekly and
`run_daily_calibration.sh` reruns nightly. Concretely: add `build_dataset.py` (with a
rolling window, e.g. always "the last 6 months as of today") plus the downstream
model-retrain step to `run_weekly_backtests.sh`, NOT `run_daily_calibration.sh` — this is
a research/discovery pipeline reading raw tick files (slow, ~20-30 min), not a cheap
same-day recalibration; daily cadence isn't warranted unless a specific live-facing signal
comes out of it later. Genuinely not done yet — flag as `OPEN_DECISION` once Phase 1 has
a real result, not before (premature to schedule a rebuild of something not yet proven
worth rebuilding).

### 5b. Discoverability — where a future session finds this

This doc is the first piece. Still needed once Phase 1 completes:
- An entry in `ARCHITECTURE.md`'s services/scripts inventory (this pilot doesn't have one
  yet — add when the downstream model exists, matching how other Python research threads
  like `ml_meta_labeling/` are documented there).
- An entry in `CLAUDE.md`'s "Where to look" section, matching every other real research
  thread in this codebase (see how `ml_meta_labeling`, `volatilityRegime`, and dozens of
  others are indexed there) — without this, a future session has to grep and hope, which
  is the exact anti-pattern CLAUDE.md's own maintenance section calls out.
- A `docs/OPEN_THREADS.md` entry for the current in-progress state (added same session,
  see that file's own 2026-09-23 entry) so this doesn't get lost across a context reset
  before Phase 1 finishes.

### 5c. A real consumer

The dataset alone is not useful — per this codebase's own convention, a signal nobody
reads is a dead end whether or not it's persisted. Planned consumer chain, none of which
is built yet:
1. **The downstream survival model** (LightGBM, matching Track A's own tooling — not a
   neural network; DeepSeek's review explicitly recommended proving the hand-feature
   baseline first) + the full validation harness (day-blocked splits with an embargo ≥ the
   survival horizon + lookback, a day-block permutation null — NOT a naive bar-shuffle
   null, per DeepSeek's correction — and effective-N reporting using real event counts,
   not row counts).
2. **A concrete, real sanity check before trusting anything it finds**: does it flag
   conditions resembling this morning's real 30-minute stopout stretch? A real example to
   check against, not just an abstract statistical pass/fail.
3. **If it survives**, the honest next step is NOT a new live setup_type — it's an
   informational-only gauge first (matching the existing Pulse reading / volatility
   regime card convention: display before trust), and only a specific, human-nameable
   condition extracted from the model's feature importance would ever go through the
   standard new-setup-type checklist (Phase 0 pretest → real stop/target bar-by-bar
   simulation → placebo test if the geometry is asymmetric → SHADOW-only → N≥20) before
   any real-dollar simulation, let alone gating/sizing a live trade.

### 5d. Recorded claim

**Not yet recorded — genuinely too early.** `scripts/record_claim.mjs`'s `recordClaim()`
is this codebase's standing mechanism for tracking a tested finding (positive OR
negative) so it can't be silently lost or re-litigated from scratch later. This pilot has
not yet produced a testable claim — Phase 1's dataset build is still running. Once the
downstream model + validation harness produce a real result, it gets recorded properly
(a real slug, `sourceFile`/`sourceDate`, sample size, and — if applicable — win-rate/EV
figures) rather than left as a private conclusion in this doc or a chat transcript. This
item is the actual gate before anything here is treated as "found," not a formality to
skip.

## 6. Why a CSV file and not a Postgres table (asked directly, worth answering precisely)

Three real reasons, not just convention:

1. **This is training data for a model, not live operational state.** The standard
   access pattern for training a model is "load the whole feature matrix into memory as
   arrays" — which is exactly what `pandas.read_csv()`/`read_parquet()` do in one call.
   Going through Postgres for this would mean a `SELECT *` over the same rows anyway,
   adding DB round-trip overhead and competing for connections with the live polling
   system for zero benefit — this codebase already has a standing concern about exactly
   that kind of self-inflicted DB pressure (see the request-coalescing-lock convention).
2. **The true source of truth is already durable and reproducible without Postgres.**
   The raw `.scid` tick files (backed up), `price_bars_contract_calendar`, and
   `price_bars_primary`'s ATR20 all already live durably. This CSV is a regenerable
   cache of a deterministic computation over that real source data, not irreplaceable
   data itself — closer to a materialized view than a table of record.
3. **Precedent**: this matches how every other backtest/research script in this codebase
   already works — `scripts/backtest_*.mjs`/`.py` scripts write intermediate results to
   `scratch/*.json`/`.csv`, not new ad hoc DB tables, precisely because they're
   exploratory. `ml_meta_labeling/`'s Track A is a partial exception (it queries Postgres
   directly for its feature source) — but that's because ITS underlying feature columns
   already live durably in `active_setups`/`performance_audit` as real operational data;
   there's no equivalent existing Postgres table for raw tick-derived features, so
   building one would mean creating new operational-looking infrastructure for what is
   currently a one-off research pass.

**Real caveat, not a permanent decision**: per §5a/5d above, once a real finding survives
validation and this becomes a recurring, actively-relied-upon pipeline (matching the
"build/grow" goal), it may be worth persisting the computed dataset (or a joinable
summary of it) into a real Postgres table so it can be queried alongside
`active_setups`/`performance_audit` rather than staying a standalone file. Flagged
honestly as a future reconsideration, not ruled out.

## 7. Current status

**Phase 1 dataset build COMPLETE, 2026-09-23** — `scratch/tick_microstructure_dataset_6mo.csv`,
696,159 rows across 150 distinct real trading days. Peak RSS held flat at 82MB for the
entire ~49.5-minute run (confirms the streaming rewrite in §4 item 2 holds at real scale,
not just in the small test slices). Event rates: K=0.25 → 97.4%, K=0.5 → 89.7%,
K=1.0 → 63.2% (440,152 real events, 230,698 UP / 209,454 DOWN — a genuinely mixed
direction split across 150 days, unlike the single-day smoke test which was 100% DOWN).

**Downstream model built and run, 2026-09-23 — CLEAN NEGATIVE.**
`scripts/tick_microstructure/train_survival_model.py`: LightGBM classifier, 15
hand-engineered features (multi-timeframe order-flow imbalance/price-impact/arrival-pace/
realized-vol/run-length), target = real ≥1.0×ATR20 move within 48h (K=1.0 chosen for its
balanced ~63/37 real event rate — K=0.25/0.5 were too close to always-true to classify
meaningfully). Day-blocked split (102 train / 19 val / 20 test days, 3-day embargo at
each boundary per the survival horizon + longest feature lookback). **Real held-out test
AUC = 0.4563 — below random.** Day-block permutation null (30 permutations, shuffling
day-level label blocks, not rows) confirms this isn't noise-shaped luck: null mean=0.4977,
90% of random permutations scored better than the real model. Recorded:
`RESEARCH_CLAIM tick_microstructure_survival_model_k1_negative_20260923`.

**What this does and doesn't close**: this specific test (predict a big directional move
48h out, from these 15 features) shows no real signal. Root cause, per DeepSeek's
independent review (2026-09-23, dispatched with the real dataset description, not a
hypothetical): the survival target only records the FIRST ±K×ATR20 crossing — a violent
whipsaw that touches +1×ATR then reverses hard is recorded identically to a clean
sustained trend. The target is structurally blind to path quality (chop vs. trend) by
construction; no relabeling could have recovered this, the target itself needed to
change. Also: 48h is a slow, macro-driven horizon for a ~30-minute phenomenon — a
plausible independent reason the 15 intraday features couldn't lead it.

**Real-data correction, 2026-09-23, before building the next version**: checked DeepSeek's
proposed "chop" framing against the actual motivating example (18 real setups stopped out
2026-09-23 9:30-9:52am ET) before building toward it. Real finding: this was NOT chop —
efficiency ratio (net move ÷ gross bucket-to-bucket path) during that window was 0.116,
HIGHER (more directional/efficient) than a same-day quiet overnight contrast window
(0.053). All 18 stopped-out setups were LONG FADES — the real mechanism was a clean,
moderate (~150pt/22min) trending move that ran through every counter-trend level in its
path, not a whipsaw that stopped everyone out going nowhere. Building a pure chop
detector would have missed this exact example. Corrected plan below reflects this.

**Corrected next build (in progress)**: user explicitly chose the trend-detection framing
over pure chop detection, given the real example above was trend-shaped, not chop-shaped
— "is a real trend building that's going to run through the fade roster," not "is this
choppy." Also explicit: real ML training target, not another informational display/badge
(skips DeepSeek's suggested "ship as an informational gauge first" middle step).

New features being added, prioritizing trend/directional-strength (efficiency ratio is
the primary signal; OFI sign-flip kept as a cheap complementary contrast feature since
the infrastructure is shared): efficiency ratio (net move ÷ gross bucket-to-bucket path,
high = trending, low = chop) at short/medium/long windows, OFI magnitude (mean |OFI|,
doesn't cancel to ~0 the way signed mean does), and explicit cross-scale divergence
(short minus long, for OFI/vol/pace — "is the recent trend diverging from the backdrop").

Real ML label: join real `active_setups` FADE-type fires (`setup_type LIKE '%_FADE_%'`,
`resolution IN ('STOP_HIT','TARGET_HIT')`, `origin_status IN ('ACTIVE','SHADOW')`,
`is_cluster_primary` filter per the standing hard rule) to the tick dataset's nearest
bucket at/before `fired_at`, then train a classifier predicting STOP_HIT vs. TARGET_HIT
from these trend/path-quality features at fire time — scoped to fade setups specifically
(matching the real mechanism: a trend running through counter-trend bets), a trade-level
classification (matching Track A's own shape), avoiding the circularity trap of training
on a label built from the same kind of data as the features.

**Chop-detection (option (a), efficiency ratio LOW rather than HIGH) explicitly NOT
dropped — user asked to note it for later, not abandon it.** The `efficiency_ratio_*`
feature being added now is signed the same way regardless (net÷gross, 0=chop, 1=trend),
so a future session can test the chop-side hypothesis (low-efficiency conditions
predicting something, e.g. informing NON-fade/breakout setups or a general "reduce size,
market isn't committing" read) on this exact same feature set without rebuilding
anything — just a different label/target, not different infrastructure.

### Result, 2026-09-23 — real reversal from negative, PROVISIONAL, not yet confirmed

Built `scripts/tick_microstructure/build_trade_level_dataset.py` (streams the tick
pipeline once, matches 2,285 real fade-fire timestamps to the nearest ready feature row
— caught and fixed a real bug along the way: `active_setups.fired_at` is a naive column
storing ET wall-clock digits directly, not UTC, matching this codebase's standing
naive-timestamp convention; an initial version wrongly treated it as UTC before this was
verified against a known real example) and `train_fade_outcome_model.py` (LightGBM,
predicting STOP_HIT vs TARGET_HIT from the 24 features above at fire time).

**Real held-out test AUC = 0.5368** (day-blocked, 43/8/10 train/val/test days, 1-day
embargo) — above random, and a real directional reversal from the earlier per-bucket
test: only 10% of 30 day-block-permuted nulls scored as good or better (vs. 90% for the
earlier negative). **Top feature by gain: `efficiency_ratio_short`** — the trend-strength
signal the user chose to prioritize, validated by the real 2026-09-23 example (18 fade
setups stopped out by a clean trending move, not chop).

**NOT confirmed — two real caveats, not glossed over**: (1) the empirical p-value (0.10)
does not clear the conventional 0.05 significance bar; (2) the 353-trade test set is
heavily day-clustered — 77.6% of test trades come from just 5 of 10 distinct days, a real
risk flagged by this codebase's own standing day-clustering discipline that a handful of
unusual days could be driving the result rather than a stable, generalizable pattern.
Recorded honestly as PROVISIONAL:
`RESEARCH_CLAIM tick_trend_efficiency_fade_outcome_provisional_20260923`.

**Recheck mechanism, DONE 2026-09-23** (not a cloud-agent routine — a cloud sandbox has
no access to this machine's local Postgres DB or local tick files, so that path was
correctly ruled out before building anything): `scripts/recheck_tick_trend_fade_finding.mjs`
re-runs the real join + model — moved from weekly to **DAILY** same day per user request
(matching the precedent already set for the live trade meta-labeler's own walk-forward
recheck) — via `scripts/run_daily_calibration.sh`, against a genuinely sliding 183-day
window (fixed a real bug in `build_trade_level_dataset.py` along the way — its `END_DATE`
was a hardcoded literal date, which would have made every future re-run silently
reprocess the identical historical range forever), and updates the `RESEARCH_CLAIM`
either way. Deliberately never auto-promotes to `CONFIRMED` even if the numbers improve
— that's a human call. Also flagged as
`OPEN_DECISION tick_trend_efficiency_fade_outcome_recheck_pending_20260923` so it's
visible at the start of every session, not just after the `next_recheck_due` date.
Tested end-to-end before wiring in — confirmed the real fade-fire population already grew
from 2,285 to 2,312 in the hours since first building this, confirming real data
genuinely accumulates on its own.

**History/stability tracking, DONE 2026-09-23** — per user's own follow-up ("see how its
reliability/predictability work"), each daily recheck appends a NEW `performance_audit`
row (confirmed: the table's `ON CONFLICT` key includes `run_date`, not just the claim's
slug, so this genuinely accumulates history rather than overwriting the same row every
day). `scripts/report_tick_trend_fade_history.mjs` reads the full day-by-day history and
reports whether the AUC is stable over time (mean/std across all runs, and what fraction
of runs have dropped below random) — a single day's number clearing a bar means little on
its own; a finding that stays consistently above random across many real days is the
actual reliability signal, matching this codebase's own day-blocked-stability discipline
applied to the finding's own run history, not just its underlying trade population.
Tested against the one real run so far — correctly reports "need at least 2 runs to judge
stability" rather than drawing a conclusion from a single data point.

**UI chart added, 2026-09-23** — per user request ("track this more closely like on a
second modal chart"): `GET /api/setups/tick-trend-fade-history` (`server/routes/setups.js`,
reads the same `performance_audit` rows the CLI report script reads) + a new amber-accented
`#tick-trend-card` on `quick-check.html` (tap for a modal history chart, matching the
existing vol-regime-history modal's exact canvas/axis convention, with a dashed reference
line at 0.5 instead of 1.0 since that's this metric's own meaningful baseline). Shows
mean/std/percent-below-random across all recorded runs, not just the latest snapshot —
same "is it stable over time" question the CLI tool answers, in the UI. Verified live via
Playwright (zero console errors, card + modal + chart all render with real data) and
through the Cloudflare tunnel (confirmed the new endpoint was added to
`~/.cloudflared/config.yml` and the service restarted — a 404 there would have meant the
card silently fails on the phone/tunnel view while looking fine on localhost, a
recurring mistake this codebase has made before).

**What's still a human decision, not automated**: once a future weekly recheck shows
p<0.05 AND the day-clustering concentration has genuinely dropped (not just more trades
from the same clustered days), a person needs to review and decide whether to promote
this to `CONFIRMED` and consider it for the fade roster via the standard new-setup-type
promotion checklist (informational-first, per this codebase's own convention) — still
informational-research-stage today, not wired to anything live.

**Sibling thread, Phase 0 done**: the depth-absorption pilot (separate archive, separate
data axis per DeepSeek's analysis — see [docs/DEPTH_ABSORPTION_PILOT_SPEC.md](DEPTH_ABSORPTION_PILOT_SPEC.md))
has its own, independent application of this same 4-item discipline. Its pre-registration
(§5d equivalent) is already recorded (`RESEARCH_CLAIM depth_absorption_replenishment_fraction_20260923`,
PROVISIONAL, not yet tested) — done FIRST for that thread, deliberately reversed from this
one's order, since DeepSeek's Phase 0 requires pre-registering before touching any data,
not after a result exists.
