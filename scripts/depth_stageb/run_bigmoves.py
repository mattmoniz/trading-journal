"""Part C of docs/BOOKMAP_STAGE_B_DEPTH_PREREG_20261102.md: the big-move event study on the Stage B heatmaps. READS OUTCOMES -> look logged first (log_look_bigmoves.mjs).
Usage: /home/mmoniz/trading-journal/venv/bin/python /home/mmoniz/trading-journal/scripts/depth_stageb/run_bigmoves.py"""
import sys, glob, os
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/depth_stageb')
import numpy as np
from scipy.stats import rankdata
import run_stageb as RS
NS, END_OK, SEED, BOOT, DRAWS = RS.NS, RS.END_OK, 20261102, 3000, 1000
SIGNED = ['imb1', 'imb5', 'imb10', 'd_imb10_60', 'pull_diff60', 'trade_imb60', 'absorb_diff', 'mom60']; UNSIGNED = ['depth10', 'spread', 'intensity60']; FEATS = SIGNED

def day_features(D, S):
    t = np.arange(NS); bb, ba, SZ, PULL, mid = D['bb'], D['ba'], D['SZ'], D['PULL'], D['mid']; pos = lambda a: np.clip(a, 0, None)
    def side_sizes(n):
        b = np.stack([pos(SZ[t, bb - k]) for k in range(n)], 1).sum(1); a = np.stack([pos(SZ[t, np.clip(ba + k, 0, SZ.shape[1] - 1)]) for k in range(n)], 1).sum(1); return b, a
    F = {}
    for name, n in (('imb1', 1), ('imb5', 5), ('imb10', 10)): b, a = side_sizes(n); F[name] = (b - a) / np.maximum(1, b + a); F['b' + name], F['a' + name] = b, a
    F['d_imb10_60'] = F['imb10'] - np.r_[np.full(60, np.nan), F['imb10'][:-60]]
    pb = RS.win(PULL, t, np.stack([bb - j for j in range(5)], 1), 60); pa = RS.win(PULL, t, np.stack([np.clip(ba + j, 0, SZ.shape[1] - 1) for j in range(5)], 1), 60); F['pull_diff60'] = (pa - pb) / np.maximum(1, pa + pb)
    cs = lambda x: np.cumsum(np.r_[0.0, x]); cb, cl = cs(D['buy']), cs(D['sell']); w = 60; i0 = np.maximum(0, t - w + 1); bu, se = cb[t + 1] - cb[i0], cl[t + 1] - cl[i0]; F['trade_imb60'] = (bu - se) / np.maximum(1, bu + se); F['intensity60'] = bu + se
    F['absorb_diff'] = (S['exec_bid'] - S['exec_ask']) / np.maximum(1, S['exec_bid'] + S['exec_ask']); F['mom60'] = mid - np.r_[np.full(60, np.nan), mid[:-60]]
    b10, a10 = F['bimb10'], F['aimb10']; F['depth10'] = np.log1p(b10 + a10); F['spread'] = (ba - bb) / 4.0; return F

def auc(x, y):
    """P(x_up > x_down) with ties 0.5 from ranks; y in {1 (up), 0 (down)}"""
    r = rankdata(x); n1, n0 = int(y.sum()), int((1 - y).sum()); return (r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)

