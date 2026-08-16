# Runner / Trailing-Stop Optimization — Notes (2026-08-14, saved not built; section 0 corrected 2026-08-16)

**Status: SAVED FOR REVIEW, NOT ACTED ON.** Per explicit user instruction ("lets review
before doing a backtest... Save it dont just do it. Need to clear context before we
proceed") — nothing here has been run against live data, no code has been wired in, and
none of it should be started until the user explicitly says go. This doc exists so the
Gemini/DeepSeek work already done isn't lost across a context clear (the source files are
in `scratch/`, which gets overwritten by the next unrelated dispatch — see the incident
note at the bottom).

## What this is

The user has been working with Gemini and DeepSeek (outside a tracked Claude Code session)
on a **structural swing-anchor trailing-stop system** — letting winning trades run further
than a fixed target by trailing the stop behind recent market structure (higher-lows in an
uptrend) instead of exiting at a fixed T1.

## 0. A REAL backtest already ran — 734 trades, 2025-08-01 to 2026-08-14 — but it has two
   confirmed problems and its headline number is not trustworthy as-is

**Added 2026-08-16, after the user pointed out this thread had more to it than the
prototype code below.** Separate from (and predating) the Gemini/DeepSeek optimizer
prototypes in sections 1-3, there's an already-executed backtest:

