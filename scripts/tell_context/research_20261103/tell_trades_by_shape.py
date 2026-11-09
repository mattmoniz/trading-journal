"""Tell trades (books A tell / B edge stop / C flip, explore window) split by the shape of the day. Pre-registration: docs/TELL_TRADES_BY_DAY_SHAPE_PREREG_20261103.md. Descriptive, hindsight; the live shadow-book code is reused (hr-022) via tell_replay_lib.
Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/tell_trades_by_shape.py"""
import os, sys, collections
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tell_replay_lib import replay_rows, F, TR, REPO
rng = np.random.default_rng(31); bim = np.array([F[d]['final']['bimod'] for d in F]); q90, q25 = float(np.quantile(bim, .9)), float(np.quantile(bim, .25))
R, bad = replay_rows()
R.to_csv(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'tell_trades_by_shape_rows.csv'), index=False); print(f'{len(TR)} tell trades in the file, {len(R)} replayed ({bad} without an entry bar). PARITY book A vs file net dollars: max abs diff {np.abs(R.A - R.csv_net).max():.4f}, mean diff {(R.A - R.csv_net).mean():+.4f}, trades differing by more than 0.01: {(np.abs(R.A - R.csv_net) > 0.01).sum()}')
print('label mix:', R.label.value_counts().to_dict())
R['strongB'] = R.bim >= q90; R['strongD'] = (R.bim <= q25) & (R.letter == 'D')
print(f'groups: final multi-hump {R.final_multi.sum()} trades on {R[R.final_multi].date.nunique()} days; strong B {R.strongB.sum()} / {R[R.strongB].date.nunique()}; strong D {R.strongD.sum()} / {R[R.strongD].date.nunique()}; developing flag seen at fire {R.seen_multi.sum()}; before first checkpoint {R.cp.isna().sum()}')
from block_stats import bootmean, bootdiff, grp as _grp, contrast as _contrast
grp = lambda df, col: _grp(df, col, rng)
contrast = lambda name, a_, b_, col: _contrast(name, a_, b_, col, rng)
BN = {'A': 'A tell', 'B': 'B edge stop', 'C': 'C flip AGAINST fires'}
print('\nALL tell trades:', {b: round(R[b].mean(), 2) for b in 'ABC'})
for b in 'ABC':
    print(f'\n=== BOOK {BN[b]} ===')
    for lab, mask in (('final multi-hump', R.final_multi), ('final NOT multi-hump', ~R.final_multi), ('strong B', R.strongB), ('strong D', R.strongD), ('developing flag seen at fire', R.seen_multi), ('no developing flag at fire', ~R.seen_multi)): print(f'  {lab:30s} {grp(R[mask], b)}')
    for lt in 'DPb': print(f'  final letter {lt:17s} {grp(R[R.letter == lt], b)}')
    print(contrast('K1 multi-hump minus not', R[R.final_multi], R[~R.final_multi], b)); print(contrast('K2 strong B minus strong D', R[R.strongB], R[R.strongD], b)); print(contrast('K3 flag seen at fire minus not', R[R.seen_multi], R[~R.seen_multi], b))
print('\n=== K4 book C, AGAINST fires only ===')
ag = R[R.label == 'AGAINST']
for lab, mask in (('final multi-hump', ag.final_multi), ('final NOT multi-hump', ~ag.final_multi), ('developing flag seen', ag.seen_multi), ('no flag seen', ~ag.seen_multi)): print(f'  {lab:24s} C flip {grp(ag[mask], "C")}   | A tell on the same fires {grp(ag[mask], "A")}')
print(contrast('K4 C: multi-hump minus not', ag[ag.final_multi], ag[~ag.final_multi], 'C'))
print('\nContext label x final multi-hump (book A / book C mean dollars, N):')
for lt in ('AGREES', 'AGAINST', 'NEUTRAL', 'UNKNOWN'):
    for fm in (True, False): g = R[(R.label == lt) & (R.final_multi == fm)]; print(f'  {lt:8s} multi-hump={fm!s:5s} N={len(g):4d} A {g.A.mean() if len(g) else float("nan"):+7.2f}  C {g.C.mean() if len(g) else float("nan"):+7.2f}')
