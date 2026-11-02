"""Structural profit exits for the tell trade (PREREG_PROFIT_EXITS.md frozen 2026-11-01). EXPLORE ONLY. Usage: ../../venv/bin/python run_profit_exits.py"""
import numpy as np
import vbars as V, trade as T
import run_break_entry as B
TICK = SLIP = 0.25; DPP, COMM = 2.0, 2.0
SEED, BOOT, TRIALS = 20261101, 2000, 40

def sim(S, ei, d, sd, td=None, W=None):
    o, h, l, c, end, start = S['o'], S['h'], S['l'], S['c'], S['end'], S['start']; n = len(c)
    entry = o[ei] + d * SLIP; stop = entry - d * sd; tgt = None if td is None else entry + d * td; t0 = end[ei - 1]; tmax = (W if W else T.TIMEOUT_S); pend = False
    net = lambda px: ((px - entry) * d) * DPP - COMM
    for j in range(ei, n):
        if pend or start[j] >= T.FLAT_S: return net(o[j] - d * SLIP), 'time'
        if j > ei and d * (o[j] - stop) <= 0: return net(o[j] - d * SLIP), 'stop'
        stop_hit = (d == 1 and l[j] <= stop) or (d == -1 and h[j] >= stop)
        if stop_hit: return net(stop - d * SLIP), 'stop'
        if tgt is not None:
            if d * (o[j] - tgt) >= 0 and j > ei: return net(o[j]), 'target'
            if (d == 1 and h[j] >= tgt + TICK) or (d == -1 and l[j] <= tgt - TICK): return net(tgt), 'target'
        if end[j] - t0 >= tmax: pend = True
    return net(c[n - 1]), 'time'

def target_dist(c, prof, i0, ei, d, kind):
    S = c['S']; entry = S['o'][ei] + d * SLIP
    if kind == 'T1':
        lv = [c['onh'], c['ibh'] if S['end'][i0] >= V.RTH_OPEN + 3600 else None] if d == 1 else [c['onl'], c['ibl'] if S['end'][i0] >= V.RTH_OPEN + 3600 else None]
        lv = [x for x in lv if x is not None and d * (x - entry) > 2 * TICK]
        return None if not lv else min(abs(x - entry) for x in lv)
    P = prof.upto(i0); nds = V.nodes_of(P, c['lo_bin'])
    if d == 1: ahead = [a * TICK for a, b in nds if a * TICK > entry + 2 * TICK]; return None if not ahead else min(ahead) - entry
    ahead = [(b + 1) * TICK for a, b in nds if (b + 1) * TICK < entry - 2 * TICK]; return None if not ahead else entry - max(ahead)

def main():
    rng = np.random.default_rng(SEED); ctxs = B.load_ctxs(); fires = []
    rep = dict(fires=0, skip=0, trades=0, fallback=0)
    for dte, c in ctxs.items():
        prof = T.Prof(c)
        for t in T.simulate(c, 'V1', rep):
            i0 = t['sig']; ei = t['ei']; d = t['dir']
            fires.append(dict(date=dte, c=c, ei=ei, d=d, risk=t['risk'], v1=t['net'], t1=target_dist(c, prof, i0, ei, d, 'T1'), t2=target_dist(c, prof, i0, ei, d, 'T2')))
    N = len(fires); print(f'Sessions usable {len(ctxs)}; V1 fires {N} (expected 1760); hold-out NOT touched; V1 actual mean ${np.mean([f["v1"] for f in fires]):+.2f} (reference only)')
    print(f"fires with a T1 structural target {sum(f['t1'] is not None for f in fires)}, with a T2 node target {sum(f['t2'] is not None for f in fires)}; median target distance T1 {np.median([f['t1'] for f in fires if f['t1'] is not None]):.1f} pts, T2 {np.median([f['t2'] for f in fires if f['t2'] is not None]):.1f} pts; median stop {np.median([f['risk'] for f in fires]):.1f}")
    med = sorted(f['date'] for f in fires)[N // 2]
    variants = [('NONE', None, None), ('T1 edge', 't1', None), ('T2 node', 't2', None), ('T3 15min', None, 900.0), ('T3 30min', None, 1800.0), ('T3 60min', None, 3600.0)]
    def run(f, dirn, key, W):
        td = f[key] if key else None
        r, why = sim(f['c']['S'], f['ei'], dirn, f['risk'], td, W); return r, why
    base = np.array([run(f, f['d'], None, None)[0] for f in fires]); out = {}
    for name, key, W in variants:
        rr = [run(f, f['d'], key, W) for f in fires]; v = np.array([r[0] for r in rr]); why = [r[1] for r in rr]
        pl = []
        for _ in range(TRIALS):
            dirs = rng.choice([-1, 1], N); pl.append(np.mean([run(f, int(dr), key, W)[0] for f, dr in zip(fires, dirs)]))
        p95 = float(np.percentile(pl, 95)); a, alo, ahi = D_abs(fires, v, rng); dd = v - base; plo, phi = D_abs(fires, dd, rng)[1:]
        h1 = dd[[f['date'] < med for f in fires]].mean(); h2 = dd[[f['date'] >= med for f in fires]].mean()
        ok = name != 'NONE' and alo > 0 and plo > 0 and v.mean() > p95 and h1 > 0 and h2 > 0
        share = {k: 100 * np.mean([w == k for w in why]) for k in ('target', 'stop', 'time')}
        print(f"{name:9s} mean ${v.mean():+7.2f} abs CI [{alo:+.2f}, {ahi:+.2f}] WR {100 * np.mean(v > 0):.0f}% exits target {share['target']:.0f}% stop {share['stop']:.0f}% time {share['time']:.0f}% | paired vs NONE {dd.mean():+.2f} CI [{plo:+.2f}, {phi:+.2f}] halves {h1:+.2f}/{h2:+.2f} | placebo mean ${np.mean(pl):+.2f} p95 ${p95:+.2f} -> {'LEAD' if ok else 'not shown'}")
        out[name] = ok
    print('\nsummary', out)

def D_abs(fires, vals, rng):
    g = {}
    for f, x in zip(fires, vals): g.setdefault(f['date'], []).append(x)
    arrs = [np.array(a) for a in g.values()]; m = len(arrs)
    means = np.array([np.concatenate([arrs[j] for j in rng.integers(0, m, m)]).mean() for _ in range(BOOT)])
    return float(np.mean(vals)), float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))

if __name__ == '__main__': main()
