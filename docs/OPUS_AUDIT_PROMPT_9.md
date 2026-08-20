# AUTONOMOUS — OPUS AUDIT 9: WHAT ELSE, AFTER THREE ENTRY-QUALITY IDEAS DIED

You are Claude Opus 4.8. This is a narrow, direct follow-up to Audit 8
(`docs/OPUS_AUDIT_PROMPT_8.md`, results in `scratch/opus_audit_8_results.md`) — read that file
first, in full, before anything else. Do not re-derive what it already found or re-propose
anything it already proposed.

**The user's own framing, verbatim, is still the brief** (unchanged from Audit 8): "trades are
great and then we get four huge losses that wipe out everything." They want ways to prevent a
bad trade from firing in the first place, not just size it smaller after the fact.

**Deliverable**: `scratch/opus_audit_9_results.md` — same format as prior audits: structured
findings + 2-4 concrete, prioritized recommendations, action items specific enough Sonnet can
execute cold with exact file/line references, no code for immediate paste. Do not implement
anything.

---

## What has happened since Audit 8 (same day, ~3 hours later) — all three of your Part 3 ideas
## are now accounted for. This is the actual gap you're being asked to fill.

Audit 8's §4/§5 proposed three entry-quality ideas. All three are now closed or explicitly
parked:

