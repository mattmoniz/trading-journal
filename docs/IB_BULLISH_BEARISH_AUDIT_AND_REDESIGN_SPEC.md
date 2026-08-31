# IB_BULLISH / IB_BEARISH — Audit Scope + Redesign Ideas (2026-08-31)

**Status: scoped and written up, zero code changed, zero backtest run.** Triggered by a direct
user question ("how is IB_BEARISH still live") that uncovered a live, currently-misleading bug
on top of the already-known day-type-gate problem. **Then user clarified the setups' actual
intended thesis** (break-and-retest of the 60-min Initial Balance boundary, then drive until the
move exhausts) — confirmed the current code implements neither the break, the retest, nor a
drive-confirmation, just a much weaker midpoint-position snapshot. That reframed this from "fix
the day-type gate" to "the entry signal itself needs rebuilding" — Part 2's Idea 1 is now the
primary redesign candidate, not a patch on top of the existing signal. Read this doc fresh
before touching either setup type again.

## What's already confirmed wrong (this session, live-verified)

1. **`ibDayTypeKey`/`ibOpt` selection is structurally unreachable** — already tracked as
   `OPEN_DECISION ib_daytype_calibration_structurally_unreachable` (HIGH). `dtClass` (read from
   `acd_daily_log.day_type`) is null essentially every time IB closes (~10:30 ET; the column
   isn't populated until 8:20 PM ET), so the day-type-specific stop/target lookup almost always
   falls through to the blended row.
2. **NEW this session — the live alert's own `tier` label is a dead constant, not a live
   signal.** `acd.js` ~5355-5357: `tier = isBull ? (dtClass==='TREND' ? 'SOLID' : dtClass==='TURBULENT' ? 'MARGINAL' : 'WEAK') : (dtClass==='TURBULENT' ? 'SOLID' : dtClass==='TREND' ? 'WEAK' : 'MARGINAL')`.
   Since `dtClass` is null when this evaluates, this collapses to the SAME value every time:
   every live IB_BULLISH fire shows `tier='WEAK'`, every IB_BEARISH fire shows `tier='MARGINAL'`,
   regardless of actual conditions. Not a bug that sometimes misfires — it never varies.
3. **NEW this session — the alert's description text hardcodes an empirically wrong claim.**
   `acd.js` ~5344-5345: IB_BULLISH's description asserts *"TREND days: strongest. BALANCE:
   suppressed"*; IB_BEARISH's asserts *"TURBULENT: strongest. BALANCE: suppressed"* — static
   strings, not computed from anything live. Real (`origin_status='ACTIVE'`) day-type breakdown
   pulled live this session (see below) shows the **opposite** for IB_BEARISH: real `TREND` is
   its one genuinely decent bucket; real `TURBULENT` loses money.
4. **NEW this session — the day-type "best bucket" answer has changed 3 times across this
   file's own comment history**, each time from a different audit: "TREND +$20 solid" (earliest,
   later marked stale/wrong) → "IB_BULLISH: no day-type clears the bar... IB_BEARISH: TURBULENT
   genuinely strong, correctly gated" (2026-07-14 correction) → this session's real-only pull
   (TREND real for IB_BEARISH, TURBULENT real for IB_BULLISH but N=3, worthless). A "best
   day-type" that keeps flipping between independent audits is the signature of noise being
   re-discovered as signal, not a stable effect.
5. **The IB classification window itself has an unresolved recalibration gap.** The live
   `computeIbBullBear()` window was corrected from 30-min to the real 60-min Initial Balance on
   2026-08-12 (`OPEN_DECISION ib_bullbear_window_fix_recalibration_needed`, still PENDING) — the
   two windows disagree on bullish/bearish/neither 51% of the time. Most of these setups' real
   trading history predates that fix.

### Live real-data pull (this session, for the record — re-derive fresh before trusting)

`IB_BEARISH`, real (`ACTIVE`) trades joined to `acd_daily_log.day_type`:
`BALANCE` N=21 EV=**-$21.24**, `TREND` N=86 EV=**+$11.23**, `TURBULENT` N=39 EV=**-$9.14**.

