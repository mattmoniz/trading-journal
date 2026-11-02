"""docs/TELL_AT_LEVEL_REJECTION_PREREG_20261102.md. EXPLORE only. READS OUTCOMES -> look logged first (log_look_tell_at_level.mjs).
Usage: nice /home/mmoniz/trading-journal/venv/bin/python run_tell_at_level.py"""
import sys; sys.argv = sys.argv[:1]
import numpy as np, pandas as pd
import tell_state as TS, vbars as V, trade as T
SEED, BOOT, SLIP, COST = 20261102, 3000, 0.25, 1.25; HZ = (15, 30, 60); LEVELS = ('VWAP', 'ONH', 'ONL', 'IBH', 'IBL')

def vwap_by_bar(S):
    n = len(S['c']); px = S['vp'] * 0.25; pv = np.bincount(S['vi'], weights=px * S['vv'], minlength=n); vv = np.bincount(S['vi'], weights=S['vv'], minlength=n); rth = S['end'] >= V.RTH_OPEN
    cpv = np.cumsum(np.where(rth, pv, 0.0)); cv = np.cumsum(np.where(rth, vv, 0.0)); return np.where(cv > 0, cpv / np.maximum(cv, 1e-9), np.nan)

def levels_at(ctx, vw, i):
    S = ctx['S']; L = {'VWAP': vw[i], 'ONH': ctx['onh'], 'ONL': ctx['onl']}
    if S['end'][i] >= V.RTH_OPEN + 3600 and ctx['ibh'] is not None: L['IBH'] = ctx['ibh']; L['IBL'] = ctx['ibl']
    return {k: v for k, v in L.items() if v is not None and np.isfinite(v)}

def event_at(ctx, vw, i, last_ev):
    """(level name, direction, entry bar index, outcome info) for the nearest qualifying level at signal bar i, or ('BREAK', ...) / None."""
    S = ctx['S']; h, l, c, o, end, n = S['h'], S['l'], S['c'], S['o'], S['end'], ctx['n']
    if i < 20 or i + 5 >= n: return None
    scale = float(np.median(h[i - 19:i + 1] - l[i - 19:i + 1])); cand = sorted(((abs(c[i] - L), nm, L) for nm, L in levels_at(ctx, vw, i).items() if abs(c[i] - L) <= scale and i - last_ev.get(nm, -99) >= 10))
    if not cand: return None
    _, nm, L = cand[0]; below = c[i] < L
    for j in range(i + 1, min(i + 4, n - 2)):
        Lj = vw[j] if nm == 'VWAP' else L
        touch = (h[j] >= Lj - 0.25) if below else (l[j] <= Lj + 0.25)
        if touch:
            held = (c[j] < Lj) if below else (c[j] > Lj)
            if not held: return ('BREAK', nm)
            last_ev[nm] = i; return (nm, -1 if below else 1, j + 1, below)     # direction away from the level: short when the level is above
    return None

def outcomes(S, j1, dr, H):
    end, o, c, comp = S['end'], S['o'], S['c'], S['comp']; t0 = S['start'][j1]
    if end[comp].max() < t0 + H * 60 - 60: return None
    w = np.where(comp & (end > t0) & (end <= t0 + H * 60))[0]
    if len(w) == 0 or w[0] < j1: return None
    return dr * (c[w[-1]] - (o[j1] + dr * SLIP))

