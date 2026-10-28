import { recordClaim } from '../record_claim.mjs';
await recordClaim({
  slug: 'macro_regime_classifier_train_audit_20261027',
  claimText: 'NQ Macro-Regime Auction Classifier, train-set frequency audit (scripts/macro_regime, prereg.lock hash becad7fc, window 2023-03-06..2026-10-26 pinned, 928 clean sessions, 556 train / 372 hold-out, hold-out table withheld). Train classified N=516: A 36.6%, D 44.0%, C 17.4%, B 1.9% (10 sessions). B+C = 19.38%, so the pre-committed verdict is PROCEED WITH UNDERPOWERED CAVEAT, DESCRIPTIVE_ONLY_NOT_CONFIRMATORY (projected hold-out B+C about 72, under 80). Regime A is under the 40% floor (report only). CAVEAT: the pooled B+C gate hides that Regime B is almost never armed; 90 of the 100 B+C sessions are Regime C. The B vol-ratio floor of 1.5 sits above the 90th percentile of the train vol-ratio distribution (1.26). No performance measured; this is a classifier-frequency audit only. compute_va_fn was cross-checked against the real JS computeProfile on 934 sessions, 0 mismatches.',
  sourceFile: 'scripts/macro_regime/run_20261027_201521.log',
  sourceDate: '2026-10-27',
  sampleSize: 516,
  rigorStatus: 'frequency_audit_only_no_pnl',
  status: 'PROVISIONAL',
});
process.exit(0);
