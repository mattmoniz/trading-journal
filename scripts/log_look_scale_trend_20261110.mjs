import { logLook } from './lib/look_ledger.mjs';
console.log('LOOK_ID', await logLook({ family: 'tell_scale_trend_20261110', dataWindow: 'explore_2023-03-07..2025-05-16', kind: 'EXPLORE', tests: 2,
  label: 'C1 follow-up: T1 forced scale-free stop (0.108 vs 0.069 x ADR20) and T2 with- vs against-trend (prior-20-session trend terciles) on the 1,750 explore tell trades', script: 'scripts/tell_context/tell_scale_trend.py', prereg: 'docs/TELL_SCALE_AND_TREND_PREREG_20261110.md', claimSlug: 'tell_scale_trend_20261110', outcome: 'RUN_PENDING' })); process.exit(0);
