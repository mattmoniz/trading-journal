# AUTONOMOUS — OPUS AUDIT 10: IS TICK-LEVEL ORDER-FLOW DATA WORTH BUILDING FOR?

You are Claude Opus 5. This is a strategic investment question, not an implementation
task — the user explicitly wants your judgment on whether to spend real engineering
effort here before anyone writes a line of ingestion code.

**Deliverable**: `scratch/opus_audit_10_results.md` — same format as prior audits:
structured findings + a clear, direct recommendation (build / don't build / build a
narrower proof-of-concept first), with reasoning specific enough that Sonnet can execute
cold from your writeup if you recommend proceeding. Do not implement anything, do not
write ingestion code, do not touch the database.

---

## The question, in one sentence

A previously "impossible" line of research (pre-entry reversal/exhaustion detection) was
tabled because it needed tick-level order-flow data this system didn't have — that premise
just turned out to be false. Does that actually change anything, or was resolution never
the real blocker?

---

## Part 1 — the already-exhausted research (context, do not re-derive or re-propose)

`OPEN_DECISION table_preentry_inflection_detection_pending_orderflow_data` (tabled
2026-07-30) is the full record. Read it directly (`node scripts/flag_decision.mjs --list`
or query `performance_audit` for that slug) before relying on this summary. Short version:
this codebase tried essentially every reasonable formulation of "detect a reversal is
about to happen, before entering," using 1-minute bar OHLCV + aggregated bid/ask volume
(`price_bars_primary`'s `bid_volume`/`ask_volume` columns) —

- `hivol_lopace_at_detection` — an absorption hypothesis, confirmed **inverted** from the
  textbook theory (high volume + low price movement predicted WORSE outcomes, not a
  defended level).
- `weakness_confirmation_entry_delay_confirmed_negative` — 3 candidate triggers (OHLC
  exhaustion, delta+reclaim, reversal pattern+delta), all negative.
- `intrabar_cvd_divergence_no_edge_confounded` — classic TA divergence, properly
  controlled, no real marginal signal.
- `confluence_exhaustion_combined_v2` — thin/unstable.

Gemini argued (`scratch/gemini_inflection_point_debate.md`) and Claude independently
agreed after trying to find a counter-example and failing: real absorption/exhaustion is a
tick-level, order-book-depth phenomenon (aggressive orders vs. resting/iceberg liquidity)
that 1-minute-aggregated trade data structurally cannot resolve. This was filed as a
genuine resolution ceiling, not a string of bad specific formulations — and the tabling
decision named exactly two things that would need to change before revisiting: (a)
finer-than-1-minute tick data ingestion, and/or (b) true order-book depth (DOM/MBO) data.

The one validated pre-entry-adjacent signal that DOES work today, `STACK_VOL_BREAK_LIVE`,
is a different kind of problem (confirming a breakout already in progress, using the same
1-min aggregated volume data) — it does not contradict the ceiling finding, and is not
what this audit is about.

**Your job is not to re-run or re-litigate any of the above.** Take the negative results as
given and correctly diagnosed *for 1-minute bar data specifically*. The open question is
whether escaping that specific constraint (tick data now genuinely available) changes the
verdict.

## Part 2 — the new fact

Confirmed this session (`OPEN_DECISION
tick_data_and_parser_already_exist_reopens_preentry_research`, flagged 2026-08-20):

- Real, **live** tick-level data exists at `/mnt/c/SierraChart/Data/` (`.scid` files,
  Sierra Chart's native per-trade tick format — every individual trade, not aggregated
  bars). The current front-month NQ contract file (`NQU6.CME.scid`) was modified the same
  day this was found — ongoing capture, not stale archived data. Prior contract-months go
  back to 2023, each file multi-hundred-MB to multi-GB.
- A **working parser already exists** in this codebase: `scripts/backtest_mnq_structural_trailing.py`
  reads raw `.scid` files directly, with correct UTC timestamp handling per Sierra Chart's
  documented `SCDateTime` format (it independently caught and fixed a real EDT/EST-naive
  sub-bug in an earlier version). Built for an unrelated backtest (structural trailing
  stops), never wired into `price_bars_primary` or reused for the tabled research question.
- Separately, `server/services/priceBarService.js` handles Sierra Chart's own *bar-export*
  filename conventions (`.scid_BarData-1m.txt`) — a different, already-live pipeline that
  produces the 1-minute bars this system already has. The `.scid` *raw tick* path and the
  *bar-export* path are two different Sierra Chart output mechanisms; don't conflate them.

## Part 3 — the actual strategic questions

1. **Is "resolution ceiling" the right diagnosis, or could tick data fail the same way for
   a different reason?** Read the specific negative findings in Part 1 again with this
   question in mind. Is there a plausible mechanism by which tick-level order flow would
   reveal a real, tradeable absorption/exhaustion signal that 1-min aggregation genuinely
   destroys — or is it equally plausible that pre-entry reversal prediction just doesn't
   have real edge in this market/timeframe regardless of data resolution, and finer data
   would just let the same negative be measured more precisely? Be honest if you think the
   evidence doesn't clearly distinguish these — that itself is a useful answer.
2. **What would need to be true for tick data to help, specifically?** Name the concrete
   mechanism (e.g., "a genuine iceberg/absorption signature requires seeing individual
   print sizes and inter-trade timing that 1-min OHLC+volume destroys by construction") and
   state what a real tick-level formulation of one of the 4 already-failed ideas would
   look like differently, not just "more data, try again."
3. **Cost, realistically.** This is not a quick backtest — estimate what's actually
   involved: ingestion pipeline engineering (reusing/extending the existing parser vs.
   building fresh), a real schema decision (tick data has fundamentally different row
   cardinality than 1-min bars — millions of rows/contract/day vs. ~1,380/day), storage and
   retention policy given multi-GB-per-contract-quarter files, and whether a full
   historical backfill is even necessary or whether a much narrower go-forward capture (or
   a small historical slice, e.g. one recent month) is sufficient to test the hypothesis
   before committing further.
4. **Recommend a staged path, not just yes/no.** If there's real reason to believe tick
   data could work, what is the *smallest, cheapest* proof-of-concept that would tell us
   that within days, not weeks — e.g., ingest a single recent week of tick data for the
   current front-month contract, hand-test one specific reversal formulation at tick
   resolution against real fired trades from that same week, and see if there's *any*
   signal before building a production pipeline. If you don't think even that is
   worthwhile, say so plainly and explain why.
5. **Priority context.** This system has other open, arguably more load-bearing threads
   competing for attention right now (Opus Audit 9's R3 time-stop, the `SUPPRESS_MAX_EV`
   floor recalibration, promotion hysteresis — see `docs/OPEN_THREADS.md`'s 2026-08-19/20
   entries for detail). Weigh in on whether this is worth prioritizing ahead of, alongside,
   or behind those, given what you know of both.

## What NOT to do

- Do not write ingestion code, a schema proposal with actual `CREATE TABLE` statements, or
  any implementation — this is a go/no-go and scoping judgment, not a build.
- Do not re-run or re-relitigate the 4 already-failed 1-min-bar formulations from Part 1 —
  take them as correctly diagnosed for that data resolution.
- Do not manufacture a confident "yes, build it" or "no, don't" if the honest answer is
  "genuinely unclear, here's the cheapest way to find out" — that's a valid, useful
  conclusion, and matches how this codebase's own tabling decision was reached last time
  (a real, reasoned negative, not evasion).
- Re-verify any number you cite directly against the DB/filesystem before using it — same
  standing discipline as every prior audit. In particular, confirm the `.scid` file dates
  and sizes yourself rather than trusting this prompt's summary.
