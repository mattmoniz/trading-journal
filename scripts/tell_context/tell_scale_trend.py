"""C1 follow-up (docs/TELL_SCALE_AND_TREND_PREREG_20261110.md): T1 forced scale-free stop replay, T2 with- vs against-trend. Stages: t1 (replay, writes scratch/tell_scale_trend_20261110/t1.csv) | t2 | report.
Usage: ulimit -v 4000000; python3 scripts/tell_context/tell_scale_trend.py t1 ; ... t2 ; ... report"""
import os, sys, glob, csv, collections
import numpy as np, pandas as pd
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')); OUT = os.path.join(REPO, 'scratch', 'tell_scale_trend_20261110'); os.makedirs(OUT, exist_ok=True)
R_EXP, R_LIVE = 0.108, 0.069
def boot(day_of, vals, B=3000, seed=1):
    """paired mean of vals with day-blocked resampling; returns mean, lo, hi, one-sided p (H1: mean > 0)."""
    days, inv = np.unique(day_of, return_inverse=True); s = np.bincount(inv, weights=vals); c = np.bincount(inv).astype(float); rng = np.random.default_rng(seed); n = len(days)
    idx = rng.integers(0, n, (B, n)); m = s[idx].sum(1) / c[idx].sum(1); return float(vals.mean()), float(np.percentile(m, 2.5)), float(np.percentile(m, 97.5)), float((1 + np.sum(m <= 0)) / (B + 1))
def boot_diff(day_of, vals, grp, B=3000, seed=2):
    """mean(vals | grp) - mean(vals | ~grp), day-blocked; H1: > 0."""
    days, inv = np.unique(day_of, return_inverse=True); n = len(days)
    sa = np.bincount(inv, weights=vals * grp, minlength=n); ca = np.bincount(inv, weights=grp.astype(float), minlength=n); sb = np.bincount(inv, weights=vals * ~grp, minlength=n); cb = np.bincount(inv, weights=(~grp).astype(float), minlength=n)
    rng = np.random.default_rng(seed); idx = rng.integers(0, n, (B, n)); m = sa[idx].sum(1) / ca[idx].sum(1) - sb[idx].sum(1) / cb[idx].sum(1); d0 = vals[grp].mean() - vals[~grp].mean()
    return float(d0), float(np.percentile(m, 2.5)), float(np.percentile(m, 97.5)), float((1 + np.sum(m <= 0)) / (B + 1))
def t1():
    HERE = os.path.join(REPO, 'scripts', 'vacuum_sim'); sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(REPO, 'scripts', 'tell_context', 'research_20261103'))
    from exit_lock_common import load_adr
    import tell_replay_lib as TRL
    from watcher_stop_lib import run_dyn
    T = TRL.T; ADR = load_adr()
    def extra(S, allb, sig, trd, ctxf):
        ctx = S['_ctx']; d = int(trd['dir']); ei = int(trd['ei']); risk = float(trd['risk']); end_i = S['end'][sig]; date = trd['date']
        run = lambda sd: run_dyn(ctx, T.Prof(ctx), ei, d, sd, end_i)[0]
        b = run(risk); out = dict(adr20=ADR.get(date), base_net=b['net'], base_why=b['reason'], risk_pts=risk)
        if date in ADR:
            for nm, rt in (('EXP', R_EXP), ('LIVE', R_LIVE)): r = run(rt * ADR[date]); out[f'{nm}_net'] = r['net']; out[f'{nm}_why'] = r['reason']; out[f'{nm}_stop'] = rt * ADR[date]
        return out
    R, bad = TRL.replay_rows(extra); R = R[R.adr20.notna()].copy(); nd = int((np.abs(R['base_net'] - R['csv_net']) > 0.01).sum()); assert nd == 0, f'parity failed {nd}'
    R.to_csv(os.path.join(OUT, 't1.csv'), index=False); print(f'T1 replay written: {len(R)} trades; unforced parity with the stored net exact; bad {bad}')
def sess_stats():
    rows = []
    for p in sorted(glob.glob(os.path.join(REPO, 'scratch', 'volbars500_full_20261028', '*.bars.tsv'))):
        d = os.path.basename(p)[:10]
        if d > '2025-05-16': continue
        h = l = c = None
        for ln in open(p):
            q = ln.rstrip('\n').split('\t')
            if len(q) < 12 or q[11] != '1' or float(q[7]) != 500: continue
            st, en = float(q[1]), float(q[2])
            if st >= 55800.0 and en <= 79200.0: h = float(q[4]) if h is None else max(h, float(q[4])); l = float(q[5]) if l is None else min(l, float(q[5])); c = float(q[6])
        if c is not None: rows.append((d, h - l, c))
    return pd.DataFrame(rows, columns=['d', 'rng', 'close'])
def trend_table():
    s = sess_stats(); s['adr20'] = [np.nan] * len(s); a = []
    for i in range(len(s)): a.append(float(np.mean(s.rng.iloc[max(0, i - 20):i])) if i >= 10 else np.nan)
    s['adr20'] = a; s['trend'] = [(s.close.iloc[i - 1] - s.close.iloc[i - 21]) / s.adr20.iloc[i] if i >= 21 and not np.isnan(s.adr20.iloc[i]) else np.nan for i in range(len(s))]
    cl = []; prior = []
    for v in s.trend:
        if np.isnan(v): cl.append('NA'); continue
        if len(prior) >= 60: lo, hi = np.percentile(prior, [100 / 3, 200 / 3]); cl.append('DOWN' if v <= lo else 'UP' if v >= hi else 'FLAT')
        else: cl.append('NA')
        prior.append(v)
    s['cls'] = cl; return s
