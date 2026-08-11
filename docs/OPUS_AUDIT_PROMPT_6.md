# Opus Consultation 6 — ATR-Compression Breakout: critique + build-out roadmap

**Scope note, unlike prompts 1-5**: this is NOT a full-app architecture audit. It's a narrow,
single-thread research consultation. User wants ONE dense, concise, actionable response —
not a back-and-forth, not a sprawling review. Write findings to
`scratch/opus_audit_6_results.md`. Be concise and instructional: a build-it-yourself roadmap
Claude can execute without further Opus consultation, not an open-ended discussion.

## What we're testing and why

User found an externally-sourced trend-continuation strategy: on NQ bars, when
ATR(20)<ATR(30) (volatility compression) on one bar, place a buy-stop at
`next_bar.open + 2xATR(20)`. If filled: stop = `entry - 0.5xATR(20)`, no profit target,
exit at the close of the current trading week's last bar (Friday). Long-only (source's
claim: NQ's persistent bullish drift makes downside breakouts less reliable — we tested
this rather than assumed it). Instrument: MNQ economics ($2/pt, $2 round-trip commission).
Clean data window: 2023-12-16 to present (~2.5 real years — `price_bars_primary` for NQ is
only 1 bar/calendar-day before 2023-11-15, a real data gap, already excluded).

## What we found, in order

1. **Bar-width sweep** (15/30/60-min): only 60-min holds a real, clean edge.
   - 60-min: N=121, WR=14.9%, EV=+$65.84/trade, rigor-clean (day-clustering low, stable
     across all 3 chronological thirds), walk-forward OOS improves (train N=37 EV=+$39.79
     -> test N=84 EV=+$77.31). Short-only near breakeven (+$1.33) -- confirms the long-only
     premise rather than assuming it.
   - 30-min: N=242, EV=**-$2.05/trade**, NOT rigor-clean (unstable). The compression filter
     actively HURTS here (no-filter control beats it, +$5.05).
   - 15-min: N=361, EV=+$11.38/trade but NOT rigor-clean (unstable, train-half negative,
     short beats long). The edge does not reliably transfer to finer timeframes -- more
     trades, weaker/unstable signal, not "the same edge with more data."

2. **Parameter-sensitivity / plateau check on the 60-min result** (real concern: is
   EV=+$65.84 an isolated lucky parameter combination or a genuine plateau?). Two grids:
   - Grid A: entry-offset multiplier {1.5x,2.0x,2.5x} x stop multiplier {0.4x,0.5x,0.6x} at
     fixed ATR(20,30) -- **all 9 cells positive EV** ($3.50 to $65.84). All 4 first-degree
     neighbors of the tested (2.0x,0.5x) cell are independently positive.
   - Grid B: ATR period pairs {(15,25),(20,30),(25,35)} at the best entry/stop -- **all 3
     cells positive** too ($51.46-$74.89).
   - Pooled the plateau (tested cell + 4 positive neighbors, N=666 -- NOT independent
     trades, many are the same real touches counted under multiple nearby parameter
     variants): EV=+$42.73/trade, rigor-clean, stable across all 3 thirds.
   - **Conclusion: this is a real, broad plateau, not a spike.** Recorded CONFIRMED.

