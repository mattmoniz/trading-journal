"""docs/PULLSTACK_FLIP_PUSH_PREREG_20261102.md Part 2: slow selective pull/stack flip (300 s window, 90th-percentile threshold), no push condition. READS OUTCOMES -> look logged first. Usage: nice python run_pullstack_slow.py"""
import sys, glob, os
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/depth_stageb')
import numpy as np
import run_pullstack as PS
DIR, END_OK, SEED, BOOT = PS.DIR, PS.END_OK, 20261102, 3000; HZ = (300, 900, 1800); ECON = 1.4

def main():
    rng = np.random.default_rng(SEED + 149); dates = sorted(os.path.basename(f)[:10] for f in glob.glob(f'{DIR}/20*.npz')); S = {}
    for d in dates:
        s = PS.session(d, w=300)
        if s is not None: S[d] = s
    ds = sorted(S); print(f'sessions usable {len(ds)}'); ev = []; per = []
    for k, d in enumerate(ds):
        if k < 20: continue
        th = float(np.quantile(np.abs(np.concatenate([S[x]['U'][900:END_OK] for x in ds[k - 20:k]])), 0.90)); U, mid = S[d]['U'], S[d]['mid']; lf = lp = -10 ** 9; nf = 0
        for t in range(900, END_OK - max(HZ)):
            fd = 1 if (U[t] >= th and U[t - 300] <= -th) else (-1 if (U[t] <= -th and U[t - 300] >= th) else 0)
            if fd and t - lf >= 300:
                lf = t; nf += 1; ev.append((k, 'FLIP', fd, [fd * (mid[t + H] - mid[t]) if np.isfinite(mid[t + H] - mid[t]) else np.nan for H in HZ])); continue
            if abs(U[t]) >= th and np.sign(U[t - 300]) == np.sign(U[t]) and abs(U[t - 300]) >= 0 and t - lp >= 300 and t - lf >= 300:
                lp = t; dd = 1 if U[t] > 0 else -1; ev.append((k, 'PERSIST', dd, [dd * (mid[t + H] - mid[t]) if np.isfinite(mid[t + H] - mid[t]) else np.nan for H in HZ]))
        per.append(nf)
    kk = np.array([e[0] for e in ev]); ty = np.array([e[1] for e in ev]); Y = np.array([e[3] for e in ev], float); dr = np.array([e[2] for e in ev]); sess = np.unique(kk); half = sess[len(sess) // 2]
    print(f'events: FLIP {int((ty == "FLIP").sum())} ({len(np.unique(kk[ty == "FLIP"]))} sessions, mean {np.mean(per):.1f} per session), PERSISTENT-STATE {int((ty == "PERSIST").sum())}')
    def stat(lab, j):
        m = (ty == lab) & np.isfinite(Y[:, j]); return np.array([Y[m & (kk == q), j].sum() for q in sess]), np.array([(m & (kk == q)).sum() for q in sess])
    res = {}
    for j, H in enumerate(HZ):
        sT, cT = stat('FLIP', j); sC, cC = stat('PERSIST', j); mm = lambda w, s, c: (w @ s) / max(1.0, w @ c); w1 = np.ones(len(sess)); bd, bt = [], []
        for _ in range(BOOT): w = np.bincount(rng.integers(0, len(sess), len(sess)), minlength=len(sess)).astype(float); bd.append(mm(w, sT, cT) - mm(w, sC, cC)); bt.append(mm(w, sT, cT))
        ha = (sess < half) * 1.0; hb = 1 - ha; diff = mm(w1, sT, cT) - mm(w1, sC, cC); p = float(min(1.0, 2 * min((np.sum(np.array(bd) <= 0) + 1) / (BOOT + 1), (np.sum(np.array(bd) >= 0) + 1) / (BOOT + 1))))
        res[H] = dict(diff=diff, lo=np.percentile(bd, 2.5), hi=np.percentile(bd, 97.5), tm=mm(w1, sT, cT), tl=np.percentile(bt, 2.5), th=np.percentile(bt, 97.5), cm=mm(w1, sC, cC), p=p, h1=mm(ha, sT, cT) - mm(ha, sC, cC), h2=mm(hb, sT, cT) - mm(hb, sC, cC), n=int(cT.sum()), ns=int((cT > 0).sum()))
    order = sorted(HZ, key=lambda h: res[h]['p']); keep = -1
    for rk, h in enumerate(order): keep = rk if res[h]['p'] <= (rk + 1) / 3 * 0.10 else keep
    print('\nRESOLUTION (FLIP absolute-mean CI half-width, points): ' + ', '.join(f'{H}s {(res[H]["th"] - res[H]["tl"]) / 2:.1f}' for H in HZ)); print('\nCOUNTED: slow FLIP minus PERSISTENT same-sign state (points, gross mid-to-mid; bar about 1.4)')
    for rk, H in enumerate(order):
        r = res[H]; ok = rk <= keep and (r['lo'] > 0 or r['hi'] < 0) and r['tl'] > ECON and r['n'] >= 100 and r['ns'] >= 40 and np.sign(r['h1']) == np.sign(r['h2']) == np.sign(r['diff'])
        print(f'  H {H:4d}s: FLIP mean {r["tm"]:+.2f} [{r["tl"]:+.2f}, {r["th"]:+.2f}] (N {r["n"]}, {r["ns"]} sessions), PERSISTENT {r["cm"]:+.2f}, difference {r["diff"]:+.2f} CI [{r["lo"]:+.2f}, {r["hi"]:+.2f}] p {r["p"]:.3f} halves {r["h1"]:+.2f} / {r["h2"]:+.2f} BH {"survives" if rk <= keep else "no"}{"  UNDERPOWERED" if r["n"] < 100 or r["ns"] < 40 else ""}{"  <== CANDIDATE" if ok else ""}')
    print('\nUNCOUNTED: ' + '; '.join(f'FLIP {nm} y900 {np.nanmean(Y[(ty == "FLIP") & (dr == v), 1]):+.2f} (N {int(((ty == "FLIP") & (dr == v)).sum())})' for nm, v in (('up', 1), ('down', -1))) + f'; PERSISTENT y300/900/1800: ' + '/'.join(f'{np.nanmean(Y[ty == "PERSIST", j]):+.2f}' for j in range(3)))

if __name__ == '__main__': main()
