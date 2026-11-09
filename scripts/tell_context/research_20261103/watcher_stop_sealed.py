"""IB-state initial stop width + watcher tighten (docs/IB_TIGHTEN_LEVELS_PREREG_20261104.md part B, amended). Arms on the same tell entries: A0 static node stop (V1); A2 tighten-only on an adverse drive (THE PRIMARY); AIB initial stop 2.0 x the node distance (capped at 100 pts) when the IB state at the signal bar is NORMAL, else 1.0 x, no tightening; AC = AIB + the tighten. Always a stop.
Usage: ulimit -v 4000000; venv/bin/python watcher_stop_sealed.py --phase 1|2 --window explore_sim|sealed   (phase 1 replays and saves rows; exit 3 = INCONCLUSIVE IN ADVANCE; the node wrapper spends the sealed look between the phases)"""
import os, sys, argparse, json
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tell_replay_lib import replay_rows, REPO, T
from watcher_stop_lib import run_dyn, shown_of, ib_state_at
from block_stats import bootmean
ap = argparse.ArgumentParser(); ap.add_argument('--phase', type=int, required=True); ap.add_argument('--window', default='sealed'); a = ap.parse_args()
OUT = os.path.join(REPO, 'scratch', 'tell_context_20261103', f'watcher_stop_sealed_rows_{a.window}.csv'); SDF = os.path.join(REPO, 'scratch', 'tell_context_20261103', 'watcher_stop_sealed_sd.json'); rng = np.random.default_rng(131)
def extra(S, allb, sig, t, ctxf):
    ctx = S['_ctx']; d = int(t['dir']); ei = int(t['ei']); s = float(t['risk']); end_i = S['end'][sig]; sh = shown_of(S); real = lambda j: sh[j]; ibs = ib_state_at(S, sig); m_ib = 2.0 if ibs == 'NORMAL' else 1.0; out = dict(ibs=ibs or 'NA', s=s)
    for nm, kw in (('A0', dict()), ('A2', dict(state_at=real, tighten=True)), ('AIB', dict(mult0=m_ib)), ('AC', dict(state_at=real, mult0=m_ib, tighten=True))):
        tr, w, k = run_dyn(ctx, T.Prof(ctx), ei, d, s, end_i, **kw); out[nm] = tr['net']; out[nm + '_t'] = bool(k); out[nm + '_r'] = tr['reason']
    out['A2silent'] = run_dyn(ctx, T.Prof(ctx), ei, d, s, end_i, state_at=lambda j: 'UNKNOWN', tighten=True)[0]['net']          # equivalence check: a tighten rule that never fires must equal the static stop
    return out
if a.phase == 1:
    R, bad = replay_rows(extra, window=a.window); R.to_csv(OUT, index=False)
    chk = f'; PARITY A0 vs the file: max |diff| {np.abs(R.A0 - R.csv_net).max():.4f}' if a.window == 'explore_sim' else ''
    sd = json.load(open(SDF))['sd']                                  # frozen: the explore per-entry spread of A2 - A0 (the primary is the tighten-only arm)
    n = len(R); de = json.load(open(SDF))['de']; mde = 2.8 * sd / np.sqrt(n) * de        # x the explore design effect (day-block SE / iid SE): same-day entries are correlated (DeepSeek round R)
    print(f'window {a.window}: {R.date.nunique()} sessions with entries, {n} entries ({bad} without an entry bar){chk}; SILENT-STATE equivalence (tighten rule with a state that never fires vs static): max |diff| {np.abs(R.A2silent - R.A0).max():.4f}; entries with the IB state NORMAL at the signal bar (initial stop 2.0 x, capped): {int((R.ibs == "NORMAL").sum())}; with the IB not yet complete (before 10:30): {int((R.ibs == "NA").sum())}; tightened under AC: {int(R.AC_t.sum())}, under A2: {int(R.A2_t.sum())}')
    print(f'  detectable mean difference (primary A2 - A0) about {mde:.2f} dollars/entry (sd {sd:.1f}, N {n}, design effect {de:.2f})')
    lim = json.load(open(SDF)).get('limit')
    if a.window == 'sealed' and lim is not None and mde > lim: print(f'  INCONCLUSIVE IN ADVANCE (above {lim}): the sealed look will NOT be spent'); sys.exit(3)
    sys.exit(0)
R = pd.read_csv(OUT)
if len(R) == 0: sys.exit('no rows for this window')
R['half'] = np.where(R.date < R.date.sort_values().iloc[len(R) // 2], 1, 2)
def ci(x, days): return bootmean(np.asarray(x), days, rng, B=2000)
print(f'{len(R)} entries, window {a.window}')
print('\nARMS: mean dollars per entry, win rate, average loser, worst loss')
for nm in ('A0', 'A2', 'AIB', 'AC'):
    x = R[nm]; c = ci(x.values, R.date.values); l = x[x <= 0]; print(f'  {nm:4s} mean {x.mean():+7.2f} CI [{c[0]:+.1f}, {c[1]:+.1f}]  WR {100*(x>0).mean():3.0f}%  avgL {l.mean():+7.1f}  worst {x.min():+8.1f}  losses over $300: {int((x < -300).sum())}')
print('\nPAIRED DIFFERENCES vs A0 (day-block CI; halves = first / second half of the window)')
res = {}
for nm in ('A2', 'AC', 'AIB'):
    d = R[nm] - R.A0; c = ci(d.values, R.date.values); h1, h2 = d[R.half == 1].mean(), d[R.half == 2].mean(); res[nm] = (d.mean(), c, h1, h2); print(f'  {nm} - A0: {d.mean():+.2f}  CI [{c[0]:+.2f}, {c[1]:+.2f}]   halves {h1:+.2f} / {h2:+.2f}')
ok = dict(ci_lower_above_0=res['A2'][1][0] > 0, positive_in_both_halves=min(res['A2'][2], res['A2'][3]) > 0, worst_loss_not_larger=float(R.A2.min()) >= float(R.A0.min()) - 1e-9)
print('\nPRIMARY (tighten-only A2 - A0; AC and AIB are context) conditions:', ok); print('=> ' + (f'CONFIRMED on the {a.window} window (all pre-registered conditions met)' if all(ok.values()) else f'NOT CONFIRMED on the {a.window} window (failed: ' + ', '.join(k for k, v in ok.items() if not v) + ')') + ('' if a.window == 'sealed' else '  [explore: design evidence only, not a confirmation]'))
print('\nBY IB STATE AT THE SIGNAL BAR (mean dollars per entry): A0 / A2 / AIB / AC')
for st in ('NORMAL', 'VARIATION', 'TREND', 'NEUTRAL', 'NA'):
    g = R[R.ibs == st]
    if len(g): print(f'  {st:9s} N={len(g):4d}  ' + '  '.join(f'{nm} {g[nm].mean():+7.1f}' for nm in ('A0', 'A2', 'AIB', 'AC')) + ('  (N<20)' if len(g) < 20 else ''))