- **`docs/backtest_mnq_20260814.py`** (permanent copy of `scratch/backtest_mnq.py`) — reads
  raw Sierra Chart tick data directly from `/mnt/c/SierraChart/Data/NQ[HMUZ]\d.CME.scid`
  (NQ contract files, not MNQ — a deliberate and reasonable choice given this codebase's own
  established convention that NQ/MNQ share identical price action and only differ by dollar
  multiplier, confirmed elsewhere in CLAUDE.md: "their per-contract P&L runs ~9.2x MNQ's...
  matching the real $20-vs-$2 ratio almost exactly"). Applies `CONTRACT_MULTIPLIER = 2`
  (MNQ's correct $/pt) to that NQ price action. Runs its own, completely from-scratch entry
  signal (volume/delta-based reversal: `b_vol > 1500` + large opposing delta, or high
  avg-trade-size + delta, near a known level from `levels_1yr.json`) and a "2-bar structural
  trailing stop" (exit when the current bar's close breaks the low/high of 2 bars back) —
  **this is NOT this app's real setup-detection logic**, it's an independent, ad-hoc signal
  built just for this test.
- **`docs/dump_levels_20260814.mjs`** (permanent copy) generates `levels_1yr.json` by
  reading every row from the real `level_prices` table for `trade_date >= '2025-08-01'`.
- **`docs/mnq_trades_log_trailing_20260814.csv`** (permanent copy, 734 rows) is the output:
  `Date,Entry_Time,Exit_Time,Direction,Level_Name,Level_Price,Entry_Price,Exit_Price,Result,PnL`.
  Raw aggregate: **N=734, sum=$500.50, avg=+$0.68/trade**, 722 `STRUCTURAL_TRAILING_EXIT` /
  12 `STOP_LOSS`.
- **`docs/summarize_csv_20260814.py`** (permanent copy) computes losing-day streaks and a
  weekly breakdown from the same CSV — no new numbers, same underlying data.

### Two confirmed problems, both independently verified by reading the actual code

1. **Lookahead bias on same-day-forming levels.** `dump_levels.mjs` dumps every level for
   every date as one flat per-date list, with zero regard for *when during the day* each
   level actually became knowable. `backtest_mnq.py` only guards the first 5 minutes
   (`if est_dt.hour == 9 and 30 <= est_dt.minute < 35: pass # Filter first 5 mins`) — but
   `levels_1yr.json`'s level set includes `OR10_HIGH/LOW/MID`, `OR15_HIGH/LOW/MID`,
   `OR30_HIGH/LOW/MID`, and `IB_HIGH/LOW/MID`, none of which get an equivalent guard. A
   trade at 9:40 AM testing proximity to `OR30_HIGH` is matching against the *actual,
   completed* 30-minute range — a level that wouldn't be knowable in real time until 10:00
   AM. This is exactly the risk CLAUDE.md's own hard rule names directly: "Same-day-forming
   levels (Opening Range, Initial Balance) need their own formation gate or a re-test
   introduces lookahead." Confirmed present here, not just theoretical — `dump_levels.mjs`
   has no time-of-day awareness at all, only `trade_date`.
2. **No commission subtracted, anywhere.** Neither `backtest_mnq.py` nor `summarize_csv.py`
   subtracts MNQ's $2 round-trip commission from any trade — every `profit = pts_gained *
   CONTRACT_MULTIPLIER * CONTRACTS` line is gross. At N=734 and $2/trade, that's -$1,468 not
   accounted for. **Net of commission, the real result is roughly -$1.32/trade — negative,
   not the breakeven-ish +$0.68 the raw CSV shows.**

### Also worth knowing, lower severity

- Every threshold in the entry signal and exit logic is a hardcoded static constant
  (`STOP_LOSS_PTS=60`, `PROXIMITY_THRESHOLD=15`, `MAX_TRADES_PER_DAY=3`, `b_vol>1500`,
  `b_delta<-200`/`>200`, `avg_size>1.2`, `b_delta<-150`/`>150`) — none derived from a rolling
  distribution, directly against this codebase's "no static thresholds, ever" rule. This
  matters more here than usual since these thresholds ARE the entry signal, not just a
  secondary filter.
- The entry signal's volume/delta inputs come from NQ's own order flow (the full-size
  contract's tick data), not MNQ's. Price parity between NQ and MNQ is well-established in
  this codebase, but order-flow/liquidity *character* between a full-size and micro contract
  isn't necessarily identical — worth a sanity check, not necessarily a real problem.
- No `origin_status`/synthetic-data concept, no N≥20 gating on the signal itself, no
  day-of-week or confluence handling — this is a from-scratch signal with none of this
  codebase's other established statistical guardrails, by design (it's a standalone
  exploration, not wired to anything live).
- The prop-account balance simulation at the bottom of `backtest_mnq.py` (DLL=-$400/day,
  trailing drawdown=$2,000, target=$53,000 from $50,000) hardcodes real external prop-firm
  rules — that's fine, those are genuinely fixed external constraints, not a trading
  threshold this codebase's no-static-thresholds rule is about.

### What this means for the runner-optimization thread overall

This backtest tests a genuinely different, simpler trailing mechanism (2-bar break, not the
zigzag/ATR versions in sections 1 below) against a from-scratch signal, not this app's real
setups — so even a clean, correctly-fixed version of this specific backtest wouldn't
directly validate "should we add a runner to our real live setups," only "does this
particular exit style help this particular toy signal." Still useful as a first read on
whether structural trailing exits have *any* legs at all before spending more effort — but
not close to sufficient to act on, and the two bugs above mean even that first read isn't
trustworthy yet. **Before this number means anything: fix the lookahead gate (add real
formation-time gating for OR10/15/30/IB, matching how `detectLevelFades()` already handles
this correctly elsewhere in this codebase) and subtract commission, then re-run.**

### CORRECTED RE-RUN (2026-08-16) — both bugs fixed, result is a real, stable negative

Fixed in `scripts/backtest_mnq_structural_trailing.py` (permanent, not scratch): (a) added
a per-level `LEVEL_FORMATION_ET_MIN` gate for `OR10/15/30_HIGH/LOW/MID` and `IB_HIGH/LOW/MID`
(575/580/585/600/630 ET-minute-of-day respectively), matching `scripts/backtest_unified.js`'s
existing `FORMATION_GATE_ET_MIN` convention exactly rather than inventing a new one; (b)
along the way, found and fixed a real *third* bug while building the fix for (a) — the
original script's `est_dt = dt - timedelta(hours=4)` assumed a flat UTC-4 offset, but Sierra
Chart's own docs (`sierrachart.com/index.php?page=doc/SCDateTime.html`, confirmed via
WebSearch, not guessed — per this codebase's standing "don't guess on Sierra Chart specifics"
rule) state `.scid` timestamps are always UTC. UTC-4 is only correct during EDT; this
backtest's date range (2025-08-01 to 2026-08-14) spans EST months too, during which the old
filter silently didn't fire at all. Replaced with real `zoneinfo`-based ET conversion
(DST-correct automatically). (c) Subtracted MNQ's real $2 round-trip commission
(`server/config/instruments.js` `LIVE_INSTRUMENT.commissionPerRoundTrip`, confirmed against
the live constant, not copied blind) on every closed trade.

**Result: N=734 (same count, different trade sequence — see below), avg=-$1.54/trade,
WR=31.5%, sum=-$1,128.00.** Negative in both chronological halves (1st -$0.91/trade, 2nd
-$2.17/trade) across 249 distinct trading days (not day-clustered) — a stable, decisive
negative, not noise. Recorded via `recordClaim()` (read back and confirmed):
`RESEARCH_CLAIM mnq_structural_trailing_2bar_toy_signal_negative`, status `CONFIRMED`.

This is materially *worse* than the doc's own original back-of-envelope estimate of
"~-$1.32/trade if you just subtract commission" — confirming some of the original +$0.68
gross headline came specifically from the lookahead bug, not just from ignoring commission.
Trade count stayed exactly 734 by coincidence, not because the formation gate had no effect:
diffing the two trade logs shows every single trade differs (entries near a not-yet-formed
level were removed — e.g. an `OR5_MID` entry at 9:26 AM ET, before market open, in the
original — and other valid entries that were previously blocked by `in_trade`/
`MAX_TRADES_PER_DAY` filled the same daily slots instead, a normal consequence of fixing a
lookahead bug in a sequential state-machine sim).

**Per the standing "report a solid negative honestly" convention: this is a real negative.**
The 2-bar structural trailing exit, tested against this specific from-scratch volume/delta
signal, loses money once measured correctly. As before, this doesn't invalidate the
zigzag/ATR optimizer prototypes in section 1 below (different exit mechanism, different
signal source, still schema-blocked) — but it does mean this particular already-run
backtest is now a closed, honest negative rather than an open, unverified "maybe +$0.68"
lead. Output: `scratch/mnq_trades_log_trailing_fixed.csv` (734 rows, same schema as the
original CSV).

## 1. Gemini's build: `docs/structural_runner_optimization_20260814.py`

(Permanent copy — the original `scratch/structural_runner_optimization.py` is fragile, see
the process note at the bottom of this doc. Copy this out to `scripts/` and rename once it's
actually adapted to the real schema and ready to run.)

A Python prototype (223 lines) implementing:
- **`compute_structural_stop_anchors()`** — a causal (no-lookahead), non-parametric zigzag
  that tracks the current trend (up/down) and returns the confirmed swing-low (in an
  uptrend) as of each bar, given a `pivot_threshold` (% move needed to flip trend
  direction).
- **`simulate_structural_trade()`** — bar-by-bar trade simulation: starts at a fixed initial
  stop (`entry - r0`), stays flat until price reaches `activation_r` (a multiple of initial
  risk), then trails the stop to `structural_low - tick_offset`, ratcheting only upward,
  never loosening.
- **`StructuralObjectiveWrapper` + `optimize_structural_system()`** — a `scipy`
  differential-evolution optimizer that searches `pivot_threshold` (0.003–0.06),
  `tick_offset` (as % of r0, 0.005–0.25), and `activation_r` (1.2–3.0×) to maximize a
  utility function: mean return + 0.35×mean-return-on-big-winners (mfe≥3R) − 1.5×(downside
  deviation below −0.5R + 0.30×tail CVaR at the 5th percentile).

**Known, explicitly-flagged blocker (Gemini's own caveat, confirmed real by inspection)**:
`fetch_trade_bars_from_db()` assumes flat columns (`trade_id`, `entry_time`, `entry_price`,
`r0`, `symbol`) directly on the `trades` table and a `price_bars_primary.bar_time` column.
This codebase's real schema doesn't work that way — trade metadata lives in
`custom_fields->'sierra_data'` JSONB (per `docs/ANTIGRAVITY_CONSTRAINTS.md` and this
session's own established convention), and `price_bars_primary` uses `ts`, not `bar_time`
(confirmed against other scripts in this codebase, e.g. `scripts/backtest_unified.js`).
**This script cannot run against real data as-is** — the SQL needs rewriting to the real
schema before any backtest is possible. This is explicitly the first thing to fix, not a
minor detail.

Second flagged caveat (Gemini's own): recompiling `TradePathStructural` inside the
optimizer's objective-function loop (once per DE evaluation, ~30 iterations × 10 population
× however many trades) will be slow at scale — may need vectorizing the pivot computation
or capping population/generations for an initial pass.

**An earlier, simpler version also exists**: `docs/runner_optimization_atr_20260814.py`
(permanent copy of `scratch/runner_optimization.py`, timestamped ~5 min before the
structural version) — the ATR-band mechanism DeepSeek's own explanation describes ("recent
highs minus your optimized ATR cushion") before Gemini's structural/zigzag version replaced
it. Same differential-evolution optimizer shape, same utility function, but the trailing
anchor is `rolling_high(lookback) - atr_mult * ATR` instead of a swing-structure pivot. One
nice detail worth keeping regardless of which mechanism wins: it bounds the activation
threshold search space by the *empirical 70th percentile MFE of the actual trade population
passed in* (`p70_mfe = np.percentile(mfe_dist, 70.0)`) rather than a flat hardcoded cap —
a data-derived bound, matching this codebase's own no-static-thresholds preference. Same
`fetch_trade_bars_from_db`-style schema mismatch would apply if this version were used
instead of/alongside the structural one — it also needs real trade-bar data to run.
A synthetic-data smoke test of the structural version (`docs/test_structural_20260814.py`,
permanent copy) confirms the optimizer code itself runs end-to-end without crashing (20
synthetic "runner" trades + 80 "chop" trades, `optimize_structural_system()` completes), but
this used randomly generated price paths, not real data — it validates the code executes,
not that the results mean anything.

## 2. DeepSeek's plain-English mechanism explanation

For a future session (or the user) that needs the non-technical version of what the
optimizer above is actually deciding, DeepSeek's explanation (verbatim, 2026-08-14):

> Think of this system as a dedicated manager for your open position. It sits between your
> trading logic and Sierra Chart, and its only job is to babysit the trade and move your
> stop-loss up at exactly the right time.
>
> **1. The Safety Net (Entry).** You enter a trade. The system immediately sends a hard,
> physical stop-loss order to Sierra Chart — not kept secret in app code, it's on the
> exchange. If the app crashes, the broker still knows where to cut the loss.
>
> **2. The Waiting Game (Holding).** As price moves in your favor, the system watches but
> does nothing — the stop stays put until price hits the optimized "Activation Threshold"
> (e.g. 2.5× initial risk). This prevents choking out a trade before it actually breaks out.
>
> **3. The Ratchet (Trailing).** Once price crosses the activation threshold, every time a
> 5-minute candle closes the system recalculates: recent highs minus the optimized ATR/
> structural cushion. If that's higher than the current stop, it moves the stop up. If
> lower, it's ignored — the ratchet only ever tightens toward the trade, never loosens.
>
> **4. The Exit and Learning (Logging).** Price eventually pulls back and hits the resting
> stop. The system logs the outcome to Postgres so next week's recalibration can use it.
>
> **Three golden rules if building this for real:**
> - **Don't calculate on every tick** — only recompute the new stop when a candle closes, or
>   you'll spam the broker with thousands of modify-order requests per minute and get
>   throttled/banned.
> - **Execute on every tick** — the resting stop order itself sits at the broker and can
>   trigger on any tick, even though the recompute only happens on candle close.
> - **Minimum move size** — only actually modify the stop if the new level is at least one
>   full tick (0.25 for NQ/MNQ) better than the old one, so the app doesn't fight over
>   fractions of a tick.

## 3. DeepSeek's broader "next level" roadmap

Also provided, unprompted, alongside the mechanism explanation — a general quant/HFT-shop
maturity roadmap (microservices + message queues, institutional data feeds + Level 2 order
book, smart order routing + VWAP/TWAP/Iceberg execution algos, Kelly-based dynamic sizing +
a real-time risk service + kill switches, CPCV + Monte Carlo backtesting rigor). Saved
verbatim below for completeness since the user asked it be saved, not summarized away —
**but flagging directly**: this reads as generic best-practice advice for an
institutional/HFT operation, not scoped to this specific single-account retail MNQ journal.
Most of it (Kafka, Level 2 data, SOR, dedicated risk microservices) is almost certainly out
of scope for what this project actually needs next. The one piece that's directly relevant
and small enough to actually matter: **dynamic position sizing already exists here**
(the `sizeMultiplier` IIFE in `acd.js`) and could be extended with a volatility-scaled or
drawdown-scaled component if that's ever prioritized — everything else in the roadmap below
is a "someday, probably not" list, not a near-term backlog. Full text:

<details>
<summary>Full "next level" roadmap text (click to expand)</summary>

> **1. Evolve Your Architecture: From Monolith to Modular** — decouple signal generation,
> risk management, and execution into services; message queue (RabbitMQ/Kafka) between
> them; Redis for low-latency reads. Benefit: horizontal scalability, fault tolerance.
>
> **2. Upgrade Your Data** — institutional low-latency feeds (dxFeed/QuantHouse) instead of
> retail feeds; Level 2 order-book data to model liquidity/impact; alternative data
> (news sentiment, macro) for edge others miss.
>
> **3. Master Execution** — Smart Order Routing across venues; VWAP/TWAP/Iceberg/Sweep order
> types beyond market/limit; a suite of execution algorithms (passive/aggressive/
> opportunistic) chosen per current conditions.
>
> **4. Institutionalize Risk Management** — dynamic position sizing (volatility-scaled,
> Kelly-based, drawdown-scaled); a dedicated real-time risk validation service (gRPC) every
> trade must clear before execution; automated kill switches on breached thresholds.
>
> **5. Fortify Backtesting & Optimization** — walk-forward analysis with purge gaps between
> train/test; Combinatorial Purged Cross-Validation (CPCV) as a more robust alternative to
> plain WFA; Monte Carlo simulation of trade-sequence variations for probability-of-ruin;
> objective functions designed for out-of-sample generalization (e.g. "GT-Score").

</details>

## What actually needs to happen next (in order)

0. ~~**Fix the already-run backtest first** (`backtest_mnq.py`)~~ — **Done 2026-08-16.** See
   "CORRECTED RE-RUN" above: fixed, re-run, result is a real, stable negative
   (-$1.54/trade, N=734). This specific backtest (2-bar exit + from-scratch toy signal) is
   now a closed thread, not an open lead — don't re-run it again without a reason to
   believe something changed.
1. **Fix the schema mismatch** in `structural_runner_optimization.py` — rewrite
   `fetch_trade_bars_from_db()` against the real schema (`custom_fields->'sierra_data'`
   JSONB for trade metadata, `price_bars_primary`'s real `ts` column, real `symbol='NQ'`
   filtering per this codebase's standing convention). This was Gemini's own next-step
   ask ("adapt the SQL pipeline... so we can run this on live data") — not done yet.
2. **Review the design** before running anything — this doc + the two sections above are
   the review material. In particular: does the utility function's weighting
   (0.35× mean-runner-return, 1.5× downside penalty, 0.30× tail CVaR weight) reflect what
   the user actually wants optimized, or were these arbitrary starting values?
3. **Only then**, run an actual backtest — and per this codebase's standing rules, that
   backtest needs the same rigor as everything else here: no lookahead (the causal zigzag
   claims to already avoid this — verify independently, don't just trust the docstring),
   N≥20, day-clustering/stability checks (`computeRigor()`), a genuine held-out test split,
   and the "control for a structural/entry-price advantage" confound check this codebase's
   confound checklist requires for any comparison-style backtest.
4. Whichever model (Gemini or DeepSeek) didn't build the optimizer should review the
   corrected code before it's trusted, per this codebase's standing "cross-review high-
   stakes work between the two blind, don't trust either's self-audit alone" rule — this is
   exactly the shape of higher-stakes work (gates real trade risk management) that rule
   exists for.

## Process note: why this needed rescuing

`scratch/antigravity_response.md` (Gemini's summary) and `scratch/deepseek_response.md`
(a separate, unrelated live-firing audit) both got silently overwritten by later, unrelated
dispatches during this session — once by the user's own parallel work, once by Claude's own
re-dispatch racing against reading the file. The live-firing audit content was recoverable
via `cline`'s own session logs (`~/.cline/data/sessions/*/`.messages.json`); this doc exists
so the runner-optimization content doesn't need the same rescue next time. **Scratch files
under `scratch/*_response.md` are ephemeral and WILL be overwritten by the next dispatch —
anything worth keeping needs to land in `docs/` (or be recorded via `recordClaim`/
`flagDecision`) before that happens, not be left as the only copy in scratch.**