`IB_BULLISH`, real (`ACTIVE`) trades:
`BALANCE` N=56 EV=**+$1.17** (roughly flat), `TREND` N=10 EV=+$48.30 (too thin), `TURBULENT`
N=3 EV=+$127.83 (worthless N).

Recent 90d aggregate (real): `IB_BEARISH` EV=**-$5.99**/trade (N=145), trend classified
`DEGRADING`, z-score trend `DECAYING` (0.69→0.53→**-2.46**). `IB_BULLISH` recent 90d real EV=
+$9.24/trade (N=74) — currently fine in aggregate, but `z_trend`=`MIXED`, all-time EV -$6.82.

## THE CENTRAL FINDING (user-clarified 2026-08-31): the current code doesn't test the intended thesis at all

User's own framing of what these setups are supposed to be: **capitalize on a break-and-retest
of the 60-minute Initial Balance low, then drive down until it stops going down (mirror for a
break-and-retest of the IB high, driving up)**. That's a 3-stage price-action pattern — break,
retest, confirmed continuation.

**None of that exists in the current code.** Confirmed by grep — zero occurrences of "retest"
anywhere in `acd.js`. The actual live logic (`computeIbBullBear()`, `caseEngine.js` ~157, fired
from `acd.js` ~5271 the instant `etMin >= 630`, i.e. immediately at IB close, no wait after
that):
```
ibBullish = ibClose > ibMid && totalAsk > totalBid
ibBearish = ibClose < ibMid && totalBid > totalAsk
```
This just asks "did price close in the upper/lower **half** of the 60-min range, with more
aggressive volume on that side" — no check that price ever actually broke beyond `ibHigh`/`ibLow`
(the midpoint is a much weaker bar than the actual boundary), no retest, no continuation
confirmation. It fires as a single, immediate, unconditional bet the moment IB closes. This is
a fundamentally different (and weaker) signal than the one these setups are named for and
supposed to represent — which plausibly explains why 3 independent audits of "which day-type is
this good on" have each reached a different answer: the entry isn't anchored to a real,
specific price-action event, so what gets captured is closer to noise than a repeatable pattern.

### Rectify against sibling setups before redesigning in isolation

Checked the rest of the roster for anything else touching this same concept, so the redesign
doesn't duplicate or conflict with an existing sibling:

- **`IB_HIGH_FADE_*`/`IB_LOW_FADE_*`** — a genuinely different thesis (fade/rejection AT the IB
  boundary, not a breakout-continuation through it). Not part of this family, leave alone.
- **`OPEN_DRIVE_LONG/SHORT`** — "price drives directionally away from the open with **no**
  test" (`caseEngine.js` ~130). Same "drive" word, different anchor (the session open, a single
  instant, not a 60-min-formed range) and explicitly the *no-retest* variant. Currently
  `THIN_N`, real numbers thin/mixed (LONG EV=-$9.20 N=61, SHORT EV=+$2.27 N=64) — not a strong
  prior either way.
- **`OPEN_TEST_DRIVE_LONG/SHORT`** — "price tests then rejects the open, driving up/down"
  (`caseEngine.js` ~138). This is the **closest existing structural analog** to what the user
  described — test/retest then drive — just anchored to the open instead of the IB boundary.
  **Real result: decisively negative.** WR 21.2%/21.7%, EV **-$29.54/trade** (N=113, LONG) and
  **-$14.74/trade** (N=106, SHORT), suppressed live since 2026-07-05. This is a real, relevant
  caution for the IB redesign — a structurally similar "test-then-drive" pattern already failed
  hard for a different anchor level. Not a reason to abandon the IB-specific version (the IB
  boundary is a level earned over 60 minutes of real price discovery and widely watched by other
  market participants, unlike a single instantaneous open price — a legitimate reason it could
  behave differently), but it raises the rigor bar: the new IB version needs to convincingly beat
  this prior, not just look plausible in isolation.
