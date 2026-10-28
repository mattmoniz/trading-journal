import { recordClaim } from '../record_claim.mjs';
import { flagDecision } from '../flag_decision.mjs';

await recordClaim({
  slug: 'macro_regime_classifier_train_audit_20261027',
  claimText: 'NQ Macro-Regime Auction Classifier train-set frequency audit (scripts/macro_regime, prereg.lock hash becad7fc, window 2023-03-06..2026-10-26 pinned, 928 clean sessions, 556 train / 372 hold-out). Train classified N=516: D 44.0%, A 36.6%, C 17.4% (90), B 1.9% (10). Pooled B+C = 19.38% -> pre-committed verdict PROCEED WITH UNDERPOWERED CAVEAT, DESCRIPTIVE_ONLY_NOT_CONFIRMATORY. POST-VERDICT FINDING (about the prereg, not the data): the pooled gate passed on Regime C alone (90 of 100 B+C sessions); Regime B was structurally under-armed (vol-ratio floor 1.5 is above the train p90 of 1.261; only 4.3% of train sessions reach it; independence product 1.15% vs observed 1.94%), so the gate was a false positive for B. B deferred to a v2 prereg; no re-tune on this window; no fresh window exists (pre-2023-03 NQ is daily placeholder only). See scripts/macro_regime/prereg_retrospective_20261027.md.',
  sourceFile: 'scripts/macro_regime/prereg_retrospective_20261027.md',
  sourceDate: '2026-10-27', sampleSize: 516, rigorStatus: 'frequency_audit_only_no_pnl', status: 'PROVISIONAL',
});

await recordClaim({
  slug: 'macro_regime_C_reversal_phase3_not_shown_20261027',
  claimText: 'Regime C (mid-concentration) reverse-breakout trigger from the handoff spec, pre-registered (PHASE3_C_PREREG.md, committed before any trade; spec lookahead fixed: entry is the bar AFTER the reclaim bar), MNQ 2 dollars/pt, 2 dollars RT commission, 1 tick/side. One look at hold-out. TRAIN: 90 C sessions, N=53 trades, WR 9.4%, mean -46.42/trade (sum/N), day-blocked CI [-71.54,-17.58], 87% stop-outs, 0% target hits, real worse than 98.5% of random-direction placebo trials. HOLD-OUT: 50 C sessions, N=28, WR 14.3%, mean -31.91/trade, CI [-89.25,44.55] (crosses zero), 82% stop / 4% target, real worse than 84% of placebo trials. Break-even WR is about 13-14% (median stop 29.75pt vs median target 178.75pt, median R:R 6.5, so the R:R>=1 filter never binds). Regime filter: same engine on all regimes, C minus non-C = -42.78 train (CI [-70.10,-13.07]) and -32.51 hold-out (CI [-94.77,50.38]); regimes A and D are about break-even. Pre-registered reading: NO DEMONSTRATED EDGE. What could not be shown: a positive edge for the reversal; the hold-out cannot reject a small positive or a large negative (CI width about 134 dollars). Both splits point the same way (below placebo), which is an observation about direction, not a tested claim: any inverted/continuation version is a NEW hypothesis and both windows are already used for C. Engine checked: 10 synthetic tests, independent pandas recomputation of 4 real trades (stops match to tick rounding).',
  sourceFile: 'scripts/macro_regime/phase3_c_run_*.log', sourceDate: '2026-10-27', sampleSize: 81,
  winRate: null, evPerTrade: null, rigorStatus: 'day_blocked_ci_placebo_one_look_holdout', status: 'PROVISIONAL',
});

await flagDecision({
  slug: 'macro_regime_B_v2_needs_redesign_no_fresh_window',
  decisionText: 'Regime B of the NQ macro-regime classifier is deferred to a v2 prereg. B was structurally under-armed (vol-ratio floor 1.5 above the train p90 of 1.261; about 1.9% of sessions, 10 train / about 3-7 hold-out) so it is a null by construction, not a result; the pooled B+C gate gave a false positive for B (see scripts/macro_regime/prereg_retrospective_20261027.md). Do NOT re-tune the floor and re-run on this window. A fresh window does not exist: NQ before 2023-03-03 is daily placeholder only (KNOWN_ISSUES #17, no NQH3 tick file), and forward accumulation (about 21 sessions a month) yields well under one B session a month at the current rate. Resolving this means writing a v2 prereg with a redesigned classifier (data-derived vol-ratio floor, per-regime gates) evaluated by walk-forward on existing data, or accepting descriptive-only. Needs the user to choose whether B is worth a v2 at all.',
  sourceFile: 'scripts/macro_regime/prereg_retrospective_20261027.md', sourceDate: '2026-10-27',
});

await flagDecision({
  slug: 'macro_regime_C_after_null_what_next_20261027',
  decisionText: 'Regime C Phase 3 (pre-registered, one hold-out look) found no demonstrated edge for the reverse-breakout trigger: train mean -46.42/trade (CI excludes zero), hold-out -31.91 (CI crosses zero), both below the random-direction placebo; C is the worst regime for this trigger. Pending user decision on direction; the options are NOT equivalent: (a) stop here and treat C as closed as specified; (b) test the opposite hypothesis (continuation after a low-volume break) as a NEW prereg, which cannot use the C train or hold-out windows cleanly because both are burned for C, so it would need walk-forward or a descriptive-only label; (c) a different trigger on the same classifier, same window problem. Nothing is wired live and no parameter of the frozen Phase 3 config may change on this data (phase3_c.lock).',
  sourceFile: 'scripts/macro_regime/PHASE3_C_PREREG.md', sourceDate: '2026-10-27',
});
process.exit(0);
