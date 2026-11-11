"""Vacuum ML stop / exit (docs/VACUUM_ML_STOP_EXIT_PREREG_20261110.md). Stages: build (one pass over explore, writes scratch/vacuum_ml_20261110/{trades,states}.csv) | v1 (stop distance) | v2 (exit: gate first). Use venv python (lightgbm).
Usage: ulimit -v 4000000; venv/bin/python scripts/vacuum_sim/vacuum_ml.py build ; ... v1 ; ... v2"""
import os, sys, glob, collections
import numpy as np, pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import globex_roc3_test as G
from unified_exit_lock import sim_vac
Fm, VM, SH = G.Fm, G.v2, G.SH
OUT = os.path.join(G.ROOT, 'scratch', 'vacuum_ml_20261110'); os.makedirs(OUT, exist_ok=True)
MULTS = (1.5, 2.0, 2.5, 3.5); COST = 2.0
def build():
    files = sorted(p for p in glob.glob(os.path.join(Fm.BARS, '*.bars.tsv')) if os.path.basename(p)[:10] <= Fm.LAST_EXPLORE)
    hist = {'RTH': [], 'GBX': []}; prevS = None; trades = []; states = []; tid = 0; maxdiff = 0.0
    for p in files:
        S = Fm.load_full(p)
        if S is None: continue
        tsp = Fm.track_split(S); close = Fm.EARLY_CLOSE if S['date'] in Fm.EARLY else Fm.CLOSE; prs = {}
        for name in ('RTH', 'GBX'):
            prev = hist[name][-Fm.K_PRIOR:]
            if len(prev) >= Fm.K_PRIOR: prs[name] = Fm.priors_of(prev)
        if len(prs) == 2:
            rt = hist['RTH'][-20:]; adr20 = float(np.mean([T['h'].max() - T['l'].min() for T in rt])) if len(rt) >= 10 else np.nan
            P, n0, reset = VM.continuous(prevS, S); n = len(P['c']); Fm.L_ROC = 10; F = VM.feats(P, n0, reset, prs, close); etr = Fm.ema(F['tr']); en, o, h, l, c = P['en'], P['o'], P['h'], P['l'], P['c']
            idx = np.arange(n); z = F['zroc']; roc = F['roc']; ok = (idx >= n0) & ~np.isnan(z); prev_ok = np.r_[False, ~np.isnan(z[:-1])]; dd = np.where(roc > 0, 1, np.where(roc < 0, -1, 0))
            on0 = SH.onset(~np.isnan(z) & (np.abs(z) > Fm.Z_ROC) & (np.sign(z) == dd)) & prev_ok
            gw = ok & (en <= 55500.0); rw = ok & (en >= 56100.0) & (en <= close - 600.0); lock = {'GBX': -1, 'RTH': -1}; hr = Fm.hour_et(en); dl = P['ask'] - P['bid']; d3 = np.full(n, np.nan); d3[2:] = dl[2:] + dl[1:-1] + dl[:-2]; dow = pd.Timestamp(S['date']).dayofweek
            for a in np.where(on0 & (gw | rw))[0]:
                tr = 'GBX' if gw[a] else 'RTH'
                if a < lock[tr]: continue
                lock[tr] = a + 30; s = int(dd[a]); lim = G.LIM if tr == 'GBX' else close - 300.0; inside = n0 + np.where(en[n0:] <= lim)[0]; flat = int(inside.max()) if len(inside) else -1; ei = a + 1
                if ei > flat or ei >= n: continue
                last = min(a + 30, flat); e = float(etr[a]); sd = 2.5 * e; entry = float(o[ei]); nets = [sim_vac(o, h, l, c, ei, last, s, m * e, None)[0] for m in MULTS]; base = nets[MULTS.index(2.5)]
                oc = SH.calc_outcome(en, o, h, l, c, a, s, e, lim, n, n0=n0)
                if oc is not None and not isinstance(oc, tuple): maxdiff = max(maxdiff, abs(oc['net_stop25'] - base))
                tid += 1; clv = (c[a] - l[a]) / (h[a] - l[a]) if h[a] > l[a] else 0.5
                trades.append(dict(tid=tid, date=S['date'], track=tr, s=s, a=a, ei=ei, last=last, **{f'n{m}': v for m, v in zip(MULTS, nets)}, absz=abs(float(z[a])), zr=float(F['zr'][a]), pace=float(F['pace'][a]), acc=float(F['acc'][a]), clv=float(clv if s == 1 else 1 - clv),
                                   d3=float(d3[a] * s), vol=e / adr20 if adr20 == adr20 and adr20 > 0 else np.nan, hour=int(hr[a]), dow=dow))
                # exit states: completed bars j while the baseline (stop 2.5) is still alive
                stop = entry - s * sd; best = 0.0
                for j in range(ei, last):
                    if (s == 1 and l[j] <= stop) or (s == -1 and h[j] >= stop): break
                    best = max(best, s * ((float(h[j]) if s == 1 else float(l[j])) - entry) / sd); exc = s * (float(c[j]) - entry) / sd; exit_net = s * ((float(o[j + 1]) - s * 0.25) - entry) - COST
                    states.append(dict(tid=tid, date=S['date'], track=tr, j=j - ei + 1, exc=exc, best=best, give=best - exc, bars=j - ei + 1, zn=float(z[j] * s) if not np.isnan(z[j]) else np.nan, dz=float((z[j] - z[a]) * s) if not np.isnan(z[j]) and not np.isnan(z[a]) else np.nan,
                                       acc=float(F['acc'][j]), d1=float(dl[j] * s), d3=float(d3[j] * s) if not np.isnan(d3[j]) else np.nan, clv=float(((c[j] - l[j]) / (h[j] - l[j]) if h[j] > l[j] else 0.5) if s == 1 else 1 - ((c[j] - l[j]) / (h[j] - l[j]) if h[j] > l[j] else 0.5)), hour=int(hr[j]), exit_net=exit_net, base_final=base))
        for name, T in tsp.items(): hist[name].append(T)
        prevS = S
    assert maxdiff <= 0.0051, f'baseline vs calc_outcome max diff {maxdiff}'
    pd.DataFrame(trades).to_csv(os.path.join(OUT, 'trades.csv'), index=False); pd.DataFrame(states).to_csv(os.path.join(OUT, 'states.csv'), index=False)
    print(f'built {len(trades)} trades ({collections.Counter(t["track"] for t in trades)}), {len(states)} states; baseline parity max diff {maxdiff:.4f}')
