"""Part B of docs/EVENT_SNAPSHOT_STUDY_20261102.md: the ALL-MOMENTS direction screen with order-book depth, RTH, on the 95 depth-summary sessions. READS OUTCOMES -> look logged first (log_look_allmoments.mjs).
Usage: /home/mmoniz/trading-journal/venv/bin/python /home/mmoniz/trading-journal/scripts/event_snapshots/run_allmoments.py"""
import sys, glob, json, os
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/event_snapshots'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_context'); sys.argv = sys.argv[:1]
import numpy as np, pandas as pd
from scipy.stats import rankdata
import run_p2b as P
OUT = '/home/mmoniz/trading-journal/scratch/event_snapshots_20261102'; DEPTH = '/home/mmoniz/trading-journal/scratch/depth_persec_20261021'
SEED, BOOT, DRAWS = 20261102, 3000, 1000; HZ = (1, 5, 15, 30); T0, T1, STEP, CLOCK_OFF = 36000, 55800, 60, 21600; RTH_OPEN = 55800.0; COST_PTS = 1.25
FEATS = ['imb_best', 'imb10', 'imb40', 'd_imb10_60', 'd_imb40_300', 'chg_diff', 'delta3', 'delta10', 'mom10', 'loc_s', 'mom60m']

def depth_file(date):
    c = sorted(glob.glob(f'{DEPTH}/{date}.*.tsv'))
    return max(c, key=lambda f: os.path.getsize(f)) if c else None

def load_depth(path):
    a = np.loadtxt(path, delimiter='\t'); sec = a[:, 0].astype(int); n = 57600 - 34200; D = np.full((n, 8), np.nan); ok = np.zeros(n, bool); ix = sec - 34200; m = (ix >= 0) & (ix < n); D[ix[m]] = a[m, 1:9]; ok[ix[m]] = True
    last = -10 ** 9
    for k in range(n):                                     # forward fill short gaps (<= 5 s), longer gaps stay invalid
        if ok[k]: last = k
        elif k - last <= 5 and last >= 0: D[k] = D[last]; ok[k] = True
    return D, ok

def day_rows(date, meta, z):
    D, ok = load_depth(depth_file(date)); atr = meta['atr']; end = z['end'] - CLOCK_OFF; comp, c, h, l, vol, bid, ask = (z[k] for k in ('comp', 'c', 'h', 'l', 'vol', 'bid', 'ask'))
    rth = z['end'] >= RTH_OPEN; cumH = np.maximum.accumulate(np.where(rth, h, -np.inf)); cumL = np.minimum.accumulate(np.where(rth, l, np.inf)); rows = []; drop = dict(book=0, bar=0, fwd=0)
    g = lambda t, k: D[t - 34200, k]; okk = lambda t: ok[t - 34200]; mid = lambda t: 0.5 * (g(t, 0) + g(t, 1))
    for t in range(T0, T1 + 1, STEP):
        if t + HZ[-1] * 60 > 57000: continue
        if not (okk(t) and okk(t - 60) and okk(t - 300) and all(okk(t + h * 60) for h in HZ)): drop['book'] += 1; continue
        i = int(np.searchsorted(end, t, side='right')) - 1
        if i < 20 or not comp[i] or not np.isfinite(cumH[i]): drop['bar'] += 1; continue
        imb = lambda tt, b, a: (g(tt, b) - g(tt, a)) / max(1e-9, g(tt, b) + g(tt, a)); b10, a10 = g(t, 4), g(t, 5); b10p, a10p = g(t - 60, 4), g(t - 60, 5)
        ds = lambda w: (ask[i - w + 1:i + 1].sum() - bid[i - w + 1:i + 1].sum()) / vol[i - w + 1:i + 1].sum()
        f = dict(imb_best=imb(t, 2, 3), imb10=imb(t, 4, 5), imb40=imb(t, 6, 7), d_imb10_60=imb(t, 4, 5) - imb(t - 60, 4, 5), d_imb40_300=imb(t, 6, 7) - imb(t - 300, 6, 7),
                 chg_diff=(b10 / max(1, b10p) - 1) - (a10 / max(1, a10p) - 1), delta3=ds(3), delta10=ds(10), mom10=(c[i] - c[i - 10]) / atr, loc_s=2 * (c[i] - cumL[i]) / (cumH[i] - cumL[i]) - 1 if cumH[i] > cumL[i] else 0.0, mom60m=(c[i] - c[max(0, int(np.searchsorted(end, t - 3600, side='right')) - 1)]) / atr)
        y = {f'y{h}': (mid(t + h * 60) - mid(t)) / atr for h in HZ}; y.update({f'pts{h}': mid(t + h * 60) - mid(t) for h in HZ}); rows.append(dict(date=date, t=t, **f, **y))
    return rows, drop

def corr_ci(x, y, days, rng):
    n = len(x); rx, ry = rankdata(x), rankdata(y); r = float(np.corrcoef(rx, ry)[0, 1]); ud, inv = np.unique(days, return_inverse=True); idx = [np.where(inv == k)[0] for k in range(len(ud))]; bs = []
    for _ in range(BOOT): pick = np.concatenate([idx[j] for j in rng.integers(0, len(ud), len(ud))]); bs.append(np.corrcoef(rx[pick], ry[pick])[0, 1])
    lo, hi = np.nanpercentile(bs, [2.5, 97.5]); sh = rng.integers(1, n, DRAWS); plc = np.array([np.corrcoef(rx, np.roll(ry, s))[0, 1] for s in sh]); p = float((np.sum(np.abs(plc) >= abs(r)) + 1) / (DRAWS + 1))
    h = n // 2; r1, r2 = (np.corrcoef(rankdata(x[a:b]), rankdata(y[a:b]))[0, 1] for a, b in ((0, h), (h, n))); return dict(r=r, lo=float(lo), hi=float(hi), p=p, h1=float(r1), h2=float(r2))