def t2():
    s = trend_table(); T = pd.read_csv(os.path.join(OUT, 't1.csv')).merge(s[['d', 'trend', 'cls']], left_on='date', right_on='d', how='left')
    T['with'] = ((T.cls == 'UP') & (T.dir == 1)) | ((T.cls == 'DOWN') & (T.dir == -1)); T['against'] = ((T.cls == 'UP') & (T.dir == -1)) | ((T.cls == 'DOWN') & (T.dir == 1))
    T.to_csv(os.path.join(OUT, 't2.csv'), index=False); s.to_csv(os.path.join(OUT, 'trend_by_session.csv'), index=False); print('T2 table written; classes:', dict(collections.Counter(T.cls.fillna('NA'))))
def report():
    T = pd.read_csv(os.path.join(OUT, 't2.csv')); print(f'{len(T)} explore trades on {T.date.nunique()} days; unforced mean {T.base_net.mean():+.2f}; stop-out rate (reason STOP / STOP_GAP) unforced {np.mean(T.base_why.isin(["STOP", "STOP_GAP"])):.1%}')
    print('\nT1 SCALE-FREE STOP (forced initial stop, V1 management otherwise):')
    for nm in ('EXP', 'LIVE'): print(f'   R_{nm}: stop {np.median(T[nm + "_stop"]):.1f} pt median, mean net {T[nm + "_net"].mean():+.2f} $/trade, stop-out rate {np.mean(T[nm + "_why"].isin(["STOP", "STOP_GAP"])):.1%}, win rate {np.mean(T[nm + "_net"] > 0):.1%}')
    dif = (T.EXP_net - T.LIVE_net).values; m, lo, hi, p = boot(T.date.values, dif, seed=11)
    print(f'   COUNTED paired R_EXP - R_LIVE = {m:+.2f} $/trade [{lo:+.2f}, {hi:+.2f}] day-blocked, one-sided p {p:.4f}; share of the 31.5 dollar live gap = {m / 31.52:.0%}')
    print('\nT2 TREND DIRECTION (expanding terciles of the prior-20-session trend in ADR20 units):')
    print('   classes:', dict(collections.Counter(T.cls.fillna('NA'))))
    for c in ('UP', 'FLAT', 'DOWN'):
        for dd, nm in ((1, 'long'), (-1, 'short')):
            g = T[(T.cls == c) & (T.dir == dd)]
            if len(g): print(f'   {c:5s} {nm:5s} N {len(g):4d} on {g.date.nunique():3d} days mean {g.base_net.mean():+8.2f} $/trade, win rate {np.mean(g.base_net > 0):.0%}')
    U = T[T['with'] | T['against']]; w = U['with'].values; nw, na = int(w.sum()), int((~w).sum()); dw, da = U[U['with']].date.nunique(), U[U['against']].date.nunique()
    d0, lo, hi, p = boot_diff(U.date.values, U.base_net.values, w, seed=12)
    print(f'   COUNTED WITH minus AGAINST: WITH N {nw} on {dw} days mean {U[U["with"]].base_net.mean():+.2f}; AGAINST N {na} on {da} days mean {U[U["against"]].base_net.mean():+.2f}; D = {d0:+.2f} [{lo:+.2f}, {hi:+.2f}] day-blocked, one-sided p {p:.4f}; power gate (>=100 per arm on >=60 days): {"MET" if min(nw, na) >= 100 and min(dw, da) >= 60 else "NOT MET"}')
    print('   by year within WITH / AGAINST:', {y: (round(float(g[g["with"]].base_net.mean()), 1), round(float(g[g["against"]].base_net.mean()), 1)) for y, g in U.groupby(U.date.str[:4])})
    # live book classification with the final explore terciles
    s = pd.read_csv(os.path.join(OUT, 'trend_by_session.csv')); lo3, hi3 = np.percentile(s.trend.dropna(), [100 / 3, 200 / 3])
    lc = pd.read_csv(os.path.join(REPO, 'scratch', 'tell_live_gap_c1_rth_closes_20261110.csv')); rg = pd.read_csv(os.path.join(REPO, 'scratch', 'tell_live_gap_c1_rth_ranges_20261110.csv')).merge(lc, on='d'); rg = rg.reset_index(drop=True)
    lv = pd.read_csv(os.path.join(REPO, 'scratch', 'tell_live_gap_c1_live_book_20261110.csv')); out = {}
    for d in sorted(lv.d.unique()):
        i = int(rg.index[rg.d == d][0]); adr = float(rg.rng.iloc[max(0, i - 20):i].mean()); tr = (rg.c.iloc[i - 1] - rg.c.iloc[i - 21]) / adr; out[d] = ('DOWN' if tr <= lo3 else 'UP' if tr >= hi3 else 'FLAT', round(float(tr), 2))
    print('\n   live dates, trend class (explore terciles %.2f / %.2f):' % (lo3, hi3), out)
    lv['cls'] = lv.d.map(lambda d: out[d][0]); print('   live book by class and direction:', {(c, dd): (int(len(g)), round(float(g.net.mean()), 1)) for (c, dd), g in lv.groupby(['cls', 'direction'])})
if __name__ == '__main__':
    st = sys.argv[1] if len(sys.argv) > 1 else ''
    {'t1': t1, 't2': t2, 'report': report}.get(st, lambda: print(__doc__))()