import lightgbm as lgb
PARAMS = dict(n_estimators=100, learning_rate=0.05, max_depth=3, num_leaves=8, min_child_samples=100, verbose=-1, random_state=1, n_jobs=2)
F1 = ['absz', 'zr', 'pace', 'acc', 'clv', 'd3', 'vol', 'hour', 'dow']; F2 = ['exc', 'best', 'give', 'bars', 'zn', 'dz', 'acc', 'd1', 'd3', 'clv', 'hour']; F2B = ['exc', 'bars']
def boot(day_of, vals, B=3000, seed=1):
    days, inv = np.unique(day_of, return_inverse=True); s = np.bincount(inv, weights=vals); c = np.bincount(inv).astype(float); rng = np.random.default_rng(seed); n = len(days)
    idx = rng.integers(0, n, (B, n)); m = s[idx].sum(1) / c[idx].sum(1); return float(vals.mean()), float(np.percentile(m, 2.5)), float(np.percentile(m, 97.5)), float((1 + np.sum(m <= 0)) / (B + 1))
def quarters(dates):
    q = pd.PeriodIndex(pd.to_datetime(dates), freq='Q').astype(str); return np.array(q)
def qstart(q): return pd.Period(q, freq='Q').start_time
def folds(df, minrows):
    """yield (quarter, train_idx, test_idx) with a 1-day embargo; the first quarters without enough training rows are skipped."""
    q = quarters(df.date.values); dts = pd.to_datetime(df.date.values)
    for qq in sorted(set(q)):
        tr = np.where(dts < qstart(qq) - pd.Timedelta(days=1))[0]; te = np.where(q == qq)[0]
        if len(tr) >= minrows and len(te): yield qq, tr, te