3. **Confluence with two existing live informational signals** (does BIGMOVE_LIVE_SIGNAL or
   SIGMA_CONTINUATION_LIVE being active at trade-entry time change the 60-min EV? A third
   signal, STACK_VOL_BREAK_LIVE, was dropped before testing -- its available reimplementation
   and the current live definition were found to test genuinely different hypotheses, too
   much drift risk to trust). Real controls applied: badges computed strictly through the
   bar BEFORE the trigger bar (no lookahead), stratified by the ATR compression-ratio
   quartile (since both badges plausibly correlate with the same volatility condition the
   filter already selects for -- a raw present-vs-absent split would be confounded), plus a
   1,000-permutation placebo test.
   - BIGMOVE (active on 34/121 trades): raw numbers look good (active EV $93 vs inactive
     $55) but the within-quartile breakdown is inconsistent (sometimes much better, sometimes
     much worse depending on quartile) and the placebo test puts the real effect at the 65th
     percentile of pure chance -- not distinguishable from noise.
   - SIGMA (active on only 5/121 trades -- too thin to conclude anything; also note SIGMA
     only fires on DOWN moves, so an active badge on a LONG entry is structurally a warning,
     not confluence, and indeed EV was worse when active).
   - **Conclusion: neither badge shows a real effect. Genuine null, recorded CONFIRMED (as a
     negative finding, not left unresolved).**

4. **Just computed, not yet analyzed**: Max Favorable Excursion (MFE -- how far price moved
   in the winning direction before the trade's actual exit, whether that exit was a stop or
   the Friday close) for the 60-min population: median MFE = 73pt (~$146), p75 = 198pt
   (~$397), p90 = 387pt (~$775), max = 1651pt. **The median trade's own peak favorable
   excursion is more than double the actual realized EV ($65.84)** -- the current
   "no target, ride to Friday" exit appears to be leaving real money on the table. 30-min
   and the other two ATR-period variants show a similar pattern (median MFE roughly 1.5-2x
   the realized EV).

## Two open questions from the user, not yet answered

**A. Badge-as-trigger / sequencing, not just confluence.** Everything above tested "was the
badge active AT THE SAME MOMENT the ATR-breakout entry fired" (confluence). We have NOT
tested: does the ATR compression condition (or the eventual breakout) tend to be FOLLOWED
BY one of these badges firing afterward -- i.e., is there a temporal/causal sequence where
compression fires first and a badge is a downstream confirmation or amplification signal,
rather than a simultaneous filter? This is a genuinely different question from what was
tested and hasn't been touched.

**B. What to do with the MFE-vs-EV gap.** Given the no-target/ride-to-Friday exit leaves a
median 2x-plus gap between peak favorable excursion and realized EV, is there a
principled, non-overfit way to capture more of that -- a partial profit-take, a
volatility-scaled trailing stop, or something else -- worth testing? This codebase already
has an established breakeven-then-trail mechanism (`scripts/lib/breakevenTrailCore.mjs`,
reused across several existing live setups) that could plausibly be adapted here rather than
building a new exit mechanism from scratch.

## What we want from you

A concise, INSTRUCTIONAL critique and roadmap -- not an open discussion, we're minimizing
Opus round-trips. Specifically:

1. **Sanity-check our reasoning on the 4 findings above** -- anything that looks
   methodologically wrong, overclaimed, or underclaimed given what's described? (You don't
   have the raw scripts -- work from the numbers and methodology described; if something is
   ambiguous, say what you'd need to know rather than guessing.)
2. **On question A (badge-as-trigger/sequencing)**: is this worth building, and if so, what's
   the right way to frame/test it without repeating the confound this session already found
   for the confluence version (a badge correlating with the same volatility the compression
   filter already selects)?
3. **On question B (the MFE gap)**: is adapting the existing breakeven-trail mechanism the
   right move, or is there a better-suited exit-improvement approach given this strategy's
   specific shape (no current target, calendar-based exit, long-only, 60-min bars, N=121 --
   thin)?
4. **Prioritization**: given limited N (121 trades over 2.5 years) and everything already
   found, what's the highest-value NEXT single step -- not a menu of options, a specific
   recommendation with reasoning, sized so Claude can execute it directly (via the
   established Gemini-mines/Claude-implements/DeepSeek-critiques workflow already in use)
   without needing to come back to you mid-stream.
5. **Anything we're missing or should be worried about** that isn't covered by 1-4 -- keep
   this section short, flag only what's load-bearing.

Keep the whole response tight and structured (headers/bullets, not prose paragraphs) so it
can be worked from directly.
