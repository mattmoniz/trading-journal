"""Part C2 of docs/BOOKMAP_STAGE_B_DEPTH_PREREG_20261102.md: causal burst event study (events defined from trailing information only). READS OUTCOMES -> look logged first (log_look_bursts.mjs).
Memory: one full session at a time; keep only small arrays. Usage: /home/mmoniz/trading-journal/venv/bin/python run_bursts.py"""
import sys, glob, os
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/depth_stageb')
import numpy as np
from scipy.stats import rankdata
import run_stageb as RS, run_bigmoves as BM
NS, END_OK, SEED, BOOT, DRAWS = RS.NS, RS.END_OK, 20261102, 3000, 1000; FE = ['imb1', 'imb5', 'imb10', 'd_imb10_60', 'pull_diff60', 'trade_imb60', 'absorb_diff']

def main():
    rng = np.random.default_rng(SEED + 97); dates = sorted(os.path.basename(f)[:10] for f in glob.glob(f'{RS.DIR}/20*.npz')); mid, F = {}, {}
    for d in dates:
        D = RS.load(d)
        if D is None: continue
        S = RS.stats_day(D); f = BM.day_features(D, S); mid[d] = D['mid']; F[d] = {n: f[n] for n in FE}; del D, S, f
    ds = sorted(mid); print(f'sessions usable {len(ds)}')
    tr = {d: np.r_[np.full(60, np.nan), mid[d][60:] - mid[d][:-60]] for d in ds}; rows = []; ref = []
    for k, d in enumerate(ds):
        if k < 20: continue
        prior = np.abs(np.concatenate([tr[x][600:END_OK - 300] for x in ds[k - 20:k]])); prior = prior[np.isfinite(prior)]; q95, q50 = np.quantile(prior, .95), np.quantile(prior, .5); m = mid[d]; last = -10 ** 9
        for t in range(600, END_OK - 300):
            a = tr[d][t]
            if not np.isfinite(a) or not np.isfinite(m[t + 300]) or a == 0: continue
            b = np.sign(a); y = b * (m[t + 300] - m[t])
            if abs(a) >= q95 and t - last >= 60: rows.append((k, y, [b * F[d][n][t] for n in FE])); last = t
            elif abs(a) >= q50 and t % 15 == 0: ref.append(y)
    K = np.array([r[0] for r in rows]); Y = np.array([r[1] for r in rows]); X = np.array([r[2] for r in rows], float); ref = np.array(ref); sess = np.unique(K); half = sess[len(sess) // 2]
    print(f'bursts {len(rows)} on {len(sess)} sessions; reference seconds (60 s move >= median, every 15 s) {len(ref)}')
    ex = Y.mean() - ref.mean(); idx = {s: np.where(K == s)[0] for s in sess}; bs = [Y[np.concatenate([idx[s] for s in sess[rng.integers(0, len(sess), len(sess))]])].mean() - ref.mean() for _ in range(BOOT)]
    lo, hi = np.percentile(bs, [2.5, 97.5]); print(f'(i) burst continuation y: mean {Y.mean():+.2f} points, reference {ref.mean():+.2f}, excess {ex:+.2f} CI [{lo:+.2f}, {hi:+.2f}] (positive = bursts continue; resolution half-width {(hi - lo) / 2:.2f} points)')
    res = {}
    for j, n in enumerate(FE):
        x = X[:, j]; m = np.isfinite(x); rx, ry = rankdata(x[m]), rankdata(Y[m]); r = float(np.corrcoef(rx, ry)[0, 1]); bsr = []
        for _ in range(BOOT):
            pick = np.concatenate([np.where((K == s) & m)[0] for s in sess[rng.integers(0, len(sess), len(sess))]]); bsr.append(np.corrcoef(rankdata(x[pick]), rankdata(Y[pick]))[0, 1])
        l, h = np.nanpercentile(bsr, [2.5, 97.5]); plc = np.array([np.corrcoef(rx, np.roll(ry, s))[0, 1] for s in rng.integers(1, m.sum(), DRAWS)]); p = float((np.sum(np.abs(plc) >= abs(r)) + 1) / (DRAWS + 1))
        c = lambda sel: np.corrcoef(rankdata(x[m & sel]), rankdata(Y[m & sel]))[0, 1]; h1, h2 = c(K < half), c(K >= half); top = x >= np.quantile(x[m], .9); res[n] = (r, l, h, p, h1, h2, float(Y[top & m].mean()), float(Y[(x <= np.quantile(x[m], .1)) & m].mean()))
    order = sorted(range(len(FE)), key=lambda i: res[FE[i]][3]); keep = -1
    for rk, ix in enumerate(order): keep = rk if res[FE[ix]][3] <= (rk + 1) / 8 * 0.10 else keep
    sv = {FE[ix]: rk <= keep for rk, ix in enumerate(order)}; print('\n(ii) Spearman(feature signed toward the burst direction, continuation y) among bursts; BH over 8 tests (the excess counts as the 8th)')
    for n in FE:
        r, l, h, p, h1, h2, ty, by = res[n]; ok = sv[n] and (l > 0 or h < 0) and np.sign(h1) == np.sign(h2) == np.sign(r)
        print(f'  {n:12s} r {r:+.3f} CI [{l:+.3f}, {h:+.3f}] p {p:.3f} halves {h1:+.3f} / {h2:+.3f} BH {"survives" if sv[n] else "no"} | top-decile y {ty:+.2f}, bottom-decile y {by:+.2f} points{"  <== CANDIDATE" if ok else ""}')

if __name__ == '__main__': main()
