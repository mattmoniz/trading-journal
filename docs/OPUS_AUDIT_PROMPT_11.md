# AUTONOMOUS — OPUS STRATEGIC AUDIT (AUDIT #11): the firehose problem — does this system know when to stop firing, and can it catch a real move?

You are Claude Opus 4.8. This audit is triggered by the user looking at a live activity feed
screenshot (2026-09-01, ~1:02pm-3:23pm ET) and asking, verbatim: **"like how many OR mid trades
can it have before it stops firing for a little bit or changes its approach. it just keeps
firing."** Followed by three concrete questions: (1) explain the current state of the app's trade
setups and firing mechanisms, (2) will it catch larger trades, (3) is there a better way to
evaluate how/when a trade fires.

Deliverable: `scratch/opus_audit_11_results.md` — structured findings + 2-4 concrete, prioritized
recommendations. Same format as prior audits (`docs/OPUS_AUDIT_PROMPT.md` through `_10.md`): no
code for immediate paste, action items specific enough Sonnet can execute cold with exact
file/line references.

## The screenshot that triggered this — real data, verify it yourself

Roughly 2.5 hours of the live activity feed today (2026-09-01 RTH), in order (newest first as
shown): `OR5_HIGH_FADE_SHORT` (invalidated), `OR15_MID_FADE_SHORT` (stop), `OR5_MID_FADE_SHORT`
(stop), `OR5_LOW_FADE_SHORT` x3 (all stop), `WS1_FADE_SHORT` (stop), `IB_LOW_FADE_SHORT` (stop),
`STACK_VOL_BREAK_LIVE_SHORT` (stop), `WS1_FADE_LONG` (target), `IB_LOW_FADE_LONG` (stop),
`IB_LOW_FADE_LONG` (invalidated), `TRT_SHORT` (expired), `OR5_LOW_FADE_LONG_GAP_DOWN` (stop),
`OR15_MID_FADE_LONG` (stop), `IB_MID_SCALP_FADE_SHORT` (target), `OR5_MID_FADE_LONG` (stop),
`OR5_MID_FADE_LONG` (stop), `OR5_HIGH_FADE_SHORT` (expired), `IB_MID_SCALP_FADE_SHORT` (target),
`OR5_HIGH_FADE_SHORT` (target), `OR10_HIGH_FADE_LONG` (stop), `ONL_FADE_SHORT` (target),
`IB_MID_SCALP_FADE_LONG` (stop), `OR10_HIGH_FADE_SHORT` (target), `OR5_HIGH_FADE_LONG` (stop),
`OR10_HIGH_FADE_LONG` (stop), `ONL_FADE_LONG` (stop). That's roughly 26 fires across at least 11
distinct setup_types in 2.5 hours, a clear majority stopping out. A direct DB check this session
(re-verify, it will have moved on) already confirmed **`OR5_MID_FADE_LONG` alone fired 3 times
today as real `ACTIVE` trades** (2 stops, 1 target), on top of several more `SHADOW`-origin fires
of the same and sibling OR5/OR15/IB_MID types. This is not a same-setup-type refire flood (each
individual type mostly fired once or twice) — it's the FULL ROSTER collectively producing a dense
stream of mostly-losing small trades, with nothing in the mechanism stack that reacts to that
pattern as a whole.

## What mechanisms exist today — verify each is real and current, don't take this inventory on faith

1. **Per-setup-type weekly suppression** (`scripts/backtest_setup_status.mjs` → `SETUP_STATUS` →
   `liveStats._suppressedSetups`): the only thing deciding whether a setup_type is allowed to fire
   `ACTIVE` at all. Recalculated weekly from `active_setups` history. Reacts on a WEEKLY cadence —
   cannot respond to "this specific afternoon is going badly."
2. **RTH same-type cluster dedup** (`acd.js` ~line 7647-7760, `recentTypeRows`): a 15-minute
   window that blocks the SAME setup_type (or, per the cluster-touch-credit fix, other levels in
   the same stacked cluster) from refiring too fast. Does not look across unrelated setup_types.
