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
2. ~~**NEW this session — the live alert's own `tier` label is a dead constant, not a live
   signal.**~~ **FIXED 2026-08-31** (see "Suggested next step" #1 below). Was `acd.js` ~5355-5357:
   `tier = isBull ? (dtClass==='TREND' ? 'SOLID' : dtClass==='TURBULENT' ? 'MARGINAL' : 'WEAK') : (dtClass==='TURBULENT' ? 'SOLID' : dtClass==='TREND' ? 'WEAK' : 'MARGINAL')`.
   Since `dtClass` is null when this evaluated, this collapsed to the SAME value every time:
   every live IB_BULLISH fire showed `tier='WEAK'`, every IB_BEARISH fire showed `tier='MARGINAL'`,
   regardless of actual conditions. Not a bug that sometimes misfired — it never varied. Removed
   entirely rather than replaced, since no frontend component read it.
3. ~~**NEW this session — the alert's description text hardcodes an empirically wrong claim.**~~
   **FIXED 2026-08-31.** Was `acd.js` ~5344-5345: IB_BULLISH's description asserted *"TREND
   days: strongest. BALANCE: suppressed"*; IB_BEARISH's asserted *"TURBULENT: strongest. BALANCE:
   suppressed"* — static
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

## DeepSeek design critique (2026-08-31) — incorporated, Idea 1 revised

Dispatched this doc (plan only, no code) to DeepSeek per the suggested next step below. Audited
before acting on it per the standing "audit all model output" rule — DeepSeek's "bottom line"
claimed a hard contradiction between Idea 1's self-recalibrating retest tolerance and Idea 3
deferring self-recalibration. **That specific claim is a misread**: Idea 3's own text already
says the retest tolerance was "folded into Idea 1... from the start" and only defers the OTHER
two parameters (break-distance, drive-confirmation-distance). Corrected below; everything else
in the critique checked out as sound and is incorporated as the new version of Idea 1's spec.

**Resolved definitions (were underspecified, each one would have let an implementer silently
sample a different population):**
- **Bar timeframe**: must be stated explicitly before any code is written (1-min vs 5-min changes
  what "retest bar's low" and "drive confirmation distance" even mean). Decide at build time, not
  deferred.
- **First eligible break bar**: the first bar whose *timestamp* > IB close (10:30 ET) — not the
  10:30 bar itself, and not ambiguous about straddling bars.
- **Break = a CLOSE below `ibLowToday`** (bearish arm) / above `ibHighToday` (bullish arm, NOT
  `ibClose`/`ibMid` — those are the dead live code's fields, not the new boundary). A wick-only
  low print below the level does not count — a close-below is a meaningfully stronger, less noisy
  event than a wick, and the two must not be conflated.
- **Retest tolerance is a FIXED fraction of the IB's own range**, computed at 10:30 ET (the IB is
  complete by then, so this is deterministic and look-ahead-free) — NOT "recent ATR-relative" for
  this first version. ATR-relative is deferred to Idea 3 alongside the other two parameters,
  specifically because a trailing-ATR window risks including the current/retest bar and
  introducing look-ahead if built carelessly. This resolves the misread "contradiction" cleanly:
  Idea 1 ships with one fixed, provably look-ahead-free tolerance; Idea 3 later makes it (and the
  other two params) continuous/self-recalibrating once the basic pattern is validated.
- **"Decisively" back above the boundary** must be a stated rule (one close above? by more than
  the tolerance? N consecutive closes?) before it can distinguish "valid rejection" from "failed
  break." Pick one, document it, sweep/plateau it like any other parameter.
- **"The retest bar"** = the first bar to enter the proximity zone (not the highest-high bar in a
  multi-bar chop) — pick one and hold it, since it defines the reference low the drive must break.
- **Drive confirmation** = a CLOSE below the retest bar's low, within a stated validity window
  (e.g. N bars) after which the retest expires and the detector returns to a wait-for-break state.
  Without a horizon, a drop 30 bars later would count as the same setup and silently sample a
  slower, different phenomenon.
- **One signal per day per level**: if price can break→retest→drive→chop→re-retest→re-drive
  multiple times in a session, those fires are within-day correlated — pool as one signal per
  day/level, not independent N.
- **Distinct, close-sequenced bars for break/retest/drive**: never let a single wide bar satisfy
  all three events at once off its own high/low — that's look-ahead wearing a "deterministic"
  costume. Each event must confirm on its own bar's close, in order.

**Confound-control plan revised — the naive "blind-delayed-entry" control was invalid for a
direction-committed setup:**
- **Replaces the vague control arm with two concrete designs**: (1) the **all-break-days
  control** — for every day that breaks the level (the full survivorship-corrected population,
  before any retest filter), enter at the same landmark/same signed-distance-from-level and hold
  to the same exit; compare the retest+drive subset against this. This directly tests whether the
  retest+drive filter adds anything over "price is below the level." (2) The **placebo/level-swap
  control** — run the IDENTICAL detector with the anchor level swapped for the session open, the
  IB mid, `ibLow`±X, and a random prior-day level. If the real IB boundary doesn't clearly beat
  these placebos, the "widely-watched 60-min level" mechanism is dead and nothing downstream
  matters. **This is now the recommended FIRST step (a0), before any forward-return work** — it's
  the cheapest possible kill-gate and it's the only experiment that actually tests the thesis
  "this level is special," as opposed to just re-deriving a fixed-parameter backtest.
- Control direction must be matched to the SIGNED distance from the level (short only on days
  price is on the short side at that moment), not "short at the mean time regardless of price
  location" — the naive version would enter the control against price on the wrong side too,
  making the signal look artificially better by comparison.

**New confound found, not in the original plan**: **the drive-confirmation distance is itself a
momentum filter.** Requiring "a new low below the retest bar's low" as the entry trigger means the
entry is conditioned on the move having already started in the signal's favor — the forward
return measured from there is partly a momentum-continuation artifact, not a clean level-rejection
effect. The all-break-days control (above) must also match this "already moved by the confirmation
distance" condition, or it isolates the momentum filter instead of the level.

**Exit-shape critique — reusing the fade-validated mechanisms wholesale is a category error, not
just a "needs tuning" fix**: a genuine continuation trade's edge lives in the tail (many small
losers, a few large winners) — a fixed wider target caps exactly the tail that's the point of the
trade (wrong SHAPE, not just wrong size); a breakeven-trail is a more plausible fit (cuts small
failures, lets winners run); the 2-lot scale-out's breakeven-minus-5 runner taxes every near-scratch
winner and scaling out early truncates the tail that pays for the losers — the default posture for
a positively-skewed continuation strategy is hold-or-add, not scale-out-early, unless the runner-
only leg is independently shown to carry the edge. **Choose the exit shape from the observed
forward-return distribution (skew/tail mass) in the signal-level pre-test, not by importing an
exit mechanism validated on a completely different (fade) return distribution.**

