"""Hold-vs-flatten value by the state at a checkpoint (docs/HOLD_EXIT_STATE_PREREG_20261104.md). Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/hold_exit_state.py --window explore_sim|sealed [--phase 1|2]"""
import os, sys, argparse
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tell_replay_lib import replay_rows, REPO, T
from watcher_stop_lib import shown_of, ib_state_at
from block_stats import bootmean, bootdiff
ap = argparse.ArgumentParser(); ap.add_argument('--window', default='explore_sim'); ap.add_argument('--phase', type=int, default=0); a = ap.parse_args()
OUT = os.path.join(REPO, 'scratch', 'tell_context_20261103', f'hold_exit_rows_{a.window}.csv'); RTH0 = 55800.0; CPS = {'11:30': 2.0, '12:30': 3.0, '13:30': 4.0, '14:30': 5.0}; rng = np.random.default_rng(163)
def extra(S, allb, sig, t, ctxf):
    d = int(t['dir']); ei = int(t['ei']); xj = int(t['xj']); entry = float(S['o'][ei]) + d * T.SLIP; end = S['end']; sh = shown_of(S); out = {}
    for nm, hrs in CPS.items():
        tc = RTH0 + 3600 * hrs; kc = int(np.searchsorted(end, tc, 'right'))                     # first bar completing after t_c
        if kc >= len(end) or ei >= kc or xj < kc: out[nm + '_open'] = False; continue
        px = float(S['o'][kc]) - d * T.SLIP; flat = ((px - entry) * d) * T.DPP - T.COMM; st = sh[kc - 1]; fav = ('DRIVE_UP', 'DRIVE_UP_BUILDING') if d == 1 else ('DRIVE_DOWN', 'DRIVE_DOWN_BUILDING'); adv = ('DRIVE_DOWN', 'DRIVE_DOWN_BUILDING') if d == 1 else ('DRIVE_UP', 'DRIVE_UP_BUILDING')
        out.update({nm + '_open': True, nm + '_flat': flat, nm + '_ib': ib_state_at(S, kc - 1) or 'NA', nm + '_w': 'BAL' if st == 'BALANCE_CONFIRMED' else ('FAV' if st in fav else ('ADV' if st in adv else 'OTH')), nm + '_pl': float((S['c'][kc - 1] - entry) * d)})
    return out
if a.phase in (0, 1):
    R, bad = replay_rows(extra, window=a.window); R.to_csv(OUT, index=False); print(f'window {a.window}: {len(R)} entries on {R.date.nunique()} days; positions open: ' + ', '.join(f'{k} {int(R[k + "_open"].fillna(False).sum())}' for k in CPS))
    if a.phase == 1: sys.exit(0)
R = pd.read_csv(OUT); half_cut = R.date.sort_values().iloc[len(R) // 2]
def rows_at(nm):
    g = R[R[nm + '_open'].fillna(False).astype(bool)].copy(); g['hv'] = g.A - g[nm + '_flat']; g['ib'] = g[nm + '_ib']; g['w'] = g[nm + '_w']; g['pl'] = g[nm + '_pl']; g['half'] = np.where(g.date < half_cut, 1, 2); return g
def ci(x, days): return bootmean(np.asarray(x), days, rng, B=2000)
def contrast(name, a_, b_):
    if len(a_) < 20 or len(b_) < 20: print(f'  {name}: a group has N<20, no contrast'); return None
    c = bootdiff(a_.hv.values, a_.date.values, b_.hv.values, b_.date.values, rng); h = [a_[a_.half == k].hv.mean() - b_[b_.half == k].hv.mean() for k in (1, 2)]
    print(f'  {name}: {a_.hv.mean() - b_.hv.mean():+7.2f} (N {len(a_)} / {len(b_)})  day-block CI [{c[0]:+.1f}, {c[1]:+.1f}]  halves {h[0]:+.1f} / {h[1]:+.1f}'); return (a_.hv.mean() - b_.hv.mean(), c, h)
print('\nHOLD-VALUE (V1 net minus flatten-at-checkpoint net; positive = holding better), by checkpoint and state')
for nm in CPS:
    g = rows_at(nm); print(f' {nm}: {len(g)} open positions; mean HOLD {g.A.mean():+.2f} FLAT {g[nm + "_flat"].mean():+.2f} hold-value {g.hv.mean():+.2f}  | IB NORMAL {g[g.ib == "NORMAL"].hv.mean():+.2f} (N {int((g.ib == "NORMAL").sum())}) vs other {g[g.ib != "NORMAL"].hv.mean():+.2f} (N {int((g.ib != "NORMAL").sum())})  | watcher BAL {g[g.w == "BAL"].hv.mean():+.2f} (N {int((g.w == "BAL").sum())}) FAV {g[g.w == "FAV"].hv.mean():+.2f} ({int((g.w == "FAV").sum())}) ADV {g[g.w == "ADV"].hv.mean():+.2f} ({int((g.w == "ADV").sum())}) OTH {g[g.w == "OTH"].hv.mean():+.2f} ({int((g.w == "OTH").sum())})  | in profit {g[g.pl > 0].hv.mean():+.2f} (N {int((g.pl > 0).sum())}) in loss {g[g.pl <= 0].hv.mean():+.2f} ({int((g.pl <= 0).sum())})')
print('\nCOUNTED TESTS')
g = rows_at('12:30'); t1 = contrast('T1 IB NORMAL minus not-NORMAL at 12:30', g[g.ib == 'NORMAL'], g[g.ib != 'NORMAL']); t2 = contrast('T2 watcher BALANCE_CONFIRMED minus all other states at 12:30', g[g.w == 'BAL'], g[g.w != 'BAL']); contrast('T3 in profit minus in loss at 12:30 (reading, not part of the lead rule)', g[g.pl > 0], g[g.pl <= 0])
P = pd.concat([rows_at(nm).assign(cp=nm) for nm in CPS]); t4 = contrast('T4 IB NORMAL minus not-NORMAL, all four checkpoints pooled', P[P.ib == 'NORMAL'], P[P.ib != 'NORMAL'])
sg = lambda r: r is not None and (r[1][0] > 0 or r[1][1] < 0) and r[2][0] * r[2][1] > 0
cp_ok = {}
for nm in ('11:30', '13:30'):
    q = rows_at(nm); a_, b_ = q[q.ib == 'NORMAL'], q[q.ib != 'NORMAL']; cp_ok[nm] = (a_.hv.mean() - b_.hv.mean()) if len(a_) >= 20 and len(b_) >= 20 else np.nan
lead = (sg(t1) and np.sign(cp_ok['11:30']) == np.sign(t1[0]) and np.sign(cp_ok['13:30']) == np.sign(t1[0])) or (sg(t2) and True)
print(f'  T1 same sign at 11:30 / 13:30: {cp_ok}\n  => ' + ('LEAD (see the rule): a hold-out look may be spent once' if lead else 'NOT SHOWN: the lead rule is not met'))