def main():
    rng = np.random.default_rng(SEED + 83); dates = sorted(os.path.basename(f)[:10] for f in glob.glob(f'{RS.DIR}/20*.npz')); D_, S_, F_ = {}, {}, {}
    for d in dates:
        D = RS.load(d)
        if D is None: continue
        S_[d] = RS.stats_day(D); F_[d] = day_features(D, S_[d]); D_[d] = dict(mid=D['mid'], ok=D['ok']); del D   # keep only small arrays, one full session at a time
    ds = sorted(D_); print(f'sessions usable {len(ds)} of {len(dates)}')
    mv = {d: np.r_[D_[d]['mid'][300:] - D_[d]['mid'][:-300], np.full(300, np.nan)] for d in ds}; ev_rows = []; ctl_rows = []
    for k, d in enumerate(ds):
        if k < 20: continue
        prior = np.concatenate([np.abs(mv[x][60:END_OK - 300]) for x in ds[k - 20:k]]); prior = prior[np.isfinite(prior)]; q95, q50 = np.quantile(prior, .95), np.quantile(prior, .5); m = mv[d]; last = -10 ** 9
        for t in range(600, END_OK - 300):
            if np.isfinite(m[t]) and abs(m[t]) >= q95 and t - last >= 300 and D_[d]['ok'][t]:
                f = F_[d]; row = {n: f[n][t] for n in SIGNED + UNSIGNED}; ev_rows.append((k, d, t, 1 if m[t] > 0 else 0, row)); last = t
    n_up = sum(r[3] for r in ev_rows); print(f'big moves {len(ev_rows)} on {len(set(r[1] for r in ev_rows))} sessions (up {n_up}, down {len(ev_rows) - n_up}); a big move = 5-minute move >= the prior-20-session 95th percentile')
    K = np.array([r[0] for r in ev_rows]); Y = np.array([r[3] for r in ev_rows]); X = {n: np.array([r[4][n] for r in ev_rows], float) for n in SIGNED + UNSIGNED}; sess = np.unique(K); half = sess[len(sess) // 2]
    print(f'resolution: {len(ev_rows)} events -> AUC half-width about {1 / np.sqrt(len(ev_rows)) * 0.9:.2f}')
    res = {}
    for f in FEATS:
        x = X[f]; m = np.isfinite(x); a0 = auc(x[m], Y[m]); bs = []
        idx = {s: np.where((K == s) & m)[0] for s in sess}
        for _ in range(BOOT):
            pick = np.concatenate([idx[s] for s in sess[rng.integers(0, len(sess), len(sess))] if len(idx[s])]); bs.append(auc(x[pick], Y[pick]) if 0 < Y[pick].sum() < len(pick) else np.nan)
        lo, hi = np.nanpercentile(bs, [2.5, 97.5]); plc = [auc(x[m], np.roll(Y[m], s)) for s in rng.integers(1, m.sum(), DRAWS)]; p = float((np.sum(np.abs(np.array(plc) - 0.5) >= abs(a0 - 0.5)) + 1) / (DRAWS + 1))
        h1 = auc(x[m & (K < half)], Y[m & (K < half)]); h2 = auc(x[m & (K >= half)], Y[m & (K >= half)]); res[f] = (a0, lo, hi, p, h1, h2)
    order = sorted(range(len(FEATS)), key=lambda i: res[FEATS[i]][3]); keep = -1
    for rk, ix in enumerate(order): keep = rk if res[FEATS[ix]][3] <= (rk + 1) / len(FEATS) * 0.10 else keep
    sv = {FEATS[ix]: rk <= keep for rk, ix in enumerate(order)}
    print('\nCOUNTED (i): AUC of each signed pre-move feature for UP vs DOWN among big moves (0.5 = no information)')
    for f in FEATS:
        a0, lo, hi, p, h1, h2 = res[f]; ok = sv[f] and (lo > 0.5 or hi < 0.5) and (h1 - 0.5) * (h2 - 0.5) > 0 and (a0 - 0.5) * (h1 - 0.5) > 0
        print(f'  {f:12s} AUC {a0:.3f} CI [{lo:.3f}, {hi:.3f}] placebo p {p:.3f} halves {h1:.3f} / {h2:.3f} BH {"survives" if sv[f] else "no"}{"  <== CANDIDATE" if ok else ""}')
    print('\nUNCOUNTED (ii): these features are known before the move; difference between big moves and matched quiet moments is a VOLATILITY signal (unsigned features, standardized mean difference):')
    ctl = {n: [] for n in UNSIGNED}
    for (k, d, t, y, row) in ev_rows:
        thq = np.quantile(np.abs(mv[ds[k]][600:END_OK - 300][np.isfinite(mv[ds[k]][600:END_OK - 300])]), .5); cand = [u for u in range(600, END_OK - 300, 7) if np.isfinite(mv[d][u]) and abs(mv[d][u]) < thq and abs(u - t) > 300]
        if len(cand) >= 4:
            for u in rng.choice(cand, 4, replace=False):
                for n in UNSIGNED: ctl[n].append(F_[d][n][u])
    for n in UNSIGNED:
        c = np.array(ctl[n], float); e = X[n]; sd = np.nanstd(np.r_[e, c]); print(f'  {n:12s} big-move mean {np.nanmean(e):+.3f} vs quiet {np.nanmean(c):+.3f} (standardized difference {(np.nanmean(e) - np.nanmean(c)) / sd:+.2f}, events {len(e)}, quiet samples {len(c)})')
    print('\nSTORY (uncounted): mean of key signed features at offsets around the move start t (UP vs DOWN events)')
    offs = (-300, -120, -60, -30, 0, 30, 120, 300)
    for f in ('imb5', 'pull_diff60', 'trade_imb60', 'absorb_diff'):
        for lab, sel in (('UP  ', 1), ('DOWN', 0)):
            vals = [np.nanmean([F_[d][f][t + o] for (k, d, t, y, row) in ev_rows if y == sel and 0 <= t + o < NS]) for o in offs]; print(f'  {f:12s} {lab} ' + ' '.join(f'{o:+4d}s:{v:+.3f}' for o, v in zip(offs, vals)))

if __name__ == '__main__': main()