**Idea 2 boundary, now explicit**: the sizing reuse (elevated volume-building strength → size up
the runner) is sound *as long as it stays sizing, never selection* — the moment it decides
whether to take the trade at all, it's silently reintroduced the already-rejected direction-
prediction claim through the back door. Separately: **fading volume-building as an in-trade exit
trigger is a different, unvalidated claim** (reversal-timing + direction), not a free byproduct
of the proven magnitude-only finding — it needs its own independent test, not inherited trust.

**Revised build order** (replaces item 3 in "Suggested next step" below):
1. **(a0) Placebo/level-swap test** — run the exact break/retest/drive detector on 4 anchor
   levels (real IB boundary, session open, IB mid, `ibLow`±X / random prior-day level). Cheapest
   possible kill-gate; no exit, no trade machinery, signal-level only. If the real boundary
   doesn't beat the placebos, stop — the whole thesis is dead at negligible cost.
2. **(a) Signal-level forward-return pre-test** — distinct-bar sequencing, next-bar-open entry,
   compared against the all-break-days control; report the funnel counts (breaks → retests →
   drives) and the *distribution* of forward returns (skew/tail), not just the mean.
3. **(a1) Parameter sweep, pre-registered, single-shot** — fixed retest tolerance (fraction of IB
   range) × drive-confirmation-distance, plateau-checked on ~70% chronologically, one untouched
   ~30% holdout for exactly one final config (no iterative re-peeking), thirds-stability run on
   the holdout.
4. **(b) Exit simulation** — only after (a0)/(a) clear, exit shape chosen from the pre-test's
   return distribution, next-bar-open fills, slippage/commission, breakeven-minus-5 tax modeled
   explicitly, not assumed small.
5. **(b1) Idea 2** — sizing-only reuse, confirmed at the actual runner horizon before relying on
   it; exhaustion-exit tested as its own separately-validated hypothesis.
6. **(c) Live wiring, last** — through the existing SHADOW→ACTIVE ramp, kill criteria specified
   in advance.

## Step (a0) result (2026-08-31): placebo/level-swap test — CLEAN NEGATIVE

Dispatched to Gemini as a mine-and-run per the revised build order. Gemini's script omitted its
own print/output calls (would have produced zero output as pasted into the response) — re-added
them and re-ran the identical logic directly against `gemini_readonly`; every number reproduced
exactly (`scratch/reproduce_ib_placebo_test.mjs`). Confirmed no day-clustering risk (the state
machine allows at most one signal per day per arm by construction).

