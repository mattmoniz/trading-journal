"""Tell-armed wait-for-break entry test (PREREG_BREAK_ENTRY.md frozen 2026-11-01). EXPLORE ONLY. Usage: ../../venv/bin/python run_break_entry.py"""
import glob, os
import numpy as np, pandas as pd
import vbars as V, trade as T
SEED, BOOT, HORIZON = 20261101, 2000, 7200.0

def load_ctxs():
    dates = sorted(os.path.basename(p)[:10] for p in glob.glob(V.ROOT + '/*.bars.tsv')); dates = [d for d in dates if d <= '2025-05-16']
    sess, stats = {}, {}
    for d in dates:
        try: S = V.load_session(d)
        except Exception: continue
        sess[d] = S; stats[d] = V.session_stats(S)
    ks = sorted(sess); ctxs = {}
    for i, d in enumerate(ks):
        if i < 20: continue
        prior = ks[i - 20:i]; rngs = [stats[p][0] for p in prior if not np.isnan(stats[p][0])]
        if len(rngs) < 15: continue
        base = {h: float(np.mean([stats[p][1][h] for p in prior if h in stats[p][1]])) for h in range(24) if sum(h in stats[p][1] for p in prior) >= 15}
        c = T.prep(sess[d], float(np.mean(rngs)), base)
        if c is not None: ctxs[d] = c
    return ctxs

def first_break(ctx, i):
    S = ctx['S']; n = ctx['n']; end, start, c = S['end'], S['start'], S['c']; t0 = end[i]
    for j in range(i + 1, n - 1):
        if start[j] >= T.FLAT_S or end[j] - t0 > HORIZON: return None
        if c[j] > T.boundary(ctx, j, 1): return j, 1
        if c[j] < T.boundary(ctx, j, -1): return j, -1
    return None

def tbin(S, ei):
    m = (S['start'][ei] - V.RTH_OPEN) / 60.0
    return 0 if m < 90 else 1 if m < 180 else 2

def agg(rows, dts):
    idx = {d: k for k, d in enumerate(dts)}; Sm = np.zeros((len(dts), 3)); N = np.zeros((len(dts), 3))
    for r in rows: Sm[idx[r['date']], r['bin']] += r['net']; N[idx[r['date']], r['bin']] += 1
    return Sm, N

def wdiff_draws(A, C, rng):
    """(point estimate, list of day-bootstrap draws) of the entry-time-mix-weighted TELL minus CONTROL difference; wdiff_ci takes the percentiles."""
    dts = sorted({r['date'] for r in A} | {r['date'] for r in C}); Sa, Na = agg(A, dts); Sc, Nc = agg(C, dts); D = len(dts)
    def one(wgt):
        na, nc = wgt @ Na, wgt @ Nc
        if (na == 0).any() or (nc == 0).any(): return None
        return float(np.sum(na / na.sum() * ((wgt @ Sa) / na - (wgt @ Sc) / nc)))
    point = one(np.ones(D)); out = [v for v in (one(np.bincount(rng.integers(0, D, D), minlength=D).astype(float)) for _ in range(BOOT)) if v is not None]
    return point, out

def wdiff_ci(A, C, rng):
    point, out = wdiff_draws(A, C, rng)
    return point, float(np.percentile(out, 2.5)), float(np.percentile(out, 97.5))

def abs_ci(A, rng):
    dts = sorted({r['date'] for r in A}); Sa, Na = agg(A, dts); S1, N1 = Sa.sum(1), Na.sum(1); D = len(dts); out = []
    for _ in range(BOOT):
        w = np.bincount(rng.integers(0, D, D), minlength=D).astype(float); out.append(float(w @ S1 / (w @ N1)))
    return float(S1.sum() / N1.sum()), float(np.percentile(out, 2.5)), float(np.percentile(out, 97.5))