1. **R3, "already-turned" entry gate (your own top pick, rated MEDIUM, "the most promising
   untested idea in this audit")** — fire only when price has already moved ≥1.5 median-bar-
   ranges in the trade's favour over the prior 15 minutes. Your pooled number looked real
   (n=371, EV +$14.23, WR 60.6%, rigor-clean, plateau-stable) but failed your own
   `computeReplication()` check (held-out −$12.63, 0/10 favourable). You prescribed a proper
   per-setup-type study with a 3-way `SIGNAL`/`SAME_SELECTION_NO_SIGNAL`/`NEVER_SELECTED`
   confound-controlled template. **That study ran the same day** (`scripts/pilot_already_turned_
   entry.mjs`, `RESEARCH_CLAIM already_turned_entry_gate_per_type`, `recordClaim` status
   `CONFIRMED`): **0 of 10 tested setup_types show the effect surviving** a direction-matched
   control at equal distance from the level (N≥20 both arms, rigor-clean requirement each). Settled
   negative — not a false start, a real per-type test that found nothing.

2. **R4, cross-setup-type same-direction throttle** (MEDIUM, "prototype at K=2, do not ship on
   today's evidence") — max N same-direction ACTIVE fires per rolling window, across all
   setup_types. Also tested the same day (dispatched as a K/W-grid + day-regime-crosstab mining
   pass, two real bugs caught and fixed before trusting the result — a population-count mismatch
   and a tied-`fired_at` double-counting bug). Final result: the K=2/W=30 candidate has a genuine
   plateau (all 4 immediate K/W neighbors same-sign) but **fails `computeRigor()`'s chronological-
   stability check** (EV declines into a negative final third) — a more precise negative than the
   original point estimate suggested. Scheduled in `run_weekly_backtests.sh` as "real but
   currently unstable," not shipped, not a hard structural rejection — but not actionable today.

3. **R5, order-flow touch-quality gate** — your own explicit verdict was **do not build this on
   current data**: `touch_quality` coverage is 26% of real rows, the directionally-interesting
   bucket (`HIGH_VOL_OVERRUN`) is N=12, below this codebase's own N≥20 floor, and `touchQuality.js`
   is structurally incapable of gating entry regardless (it reads bars *after* `fired_at`). You
   named the one real alternative — a genuinely new pre-fire computation reusing the `volZ`/
   `oneSidedRatio` block at `acd.js` ~3840-3923 that `STACK_VOL_BREAK_LIVE` already uses live — but
   rated the whole idea LOW / do-not-act-yet given the thin data. This has NOT been built or
   tested (unlike #1 and #2 above) — it's parked on your own advice, tracked as `OPEN_DECISION
   prefire_orderflow_touch_gate_candidate`, waiting on more real N to accumulate naturally. **Do
   not re-propose a version of this that still routes through `touch_quality` or still needs
   N=12→20 to grow before it's testable** — if you have a genuinely different way to attack the
   same order-flow-at-entry question that doesn't have that population problem, that's in scope;
   a restatement of the existing idea is not.

**So: three ideas, three outcomes (2 tested-and-dead, 1 explicitly not-ready), zero of them
currently actionable.** The user is asking, reasonably, whether there's a fourth angle you
haven't tried yet — not a re-litigation of the three above.

---

## Context you should factor in, not re-investigate from scratch

- **§6 incidental finding #3 from Audit 8, still unaddressed**: the ACTIVE equity curve peaked
  +$4,705 on 2026-08-05 and has given back $781 over the 8 sessions since (7 of 8 negative,
  currently +$3,924), with fire count collapsing from 60/day (2026-07-29) to 3-4/day. You
  yourself flagged this as "a different failure shape... arguably the more urgent one right now."
  Nobody has picked this up yet. If your new ideas connect to this (a shrinking, adversely-
  selected roster rather than a small number of catastrophic entries), say so explicitly — it may
  reframe what "prevent a bad trade" should even mean here.
- **§6 incidental finding #1**: `PD_POC_FADE_SHORT` is live-ACTIVE at negative real EV (all_time
  −$8.93, real −$2.40 off real_n=22), the worst single contributor of the last 8 sessions (−$390
  over 3 fires). Check whether this specific type is still live-ACTIVE as of today before citing
  it as current.
- Two entirely separate research threads unrelated to Part 3 also closed today and are NOT
  fair game to re-propose: a pattern_memory double/triple-counting bug (occurrences/wins/losses
  inflated up to 6x, fix shipped, historical rebuild still pending — `OPEN_DECISION
  condition_memory_needs_rebuild_not_backfill`) and a hardcoded STOP=90/TARGET=40 fallback
  affecting 18+ uncalibrated setup_types (interim volatility-scaled fix shipped same day). Read
  `docs/OPEN_THREADS.md`'s 2026-08-19 entries if you want the full account, but neither is what
  this audit is about.
- Re-verify any number you use directly against the DB — do not trust anything above without
  independently confirming it, same standing discipline as every prior audit.

---

## What "a fourth angle" could look like — not a prescription, just to calibrate scope

You are not restricted to these, but plausible directions nobody has tried yet: (a) a
**pre-entry** signal that isn't price-action-based (§1's already-turned) and isn't order-flow-
based (§3's touch-quality) — e.g. something about the LEVEL itself (how many times has it
already been tested today, is it a level that's historically defended vs. one that's historically
broken — `backtest_confluence_zone_memory.js`'s "prior defended/broken" idea existed for a
DIFFERENT question but the mechanism might transfer); (b) a **structural** filter unrelated to
the touch itself — e.g. does the CURRENT trade's setup_type have a live sibling/opposite
already open or recently resolved badly, a same-level-family circuit breaker rather than
same-direction; (c) something in the size/exit machinery that could substitute for an entry
filter entirely (if you genuinely cannot make entries better, is there a fast, cheap
first-N-minutes exit that would have capped Audit 8's "four huge losses" days without touching
entries at all — check whether `bar6_checkpoint`/`bar6_exit_recommended`, already live
informational-only per `docs/OPEN_THREADS.md`, would have caught these specific days if it were
actually acted on). Or something none of this suggests — the goal is a genuinely new lever, not
a fourth variation on "look harder at the touch."

If, after real investigation, your honest conclusion is that there ISN'T a good fourth idea and
this specific line of attack ("gate the entry to prevent the loss") is exhausted for now given
current data — say that plainly, with your reasoning, rather than manufacturing a weak candidate
to fill the deliverable. A clean "not yet, here's what would need to be true first" is a valid
and useful answer.