**NQ 1-min RTH bars, 2022-12-14 to 2026-08-31 (449 trading days).** Same break/retest/drive logic
(0.15×IB-range tolerance, close-below-retest-bar's-own-low/high within 20 bars) applied
identically to 4 anchor levels — only the anchor price differs:

| Arm | Bearish N | 20m/40m/60m (pt) | Bullish N | 20m/40m/60m (pt) |
|---|---|---|---|---|
| A: Real IB boundary | 155 | -2.76 / +1.43 / **-8.27** | 195 | -1.73 / +1.52 / -2.30 |
| B: Session open | 141 | -4.21 / +1.52 / +1.76 | 162 | +0.42 / +0.35 / +0.02 |
| C: IB midpoint | 200 | **+6.99 / +2.96 / +6.24** | 221 | -0.03 / +4.21 / +3.16 |
| D: Shifted (±1 IB range) | 42 | -19.07 / -29.04 / -20.85 | 31 | -3.05 / -7.75 / -3.18 |

The real IB boundary (Arm A) shows flat-to-negative, sign-inconsistent returns on both sides —
**worse than Arm C, an economically meaningless midpoint level, on the bearish side across all 3
horizons.** The all-break-days control (raw break of the real boundary, no retest/drive filter)
performed statistically indistinguishably from the full setup (-2.68/+2.32/-3.37 vs
-2.76/+1.43/-8.27 bearish) — retest+drive added no measurable EV over trading the raw break.

**This directly refutes the one differentiator that justified testing IB despite the two prior
negatives** ("a 60-min-earned, widely-watched level, unlike a session open or an arbitrary
pivot") — the real boundary did not outperform either an arbitrary shifted level or an
even-more-arbitrary midpoint. DeepSeek's design critique predicted exactly this outcome on
mechanism grounds before the test ran (a discretionary "traders defend this level" effect
plausibly arbitraged out of a liquid, algo-dominated micro contract) and called this the single
highest-value, cheapest de-risking step for exactly this reason.

Recorded as `RESEARCH_CLAIM ib_break_retest_drive_placebo_test_negative` (CONFIRMED — the
independent re-run IS the confirmation, not a second pending check).

## RESOLVED 2026-08-31 (user-confirmed): both setup types suppressed, thread closed

User's direct call given the full weight of evidence above: **"dump them both."** Implemented via
a new, deliberate `MANUAL_SUPPRESS_OVERRIDE` in `scripts/backtest_setup_status.mjs` (removed
`IB_BULLISH`/`IB_BEARISH` from `DAY_TYPE_CONDITIONAL` — that carve-out was itself part of the
problem, giving them a pass whenever at least one day-type bucket happened to clear the bar,
which is exactly why the "good bucket" answer kept flip-flopping across audits). Ran the pipeline
live: both now show `recommendation='SUPPRESS'` in `performance_audit` as of 2026-08-31, which
`_suppressedSetups` picks up on the next poll — same real, no-banner, no-real-trade-alert
treatment as every other suppressed setup_type (SHADOW-only, keeps accumulating forward-test
data silently in case of a future genuine recovery attempt, matching this codebase's standard
mechanism). Do not remove the override based on a routine automatic recovery signal — see the
override's own `REVISIT` condition in the code (a materially different, freshly-tested
mechanism, not this file's own PROMOTE logic).

**This does not close the door on the underlying idea** — see "Next: capitalizing on big
breaks" below for the user's follow-up direction (the same session, same day).

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

1. **DONE 2026-08-31** — removed the hardcoded `tier`/description claims from the live alert
   (Part 1, item 1). `server/routes/acd.js`'s ibSetup construction no longer sets a `tier` field
   (confirmed via grep that no frontend component read it) and the description no longer asserts
   "TREND days: strongest"/"TURBULENT: strongest. BALANCE: suppressed" — the live `_edgeText()`
   call still supplies the real blended-EV summary. Everything below is still open.
2. **DONE 2026-08-31** — dispatched this doc to DeepSeek for a design critique, audited the
   result (caught one misread, rest sound), incorporated into the "DeepSeek design critique"
   section above. Idea 1's spec is now revised: resolved state-machine definitions, a fixed
   (not ATR-relative) retest tolerance for this first version, a redesigned confound-control
   plan (all-break-days control + placebo/level-swap control), a new momentum-filter confound,
   and a revised exit-shape approach.
3. **Next**: build the revised order's step (a0) — the placebo/level-swap test — as a Gemini
   mine-and-run dispatch (DB-backed, matches "Gemini owns heavy mining" convention), per the
   revised build order above. This is now the cheapest kill-gate and comes BEFORE the
   signal-level forward-return pre-test that was originally step 3 here.
4. Only once Idea 1 clears (a0) and (a) with a real, rigor-clean result does Part 1's original
   day-type-audit question (fix the gate vs. suppress) become relevant again — if Idea 1 replaces
   the entry signal entirely, the day-type conditioning built around the OLD signal may not even
   transfer.
