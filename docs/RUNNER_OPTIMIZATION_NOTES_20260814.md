# Runner / Trailing-Stop Optimization — Notes (2026-08-14, saved not built)

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