3. **Globex refire cooldown** (`REFIRE_COOLDOWN_MINUTES`/`isInRefireCooldown()`, `acd.js` ~line
   273-301, 1919-1929): Globex-only (`detectGlobexSetup()`), a hardcoded per-setup-type minute
   map, just fixed today (2026-09-01, see `docs/OPEN_THREADS.md`'s "real Globex refire-cooldown
   dead-config gap" entry) after being silently unwired for an unknown period. Does not apply to
   the RTH level-fade engine at all, and does not look across setup_types either.
4. **"Death Sequence" protection** (`acd.js` ~line 8998-9342, `hasLossToday`): the ONLY existing
   cross-setup-type, same-day mechanism. Checks if ANY setup lost today; if so, caps
   `active.sizeMultiplier` at 0.5x. **This only ever reduces size — it never blocks a fire.** A
   setup can keep firing and stopping out all day at half size, forever, and nothing currently
   escalates beyond that single 0.5x step regardless of how many losses accumulate.
5. **sizeMultiplier IIFE** (~25 hardcoded factors, `acd.js`, see CLAUDE.md's own note that this is
   "confirmed rigid, not distribution-derived," only 2/25 factors self-recalibrate) — sizes
   individual fires, does not gate whether they fire, and is itself flagged as due for a composite
   redesign (`docs/SIZE_MULTIPLIER_COMPOSITE_REDESIGN_SPEC.md`, not built).

**Core question 1**: given all of the above, is there ANY existing mechanism that would have
throttled today's 2.5-hour stretch, or does the honest answer come back "no — every individual
gate is scoped to one setup_type at a time, and the one cross-cutting mechanism (Death Sequence)
only touches size, never fire/no-fire"? Verify by tracing today's actual fires through each gate
in the code, don't just reason abstractly.

## Question 2: will it catch larger trades?

The OR-family (`OR5`/`OR10`/`OR15`/`OR30` HIGH/LOW/MID) and IB-family fades are, per
`docs/OR_LENGTH_SEASONALITY_SPEC.md` and the setup-type checklist in CLAUDE.md, fixed-stop/
fixed-target fade setups calibrated via `OPTIMAL_STOP`/EV-sweep — built to win small and often,
not to ride a real continuation move. Check:
- Are ANY of the types firing in today's screenshot wired into the breakeven-trail mechanism
  (`docs/OPEN_THREADS.md`'s `BREAKEVEN_TRAIL_TEST` entries — 6 blended survivors, 5 confirmed
  non-functional 2026-08-04) or the wider-target/runner mechanism
  (`project_trailing_mechanism_20260817` memory, `docs/TWOLOT_SCALEOUT_BREAKEVEN_MINUS5_SPEC.md`)?
  Query `CONDITIONAL_VARIANTS` in `server/config/setupTypes.js` directly for OR5/OR10/OR15/IB
  entries.
- If none of them are, then the honest answer to "will it catch larger trades" is structurally
  NO for this entire visible roster — these are scalp-sized mean-reversion fades by design, and a
  big continuation day (the kind that actually matters for asymmetric payoff, per CLAUDE.md's own
  stated project goal) would show up as a string of quick stops on THESE setups, not a caught
  trade. Distinguish clearly between "this specific mechanism isn't built to catch big moves" (a
  design fact) and "the roster is currently missing exposure to a setup FAMILY that would" (a gap
  worth naming, cross-reference `docs/IB_BULLISH_BEARISH_AUDIT_AND_REDESIGN_SPEC.md`'s break/
  retest/drive redesign and the volume-building expansion signal
  (`docs/VOLUME_BUILDING_EXPANSION_SIGNAL_SPEC.md`) as the closest existing threads toward this).

## Question 3: is there a better way to evaluate how/when a trade fires?

Don't just recommend "add a circuit breaker" in the abstract — get concrete about the actual
mechanism gap found in question 1, informed by what this codebase has already tried and learned:
- A rolling-window health gate (win-rate/EV cooling off, per-setup_type) was already tested
  2026-07-28 (Audit #5's finding #17 above) and found to be mostly rediscovering `TURBULENT`
  day-type, not real per-setup fatigue — not built. Should a PORTFOLIO-LEVEL version (not
  per-setup_type, but "N losses across ANY setup_type within a rolling window") be tested
  independently? It's a different question — the earlier test was about whether ONE setup_type's
  own edge decays; this is about whether the SESSION itself has turned hostile to the whole
  fade-roster mechanism (whipsaw/chop), which is closer to what today's screenshot actually shows.
- Compare against the volume-building expansion signal (already confirmed real, NOT wired) as a
  candidate session-level gauge — does elevated volume-building strength correlate with today's
  cluster of stops, i.e. would a live "the tape is unusually choppy/expanding right now, tighten
  up" read have flagged this afternoon in real time?
- Is a hard fire-count cap (e.g. "no more than N new ACTIVE fires across the whole roster per
  rolling hour") worth testing as a blunt but simple mechanism, separate from any smarter
  quality-based gate? Give a real opinion, grounded in whether this project's stated goal
  (unemotional discipline, asymmetric payoff, trustworthy decisions — not signal volume) is
  better served by fewer, higher-conviction fires.

## Hard rules (same as prior audits)

1. N≥20 before citing any stat as decisive; say "N=X, thin" otherwise.
2. Query the live DB directly for every number — don't trust this prompt's citations without
   re-verifying (correct as of when written, today may have moved on).
3. Read `docs/OPEN_THREADS.md`'s 2026-09-01 entries in full before starting (the Globex
   refire-cooldown fix, the approach-pace refire-quality thread, and the just-closed post-stop
   continuation/order-flow negative) — this audit is adjacent to but distinct from that whole
   refire-quality investigation, which was about SAME-setup_type refires specifically. This audit
   is about the FULL-ROSTER firing cadence, a different and so-far-untested question.
4. Do not implement anything. Do not generate code for immediate paste.
5. Be willing to conclude the current design is fine and the screenshot is a normal/expected
   pattern for a fade roster on a choppy day, if that's genuinely what the data shows — but back
   it with the actual WR/EV of today's cluster, not a shrug.

## Read first (in this order)

1. `CLAUDE.md` in full — especially "Hard rules" (no dead ends, no static thresholds) and
   "Collaboration" (the stated goal: asymmetric payoff / unemotional discipline, not signal
   volume or win rate)
2. `docs/OPEN_THREADS.md`'s full 2026-09-01 section (refire-cooldown fix, approach-pace lead,
   displacement-since-last-visit negative, post-stop continuation/order-flow negative)
3. `server/routes/acd.js` lines ~3830-4430 (RTH level-fade engine, sizeMultiplier IIFE, cluster
   dedup ~7647-7760), ~8998-9342 (Death Sequence), ~273-301 + ~1894-1929 (Globex refire cooldown)
4. `docs/OR_LENGTH_SEASONALITY_SPEC.md`, `docs/TWOLOT_SCALEOUT_BREAKEVEN_MINUS5_SPEC.md`,
   `docs/VOLUME_BUILDING_EXPANSION_SIGNAL_SPEC.md`, `docs/IB_BULLISH_BEARISH_AUDIT_AND_REDESIGN_SPEC.md`
5. Direct DB queries against `active_setups` for today's real fire count/WR/EV by setup_type and
   in aggregate across the roster, and for the historical base rate of similar dense-firing
   stretches (is today unusual, or does this happen most choppy days?)
