"""docs/PULLSTACK_FLIP_PUSH_PREREG_20261102.md. READS OUTCOMES -> look logged first (log_look_pullstack.mjs). Streams one session at a time (small per-second arrays only). Usage: nice python run_pullstack.py"""
import sys, glob, os
import numpy as np
DIR = '/home/mmoniz/trading-journal/scratch/depth_stageb_20261102'; NS = 23400; END_OK = 23100; SEED, BOOT = 20261102, 3000; HZ = (60, 300, 900); R = 20; ECON = 1.4

def session(date):
    z = np.load(f'{DIR}/{date}.npz'); bb, ba = z['bb'].astype(int), z['ba'].astype(int)
    if (bb < 0).mean() > 0.02 or (ba < 0).mean() > 0.02: return None
    ok = (bb >= 0) & (ba >= 0); add, pull = z['add'].astype(float), z['pull'].astype(float); n = len(bb); off = np.where(ok, ba - bb, 1); cols_b = np.arange(R - 4, R + 1); N = np.zeros(n); Dn = np.zeros(n)
    ab = add[:, cols_b].sum(1); pb = pull[:, cols_b].sum(1); idx = np.clip(R + off[:, None] + np.arange(5)[None, :], 0, 2 * R); aa = np.take_along_axis(add, idx, 1).sum(1); pa = np.take_along_axis(pull, idx, 1).sum(1)
    N = (ab - pb) - (aa - pa); Dn = ab + pb + aa + pa; cN, cD = np.cumsum(np.r_[0.0, N]), np.cumsum(np.r_[0.0, Dn]); t = np.arange(n); i0 = np.maximum(0, t - 29); U = (cN[t + 1] - cN[i0]) / np.maximum(1.0, cD[t + 1] - cD[i0])
    mid = np.where(ok, (bb + ba) / 8.0, np.nan); spread = np.where(ok, (ba - bb) / 4.0, np.nan); return dict(U=U, mid=mid, spread=spread, ok=ok)

