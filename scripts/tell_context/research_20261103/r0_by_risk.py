"""Uncounted descriptive follow-up (ledger look r0_by_risk): R0 minus V1 by the size of the tell's own stop, from scratch/tell_context_20261103/tell_leg_profile_exit_rows.csv."""
import os, sys, numpy as np, pandas as pd
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
R = pd.read_csv(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'tell_leg_profile_exit_rows.csv')); A = R[R.r0_acted == True]
print(f'R0 acted on {len(A)} of {len(R)}; by the tell stop size (points): N, V1 mean net, R0 mean net, diff, V1 worst, R0 worst, median stop V1 / R0, share of trades where R0 stop was tighter')
for lab, m in (('under 50', A.v1_risk < 50), ('50 to 100', (A.v1_risk >= 50) & (A.v1_risk < 100)), ('over 100', A.v1_risk >= 100)):
    g = A[m]; print(f'  {lab:9s} N={len(g):4d}  V1 {g.v1_net.mean():+7.2f}  R0 {g.r0_net.mean():+7.2f}  diff {(g.r0_net - g.v1_net).mean():+7.2f}  worst {g.v1_net.min():+7.1f} / {g.r0_net.min():+7.1f}  median stop {g.v1_risk.median():5.0f} / {g.r0_stopdist.median():5.0f}  tighter in {100 * (g.r0_stopdist < g.v1_risk).mean():3.0f}%  win rate {100 * (g.v1_net > 0).mean():3.0f}% / {100 * (g.r0_net > 0).mean():3.0f}%')
big = A[A.v1_risk >= 100]; print(f'\nover 100 points: R0 stop as a share of the tell stop: median {(big.r0_stopdist / big.v1_risk).median():.2f}, p25 {(big.r0_stopdist / big.v1_risk).quantile(.25):.2f}, p75 {(big.r0_stopdist / big.v1_risk).quantile(.75):.2f}; V1 profit on these trades {big.v1_net.sum():+.0f} vs R0 {big.r0_net.sum():+.0f}')
