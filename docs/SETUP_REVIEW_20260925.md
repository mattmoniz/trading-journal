# Setup review — past month (written 2026-09-25, overnight)

Scope: every real resolved trade (`origin_status` ACTIVE or SHADOW, cluster-primary only, BACKFILL excluded) — primarily the last 30 days (2026-08-26 → 09-24), with 8- and 11-week windows used as robustness checks. All numbers are MNQ $ per 1 contract, net of $2 commission. Scripts are in `scratch/*_20260925.mjs`; every tested claim is recorded via `record_claim.mjs`.

Two caveats that apply to everything below:
- **~90% of these trades are SHADOW** (background-only, never a live alert). Live (ACTIVE) trades are a small, curated subset, and they often behave differently — both are reported where it matters.
- **The roster changed a lot inside the window** (CLAUDE.md's roster-churn confound). A 30-day number and an 11-week number can disagree for that reason alone; I only call something real when it holds across windows.

## 1. Headline

| | N | EV/trade | Total |
|---|---|---|---|
| All real trades, 30d | 2,189 | -$3.61 | -$7,899 |
| Live ACTIVE, RTH, since 08-01 | 201 | -$10.16 | -$2,043 |
| Live ACTIVE, Globex, since 08-01 | 154 | -$6.62 | -$1,019 (Globex paused live since 09-16) |

- 198 distinct setup_types fired in 30 days; 174 of them fired fewer than 20 times.
- Payoff ratio 1.24 (avg win $83 / avg loss $67) → breakeven win rate 44.6%; actual 42%. The whole book sits just below breakeven.
- **Losers die fast**: median loser is stopped in 12 minutes; 46% within 10 min, 70% within 30 min. Winners take a median 19 min.
- Over 8 weeks, **no setup has a day-blocked EV confidence interval above zero**. Four are confirmed losers (CI below zero) — `IB_HIGH_FADE_LONG`, `BRACKET_BREAKOUT_SHORT`, `C_PAIRED_SHORT`, `IB_BEARISH` — and all four are already SUPPRESSed, so the suppression pipeline is doing its job on the clear cases.

## 2. Systemic critique (what's structurally wrong, ranked by how much I trust it)

1. **The fade roster is a near-zero-edge book with a slightly-too-low hit rate.** Most fade families calibrate to stop ≈ target (many on the `volatility-scaled-default` 37/38pt fallback, all `_OVERNIGHT` types on a 45/90 default), which needs ~49% WR; they're realizing ~40-45%. There is no family-level fix hiding in the time-of-day or first-30-minutes data (tested below) — the improvement has to come from entries or exits, not filters.
2. **Wide-target calibrations don't hold up live.** The two live setups calibrated to a 2:1 target — `IB_HIGH_FADE_SHORT` (25/50) and `OR5_HIGH_FADE_SHORT` (35-40/70-80) — realized **12% and 11% WR live since 09-10** against ~32-37% breakeven. The EV-maximizing optimizer picks far targets that rarely print. Worth re-running their calibration with a hit-rate-aware objective (the forward-path/exit-policy tooling built on 09-24 is the right tool).
3. **The live bar lets mildly negative setups stay live.** SUPPRESS triggers only below -$5/trade real EV, so `PD_VAL_FADE_LONG` (all-time -$4.85) and `IB_LOW_FADE_LONG` (-$1.67) are live now. I tested raising the bar retroactively (status as of the prior day, no lookahead): EV≥0 → +$400 over 46 days, EV≥2.5 → +$720, CI crossing zero every time. Directionally right, not decisive — not changed.
4. **(Lead, not confirmed) The first live touch may be the weaker trade.** Live trades averaged -$9.08 vs -$0.63 for SHADOW trades of the *same setup on the same day* (CI [-19.7, +3.4]); the best same-day shadows were re-fires suppressed by the cluster/refire gates (+$4). Not promotion timing (setup-days with only-live vs only-shadow fires are equal). Consistent with the opening-burst finding that later fires beat earlier ones. `RESEARCH_CLAIM live_first_touch_underperforms_same_day_shadow_lead_20260925`.
5. **New setup types lose while unproven.** A setup's first ~5 real fires average -$8.9/trade in every window (N=330/603/799). They're SHADOW, so it's not live money — but it is most of the "mass firing" noise on the dashboard. (Correction to an earlier draft: "setups with <20 fires caused all the losses" was partly circular; with a no-lookahead definition the proven/unproven gap is not significant.)
6. **Sprawl dilutes evidence.** 18 near-duplicate OR5/10/15/30 × HIGH/LOW/MID types, 30+ pivot variants, 20+ overnight variants — each too thin to ever calibrate alone. Pooled calibration by level family (as already done for bet-class suppression) is the structural fix.

## 3. Currently-live roster (SETUP_STATUS = ACTIVE), one by one

| Setup | 8wk pooled (N / EV / CI) | Live ACTIVE since 08-01 | Critique → suggestion |
|---|---|---|---|
| `IB_HIGH_FADE_SHORT` | 89 / +$3.54 / [-8, 15] | 25 / -$11.50 (12% WR since 09-10) | Wide 25/50 target rarely hits live. Re-calibrate with a hit-rate-aware objective before trusting it live. |
| `PD_VAL_FADE_LONG` | 84 / +$3.11 / [-10, 17] | 42 / -$8.19 | Sits at -$4.85 all-time — live only because the SUPPRESS line is -$5. Candidate for the live-bar decision above. |
| `IB_LOW_FADE_LONG` | 63 / +$1.73 / [-14, 19] | 16 / -$3.81 | Flat. Fine to leave; no edge to protect. |
| `IB_MID_SCALP_FADE_SHORT` | 51 / +$3.40 / [-13, 20] | 13 / **+$13.73** | The one live setup doing well live. Tight 12/40 geometry (BE 23%). Keep. |
| `ONL_FADE_SHORT` | 25 / +$9.96 / [-29, 42] | 3 / -$14.50 | Too thin to judge. |
| `STOP_SWEEP_SHORT` | 21 / +$11.10 / [-17, 49] | 0 | Positive-leaning, 62% WR; hasn't fired live since 08-01. |
| `STOP_SWEEP_LONG` | 78 / -$2.25 / [-33, 12] | 0 | ACTIVE status but lean negative over 8wk (-$35/trade last 30d, N=5). Watch. |
| `GLOBEX_VWAP_MAGNET_SHORT` | 36 / -$7.22 | paused | Globex paused. |
| `WPP_FADE_SHORT_GAP_UP`, `MOMENTUM_60m_*` | backtest-derived | never fired | "ACTIVE" rows are backtest-written; `setupEligibility.js` already blocks live firing without real N≥20. `MOMENTUM_60m_60m_TREND` has never fired (its admission gate reads a day-type column that's null all session — known). |

## 4. Families

| Family (30d) | N | EV | Notes |
|---|---|---|---|
| POC rotation join | 91 | **+$15.14** | Best family. Stuck in SUPPRESS — see §7. |
| Breakout/continuation | 51 | **+$19.07** | `STACK_VOL_BREAK_LIVE_LONG` +$80/trade (N=10, thin). Matches your breakout preference; all SHADOW. |
| Prior-day levels | 415 | +$0.76 | Flat; the largest family. |
| Case-engine (level-anchored) | 111 | -$2.45 | `C_PAIRED_LONG` +$21/trade over 8wk but carried by a few big days (11 dates). Judge by target-hit rate, not R-multiple (CLAUDE.md). |
| Opening Range fades | 181 | -$3.29 | Good 9:30-10 (+$17), bad after 13:00 (-$16). 18 near-duplicate types. |
| IB fades | 299 | -$4.66 | IB_HIGH_FADE_LONG is a confirmed loser (suppressed). |
| Weekly/monthly/quarterly | 329 | -$5.27 | Many thin variants. |
| Pivots (camarilla/floor) | 258 | -$6.16 | Afternoon drag (-$18 after 13:00). |
| VWAP (fade+magnet) | 283 | **-$9.66** | Biggest $ drag (-$2,735), 78% Globex. **Correction:** the 09-24 "next structural level target flips `GLOBEX_VWAP_MAGNET_LONG` to +$86.55" result was a timestamp bug (trades were simulated from ~4h before they fired); corrected, that swap makes it *worse* (-$16.38) and its sample is 56% one day. `RESEARCH_CLAIM next_structural_level_target_placebo_20260924` has the corrected numbers. |
| Overnight high/low | 57 | -$12.89 | |
| Reversal/sweep | 113 | -$12.72 | `FAILED_SWEEP_REVERSAL_SHORT` worst single setup (-$1,149, 11% WR). |

## 5. Opening burst (your ask #2)

- Median 5-8 real fires in 9:30-9:50 (max 12); ~95% SHADOW, so the default Live view on quick-check hides most of them.
- **Capping the count is harmful** — the 4th+ burst fires were profitable (+$7 to +$9.63/trade); only-first-K and max-1-per-direction all lost money in every window. `RESEARCH_CLAIM opening_burst_count_cap_harmful_20260925`.
- The damage is concentrated in (a) the first minutes (9:30-9:35: -$20 to -$34/trade in every window), (b) early-touch backfill rows inside the burst (-$27 to -$32), and (c) fading a strong opening drive — which is what got fixed (§6). (a) and (b) have CIs just crossing zero and small N; left as observation per the design review.

## 6. Firing against the first 30 minutes (your ask #3)

What the data says, honestly:
- **A blanket "don't trade against the first-30-min direction for the rest of the day" rule would not help.** Against-first-30 trades were on average *better* than with-first-30 trades (11wk: +$0.71 vs -$6.12). After 10:00, strong-open days are bad for fades in *both* directions. For your live trades, against-trend was not worse than with-trend. `RESEARCH_CLAIM first30_direction_blanket_gate_negative_20260925`.
- **The real, robust effect is during the drive itself (9:31-10:00).** A trade opposing a move-so-far above the p70 of the prior 20 sessions (same minute) lost -$46.73/trade (N=52, per-trade CI [-72, -13], LONG -$55 / SHORT -$34), while trades *with* that drive won +$68/trade. Positive in all three disjoint periods; smooth across cutoffs p60-p85; Globex analog flat.
- **Shipped**: `server/services/openingDriveGate.js` — force-SHADOW (never skip, so data keeps accruing) at all 4 RTH insert paths, frozen P=0.70, daily recheck with a pre-registered prospective look at ≥20 affected days (`OPEN_DECISION opening_drive_gate_6week_revisit_20260925`). DeepSeek design-critiqued (its LONG-only and "0 ACTIVE is cutoff-sensitive" objections were audited and rejected — both came from the all-day variant, not the proposed window) and code-reviewed (SHIP).
- Honest limit: none of the historical blocked trades were live alerts, so this protects future live trades; it wouldn't have changed past live P&L.
- The day-long "fading into momentum" problem is already covered by existing observation tags with pre-registered revisit dates — **MomFade** (parked 09-21 because its live-only subset CI crossed zero) and **EntryFlow-S** (revisit 10-28). I did not flip either early: re-checking them daily until they look good is optional stopping. DirGate's forward result has flipped sign since 09-14 — not safe.
- Also checked: an afternoon no-new-entries cutoff. Looked robust over 30d/8wk but **failed out-of-sample** (post-09-14: -$2.50/trade, CI crossing zero) and your live afternoon trades over 11 weeks were net positive. Not wired. `RESEARCH_CLAIM afternoon_cutoff_oos_recheck_weakened_20260925`.

## 7. Bugs found

1. **Fixed — resolver race mislabeled POC rotation wins.** `expireStaleSetups()` (60s timer) raced the designed 60-min timeout branch (15s poll) and won 7 of 36 times since 09-15, labeling real wins (+$2 to +$256) as `MARK_TO_MARKET`, which the real-trade filter excludes. Fix: 5-min grace for designed-timeout families (`DESIGNED_TIMEOUT_EXIT_PREFIXES`); the 7 rows relabeled via the existing backup-first relabel script.
2. **Needs your decision — POC rotation join can never be re-promoted.** Its WR is computed as target-hits only and it has no target by design, so stored WR = 0% and the 52% promote floor can never pass. Even with WR computed from P&L (~35-38%) it wouldn't pass. `OPEN_DECISION poc_rotation_join_structurally_unpromotable_20260925` lays out the options.
3. **Fixed — my own 09-24 backtest bug** (not app code): the "next structural level target" script compared a true-instant bar timestamp to a UTC-mislabeled `fired_at`, so every trade was walked from ~4h before it fired. Caught by an independent re-implementation disagreeing; claims corrected (see §4 VWAP row). Its winners changed completely — the idea is essentially negative.
4. **Not code — needs billing**: the nightly AI daily-review (`POST /api/playbook/daily-review/<date>/generate`, 8:35pm) has failed every day since 08-28 (30 times): "Your credit balance is too low to access the Anthropic API."
5. Checked and **not** bugs: the live Globex silence since 09-16 (your deliberate `GLOBEX_PAUSED`); SUPPRESSed setups that fired live on 09-10 → 09-24 (they were ACTIVE at the time — status updates nightly, one-day lag); the 37/38 and 45/90 geometries (documented fallback method).

## 8. What I'd do next, in order

1. Decide the POC rotation promotion path (§7.2) — it's the best real setup and it's locked out.
2. Re-calibrate `IB_HIGH_FADE_SHORT` (and any live 2:1-target setup) with a hit-rate-aware objective — its live 12% WR is the clearest live leak.
3. Pooled, family-level calibration for the near-duplicate OR/pivot/weekly families.
4. Follow the first-touch-vs-refire lead (§2.4) with a direct first-touch-of-day test.
5. Overnight fades run on a 45/90 default geometry that looks poor: the corrected next-structural-level test found closer targets helped several `_OVERNIGHT` types, but only `PM_POC_FADE_SHORT_OVERNIGHT` (N=15) beat a direction placebo — a proper overnight geometry calibration is the better fix than per-level targets (only matters once Globex is unpaused).
