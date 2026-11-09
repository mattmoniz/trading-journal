"""Part A of docs/IB_TIGHTEN_LEVELS_PREREG_20261104.md: initial-balance extension day types as a state known during the day. Explore. Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/ib_daytype.py"""
import os, sys, json, glob, datetime
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from block_stats import bootdiff, auc, week_boot
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..')); ROOT = os.path.join(REPO, 'scratch', 'volbars500_full_20261028'); RTH0, RTH1 = 55800.0, 79200.0
F = json.load(open(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'b_d_formation_rows.json'))); rng = np.random.default_rng(127); TOL = 0.1
bim = np.array([F[d]['final']['bimod'] for d in F]); Q90, Q25 = float(np.quantile(bim, .9)), float(np.quantile(bim, .25))
def state(x_up, x_dn):
    su, sd = x_up > TOL, x_dn > TOL
    if not su and not sd: return 'NORMAL'
    if su and sd: return 'NEUTRAL'
    return 'VARIATION' if max(x_up, x_dn) <= 2.0 else 'TREND'
S = {}; rows = []
for p in sorted(glob.glob(ROOT + '/*.bars.tsv')):
    d = os.path.basename(p)[:10]
    if d > '2025-05-16' or d not in F: continue
    b = np.loadtxt(p, delimiter='\t', ndmin=2); end, h, l = b[:, 2], b[:, 4], b[:, 5]; rth = (end >= RTH0) & (end < RTH1); ib = rth & (end <= RTH0 + 3600)
    if rth.sum() < 100 or ib.sum() < 5: continue
    ibh, ibl = h[ib].max(), l[ib].min(); ibr = ibh - ibl
    if ibr <= 0: continue
    S[d] = dict(end=end, h=h, l=l, ibh=ibh, ibl=ibl, ibr=ibr)
    r = dict(d=d, wk=f'{d[:4]}-{datetime.date.fromisoformat(d).isocalendar()[1]}', letter=F[d]['final']['letter'], bim=F[d]['final']['bimod'], pb=F[d]['final']['letter'] != 'D', multi=F[d]['final']['bimod'] >= 0.365, ibr=ibr)
    r['sB'] = r['bim'] >= Q90; r['sD'] = r['bim'] <= Q25 and r['letter'] == 'D'
    for nm, t in (('11', 1.5), ('12', 2.5), ('13', 3.5)):
        m = rth & (end <= RTH0 + 3600 * t); xu = max(0.0, h[m].max() - ibh) / ibr; xd = max(0.0, ibl - l[m].min()) / ibr; r['x' + nm] = xu + xd; r['s' + nm] = state(xu, xd)
    dv = F[d]['dev'].get('12:00'); r['w12'] = (dv['state'] == 'BALANCE_CONFIRMED') if dv else False
    rows.append(r)
R = pd.DataFrame(rows); print(f'{len(R)} sessions; IB range median {R.ibr.median():.0f} pts; base rates: P/b {100*R.pb.mean():.0f}%, multi-hump {100*R.multi.mean():.0f}%, strong B {int(R.sB.sum())}, strong D {int(R.sD.sum())}')
print('\nSTATE FREQUENCIES and FINAL SHAPE by IB state at each time (uncounted)')
for nm, lab in (('11', '11:00'), ('12', '12:00'), ('13', '13:00')):
    print(f' at {lab}:')
    for st in ('NORMAL', 'VARIATION', 'TREND', 'NEUTRAL'):
        g = R[R['s' + nm] == st]
        if len(g): print(f'   {st:9s} N={len(g):4d} ({100*len(g)/len(R):3.0f}%)  letter D {100*(g.letter=="D").mean():3.0f}%  P/b {100*g.pb.mean():3.0f}%  multi-hump {100*g.multi.mean():3.0f}%  strongD {100*g.sD.mean():3.0f}%  strongB {100*g.sB.mean():3.0f}%' + ('  (N<20)' if len(g) < 20 else ''))
print('\nCOUNTED TESTS')
a = auc(R.x13, R.pb); c = week_boot(R, lambda d: auc(d.x13, d.pb), rng); print(f'  T1 AUC of total extension (IBR units) at 13:00 for P/b vs D: {a:.3f}  week-block CI [{c[0]:.3f}, {c[1]:.3f}]  (0.5 = nothing)')
Q = R[R.sB | R.sD].reset_index(drop=True)
f = lambda d: auc(-d.x12, d.sD) - auc(d.w12.astype(float), d.sD); c = week_boot(Q, f, rng)
print(f'  T2 strong D vs strong B at 12:00 (N={len(Q)}): AUC of IB state (-X) {auc(-Q.x12, Q.sD):.3f} vs the watcher BALANCE_CONFIRMED {auc(Q.w12.astype(float), Q.sD):.3f}; difference {f(Q):+.3f} week-block CI [{c[0]:+.3f}, {c[1]:+.3f}]')
L = pd.read_csv(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'tell_ladder_rows.csv')); L = L[L.end_sec >= RTH0 + 3600].copy(); st = []
for d, sg in zip(L.date, L.sig):
    s = S.get(d)
    if s is None: st.append(None); continue
    m = (s['end'] >= RTH0) & (s['end'] <= s['end'][int(sg)]); xu = max(0.0, s['h'][m].max() - s['ibh']) / s['ibr']; xd = max(0.0, s['ibl'] - s['l'][m].min()) / s['ibr']; st.append(state(xu, xd))
L['ibs'] = st; L = L[L.ibs.notna()]; L['dw'] = L['n2.0'] - L['n1.0']; a_, b_ = L[L.ibs == 'NORMAL'], L[L.ibs != 'NORMAL']
c = bootdiff(a_.dw.values, a_.date.values, b_.dw.values, b_.date.values, rng)
print(f'  T3 stop width (net at 2.0x minus 1.0x the node stop), entries from 10:30 on: IB-NORMAL at entry {a_.dw.mean():+.2f} (N={len(a_)}) vs other states {b_.dw.mean():+.2f} (N={len(b_)}): difference {a_.dw.mean() - b_.dw.mean():+.2f} day-block CI [{c[0]:+.1f}, {c[1]:+.1f}]')
print('\nTELL ENTRIES by IB state at entry (10:30 on): mean dollars per trade at stop multiples 0.5 / 1.0 / 2.0 / 3.0')
for s_ in ('NORMAL', 'VARIATION', 'TREND', 'NEUTRAL'):
    g = L[L.ibs == s_]
    if len(g): print(f'   {s_:9s} N={len(g):4d}  ' + '  '.join(f'm={m} {g[f"n{m}"].mean():+7.1f}' for m in (0.5, 1.0, 2.0, 3.0)) + ('  (N<20)' if len(g) < 20 else ''))