- **`STOP_SWEEP_LONG/SHORT`** — a genuinely different thesis (sweep beyond a level THEN
  *reverse*, the opposite of a continuation drive). Currently `ACTIVE`, modestly positive
  (EV +$2.00/+$7.77). Shares the same IB-window-recalibration decision
  (`ib_bullbear_window_fix_recalibration_needed`) since it also reads IB boundaries, but it's a
  different pattern — leave the entry logic alone, just make sure it gets included when that
  window recalibration is eventually done.
- **General structural breakout/retest research (`docs/STRUCTURAL_BREAKOUT_RETEST_SPEC.md`)** —
  already tested this exact SHAPE of idea (dynamically-discovered swing-pivot levels, break +
  retest + continuation) with real rigor and got a clean negative: 0/8 gated cells passed.
  **Doesn't automatically transfer** — IB high/low is a specific, calendar-anchored, widely-
  watched level, not an arbitrary discovered swing pivot — but it's the second independent prior
  pointing the same direction (test/retest-then-continue ideas have a real track record of
  failing in this codebase once actually tested), and that methodology's confound-control
  lessons (entry-price-vs-fixed-exit structural advantage, the exact failure mode already caught
  once on the candle-pattern/overshoot incident) apply directly to building this correctly.

## Part 1 — Audit scope (fix/verify what exists)

1. **Immediate, low-risk fix (separable from the bigger redesign question)**: remove or correct
   the hardcoded `tier` ternary and the "TREND days: strongest"/"TURBULENT: strongest" strings
   in the description text. At minimum, stop asserting a specific day-type is "strongest" in
   live-rendered copy when that claim (a) can't be computed live anyway (`dtClass` null) and
   (b) is currently empirically wrong for IB_BEARISH. This alone doesn't fix the underlying
   day-type-gating problem, but it stops actively misleading the user on every fire in the
   meantime. Can be done independent of and before the larger audit below.