def main():
    rng = np.random.default_rng(SEED + 113); sess, ctxs, _ = TS.sessions_and_contexts(); rows = []; brk = {'TELL': 0, 'CONTROL': 0}; npts = {'TELL': 0, 'CONTROL': 0}
    for d in sorted(ctxs):
        ctx = ctxs[d]; S = ctx['S']; vw = vwap_by_bar(S); end, comp = S['end'], S['comp']; prof = T.Prof(ctx)
        tells = [(int(t['sig']), int(t['dir'])) for t in T.simulate(ctx, 'V1', dict(fires=0, skip=0, trades=0, fallback=0))]
        for arm, pts in (('TELL', tells), ('CONTROL', [(i, 0) for i in range(ctx['n'] - 1) if i % 10 == 0 and V.DEC_FIRST <= end[i] <= V.DEC_LAST and comp[i] and (ctx['moving1'][i] or ctx['moving-1'][i]) and not any(T.ncomp_at(ctx, prof, i, dd, need_nodes=False)[1] for dd in (1, -1))])):
            last_ev = {}
            for i, tdir in pts:
                npts[arm] += 1; ev = event_at(ctx, vw, i, last_ev)
                if ev is None: continue
                if ev[0] == 'BREAK': brk[arm] += 1; continue
                nm, dr, j1, below = ev; row = dict(date=d, arm=arm, level=nm, dr=dr, tell_toward=(None if arm == 'CONTROL' else (tdir == (1 if below else -1))), bin=(0 if (S['start'][i] - V.RTH_OPEN) / 60 < 90 else 1 if (S['start'][i] - V.RTH_OPEN) / 60 < 180 else 2))
                for H in HZ: row[f'y{H}'] = outcomes(S, j1, dr, H)
                rows.append(row)
    R = pd.DataFrame(rows); print(f'signal bars: TELL {npts["TELL"]}, CONTROL {npts["CONTROL"]}; level rejections (events): TELL {int((R.arm == "TELL").sum())} on {R[R.arm == "TELL"].date.nunique()} dates, CONTROL {int((R.arm == "CONTROL").sum())} on {R[R.arm == "CONTROL"].date.nunique()} dates; touch-then-break (not traded): TELL {brk["TELL"]}, CONTROL {brk["CONTROL"]}')
    print(f'rejection share of (rejections + breaks): TELL {100 * (R.arm == "TELL").sum() / ((R.arm == "TELL").sum() + brk["TELL"]):.1f}%, CONTROL {100 * (R.arm == "CONTROL").sum() / ((R.arm == "CONTROL").sum() + brk["CONTROL"]):.1f}%')
    dates = np.array(sorted(R.date.unique())); res = {}
    def stat(df, H):
        d = df[['date', 'arm', f'y{H}']].dropna(); return d
    for H in HZ:
        d = stat(R, H); T_, C_ = d[d.arm == 'TELL'], d[d.arm == 'CONTROL']; sT = T_.groupby('date')[f'y{H}'].agg(['sum', 'count']); sC = C_.groupby('date')[f'y{H}'].agg(['sum', 'count']); ud = np.array(sorted(set(sT.index) | set(sC.index))); aT = sT.reindex(ud).fillna(0).values; aC = sC.reindex(ud).fillna(0).values
        def m(w, a): return (w @ a[:, 0]) / max(1.0, w @ a[:, 1])
        AT = np.c_[aT[:, 0], aT[:, 1]] if False else np.c_[sT.reindex(ud)['sum'].fillna(0).values, sT.reindex(ud)['count'].fillna(0).values]; AC = np.c_[sC.reindex(ud)['sum'].fillna(0).values, sC.reindex(ud)['count'].fillna(0).values]
        w1 = np.ones(len(ud)); diff = m(w1, AT) - m(w1, AC); bd, bt = [], []
        for _ in range(BOOT): w = np.bincount(rng.integers(0, len(ud), len(ud)), minlength=len(ud)).astype(float); bd.append(m(w, AT) - m(w, AC)); bt.append(m(w, AT))
        lo, hi = np.percentile(bd, [2.5, 97.5]); tl, th = np.percentile(bt, [2.5, 97.5]); h = len(ud) // 2; hv = lambda s: m((np.arange(len(ud)) < h) * 1.0 if s else (np.arange(len(ud)) >= h) * 1.0, AT) - m((np.arange(len(ud)) < h) * 1.0 if s else (np.arange(len(ud)) >= h) * 1.0, AC)
        p = float(min(1.0, 2 * min((np.sum(np.array(bd) <= 0) + 1) / (BOOT + 1), (np.sum(np.array(bd) >= 0) + 1) / (BOOT + 1)))); res[H] = dict(diff=diff, lo=lo, hi=hi, p=p, tm=m(w1, AT), tl=tl, th=th, cm=m(w1, AC), nT=len(T_), dT=T_.date.nunique(), h1=hv(True), h2=hv(False))
    order = sorted(HZ, key=lambda k: res[k]['p']); keep = -1
    for rk, k in enumerate(order): keep = rk if res[k]['p'] <= (rk + 1) / 3 * 0.10 else keep
    print('\nRESOLUTION (CI half-width of the TELL absolute mean, points): ' + ', '.join(f'{H}m {(res[H]["th"] - res[H]["tl"]) / 2:.1f}' for H in HZ))
    print('\nCOUNTED: pooled levels, y = points moved AWAY from the level after a 1-3 bar rejection (gross; cost 1.25 + slip)')
    for rk, H in enumerate(order):
        r = res[H]; ok = rk <= keep and (r['lo'] > 0 or r['hi'] < 0) and r['tl'] > COST and r['nT'] >= 100 and r['dT'] >= 60 and np.sign(r['h1']) == np.sign(r['h2']) == np.sign(r['diff'])
        print(f'  H {H:2d}m: TELL mean {r["tm"]:+.2f} [{r["tl"]:+.2f}, {r["th"]:+.2f}] (N {r["nT"]}, {r["dT"]} dates), CONTROL mean {r["cm"]:+.2f}, TELL minus CONTROL {r["diff"]:+.2f} CI [{r["lo"]:+.2f}, {r["hi"]:+.2f}] p {r["p"]:.3f} halves {r["h1"]:+.2f} / {r["h2"]:+.2f} BH {"survives" if rk <= keep else "no"}{"  UNDERPOWERED" if r["nT"] < 100 or r["dT"] < 60 else ""}{"  <== CANDIDATE" if ok else ""}')
    print('\nUNCOUNTED per level (mean y30, N): ' + '; '.join(f'{lv} TELL {R[(R.arm == "TELL") & (R.level == lv)]["y30"].mean():+.2f} (N {int(((R.arm == "TELL") & (R.level == lv)).sum())}) CONTROL {R[(R.arm == "CONTROL") & (R.level == lv)]["y30"].mean():+.2f} (N {int(((R.arm == "CONTROL") & (R.level == lv)).sum())})' for lv in LEVELS))
    tt = R[R.arm == 'TELL']; print('UNCOUNTED tell direction vs the level (the user case): ' + '; '.join(f'tell {"TOWARD" if k else "AWAY FROM"} the level: N {int((tt.tell_toward == k).sum())}, mean y30 away-from-level {tt[tt.tell_toward == k]["y30"].mean():+.2f}' for k in (True, False)))
    print('UNCOUNTED by year (TELL mean y30): ' + ', '.join(f'{y} {tt[tt.date.str[:4] == y]["y30"].mean():+.2f} (N {int((tt.date.str[:4] == y).sum())})' for y in sorted(set(tt.date.str[:4]))))

if __name__ == '__main__': main()
