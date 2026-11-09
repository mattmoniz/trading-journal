"""Sealed / regression run of the flip time-of-day test (docs/FLIP_TIME_OF_DAY_SEALED_PREREG_20261103.md). Phases (called by flip_time_sealed.mjs which spends the sealed look between them):
  --phase1 replay the window (tell simulation + shadow books), save the rows, print counts + the detectable effect (exit 3 = INCONCLUSIVE IN ADVANCE, look NOT spent); --phase2 read the saved rows and print the verdict.  --window sealed | explore_sim"""
import os, sys, argparse
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tell_replay_lib import replay_rows, RTH0, REPO
from block_stats import bootmean, bootdiff
ap = argparse.ArgumentParser(); ap.add_argument('--phase', type=int, required=True); ap.add_argument('--window', default='sealed'); a = ap.parse_args()
OUT = os.path.join(REPO, 'scratch', 'tell_context_20261103', f'flip_time_rows_{a.window}.csv'); CUT_SEC = RTH0 + 9000; SD, MDE_LIMIT = 166.7, 44.4; rng = np.random.default_rng(41)        # amendment A1: limit = the explore late-GAP estimate; the primary is the LATE gap alone; rng = np.random.default_rng(41)
if a.phase == 1:
    R, bad = replay_rows(window=a.window); R.to_csv(OUT, index=False)
    ag = R[R.label == 'AGAINST']; ne, nl = int((ag.end_sec < CUT_SEC).sum()), int((ag.end_sec >= CUT_SEC).sum()); mde_diff = 2.8 * SD * np.sqrt(1 / max(ne, 1) + 1 / max(nl, 1)); mde = 2.8 * SD / np.sqrt(max(nl, 1))
    print(f'window {a.window}: {R.date.nunique()} sessions with fires ({R.date.min()}..{R.date.max()}), {len(R)} fires ({bad} without an entry bar); labels {R.label.value_counts().to_dict()}; AGAINST fires early (<12:00) {ne}, late (>=12:00) {nl}')
    print(f'  detectable LATE gap (amended primary) about {mde:.1f} dollars (sd {SD}; the original early-minus-late test would need {mde_diff:.1f}) ->  ' + (f'INCONCLUSIVE IN ADVANCE (above {MDE_LIMIT}): the sealed look will NOT be spent' if mde > MDE_LIMIT else f'testable (at or below {MDE_LIMIT})'))
    sys.exit(3 if (mde > MDE_LIMIT and a.window == 'sealed') else 0)
R = pd.read_csv(OUT); ag = R[R.label == 'AGAINST'].copy(); ag['gap'] = ag.C - ag.A; ag['late'] = ag.end_sec >= CUT_SEC; e, l = ag[~ag.late], ag[ag.late]
def ci_mean(g): return bootmean(g.gap.values, g.date.values, rng)
ce, cl = ci_mean(e), ci_mean(l); cd = bootdiff(e.gap.values, e.date.values, l.gap.values, l.date.values, rng); diff = e.gap.mean() - l.gap.mean()
med = ag.date.sort_values().iloc[len(ag) // 2]; halves = [(h, ag[(ag.date < med) == (h == 1)]) for h in (1, 2)]; hd = [x[~x.late].gap.mean() - x[x.late].gap.mean() for _, x in halves]
med = ag.date.sort_values().iloc[len(ag) // 2]; hl = [l[(l.date < med) == (h == 1)].gap.mean() for h in (1, 2)]
print(f'\nPRIMARY (amendment A1; AGAINST fires from 12:00, flip minus tell, dollars/trade): N={len(l)} mean {l.gap.mean():+.2f} day-block CI [{cl[0]:+.1f}, {cl[1]:+.1f}]   halves (split at {med}): {hl[0]:+.1f} / {hl[1]:+.1f}')
ok = dict(ci_upper_below_0=cl[1] < 0, negative_in_both_halves=max(hl) < 0)
print('conditions:', ok); print('=> ' + (f'CONFIRMED on the {a.window} window (both pre-registered conditions met)' if all(ok.values()) else f'NOT CONFIRMED on the {a.window} window (failed: ' + ', '.join(k for k, v in ok.items() if not v) + '; at about 50 percent power this may be inconclusive, not a refutation)') + ('' if a.window == 'sealed' else '  [regression check only, not a confirmation]'))
print(f'\nSECONDARY (counted): early (before 12:00) N={len(e)} {e.gap.mean():+.2f} CI [{ce[0]:+.1f}, {ce[1]:+.1f}];  early minus late (the original test) {diff:+.2f} CI [{cd[0]:+.1f}, {cd[1]:+.1f}]')
cg = bootmean(ag.gap.values, ag.date.values, rng); print(f'  all-day AGAINST flip minus tell: N={len(ag)} {ag.gap.mean():+.2f} CI [{cg[0]:+.1f}, {cg[1]:+.1f}]')
na = R[R.label != 'AGAINST'].copy(); na['late'] = na.end_sec >= CUT_SEC; print(f'CONTROL (uncounted), tell mean on NON-AGAINST fires: early N={int((~na.late).sum())} {na[~na.late].A.mean():+.2f}   late N={int(na.late.sum())} {na[na.late].A.mean():+.2f}')
print('\nDESCRIPTIVE: AGAINST fires, tell / flip means')
for lab, g in (('early', e), ('late', l)): print(f'  {lab:5s} N={len(g):3d} tell {g.A.mean():+7.2f}  flip {g.C.mean():+7.2f}')
ag['hr'] = ((ag.end_sec - RTH0) // 3600).astype(int) + 9
for h, g in ag.groupby('hr'): print(f'  hour {h}:00  N={len(g):3d} tell {g.A.mean():+7.2f} flip {g.C.mean():+7.2f}')