def main():
    rng = np.random.default_rng(SEED); ctxs = load_ctxs(); print(f'Sessions usable {len(ctxs)}; hold-out NOT touched')
    df = pd.read_csv('decision_points_explore.csv'); tl = df.groupby(['date', 'i']).ncomp.max().reset_index(); tl['armed'] = tl.ncomp == 5
    print(f"decision points {len(tl)}: armed {int(tl.armed.sum())}, control {int((~tl.armed).sum())}")
    ev = {}; excl = dict(armed=0, control=0)
    for d, g in tl.groupby('date'):
        if d not in ctxs: continue
        c = ctxs[d]
        for i, armed in zip(g.i.to_numpy(), g.armed.to_numpy()):
            if not (T.inside_range(c, int(i), 1) and T.inside_range(c, int(i), -1)): excl['armed' if armed else 'control'] += 1; continue
            fb = first_break(c, int(i))
            if fb is None: continue
            j, dr = fb; key = (d, j + 1, dr)
            if armed: ev[key] = 'armed'
            elif key not in ev: ev[key] = 'control'
    print(f"points excluded because a side was already broken: armed {excl['armed']}, control {excl['control']}; break events: armed {sum(v == 'armed' for v in ev.values())}, control {sum(v == 'control' for v in ev.values())}")
    res = {'S_EDGE': {'armed': [], 'control': []}, 'S_NODE': {'armed': [], 'control': []}}; skip = {'S_EDGE': 0, 'S_NODE': 0}
    byd = {}
    for (d, ei, dr), arm in ev.items(): byd.setdefault(d, []).append((ei, dr, arm))
    for d, lst in byd.items():
        c = ctxs[d]; S = c['S']; prof = T.Prof(c)
        for ei, dr, arm in sorted(lst):
            j = ei - 1; entry = S['o'][ei] + dr * T.SLIP
            stops = {'S_EDGE': T.boundary(c, j, dr) - dr * T.TICK}; sp = T.stop_price(c, prof.upto(j), j, dr, 2); stops['S_NODE'] = sp[0] if sp else None
            for nm, st in stops.items():
                if st is None or dr * (entry - st) <= 0: skip[nm] += 1; continue
                tr = T.run_position(c, prof, ei, dr, st, 'V3', S['end'][j]); res[nm][arm].append(dict(date=d, net=tr['net'], pts=tr['pts'], bin=tbin(S, ei), risk=tr['risk']))
    print(f"skipped (entry not beyond stop / no node stop): {skip}")
    for nm in ('S_EDGE', 'S_NODE'):
        A, C = res[nm]['armed'], res[nm]['control']
        if not A or not C: print(nm, 'no events'); continue
        mdate = sorted(r['date'] for r in A)[len(A) // 2]
        print(f"\n=== {nm} ===")
        for lab, rr in (('ARMED', A), ('CONTROL', C)):
            p = np.array([r['net'] for r in rr]); print(f"  {lab:8s} N={len(rr)} on {len({r['date'] for r in rr})} dates, mean ${p.mean():+.2f}, WR {100 * np.mean(p > 0):.1f}%, median stop distance {np.median([r['risk'] for r in rr]):.1f} pts")
        m, lo, hi = abs_ci(A, rng); print(f"  ARMED absolute mean ${m:+.2f} day-blocked CI [{lo:+.2f}, {hi:+.2f}]")
        pt, lo, hi = wdiff_ci(A, C, rng); h = [wdiff_ci([r for r in A if r['date'] < mdate], [r for r in C if r['date'] < mdate], rng)[0], wdiff_ci([r for r in A if r['date'] >= mdate], [r for r in C if r['date'] >= mdate], rng)[0]]
        print(f"  ARMED minus CONTROL (entry-time-mix weighted) ${pt:+.2f} CI [{lo:+.2f}, {hi:+.2f}], halves {h[0]:+.2f}/{h[1]:+.2f}")
        ok = len(A) >= 200 and len({r['date'] for r in A}) >= 100 and lo > 0 and abs_ci(A, rng)[1] > 0 and h[0] > 0 and h[1] > 0
        print(f"  READING: {'LEAD (all conditions met)' if ok else 'not shown'}")

if __name__ == '__main__': main()
