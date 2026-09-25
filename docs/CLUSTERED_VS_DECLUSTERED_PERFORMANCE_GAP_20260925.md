# Clustered vs. Declustered performance gap — investigation, 2026-09-25

## The observation

On `quick-check.html`'s Performance card, the **Declustered** view (every confluence-cluster
sibling counted as its own trade, `is_cluster_primary` ignored) has been outperforming the
**Clustered** view (one row per real market touch — a cluster's siblings excluded, matching
CLAUDE.md's standing `is_cluster_primary` hard rule) on nearly every trading day for the last
~3 weeks. User-reported, then verified directly against the DB (not assumed) below.

## Finding 1: the pattern is real, but only in the SHADOW-background population

Scope: RTH-adjacent (9:30am–6pm ET, matching `range-summary`'s own window), `origin_status IN
('ACTIVE','SHADOW')` (real, non-synthetic — CLAUDE.md's "real" scope), `actual_pnl IS NOT NULL`,
last 20 calendar days (15 real trading days in that window).

| date | Clustered $ | N | Declustered $ | N | Declustered wins? |
|---|---:|---:|---:|---:|---|
| 09-07 | 94.50 | 7 | 151.50 | 14 | YES |
| 09-08 | -889.00 | 78 | 1762.50 | 210 | YES |
| 09-09 | -80.10 | 56 | 1102.40 | 149 | YES |
| 09-10 | -677.10 | 66 | 511.15 | 127 | YES |
| 09-11 | 1059.50 | 48 | 3099.49 | 135 | YES |
| 09-14 | 396.00 | 45 | 447.00 | 79 | YES |
| 09-15 | -608.00 | 32 | 700.50 | 56 | YES |
| 09-16 | -1094.50 | 84 | -32.00 | 204 | YES |
| 09-17 | -207.00 | 50 | 546.50 | 72 | YES |
| 09-18 | 343.82 | 55 | 1175.82 | 114 | YES |
| 09-21 | 572.50 | 10 | 640.50 | 13 | YES |
| 09-22 | -188.10 | 36 | 788.40 | 67 | YES |
| 09-23 | -712.50 | 21 | -972.65 | 44 | no |
| 09-24 | 858.90 | 90 | 3494.90 | 160 | YES |
| 09-25 | 265.30 | 77 | 787.30 | 140 | YES |

**Declustered beat Clustered on 14 of 15 days.** Totals over the window: Clustered **-$865.78**,
Declustered **+$14,203.31**.

## Finding 2 (the critical caveat): this gap disappears almost entirely for real, live-fired trades

Same scope, restricted to `origin_status = 'ACTIVE'` only — trades the user was actually shown
as a live alert, i.e. real capital exposure (matches `range-summary`'s `origin=live` default and
quick-check's "Live" toggle):

| date | Clustered $ | N | Declustered $ | N | Siblings present? |
|---|---:|---:|---:|---:|---|
| 09-07 | -2.00 | 1 | -2.00 | 1 | no |
| 09-08 | -168.50 | 3 | -168.50 | 3 | no |
| 09-09 | -129.50 | 7 | -129.50 | 7 | no |
| 09-10 | -32.50 | 9 | -32.50 | 9 | no |
| 09-11 | -23.00 | 1 | -23.00 | 1 | no |
| 09-14 | -152.00 | 2 | -154.50 | 3 | YES (1) |
| 09-15 | -80.50 | 2 | -80.50 | 2 | no |
| 09-16 | -146.50 | 9 | -146.50 | 9 | no |
| 09-17 | -229.50 | 9 | -229.50 | 9 | no |
| 09-18 | 216.00 | 7 | 216.00 | 7 | no |
| 09-22 | -25.00 | 1 | -25.00 | 1 | no |
| 09-24 | -13.50 | 7 | -13.50 | 7 | no |
| 09-25 | -87.50 | 7 | -87.50 | 7 | no |

**12 of 13 days are exact ties.** Totals: Clustered **-$874.00**, Declustered **-$876.50** —
statistically identical. Cluster siblings are almost always `SHADOW`-origin (only the RTH
winner fires `ACTIVE` via `sortedCandidates`), so **the entire +$14,203 "Declustered
outperformance" lives in background-only observational data that was never a live alert and
never risked real capital.** Real trading over this same 3-week window has been flat to
slightly negative (-$874 to -$877), not the headline-looking recovery the Declustered chart
implies. This is the same shape of confound `RESEARCH_CLAIM
declustered_recovery_is_shadow_sibling_artifact_20260922` found on an earlier window — confirmed
here to still hold, not assumed to still hold.

**Practical rule going forward: read Clustered (and, better, ACTIVE-only) as the real number.
Declustered mixing in SHADOW siblings will keep looking better than reality for structural
reasons below, not because the roster is secretly working better than it appears.**

## Finding 3: why siblings look better — a target-distance geometry effect, not just "better entry price"

The earlier (2026-09-22) diagnosis was: a sibling enters at its own level, which for a fade sits
further into the move than the touch price the primary enters at — a real, structural
advantage. Re-derived on the current window (last 20 days, 157 clusters with a primary + ≥1
sibling): sibling entries are a median 5.3pt further from the touch price than the primary's
zero offset (mean 5.7pt), and pairwise, siblings beat their own cluster's primary 128 times vs.
102 times the primary won (40 ties) — confirms the direction, but a coin-flip-adjacent 128/230
split doesn't by itself explain a $7.96/trade vs $14.21/trade gap. There's a second, more
decisive mechanism:

**The primary systematically holds the FARTHEST (hardest-to-reach) target in its own cluster —
73.2% of the time (115/157 clusters), vs. ~50% expected if there were no pattern.** Mean
normalized target-distance rank of the primary is 0.783 on a 0 (closest) to 1 (farthest) scale.

This isn't a selection-logic bug — it falls directly out of how the two roles are defined:
- The **primary enters at the raw touch price** (zero head start), so its distance-to-target
  equals its setup_type's *full* calibrated stop/target width (~38pt median in this population).
- **Every sibling enters at its own level**, which — because that level sits further into the
  move in the direction its own fade needs to travel — already "pre-pays" part of the distance.
  A sibling's median distance from touch price to its own target is ~32.8pt, materially less
  than the ~38pt it would need starting fresh from its own entry.

Since every cluster member is a level-fade with similarly-sized calibrated targets, **being "the
primary" mechanically means "the one member with zero head start," and being "a sibling" means
"one of the members with some head start" — every cluster, by construction, tends to hand the
worst geometry to whoever gets picked as primary.**

Confirmed directly, independent of primary/sibling identity — **whoever holds the farthest
target in a cluster wins less and less often, regardless of which setup_type or role they are**:

| | N | Win rate | Sum P&L | Mean P&L |
|---|---:|---:|---:|---:|
| Holds the **farthest** target in the cluster | 157 | 47.8% | $1,168.48 | $7.44 |
| Holds the **closest** target in the cluster | 157 | 58.0% | $1,865.52 | $11.88 |

That's a ~10-point win-rate gap and a ~60% larger mean P&L purely from which end of the
cluster's own target-distance spread a trade happens to sit on — a geometry artifact of
confluence packing, not evidence that the sibling setup_types are individually better-edged
trades.

**CORRECTION, same day — this does NOT survive a proper rigor check, and the finding above
overstated it.** Cluster sizes are dominated by 2-member clusters (168 of 291 clusters with
≥2 members; only 25 clusters have 3+), so the "closest vs farthest" split above is mostly just
rank0-vs-rank1 of pairs, not a broad multi-rank effect — the full rank breakdown (rank 0 through
7) is NOT monotonic (rank 4, N=14, actually shows a *higher* win rate and mean than rank 0), and
neither is a continuous-distance decile breakdown (mean P&L bounces between deciles rather than
decaying; the farthest decile has the *worst* win rate, 37.8%, but one of the *higher* means,
$26.82, likely a couple of large winners in a thin, wide 50-367pt bucket). Run through the
paired-within-cluster + day-blocked-bootstrap discipline this codebase requires before trusting
any comparison-style finding: the closest-minus-farthest difference per cluster is mean **+$4.08**
with day-blocked CI **[-$9.94, $20.87]** — crosses zero. Both the closest and farthest
populations are day-clustered (61.3% of N from the top 5 of just 15 distinct dates) and fail
`computeRigor()`'s `clean` check; the farthest group's own chronological trend is
`STRENGTHENING`, the opposite of what a decaying "hard target" mechanism should look like.

**Corrected read: win rate trends down with target distance (directionally consistent with the
hypothesis), but the dollar effect is small, non-monotonic, day-clustered, and does not clear a
real significance bar at the current N=160 pairs / 15 distinct dates.** This is a real lead worth
re-checking as more data accumulates (see the follow-up note below), not a confirmed mechanism
— downgraded accordingly in the recorded `RESEARCH_CLAIM`.

## Finding 4: an additional, un-repaired contamination source sits on top of this

Cluster-sibling resolution breakdown, last 20 days (272 sibling rows with a matched primary):
`TARGET_HIT` 466 rows / ~$38,123 total across sub-methods, `STOP_HIT` 316 rows / ~-$23,266,
`TIME_EXPIRED` ~49 rows / ~$214. TARGET_HIT dominates both count and dollars.

Separately, and importantly: **as of this writing, zero `NOT_FILLED` rows exist anywhere in the
database.** The sibling fill gate (shipped this same morning, 2026-09-25, ~09:45 ET — a sibling's
own-level entry must actually trade before it's scored a win/loss, or it resolves `NOT_FILLED`
with a null `actual_pnl`) has had no opportunity to correct any historical row yet — **every
sibling row in the tables above was resolved under the OLD, pre-fix logic**, which the
2026-09-22 investigation already found let ~12% of sibling rows over a 30-day window score a
win despite the market never trading through the sibling's own entry (a "phantom fill"),
contributing roughly +$15,089 of fake profit against -$8,450 of real loss on the rows that
genuinely did fill. **The historical repair for those already-contaminated rows has not been
run** — `OPEN_DECISION sibling_fill_gate_resolver_fix_20260925` (still PENDING) tracks it. Until
that repair runs, some unknown fraction of the $14,203 Declustered total and the 466 sibling
TARGET_HIT wins above is phantom, on top of (not instead of) the real target-geometry effect in
Finding 3.

## Bottom line

The Declustered "outperformance" is real as a number, but it is **not evidence that firing every
level in a confluence cluster live would make money**. It's the sum of three effects, none of
which reflect real trading edge:
1. It's almost entirely SHADOW-background data (Finding 2, solid) — the real, live-fired trades
   over the identical window show no such recovery.
2. A target-distance geometry effect (Finding 3) is directionally real on win rate but, once
   properly paired and day-blocked, does NOT clear significance on dollar terms at the current
   sample size — a real lead, not a confirmed driver of the gap.
3. An unknown remaining chunk is still phantom-fill contamination from before today's fix
   (Finding 4), not yet backfilled out of the historical rows.

**Finding 1 (the SHADOW-vs-real split) is the solid, decisive part of this investigation.**
Finding 3 is a real hypothesis worth continuing to track, not yet a proven mechanism.

This directly reinforces why `ALL_LEVELS_LIVE` was reverted the same morning (see CLAUDE.md's
"Where to look" entry) — the sibling population that looked so promising on the Declustered
chart is not a population that would perform the same way if it were actually fired live at its
own entry price, for exactly the reasons above.

## Related, still-open work

- `OPEN_DECISION sibling_fill_gate_resolver_fix_20260925` (PENDING) — historical phantom-fill
  repair for pre-2026-09-25 sibling rows, not yet run. This doc adds urgency: the repair is
  needed to know how much of Finding 3's geometry effect is genuinely "a real fill with a
  shorter runway" vs. still-uncorrected "never filled at all."
- `OPEN_DECISION case_engine_family_cluster_tagging_gap_20260908` (PENDING) — the older
  case-engine setup family (`C_PAIRED`/`C_REVERSAL`/`TRT`/etc.) still has zero cluster-tagging
  coverage, so its own sibling population isn't represented in any of the numbers above at all.
- The target-distance geometry effect in Finding 3 is a real lead, not yet a confirmed signal —
  win rate trends the right direction but the dollar effect fails a paired/day-blocked
  significance check at N=160 pairs/15 dates, and the full rank/decile distribution isn't
  monotonic. Re-check once more real data accumulates (more distinct dates, not just more rows,
  since the current population is day-clustered at 61.3% top-5-day concentration) before treating
  this as anything more than "worth watching." Not the same question as confluence
  presence/absence (already tested and rejected 2026-09-09) — this is specifically about
  distance-to-target rank within a cluster, still untested as a standalone factor outside this
  cluster-tagging context.

## Fixes already shipped in this space (chronological, for context)

- **2026-09-04** — Cluster touch credit shipped: losing cluster siblings get real N credit
  instead of being invisible (`docs/CLUSTER_TOUCH_CREDIT_SPEC.md`).
- **2026-09-07** — Globex-origin sibling tagging shipped (pooled-dedup only, no EV-ranked
  winner selection needed since Globex fires every eligible candidate as its own row).
- **2026-09-08** — Two more real tagging gaps found and fixed the same day: the RTH winner
  never got tagged when it itself fell into a separate "suppressed near-level audit" INSERT
  branch, and the `EARLY_TOUCH_BACKFILL` path had zero cluster-tagging at all. A follow-up
  round-2 repair caught more rows a first repair marker had missed. The case-engine family gap
  (above) was found the same day and left open.
- **2026-09-22** — The entry-price structural confound diagnosed: a pooled primary-vs-sibling
  P&L comparison is confounded by entry price, not a real ranking bug
  (`RESEARCH_CLAIM rth_cluster_primary_gap_confound_not_ranking_20260922`); the Declustered
  chart's apparent "recovery" traced to the same sibling artifact
  (`RESEARCH_CLAIM declustered_recovery_is_shadow_sibling_artifact_20260922`).
- **2026-09-25** — `ALL_LEVELS_LIVE` shipped, then reverted the same morning (the sibling
  entry-price design question was never resolved with the user before shipping — see CLAUDE.md).
  The sibling fill gate shipped the same morning and stayed live independent of that revert —
  a sibling's own-level entry must now actually trade before it's scored (`NOT_FILLED`
  otherwise) — but the historical backfill for rows resolved before this fix has not yet run
  (Finding 4 above).
