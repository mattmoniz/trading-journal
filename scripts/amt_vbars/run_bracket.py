"""Bracket (side-agnostic) after the tell, 5/15/30-minute exits (PREREG_BRACKET.md frozen 2026-11-01). EXPLORE ONLY. Usage: ../../venv/bin/python run_bracket.py"""
import numpy as np, pandas as pd
import vbars as V, trade as T
import run_break_entry as B
import run_expansion_horizons as H
SEED, SLIP, DPP, COMM = 20261101, 0.25, 2.0, 2.0
FLAT = T.FLAT_S

def bracket(S, i, k, W):
    """returns (net dollars or None for no fill, ambiguous flag)"""
    o, h, l, c, end, start = S['o'], S['h'], S['l'], S['c'], S['end'], S['start']; n = len(c); c0 = c[i]; up, dn = c0 + k, c0 - k; t0 = end[i]
    for j in range(i + 1, n):
        if start[j] >= FLAT or end[j] - t0 > W: return None, False
        hu, hd = h[j] >= up, l[j] <= dn
        if hu and hd: return -(2 * k + 2 * SLIP) * DPP - COMM, True
        if hu or hd:
            d = 1 if hu else -1; trig = up if hu else dn; ent = (max(trig, o[j]) if d == 1 else min(trig, o[j])) + d * SLIP; stop = dn if d == 1 else up; tf = end[j]
            for m in range(j + 1, n):
                if start[m] >= FLAT: return (((o[m] - d * SLIP) - ent) * d) * DPP - COMM, False
                if (d == 1 and l[m] <= stop) or (d == -1 and h[m] >= stop):
                    px = min(stop, o[m]) if d == 1 else max(stop, o[m]); return (((px - d * SLIP) - ent) * d) * DPP - COMM, False
                if end[m] - tf >= W: return (((c[m] - d * SLIP) - ent) * d) * DPP - COMM, False
            return (((c[n - 1] - d * SLIP) - ent) * d) * DPP - COMM, False
    return None, False

def main():
    rng = np.random.default_rng(SEED); sess, atr = H.sessions()
    df = pd.read_csv('decision_points_explore.csv')
    for c in ('moving', 'nodes', 'fast', 'flip', 'osc', 'strides'): df[c] = df[c].astype(str).str.lower().eq('true')
    df['nonode'] = (~df.nodes) & df.fast & df.flip & df.osc & df.strides
    g = df.groupby(['date', 'i']).agg(nmax=('ncomp', 'max'), mov=('moving', 'any'), nn=('nonode', 'any')).reset_index()
    arms = {'TELL': g[g.nmax == 5], 'CONTROL_MOVING': g[(g.nmax < 5) & g.mov], 'CONTROL_NONODE': g[g.nn & (g.nmax < 5)]}
    print({k: (len(v), v.date.nunique()) for k, v in arms.items()}, '(points, dates)')
    out = {}
    for mult in (1, 2):
        for Wm in (5, 15, 30):
            W = Wm * 60.0; res = {}
            for an, pts in arms.items():
                rows = []; fills = amb = 0
                for r in pts.itertuples():
                    S = sess[r.date]; i = int(r.i)
                    if i < 20: continue
                    k = mult * float(np.median(S['h'][i - 19:i + 1] - S['l'][i - 19:i + 1]))
                    net, a = bracket(S, i, k, W)
                    rows.append(dict(date=r.date, net=0.0 if net is None else net, bin=B.tbin(S, i), fill=net is not None, amb=a)); fills += net is not None; amb += a
                res[an] = (rows, fills, amb)
            A = res['TELL'][0]; mdate = sorted(r['date'] for r in A)[len(A) // 2]
            print(f"\n=== bracket k = {mult} x median bar range, window {Wm} min ===")
            for an in arms:
                rows, fills, amb = res[an]; p = np.array([r['net'] for r in rows]); fl = np.array([r['net'] for r in rows if r['fill']])
                print(f"  {an:15s} points {len(rows):5d} on {len({r['date'] for r in rows}):3d} dates | fill rate {100 * fills / len(rows):.0f}% ambiguous {100 * amb / max(fills, 1):.0f}% of fills | mean per point ${p.mean():+.2f} | per fill ${fl.mean() if len(fl) else float('nan'):+.2f}")
            m_, lo_, hi_ = B.abs_ci(A, rng); print(f"  TELL absolute per point ${m_:+.2f} day-blocked CI [{lo_:+.2f}, {hi_:+.2f}]")
            for cn in ('CONTROL_MOVING', 'CONTROL_NONODE'):
                C = res[cn][0]; pt, lo, hi = B.wdiff_ci(A, C, rng)
                h1 = B.wdiff_ci([r for r in A if r['date'] < mdate], [r for r in C if r['date'] < mdate], rng)[0]; h2 = B.wdiff_ci([r for r in A if r['date'] >= mdate], [r for r in C if r['date'] >= mdate], rng)[0]
                print(f"  TELL minus {cn:15s} (entry-time-mix weighted) ${pt:+.2f} CI [{lo:+.2f}, {hi:+.2f}] halves {h1:+.2f}/{h2:+.2f}")
                if cn == 'CONTROL_MOVING':
                    ok = len(A) >= 200 and len({r['date'] for r in A}) >= 100 and lo_ > 0 and lo > 0 and h1 > 0 and h2 > 0 and (res['TELL'][2] / max(res['TELL'][1], 1)) < 0.25
                    out[(mult, Wm)] = ok
            print(f"  READING: {'LEAD' if out[(mult, Wm)] else 'not shown'}")
    print('\nsummary', out)

if __name__ == '__main__': main()
