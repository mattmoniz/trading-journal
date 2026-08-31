# IB_BULLISH / IB_BEARISH — Audit Scope + Redesign Ideas (2026-08-31)

**Status: scoped and written up, zero code changed, zero backtest run.** Triggered by a direct
user question ("how is IB_BEARISH still live") that uncovered a live, currently-misleading bug
on top of the already-known day-type-gate problem. Read this doc fresh before touching either
setup type again.

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

The common thread across everything found in Part 1: `computeIbBullBear()` is a **binary
snapshot** (`ibClose > ibMid AND totalAsk > totalBid`) computed **once**, at a fixed moment (IB
close), with a **downstream binary day-type gate that can't even be read live**. This is the
same shape of problem the volume-building work fixed — a static, single-snapshot binary
classifier, no rolling self-recalibration, no separation of magnitude from direction. Three
concrete alternative framings, roughly in order of buildable-now-ness:

### Idea A — Reuse the already-validated volume-building signal instead of a frozen day-type read

`active_setups.vol_building_signal` (JSONB: `compositeStrength`, `avgVolZ`, `momentumContext`,
etc.) is **already computed, already live, already self-recalibrating weekly** — no new research
needed, it's wired informational-only across all real fades since 2026-08-28. Question: does
IB_BULLISH/IB_BEARISH's edge condition on volume-building strength at the moment of the IB-close
signal (e.g., does a HIGH `compositeStrength` reading distinguish real winners from real
losers), instead of (or alongside) the broken day-type read? This directly reuses a signal this
codebase has already spent real validation effort on, rather than inventing something new.
**Real limitation**: coverage is thin right now — only 4 of 229 real IB fires have
`vol_building_signal` populated (it's only been stamping since 2026-08-28), so this can only be
tested going forward from here, not against the full historical population. Frame as a
forward-accumulating informational tag first (matching the volume-building convention itself —
tag now, test once N≥20 accumulates), not an immediate backtest.

### Idea B — Replace the binary AND with a continuous, self-recalibrating conviction score

Instead of `ibBullish = (ibClose > ibMid) AND (totalAsk > totalBid)` (a 0/1 flag that treats a
razor-thin IB close identically to a decisive one), compute a continuous composite: e.g.
`(ibClose - ibMid) / (ibHigh - ibLow)` (a -0.5..+0.5 continuous position measure) combined with
`totalAsk / (totalAsk + totalBid)` (a continuous 0..1 order-flow-imbalance ratio), each z-scored
against a rolling distribution of past IBs' own such measures (matching the "no static
thresholds" hard rule — no hardcoded 50/50 midpoint cutoff). This gives a genuine conviction
score instead of a binary label, and — critically — lets magnitude and direction be tested
*separately*, the exact methodological split that made the volume-building finding trustworthy
(direction was a clean negative there; magnitude was real). Worth checking whether IB conviction
strength predicts move SIZE regardless of the bullish/bearish label, independent of whether the
label itself predicts direction correctly.

### Idea C — Early follow-through confirmation instead of betting on the IB-close snapshot alone

Given the one real, moderately-sized surviving signal (`IB_BEARISH` on real `TREND` days) points
at continuation/persistence mattering, consider: instead of firing purely on the binary
IB-close read, add a confirmation window — does price actually *continue* in the IB-implied
direction in the first N bars after IB close, before committing? This is directly analogous to
the scale-out confirmation-gate thread earlier this session — **must be built with the same
immortal-time-bias control DeepSeek caught there** (compare confirmed-and-continued trades only
against other trades alive at the same landmark bar, never against a population that includes
early failures) and a genuine structural-control arm, not a naive "confirmed vs. everyone" split.

## Rigor requirements before trusting any of Part 1 or Part 2's output

Same non-negotiable bar as every other backtest this session: chronological OOS split, plateau
check where a parameter is swept, `computeRigor()` (now with `zTrend`) on the winning
config, real-N floors (`origin_status IN ('ACTIVE','SHADOW')` only), and independent
re-verification before anything gets promoted or wired. A genuine negative — "no day-type
interaction survives, IB_BULLISH/IB_BEARISH should just be suppressed outright" — is a fully
legitimate outcome of this audit, not a failure to find something.

## Suggested next step

1. Do the cheap fix first (remove the hardcoded tier/description claims) — low risk, addresses
   an actively-misleading live display today, doesn't require the full audit to be done first.
2. Dispatch this doc (not code) to DeepSeek for a design critique per the 3-phase workflow.
3. Build the real-data-only, window-split audit script from Part 1.
4. Only after Part 1's output is in hand, decide which (if any) of Part 2's ideas is worth a
   real build — don't start Idea A/B/C code before Part 1 settles whether there's anything left
   to save in the day-type-conditioning approach at all.