def bh(ps, q=0.10):
    order = sorted(range(len(ps)), key=lambda i: ps[i]); keep = -1
    for rk, ix in enumerate(order): keep = rk if ps[ix] <= (rk + 1) / len(ps) * q else keep
    return {ix: rk <= keep for rk, ix in enumerate(order)}

def main():
    rng = np.random.default_rng(SEED + 53); rows = []; used = []; drops = dict(book=0, bar=0, fwd=0); nodepth = 0
    for f in sorted(glob.glob(f'{OUT}/day_*.json')):
        m = json.load(open(f)); d = m['date']
        if not depth_file(d): nodepth += 1; continue
        z = np.load(f.replace('.json', '.npz')); r, dr = day_rows(d, m, z); rows += r; used.append(d); [drops.__setitem__(k, drops[k] + dr[k]) for k in dr]
    X = pd.DataFrame(rows).sort_values(['date', 't'], kind='stable').reset_index(drop=True); days = X.date.values
    print(f'stage-1 days with a depth summary: {len(used)} ({used[0]}..{used[-1]}); stage-1 days without: {nodepth}; grid minutes {len(X)}; dropped (book / bar): {drops["book"]} / {drops["bar"]}')
    print('mean forward move (points) by horizon, and SD: ' + ', '.join(f'{h}m {X[f"pts{h}"].mean():+.2f} / {X[f"pts{h}"].std():.1f}' for h in HZ))
    res = {}
    for h in HZ:
        for f in FEATS: res[(f, h)] = corr_ci(X[f].values, X[f'y{h}'].values, days, rng)
    ps = [res[k]['p'] for k in res]; keys = list(res); sv = bh(ps); res_hw = np.mean([(v['hi'] - v['lo']) / 2 for v in res.values()]); print(f'\nRESOLUTION: mean half-width of the day-blocked CI of a correlation {res_hw:.3f} (break-even corr: 1m n/a, 5m 0.089, 15m 0.052, 30m 0.037)')
    print('\nCOUNTED (i): Spearman(feature, signed forward move), 11 features x 4 horizons, BH q=0.10 over 44')
    print('feature | horizon | r | CI | placebo p | halves | BH | top-decile gross $/trade (cost $2.50)')
    cands = []
    for ix, (f, h) in enumerate(keys):
        v = res[(f, h)]; s = np.sign(v['r']) or 1.0; x = X[f].values * s; top = x >= np.quantile(x, 0.9); gross = float(np.mean(X[f'pts{h}'].values[top] * s) * 2)
        ok = sv[ix] and (v['lo'] > 0 or v['hi'] < 0) and np.sign(v['h1']) == np.sign(v['h2']) == np.sign(v['r'])
        if ok: cands.append((f, h, v['r'], gross))
        print(f'{f:11s} | {h:2d}m | {v["r"]:+.3f} | [{v["lo"]:+.3f}, {v["hi"]:+.3f}] | {v["p"]:.3f} | {v["h1"]:+.3f} / {v["h2"]:+.3f} | {"survives" if sv[ix] else "no"} | {gross:+6.2f}{"  <== CANDIDATE" if ok else ""}')
    print(f'\nCANDIDATES (features): {[(c[0], c[1], round(c[2], 3), round(c[3], 2)) for c in cands]}')
    print('\nCOUNTED (ii): walk-forward ridge on all 11 features + 30-minute clock dummies, one per horizon; out-of-sample Spearman')
    ud = sorted(X.date.unique()); Z0 = X[FEATS].values; clk = ((X.t.values - T0) // 1800); CL = np.eye(int(clk.max()) + 1)[clk.astype(int)][:, 1:]; Xd = np.hstack([Z0, CL]); first, step = 30, 10
    for h in HZ:
        y = X[f'y{h}'].values; pred = np.full(len(X), np.nan)
        for b in range(first, len(ud), step):
            tr = np.isin(days, ud[:b]); te = np.isin(days, ud[b:b + step]); Zs, Zt = P.standardize(Xd[tr], Xd[te]); a = P.choose_alpha(Zs, y[tr], days[tr]); ym = y[tr].mean(); pred[te] = Zt @ P.ridge_solve(Zs.T @ Zs, Zs.T @ (y[tr] - ym), a) + ym
        m = ~np.isnan(pred); v = corr_ci(pred[m], y[m], days[m], rng); ok = v['lo'] > 0 and v['p'] < 0.05 and np.sign(v['h1']) == np.sign(v['h2']) == 1
        s = np.sign(pred[m] - np.median(pred[m])); top = np.abs(pred[m] - np.median(pred[m])) >= np.quantile(np.abs(pred[m] - np.median(pred[m])), 0.9); gross = float(np.mean(X[f'pts{h}'].values[m][top] * s[top]) * 2)
        print(f'  {h:2d}m: OOS Spearman {v["r"]:+.4f} CI [{v["lo"]:+.4f}, {v["hi"]:+.4f}] placebo p {v["p"]:.3f} halves {v["h1"]:+.4f} / {v["h2"]:+.4f}; top-decile |prediction| gross ${gross:+.2f}/trade (cost $2.50) -> {"CANDIDATE" if ok else "NOT SHOWN"}')

if __name__ == '__main__': main()
