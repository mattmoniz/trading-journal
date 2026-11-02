"""docs/TELL_PULLBACK_AND_LEVEL_DIRECTION_PREREG_20261102.md Part A. EXPLORE only, SIMULATED dollars. READS OUTCOMES -> look logged first (log_look_tell_pullback.mjs). Usage: nice python run_tell_pullback.py"""
import sys; sys.argv = sys.argv[:1]
import numpy as np, pandas as pd
import tell_state as TS, vbars as V, trade as T
SEED, BOOT, SLIP, TICK, DPP, W = 20261102, 3000, T.SLIP, 0.25, T.DPP, 10

def main():
    rng = np.random.default_rng(SEED + 157); _, ctxs, _ = TS.sessions_and_contexts(); rows = []
    for d in sorted(ctxs):
        ctx = ctxs[d]; S = ctx['S']; o, h, l, c, end, start = S['o'], S['h'], S['l'], S['c'], S['end'], S['start']; n = ctx['n']
        for t in T.simulate(ctx, 'V1', dict(fires=0, skip=0, trades=0, fallback=0)):
            i = int(t['sig']); dr = int(t['dir']); row = dict(date=d, net0=float(t['net']), conf=False, filled=False, netp=0.0)
            if i + W + 3 < n and dr * (c[i + 1] - c[i]) > 0:
                row['conf'] = True; lim = c[i]; scale = float(np.median(h[i - 19:i + 1] - l[i - 19:i + 1])) if i >= 20 else 10.0; ext = (h[i] if dr == 1 else l[i]) + dr * scale; fill = None
                for j in range(i + 2, min(i + 2 + W, n - 1)):
                    if start[j] >= T.FLAT_S: break
                    if (dr == 1 and h[j] >= ext) or (dr == -1 and l[j] <= ext): break           # ran away without a pullback: cancel
                    if (dr == 1 and l[j] <= lim - TICK) or (dr == -1 and h[j] >= lim + TICK): fill = j; break
                if fill is not None:
                    stop = float(t['stop'])
                    if dr * (lim - stop) > 0:
                        tr = T.run_position(ctx, T.Prof(ctx), fill, dr, stop, 'V1', end[i]); entry_open = o[fill] + dr * SLIP; row['filled'] = True; row['netp'] = float(tr['net']) + dr * (entry_open - lim) * DPP; row['reasonp'] = tr['reason']
            rows.append(row)
    R = pd.DataFrame(rows); n = len(R); print(f'V1 trades {n}; confirmed {int(R.conf.sum())}; limit filled {int(R.filled.sum())} ({100 * R.filled.sum() / max(1, R.conf.sum()):.0f}% of confirmed)')
    ud = np.array(sorted(R.date.unique())); idx = {u: np.where(R.date.values == u)[0] for u in ud}; half = (np.arange(len(ud)) < len(ud) // 2) * 1.0; hb = 1 - half; w1 = np.ones(len(ud))
    def agg(vals, mask): return np.array([vals[idx[u]][mask[idx[u]]].sum() for u in ud]), np.array([mask[idx[u]].sum() for u in ud])
    net0, netp = R.net0.values, R.netp.values; allm = np.ones(n, bool); fm = R.filled.values; A0 = agg(net0, allm); AF = agg(netp, fm); AS = (np.array([netp[idx[u]].sum() for u in ud]), np.array([len(idx[u]) for u in ud]))   # per ORIGINAL signal, missed = 0
    mm = lambda w, a: (w @ a[0]) / max(1.0, w @ a[1])
    def test(a, b):
        bd = [mm(w, a) - mm(w, b) for w in (np.bincount(rng.integers(0, len(ud), len(ud)), minlength=len(ud)).astype(float) for _ in range(BOOT))]; diff = mm(w1, a) - mm(w1, b); p = float(min(1.0, 2 * min((np.sum(np.array(bd) <= 0) + 1) / (BOOT + 1), (np.sum(np.array(bd) >= 0) + 1) / (BOOT + 1))))
        return dict(diff=diff, lo=np.percentile(bd, 2.5), hi=np.percentile(bd, 97.5), p=p, h1=mm(half, a) - mm(half, b), h2=mm(hb, a) - mm(hb, b))
    ta1 = test(AF, A0); ta2 = test(AS, A0); bdf = [mm(w, AF) for w in (np.bincount(rng.integers(0, len(ud), len(ud)), minlength=len(ud)).astype(float) for _ in range(BOOT))]; fl, fh = np.percentile(bdf, [2.5, 97.5])
    order = sorted([('TA1', ta1), ('TA2', ta2)], key=lambda x: x[1]['p']); keep = -1
    for rk, (k, r) in enumerate(order): keep = rk if r['p'] <= (rk + 1) / 2 * 0.10 else keep
    print(f'means ($ per trade): ORIGINAL all {mm(w1, A0):+.2f}; PULLBACK filled (N {int(fm.sum())}) {mm(w1, AF):+.2f} CI [{fl:+.1f}, {fh:+.1f}]; per ORIGINAL signal (missed = 0) {mm(w1, AS):+.2f}; original net of the signals the limit MISSED (confirmed, unfilled) {R[R.conf & ~R.filled].net0.mean():+.2f} (N {int((R.conf & ~R.filled).sum())})')
    for rk, (k, r) in enumerate(order):
        ok = rk <= keep and (r['lo'] > 0 or r['hi'] < 0) and fl > 0 and int(fm.sum()) >= 150 and len(np.unique(R.date[R.filled])) >= 80 and np.sign(r['h1']) == np.sign(r['h2']) == np.sign(r['diff'])
        print(f'  {k} {"filled mean minus original mean" if k == "TA1" else "per-signal total minus original mean"}: {r["diff"]:+.2f} CI [{r["lo"]:+.2f}, {r["hi"]:+.2f}] p {r["p"]:.3f} halves {r["h1"]:+.2f} / {r["h2"]:+.2f} BH {"survives" if rk <= keep else "no"}{"  <== CANDIDATE" if ok else ""}')
    f = R[R.filled]; print('UNCOUNTED by year (filled mean $): ' + ', '.join(f'{y} {f[f.date.str[:4] == y].netp.mean():+.1f} (N {int((f.date.str[:4] == y).sum())})' for y in sorted(set(f.date.str[:4]))))

if __name__ == '__main__': main()