def v1(perm=0):
    T = pd.read_csv(os.path.join(OUT, 'trades.csv')); cols = [f'n{m}' for m in MULTS]; res = {}
    for tr in ('RTH', 'GBX'):
        D = T[T.track == tr].reset_index(drop=True); rows = []
        for qq, a, b in folds(D, 1000):
            X = D.loc[a, F1]; Y = D.loc[a, cols].values; best_c = int(np.argmax(Y.mean(0)))
            pred = np.column_stack([lgb.LGBMRegressor(**PARAMS).fit(X, Y[:, k]).predict(D.loc[b, F1]) for k in range(len(MULTS))]); pick = pred.argmax(1); O = D.loc[b, cols].values
            for r, i in enumerate(b): rows.append((D.date[i], O[r, pick[r]], O[r, best_c], O[r, MULTS.index(2.5)], pick[r], qq))
        R = pd.DataFrame(rows, columns=['date', 'pick', 'const', 'live', 'k', 'q']); res[tr] = R
        d = (R.pick - R.const).values; m, lo, hi, p = boot(R.date.values, d, seed=21 if tr == 'RTH' else 22); nd = R.date.nunique()
        dl = (R.pick - R.live).values; ml, llo, lhi, _ = boot(R.date.values, dl, seed=23)
        print(f'\nML-V1 {tr}: test trades {len(R)} on {nd} days, quarters {R.q.nunique()}; power gate {"MET" if len(R) >= 100 and nd >= 60 else "NOT MET"}')
        print(f'   COUNTED policy minus best-constant (train-chosen): {m:+.3f} pt/trade [{lo:+.3f}, {hi:+.3f}], one-sided p {p:.4f}   | policy mean {R.pick.mean():+.3f}, best-constant mean {R.const.mean():+.3f}, live m 2.5 mean {R.live.mean():+.3f}')
        print(f'   descriptive: policy minus live 2.5 {ml:+.3f} [{llo:+.3f}, {lhi:+.3f}]; share of trades off 2.5: {np.mean(R.k != MULTS.index(2.5)):.0%}; picks {dict(collections.Counter(R.k.map(lambda k: MULTS[k])))}')
    return res
def spear(a, b): return float(np.corrcoef(pd.Series(a).rank().values, pd.Series(b).rank().values)[0, 1])
def run_v2():
    T = pd.read_csv(os.path.join(OUT, 'trades.csv'))[['tid', 'date', 'track']]; S = pd.read_csv(os.path.join(OUT, 'states.csv')); S['label'] = S.base_final - S.exit_net
    for tr in ('RTH', 'GBX'):
        D = S[S.track == tr].sort_values(['date', 'tid', 'j']).reset_index(drop=True); parts = []
        for qq, a, b in folds(D, 5000):
            mf = lgb.LGBMRegressor(**PARAMS).fit(D.loc[a, F2], D.loc[a, 'label']); mb = lgb.LGBMRegressor(**PARAMS).fit(D.loc[a, F2B], D.loc[a, 'label'])
            Z = D.loc[b, ['tid', 'date', 'j', 'label', 'exit_net', 'base_final']].copy(); Z['pf'] = mf.predict(D.loc[b, F2]); Z['pb'] = mb.predict(D.loc[b, F2B]); Z['q'] = qq; parts.append(Z)
        Z = pd.concat(parts, ignore_index=True); nd = Z.date.nunique(); icf, icb = spear(Z.pf, Z.label), spear(Z.pb, Z.label)
        days = Z.date.values; ud, inv = np.unique(days, return_inverse=True); rng = np.random.default_rng(31); groups = [np.where(inv == k)[0] for k in range(len(ud))]; diffs = []
        for _ in range(1000):
            ix = np.concatenate([groups[k] for k in rng.integers(0, len(ud), len(ud))]); diffs.append(spear(Z.pf.values[ix], Z.label.values[ix]) - spear(Z.pb.values[ix], Z.label.values[ix]))
        lo, hi = np.percentile(diffs, [2.5, 97.5]); gate = lo > 0
        print(f'\nML-V2 {tr}: test states {len(Z)} on {nd} days, trades {Z.tid.nunique()}; rank IC full {icf:+.4f}, baseline (excursion, bars) {icb:+.4f}; difference {icf - icb:+.4f} [{lo:+.4f}, {hi:+.4f}] day-blocked -> GATE {"PASSED" if gate else "FAILED: NO INFORMATION, no policy scored"}')
        if gate:
            first = Z[Z.pf <= 0].sort_values(['tid', 'j']).groupby('tid').first(); tt = Z.groupby('tid').agg(date=('date', 'first'), base=('base_final', 'first')); tt['pol'] = tt.base; tt.loc[first.index, 'pol'] = first.exit_net
            d = (tt.pol - tt.base).values; m, lo2, hi2, p = boot(tt.date.values, d, seed=41); print(f'   COUNTED policy minus baseline: {m:+.3f} pt/trade [{lo2:+.3f}, {hi2:+.3f}], one-sided p {p:.4f}; policy mean {tt.pol.mean():+.3f} baseline {tt.base.mean():+.3f}; exits {len(first)} of {len(tt)} trades; win rate {np.mean(tt.pol > 0):.1%} vs {np.mean(tt.base > 0):.1%}')
if __name__ == '__main__':
    st = sys.argv[1] if len(sys.argv) > 1 else ''
    {'build': build, 'v1': v1, 'v2': run_v2}.get(st, lambda: print(__doc__))()
