# Design critique — `docs/ES_CORROBORATION_PREREG_20261026.md` (ES corroboration + canary, including Amendment 1)

**Mode:** read-only critique. No code executed, no DB run, no live behaviour touched. Written 2026-10-26, BEFORE any outcome is computed. This report is the only file I wrote.

The prereg's *intent* is right — ES corroboration is a co-movement question that IS resolvable at 1-minute bars; the canary is a lead-lag question that is NOT — and the study's actual scripts (`build_es_features_20261026.mjs`, `study_es_corroboration_20261026.mjs`) are in several respects more careful than the prereg text (they include the NQ-only reference row, a residual↔NQ audit, a permutation sanity, a data-driven power line, and the absolute arm means). The critique below is therefore mostly about the *residual construction / isolation claim*, the *hold-out power*, and the *alignment proof burden*, not about lookahead (which is clean).

---

## Verification status

**Verified against real files:**
- `docs/ES_CORROBORATION_PREREG_20261026.md` (full, 57 lines, incl. Amendment 1).
- `docs/MECHANISM_DECOMPOSITION_PREREG_20261026.md` (touch rule, exclusions, the control-artifact / absolute-return lessons).
- `reports/deepseek_mechanism_prereg_2026-10-26.md` (my earlier review).
- `scripts/build_level_touch_events_20261026.mjs` — event bar `t=gi`; entry `open[t+1]`; `ret60 = f*(C[gi+60] - O[gi+1])/atr` (needs `gi+60 <= b-1`, so post-15:00 touches are `ret60=null`); direction `long = !(C[gi-5] < C[gi])`; weight `1/nLevels`; `familyOf`/`bucketOf` (`FIRST_HOUR<10:30, MID 10:30-14:30, LAST_90`).
- `scripts/load_es_bars.mjs` — forward-only roll by RTH-volume leader; `rth_minutes` added in `ecb7aa1`.
- `scripts/migrate_create_price_bars_es_20261026.mjs` — **`ts = naive ET wall-clock minute, the same convention as price_bars`**; view `price_bars_es_front` joins `c.trade_date = (b.ts + interval '6 hours')::date` (bars ≥18:00 ET belong to the NEXT date's session); `is_roll_day` comment confirms a return spanning the previous close to the roll date's first bar crosses a basis break.
- `scripts/verify_es_bars_20261026.mjs` — lead/lag correlation at lags -2..+2 **on a 1-in-6 day sample** (`i % 6 === 0`); roll-continuity spread on overlap days; day-level RTH counts with a 371-minute floor.
- `scripts/build_es_features_20261026.mjs` — exact-timestamp lookups `ES.get(at(back))` with **drop-on-missing** (never positional shift); `aN_L/aE_L` and `nN_k/nE_k` match the prereg formulas exactly.
- `scripts/study_es_corroboration_20261026.mjs` — OLS slope-only residual, per-`f` terciles from explore only, `aN`-tercile × bucket × family strata, strata-weighted by arm size, day-blocked bootstrap (B=2000), BH q=0.10 within family, underpowered gate (N<100 or days<40 in explore), SHOWN rule, NQ-only reference row, residual↔NQ/minute-of-day audit, permutation sanity (NPERM=300).

**UNVERIFIED (DB-dependent; per the task I could not run the database):**
- Every numeric prior/output: the "0.91 per-minute" contemporaneous correlation, the ES[t-1]→NQ[t] = −0.000 and NQ[t-1]→ES[t] = +0.011 lead-lag priors, "~55,000 sampled minutes", the "18,719 touches on 691 days" count baked into the `--record` claim text, and the "~15,000 usable" figure. These are prereg/claim numbers, not recomputed here.
- Whether the exact-minute grids are aligned on the **~83% of days not in the verify sample** (see S4).
- Whether the **overnight (04:00–09:30 ET) minutes** used by the L=60 first-hour lookback are complete on every non-roll clean day (the 371-minute filter only checks 09:30–16:00) (see S5).
- The actual explore/hold-out half-widths; the ~1.6× hold-out widening below is analytic (40% of days ⇒ SE ×√(1/0.4)).

## Executive severity ranking

| # | Severity | Finding | Q |
|---|----------|---------|---|
| S1 | **High** | The residual `r_L = aN − b·aE` is **not** "ES-only" and the prereg's claim that it "keeps r_L from being a re-labelled NQ approach size" is false: `r_L` is NQ's move residualized against ES, still correlated with `aN_L` at ~`sqrt(1−ρ²) ≈ 0.3–0.4`. The actual ES-isolation comes from the `aN`-tercile stratification and the NQ-only reference row — which exist but are not *gated*. | (b) |
| S2 | **High** | The **hold-out stage is underpowered for the practical bar**: the 60/40 date split puts ~40% of days in hold-out, so the hold-out CI is ~1.6× wider than the full-sample ~0.01–0.02 ATR60. A true effect at the 0.02 ATR60 bar likely fails the hold-out one-sided p<0.05 gate → structural bias toward a **false null**, not a false SHOWN. | (c),(d) |
| S3 | **Medium** | The absolute top-minus-bottom contrast is not day-balanced; the point estimate (`stratDiff`) can be pulled by a few high-drift days, and only the day-blocked bootstrap CI (not the point estimate) guards it. No within-day demeaning robustness check. | (b),(d) |
| S4 | **Medium** | Timestamp/alignment is proven only on a 1-in-6 day sample (lag-0 dominance) plus day-level counts plus roll continuity. A systematic per-contract 1-minute offset on the unsampled days would silently misalign `C_ES[t-1]`/`C_ES[t-1-L]`/`C_ES[t-1-k]`. The drop-on-missing join is safe, but the proof burden is incomplete. **UNVERIFIED** for the unsampled days. | (a) |
| S5 | **Medium** | First-hour L=60 lookback reaches 08:34 ET (overnight). The `rth_minutes≥371` filter validates only 09:30–16:00, so the overnight minutes the L=60 feature depends on are not validated; a gap silently nulls `aE_60` (safe but reduces sample, and is not separately counted). **UNVERIFIED**. | (a) |
| S6 | Low-Med | Family C's OLS (`ok: () => true`, no null filter) is asymmetric with Family A; a null `nN_k`/`nE_k` coerces to 0 and a null row lands in the **bottom tercile** (resid→0) rather than being excluded. Latent (nulls are rare). | (d) |
| S7 | Low | The 0.02 ATR60 practical bar is applied to `allDiff` (includes explore) and to an exit-free `ret60`, not the hold-out diff or the tradeable symmetric P&L. | (c) |
| S8 | Low | The code can label an OPPOSITE-sign cell "SHOWN (OPPOSITE)" and record it in the claim text, whereas the prereg says the SHOWN verdict requires the hypothesis sign and an opposite effect is "reported as such, not as support". Minor wording/recording inconsistency. | (c) |
| S9 | Low | Prereg numbers ("~15,000", "0.91", "0.01–0.02 half-width") are estimates; the printed state counts and the data-driven power line supersede them and should be reconciled before any verdict. | (c) |

## (a) Lookahead and alignment

**`C[t-1]`, `C[t-1-L]`, `C[t-1-k]` are lookahead-safe.** The builder's event bar is `t=gi`, entry is `open[t+1]`, and every ES/NQ feature is a close at `t−1`, `t−1−L`, `t−1−k` — all strictly before `t`, hence known at the entry decision. `build_es_features` computes these as wall-clock offsets from `r.ts` (`at(1)`, `at(1+L)`, `at(1+k)`) and reads closes at the exact timestamps. No lookahead in the feature→outcome alignment. ✓

**Timestamp convention is consistent by design.** The migrate script states ES `ts` is "naive ET wall-clock minute, the same convention as `price_bars`", and `build_es_features` uses the same naive-as-UTC round-trip as `pocJoinLoader.epoch`. NQ and ES therefore share one grid; the `(ts+6h)::date` shift only decides *which front contract* an overnight bar belongs to, not the minute grid. ✓

**Missing minutes are handled safely, but the proof burden is partial.** `nq()`/`ES.get()` return null on a missing minute and the touch is dropped (or the feature nulled), never positionally shifted — so a missing minute cannot cause lookahead, only sample loss. The alignment *evidence* is the verify script's lag-0 dominance, which samples `i % 6 === 0` days (~17% of days) and computes log returns over the **joined** rows; a missing ES minute makes that joined "consecutive" return span two minutes, silently damping the lead-lag prior toward 0. Two independent guards exist (the 371-minute day floor, and the roll-continuity spread), but a systematic per-contract timestamp shift on the unsampled days would pass all of them except the lag-0 check that never saw those days. **UNVERIFIED** beyond the sample.

**Roll days are handled correctly.** A roll day is excluded from the population, and the `is_roll_day` rationale (a return spanning the previous close to the roll date's first bar crosses a basis break) is exactly the right reason. The one place the `(ts+6h)::date` convention mis-attributes a contract is the roll day's *own* overnight (18:00 ET of D−1 → trade_date D → NEW contract, when OLD was still front overnight); but that overnight is only used by touches on D, which are excluded, and by nothing on D−1 (whose 60-minute lookback cannot reach forward) or D+1 (whose overnight is post-roll and correctly NEW). Net: no basis break enters any feature or outcome. ✓ (This is a real subtlety the author got right.)

**The L=60 first-hour lookback is the one genuinely unvalidated data dependency.** For a 09:35 touch, `at(1+60)=08:34 ET`, i.e. pre-open. The `rth_minutes≥371` filter checks 09:30–16:00 only, so it does not vouch for the 04:00–09:30 overnight minutes that `aE_60` silently consumes. A gap there nulls `aE_60` and quietly shrinks the A_L60 arm; it does not misalign, but it is neither validated nor counted. **UNVERIFIED.**

---

## (b) Residual construction and stratification

**The residual does NOT isolate ES information by itself — the prereg's stated rationale is wrong.** `r_L = aN_L − b_L·aE_L` with `b_L` the slope-only OLS of `aN` on `aE`. This is NQ's approach *orthogonalized to ES*: it removes the part of NQ that ES linearly predicts and keeps NQ's idiosyncratic move. Because `aN_L` and `aE_L` are L-minute aggregates (more correlated than the 0.91 per-minute figure), `corr(r_L, aN_L) ≈ sqrt(1 − ρ²) ≈ 0.3–0.4`, not ~0. So "high `r_L`" is still, at ~30–40% correlation, "NQ moved a lot" — the residual is literally a re-labelled (residualized) NQ approach size, the opposite of what line 16 claims. The study's own audit (line 61) prints `corr(resid, NQ move)` and it will print ~0.3–0.4 despite the comment "should be near 0", and nothing gates a SHOWN on that value.

**The isolation actually comes from the stratification, and it is only coarsely applied.** Within a fixed `aN_L` tercile, `r_L ≈ const − b·aE_L`, so the top-vs-bottom contrast does isolate ES's move. But (i) three tercile bands still leave `aN` free to vary within a band, so the contrast is a mix of "higher within-band NQ move" and "lower ES move"; (ii) on **hold-out** the slope `b_L` is frozen from explore, so the hold-out residual is no longer orthogonal to `aE` — it leaks `aE`'s own *size* (a large ES move shows up as a large residual). The time-of-day component IS controlled (bucket strata); the NQ component is only partially controlled (3 bands + reference row).

**The NQ-only reference row is the real safeguard and it is present** (`refDiff`, line 45/58: top-vs-bottom tercile of `aN_L`/`nN_k`, stratified bucket×family). If it reproduces the residual row's sign and size, the ES cell adds nothing — but this is only *printed*, not gated. It should be a SHOWN precondition (amendment 1).

**The absolute `ret60` contrast IS free of the same-day-control artifact, with one residual caveat.** Dropping the random control removes the mechanism study's artifact (17/20 spurious SHOWN from a same-day random baseline) — correct. But an absolute within-`f` contrast is drift-free only if the two arms are balanced across *days*; the strata balance bucket/family/`aN`-tercile but **not day**. A crash day whose touches cluster in one tercile (e.g. top, "ES not confirming" on a NQ-led selloff) drags that arm's mean down. The day-blocked bootstrap makes the CI honest (wide), so this is not a false-SHOWN vector, but the *point estimate* is fragile; the "absolute return was negative" lesson means both arms can be negative and a top>bottom gap is then "the top loses less", which the filter read (line 63–64) does surface. Add a within-day demeaning robustness check (amendment 3).

## (c) Multiplicity, SHOWN/practical bar, power

**Multiplicity is handled honestly.** 10 tests (6 + 4), BH q=0.10 within each family, never pooled; the SHOWN gate is four-fold (BH survivor on explore AND hold-out same-sign p<0.05 AND ≥half explore magnitude AND hypothesis/opposite labelling). The overlapping L and k windows and the long/short pairing mean the 10 tests are positively dependent, which BH tolerates; the effective independent count is <10, so the gate is conservative. The "informational filter read" (bottom-tercile-of-`r_15` vs rest) is an extra contrast but is explicitly no-gate.

**The practical bar has two mismatches.** It is evaluated on `allDiff` (explore+hold-out) rather than the hold-out diff, and on an exit-free `ret60` rather than the tradeable symmetric ±0.5-ATR P&L. The `$10 ≈ 0.02 ATR60 × ~240 pt × $2/pt` arithmetic checks out, but "too small to trade" should be stated against the hold-out diff and the P&L, not an in-sample exit-free return (amendment 6).

**The power statement overstates the confirmatory stage.** The power line (study line 14) is data-driven (good) but computed for the *explore* contrast. The SHOWN verdict lives on hold-out (~40% of days), whose CI is ~`√(1/0.4) ≈ 1.6×` wider. If the full-sample half-width is ~0.01–0.02 ATR60 — i.e. *equal to* the 0.02 practical bar — then the hold-out half-width is ~0.016–0.032 and a true 0.02 effect will often fail the hold-out p<0.05 gate. This is the single most important **false-null** mechanism in the design, and it is consistent with the prereg's own "~10% chance of SHOWN": the study is configured to mostly produce nulls even if a real 0.02-ATR effect exists. The "~15,000 touches / terciles ~5,000" is fine as a rough estimate, but the binding number is the *with-`ret60`* count the study prints (post-15:00 touches are dropped), and the hold-out half-width should be printed and gated (amendment 2).

---

## (d) False-SHOWN and false-null vectors, and amendments

**False-SHOWN risks (ranked):**
1. *Mechanical NQ link* (S1): if NQ's own approach predicts `ret60` (plausible, and exactly what the reference row tests), the residual contrast inherits ~30–40% of that and can look "SHOWN" without ES adding anything. The reference row mitigates; it must be *gated*.
2. *Hold-out residual leak of aE's size* (S1(ii)): with a drifted ES-NQ beta, the hold-out residual ranks partly by raw ES move, not divergence.
3. *Alignment on unsampled days* (S4): a per-contract offset is the one thing that could manufacture spurious "divergence" (`C_ES[t-1]` stale ⇒ fake ES-confirmation). Drop-on-missing prevents lookahead but not a grid offset.

**False-null risks (ranked):**
1. *Hold-out underpowered for the practical bar* (S2) — see above; the dominant one.
2. *First-hour L=60 sample shrinkage* (S5) — overnight gaps silently empty the A_L60 arm.
3. *Family C is structurally unresolvable* (framing, below) — a null there is uninformative, and the study spends 4 of 10 tests on it.

**Concrete amendments (verbatim-adoptable):**

1. **Residual framing + gate (S1).** *"Replace line 16's last sentence with: '`r_L` is NQ's approach residualized against ES; it is NOT orthogonal to NQ's own move (corr(r_L, aN_L) ≈ sqrt(1−ρ²) ≈ 0.3–0.4), so the isolation of ES information comes from the `aN_L`-tercile stratification and the `aN_L` reference row, not from the residual alone.' Add to the SHOWN rule: 'a cell is SHOWN only if its `aN_L` reference row does NOT reproduce the same sign with a magnitude within half of the cell's; otherwise it is reported as "ES adds nothing beyond NQ".'"*
2. **Hold-out power (S2).** *"Print the hold-out 95% CI half-width separately before any outcome; if it is at or above the 0.02 ATR60 practical bar, the cell is declared UNDER-POWERED AT HOLD-OUT and a hold-out null is reported 'could not be resolved at the practical bar', not as a refutation."*
3. **Within-day demeaning (S3).** *"Recompute the top-minus-bottom contrast with ret60 demeaned within day and f (ret60 − mean ret60 of touches that day with the same f); a SHOWN must survive both the absolute and the within-day-demeaned contrast."*
4. **Alignment proof + counts (S4/S5).** *"The ES join is on exact naive-ET timestamp equality with drop-on-missing (never positional shift). Before any outcome, print: (i) touches dropped per L and per k for a missing ES or NQ minute; (ii) first-hour touches whose L=60 lookback reaches before 09:30 ET (overnight bars). Re-run the lag-0 dominance check on ALL days, and on the 04:00–09:30 ET window used by the L=60 first-hour lookback."*
5. **Family C null handling (S6).** *"In `build_es_features`, a null `nN_k`/`nE_k` excludes the touch from Family C (not coerce to 0); in `study_es_corroboration`, Family C's OLS filters nulls exactly as Family A does, with `ok(r) = nN_k != null && nE_k != null`."*
6. **Practical bar (S7).** *"The 0.02 ATR60 practical bar is evaluated on the HOLD-OUT stratified difference and reported beside the symmetric-trade dollar P&L of the top and bottom arms, since ret60 is exit-free."*
7. **Opposite-direction recording (S8).** *"A significant OPPOSITE-direction cell is recorded with status 'OPPOSITE' and is never counted among hypothesis-supporting SHOWN cells in the recorded claim."*
8. **Canary scope (framing).** *"Family C is reported as EXPLORATORY at 1-minute resolution and carries no confirmatory weight: the unconditional 1-minute ES→NQ lead is ~0 (verified), so the canary's timescale is sub-minute. A Family C SHOWN requires an independent tick/second-level dataset before any decision; a Family C null is recorded 'unresolved at this resolution', not 'no canary'."*

## Is the "ES as canary at one-minute resolution" framing testable at all?

**Largely no — it is structurally too coarse, and the prereg already knows it.** The canary (Family C) is a lead-lag claim ("ES turns first, NQ follows") whose characteristic timescale is seconds to sub-seconds and is arbitraged away; the prereg's own verified prior is that the unconditional 1-minute ES→NQ lead is −0.000. One-minute bars literally cannot contain a sub-minute lead: by the time an ES 1-minute close is stamped, NQ's same-minute move is already contemporaneous (lag-0 dominates). The canary feature `c_k = nE_k − d_k·nN_k` for k∈{1,3} is a 1–3 minute move normalized by the full-day ATR (~0.2–1% of range), i.e. dominated by measurement noise, with only 4 tests at BH q=0.10 (the smallest p needs to clear ~0.025). So Family C is "testable" only in the trivial sense that it emits numbers: a SHOWN there would be a near-certain false positive, and a null is uninformative (it cannot separate "no canary" from "canary below 1-minute resolution"). The honest answer is that **the canary question should be deferred to a tick/second dataset or dropped** — the 4 extra tests add false-positive surface without adding resolvable evidence.

**Family A, by contrast, IS testable at 1-minute resolution.** It asks a contemporaneous co-movement question ("did ES move as much as NQ into the level?"), which is exactly what 1-minute bars measure. The "ES as canary" framing conflates these two; the prereg's Amendment 1 correctly splits them, but then runs both. The recommendation is to keep Family A as the confirmatory study and demote Family C to exploratory/deferred.

---

## Bottom line

No lookahead, and the roll-day/overnight handling is more careful than it first appears (the `(ts+6h)::date` contract mismatch only ever touches the excluded roll day). The study's real weaknesses are (1) a residual feature whose prereg'd rationale overstates its isolation — `r_L` remains ~30–40% an NQ-approach re-labelling, and the genuine ES-isolation is carried by the stratification and the reference row, which should be *gated*; (2) a confirmatory hold-out stage that is ~1.6× wider than the stated ~0.01–0.02 power and therefore structurally biased toward a null at the practical bar; and (3) an alignment proof that currently rests on a ~17% day sample and a RTH-only completeness filter, leaving the overnight L=60 dependency and the unsampled days UNVERIFIED. The canary (Family C) is not resolvable at 1-minute bars and should be demoted or dropped. The amendments above (1–8) are small and verbatim-adoptable; with them, the likely honest outcome remains "Family A null or tiny at the resolution floor; Family C unresolvable", which is a real, publishable falsification of the 1-minute ES-corroboration filter rather than a false negative.
