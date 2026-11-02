import { recordClaim } from '../record_claim.mjs';
await recordClaim({
  slug: 'last30_momentum_not_shown_20261102',
  claimText: 'Last-30-minute momentum/reversal (docs/LAST30_MOMENTUM_PREREG_20261102.md committed before the script; look id 88; 463 explore RTH days, hold-out untouched; 3 counted tests). Spearman of the 15:30-16:00 move (SD 48 points, mean -1.0) with: first 30 minutes -0.011 (CI -0.110..+0.085, p 0.81), open-to-15:30 -0.062 (CI -0.159..+0.038, p 0.18), 15:00-15:30 -0.049 (CI -0.151..+0.053, p 0.30); none survives BH; halves and years all lean slightly negative for f2 and f3 (a weak reversal tendency: -0.10/-0.04/-0.08 for 2023/2024/2025) but inside the noise. Resolution: correlation half-width 0.093 against a break-even of 0.032, so only a large relationship could have been seen. Gross of trading the sign in the strong third (N 156): +0.2, -3.4, +3.0 points, inconsistent signs, none dependable. READING: no large last-30-minute continuation or reversal tied to the day so far; a small reversal lean is not excluded and not resolvable here. NOT SHOWN: effects below about 0.09 correlation, other horizons, the hold-out (unspent).',
  sourceFile: 'scripts/range_budget/run_last30_output.txt', sourceDate: '2026-11-02', sampleSize: 463, rigorStatus: 'explore_only_null_resolution_stated', status: 'PROVISIONAL',
});
process.exit(0);