2. **Re-derive the real, origin_status-filtered day-type breakdown as a proper script**, not an
   ad hoc query — `scripts/backtest_ib_daytype_realdata_audit.mjs` or similar. Must:
   - Filter `origin_status IN ('ACTIVE','SHADOW')` only (real data), report `UNKNOWN`/`BACKFILL`
     separately, never blend them into the headline number (this session's core finding was
     exactly this contamination).
   - Split explicitly by whether the trade fired before or after the 2026-08-12 IB-window fix
     (join against `fired_at` vs. the fix's deploy timestamp), and report both windows'
     day-type breakdown separately, not pooled — per the confound checklist ("baseline must be
     computed the same way as the candidate").
   - Run `computeRigor()` (now including the `zScores`/`zTrend` fields added earlier this
     session) on each day-type bucket's chronological stability, not just the headline EV —
     given 3 prior audits already disagreed on which bucket is "best," instability itself is
     the headline finding to check for, not an afterthought.
   - Report a genuine N-weighted overall real EV, not the currently-displayed all-time blended
     number.
3. **Decide, based on (2)'s output**: is there a real, stable, real-data-confirmed day-type
   interaction at all for either setup? If yes, for which specific bucket(s), and is real N
   there actually ≥20 (SUPPRESS_MIN_N) or still thin? If the audit reproduces "IB_BEARISH real
   TREND is the one working bucket," decide whether to gate it to TREND-only (once a working
   live day-type read exists — see Part 2 below) or suppress everything else.
4. **This is exactly the kind of higher-stakes, live-wiring-adjacent work CLAUDE.md's 3-phase
   Gemini workflow exists for** — before writing the audit script, send the plan (this doc, not
   code) to DeepSeek/Gemini for a design critique first, per the standing convention, especially
   given how many times this exact analysis has already been redone and gotten a different
   answer.

## Part 2 — New approach ideas (design-only, not started)

Given the central finding above, the redesign priority is inverted from the first draft of this
doc: don't patch the day-type gate around a signal that never tested the intended thesis —
**build the actual break-retest-drive pattern**, then decide whether the day-type conditioning
still matters on top of it. Idea 1 is the primary candidate; Ideas 2-3 are refinements once 1
exists, not independent alternatives to it.

### Idea 1 (PRIMARY) — Build the real break/retest/drive pattern, replacing `computeIbBullBear()`

Concrete mechanics for `IB_BEARISH` (mirror for `IB_BULLISH`):
1. **Break**: after the 60-min IB completes (10:30 ET, `ibLowToday` already computed live), price
   trades below `ibLowToday` — a genuine boundary break, not a midpoint check.
2. **Retest**: price subsequently trades back up to NEAR `ibLowToday` again from below — user
   confirmed 2026-08-31 this does NOT require an exact touch, a proximity zone counts — without
   closing decisively back above the boundary (a rejection at the broken level from the
   underside). "Near" should be a rolling, self-recalibrating distance (e.g. a fraction of the
   IB's own range, or a recent-ATR-relative tolerance), not a fixed point value — this pulls
   forward part of what Idea 3 originally scoped as a later upgrade, since the user is specifying
   proximity-tolerance as core to the definition from the start, not a refinement to add once a
   fixed-touch version is already validated.
3. **Drive (the actual entry trigger)**: price resumes down after the retest — e.g. a new local
   low below the retest bar's own low, or a close below the retest bar's low, confirming the
   level held as resistance and continuation is underway. This is what should actually arm the
   trade, not the IB-close snapshot.
4. **Exit shape**: "drive until it stops going down" is a trend-continuation description, not a
   fixed-small-target description — the current 30.5pt/45.8pt sweep-optimal targets almost
   certainly cap a supposed continuation trade far too early, which may itself explain real
   underperformance even on days the direction call was right. This is a natural fit for the
   wider-target/breakeven-trail mechanisms already built in this codebase, or the 2-lot
   scale-out-with-runner mechanism scoped earlier this same session
   (`docs/TWOLOT_SCALEOUT_BREAKEVEN_MINUS5_SPEC.md`) — a quick partial plus a protected runner is
   a much more natural match for a genuine continuation setup than for the fade-heavy roster it
   was originally tested on.

**Required rigor, given two independent real priors already point negative** (`OPEN_TEST_DRIVE`'s
decisive real failure, the general structural-breakout-retest engine's clean 0/8 negative):
- **No lookahead / no immortal-time-bias**: the retest-then-drive population is, by construction,
  a survivorship-filtered subset (only trades that got as far as a retest). Compare against
  trades alive at the same landmark bar (post-break, pre-retest), never against a population that
  includes early breaks that never got a retest at all — the exact bias DeepSeek caught on the
  scale-out confirmation-gate thread this session.
- **Structural-advantage control arm**: since a "wait for break+retest" entry is inherently later
  and closer to the eventual move than a naive immediate entry, include a blind-delayed-entry
  control (same average entry timing/distance, no actual signal) to rule out the entry-price-vs-
  fixed-exit confound that has burned this codebase before (the overshoot-entry incident cut an
  apparent ~$77/trade edge down to ~$6).
- Chronological OOS split, plateau check on any swept parameter (retest tolerance, drive
  confirmation distance), `computeRigor()` (with `zTrend`) on the winning config.
- A genuine negative — "the IB boundary doesn't behave differently from the open, break-retest-
  drive still doesn't work here" — is a fully legitimate outcome given the priors already stacked
  against this shape of idea.

### Idea 2 — Volume-building to identify which break/retest/drive setups become big winners

User's own framing (2026-08-31): "worth using the volume building stuff... because they should
be big winners" — i.e. don't just check whether volume-building agrees with direction, use it
specifically to select which drive-confirmed setups are likely to turn into large moves worth a
runner. This is a well-grounded hypothesis, not a fresh guess: volume-building's **most
rigorously validated finding** (confound-checked, RTH+Globex independently) is specifically a
**magnitude** prediction — top-decile composite strength correlates with a ~44% larger 20-min
excursion than bottom-decile, **in either direction** — while its direction-prediction property
was a clean, separately-tested negative. A break/retest/drive setup is, by construction, already
direction-committed (the break tells you which way) — so pairing it with volume-building's
proven magnitude signal at the drive-confirmation moment is a natural fit: use elevated
`compositeStrength` as a real, evidence-based reason to size up / trust the runner further,
rather than a generic "does it agree" filter. Two uses, not mutually exclusive:
- **At drive confirmation**: does elevated volume-building strength at that moment predict which
  confirmed drives actually become the big winners, vs. the ones that stall quickly? This is the
  primary hypothesis to test, directly reusing the already-proven magnitude property.
- **During the trade**: volume-building is also documented as a real-time gauge with short
  persistence (median ~4min episodes) — keep reading it live while the drive is underway and
  tighten/trail as it fades, since fading volume-building is plausibly the live signature of
  "stopping going down" (the user's own exit description) rather than a fixed target or static
  trailing distance. Pairs naturally with Idea 1's runner-style exit shape.
- Same coverage caveat as before: only stamped since 2026-08-28, forward-accumulating, can't be
  backtested against the full historical IB population yet — but that's less of a blocker for
  this idea specifically, since Idea 1's own detector is also being built from scratch and both
  can accumulate real data together going forward rather than needing a historical backtest.

### Idea 3 — Continuous break/retest strength instead of a binary pass/fail

The retest-proximity tolerance is now specified as rolling/self-recalibrating from the start
(folded into Idea 1 above, per the user's clarification). Two parameters still worth the same
treatment once Idea 1's basic structure is validated: how far below `ibLowToday` counts as a
genuine break (currently would default to a hardcoded literal), and how much continuation counts
as "driving" (the drive-confirmation distance) — both should be rolling, self-recalibrating
distribution-derived values (e.g. relative to recent ATR/IB range), not hand-picked constants,
once the basic pattern is proven worth tuning further.

## Rigor requirements before trusting any of Part 1 or Part 2's output

Same non-negotiable bar as every other backtest this session: chronological OOS split, plateau
check where a parameter is swept, `computeRigor()` (now with `zTrend`) on the winning
config, real-N floors (`origin_status IN ('ACTIVE','SHADOW')` only), and independent
re-verification before anything gets promoted or wired. A genuine negative — "no day-type
interaction survives, IB_BULLISH/IB_BEARISH should just be suppressed outright" — is a fully
legitimate outcome of this audit, not a failure to find something.

## Why this is worth the effort despite two negative priors already stacked against it

Worth stating plainly: `OPEN_TEST_DRIVE`'s real -$29.54/-$14.74/trade failure and the general
structural-breakout-retest engine's clean 0/8 negative are real reasons for skepticism, not
reasons to skip the audit. But a correctly-built IB break-retest-drive setup would be one of the
only genuine trend-continuation bets in a roster that's ~118/122 mean-reversion fades — this
codebase has an existing, previously-unaddressed gap here (see memory
`user-trading-style-breakout-preference`), and IB high/low is a meaningfully different anchor
than either of the two priors (a session open, or an arbitrary discovered swing pivot) — it's a
level formed over a full 60 minutes of real price discovery and widely watched by other market
participants. That's a real reason it could behave differently, not just optimism. Worth testing
properly; not worth assuming either way going in.

## Suggested next step

1. **Do the cheap fix first** — remove the hardcoded `tier`/description claims from the live
   alert (Part 1, item 1). Low risk, addresses an actively-misleading display today, doesn't
   require anything else in this doc to be resolved first.
2. **Dispatch this doc (not code) to DeepSeek for a design critique**, per the 3-phase workflow —
   especially the Idea 1 mechanics and the confound-control plan, given how much is already
   riding on getting the rigor right (two real negative priors for this shape of idea).
3. **Build Idea 1's break/retest/drive detector as a bar-by-bar backtest first** (matching this
   session's established pattern for exit-mechanism work) — a signal-level forward-return
   pre-test before any trade machinery, per this codebase's own "new setup type checklist" item
   4a — before writing any live insert path.
4. Only once Idea 1 has a real, rigor-clean result does Part 1's original day-type-audit question
   (fix the gate vs. suppress) become relevant again — if Idea 1 replaces the entry signal
   entirely, the day-type conditioning built around the OLD signal may not even transfer.