def main():
    rng = np.random.default_rng(SEED + 139); dates = sorted(os.path.basename(f)[:10] for f in glob.glob(f'{DIR}/20*.npz')); S = {}
    for d in dates:
        s = session(d)
        if s is not None: S[d] = s
    ds = sorted(S); print(f'sessions usable {len(ds)} of {len(dates)}'); ev = []; flips = []; hs = []
    for k, d in enumerate(ds):
        if k < 20: continue
        prior = ds[k - 20:k]; th = float(np.median(np.abs(np.concatenate([S[x]['U'][600:END_OK] for x in prior])))); P = float(np.quantile(np.concatenate([np.abs(S[x]['mid'][660:END_OK] - S[x]['mid'][600:END_OK - 60]) for x in prior]), 0.75)) if False else None
        mv = np.concatenate([np.abs(S[x]['mid'][660:END_OK] - S[x]['mid'][600:END_OK - 60]) for x in prior]); P = float(np.nanquantile(mv, 0.75)); U, mid, sp = S[d]['U'], S[d]['mid'], S[d]['spread']; last_f = -10 ** 9; last_p = -10 ** 9; fl_ct = 0; flip_secs = []
        for t in range(660, END_OK - 60 - max(HZ)):
            if U[t] >= th and U[t - 30] <= -th: fd = 1
            elif U[t] <= -th and U[t - 30] >= th: fd = -1
            else: fd = 0
            if fd and t - last_f >= 60:
                last_f = t; flip_secs.append(t); fl_ct += 1; s = t + 60; push = fd * (mid[s] - mid[t])
                if np.isfinite(push):
                    y = [fd * (mid[s + H] - mid[s]) if np.isfinite(mid[s + H]) else np.nan for H in HZ]; ev.append((k, 'FLIPPUSH' if push >= P else 'FLIPNOPUSH', fd, y, sp[s]))
        fs = np.array(flip_secs); hs.append(fl_ct)
        for s in range(720, END_OK - max(HZ)):
            mvv = mid[s] - mid[s - 60]
            if not np.isfinite(mvv) or abs(mvv) < P or s - last_p < 60: continue
            if len(fs) and np.any((fs >= s - 120) & (fs <= s)): continue
            last_p = s; dd = 1 if mvv > 0 else -1; y = [dd * (mid[s + H] - mid[s]) if np.isfinite(mid[s + H]) else np.nan for H in HZ]; ev.append((k, 'PUSHONLY', dd, y, sp[s]))
    kk = np.array([e[0] for e in ev]); ty = np.array([e[1] for e in ev]); Y = np.array([e[3] for e in ev], float); SP = np.array([e[4] for e in ev], float); sess = np.unique(kk); half = sess[len(sess) // 2]
    cnt = lambda lab: int((ty == lab).sum()); print(f'events: FLIP+PUSH {cnt("FLIPPUSH")} ({len(np.unique(kk[ty == "FLIPPUSH"]))} sessions), PUSH-ONLY {cnt("PUSHONLY")}, FLIP-NO-PUSH {cnt("FLIPNOPUSH")}; flips per session mean {np.mean(hs):.1f}')
    def stat(lab, j):
        m = (ty == lab) & np.isfinite(Y[:, j]); s = np.array([Y[m & (kk == q), j].sum() for q in sess]); c = np.array([(m & (kk == q)).sum() for q in sess]); return s, c
    res = {}
    for j, H in enumerate(HZ):
        sT, cT = stat('FLIPPUSH', j); sC, cC = stat('PUSHONLY', j); mm = lambda w, s, c: (w @ s) / max(1.0, w @ c); w1 = np.ones(len(sess)); bd, bt = [], []
        for _ in range(BOOT): w = np.bincount(rng.integers(0, len(sess), len(sess)), minlength=len(sess)).astype(float); bd.append(mm(w, sT, cT) - mm(w, sC, cC)); bt.append(mm(w, sT, cT))
        ha = (sess < half) * 1.0; hb = 1 - ha; diff = mm(w1, sT, cT) - mm(w1, sC, cC); p = float(min(1.0, 2 * min((np.sum(np.array(bd) <= 0) + 1) / (BOOT + 1), (np.sum(np.array(bd) >= 0) + 1) / (BOOT + 1))))
        res[H] = dict(diff=diff, lo=np.percentile(bd, 2.5), hi=np.percentile(bd, 97.5), tm=mm(w1, sT, cT), tl=np.percentile(bt, 2.5), th=np.percentile(bt, 97.5), cm=mm(w1, sC, cC), p=p, h1=mm(ha, sT, cT) - mm(ha, sC, cC), h2=mm(hb, sT, cT) - mm(hb, sC, cC), n=int(cT.sum()), ns=int((cT > 0).sum()))
    order = sorted(HZ, key=lambda h: res[h]['p']); keep = -1
    for rk, h in enumerate(order): keep = rk if res[h]['p'] <= (rk + 1) / 3 * 0.10 else keep
    print('\nRESOLUTION (FLIP+PUSH absolute-mean CI half-width, points): ' + ', '.join(f'{H}s {(res[H]["th"] - res[H]["tl"]) / 2:.2f}' for H in HZ)); print('\nCOUNTED: FLIP+PUSH minus PUSH-ONLY (points, gross mid-to-mid; economic bar about 1.4)')
    for rk, H in enumerate(order):
        r = res[H]; ok = rk <= keep and (r['lo'] > 0 or r['hi'] < 0) and r['tl'] > ECON and r['n'] >= 100 and r['ns'] >= 40 and np.sign(r['h1']) == np.sign(r['h2']) == np.sign(r['diff'])
        print(f'  H {H:3d}s: FLIP+PUSH mean {r["tm"]:+.2f} [{r["tl"]:+.2f}, {r["th"]:+.2f}] (N {r["n"]}, {r["ns"]} sessions), PUSH-ONLY {r["cm"]:+.2f}, difference {r["diff"]:+.2f} CI [{r["lo"]:+.2f}, {r["hi"]:+.2f}] p {r["p"]:.3f} halves {r["h1"]:+.2f} / {r["h2"]:+.2f} BH {"survives" if rk <= keep else "no"}{"  <== CANDIDATE" if ok else ""}')
    print('\nUNCOUNTED: ' + '; '.join(f'{lab} mean y at 60/300/900 s: ' + '/'.join(f'{np.nanmean(Y[ty == lab, j]):+.2f}' for j in range(3)) + f' (N {int((ty == lab).sum())})' for lab in ('FLIPPUSH', 'PUSHONLY', 'FLIPNOPUSH')))
    dr = np.array([e[2] for e in ev]); print('UNCOUNTED FLIP+PUSH by flip direction (y300): ' + ', '.join(f'{nm} {np.nanmean(Y[(ty == "FLIPPUSH") & (dr == v), 1]):+.2f} (N {int(((ty == "FLIPPUSH") & (dr == v)).sum())})' for nm, v in (('up', 1), ('down', -1))))

if __name__ == '__main__': main()
