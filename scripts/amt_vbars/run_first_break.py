"""First-break-side count for the tell (PREREG_FIRST_BREAK_SIDE.md frozen 2026-11-01). EXPLORE ONLY. Usage: ../../venv/bin/python run_first_break.py"""
import glob, os
import numpy as np
import vbars as V, trade as T
SEED, BOOT, HORIZON = 20261101, 2000, 7200.0

def first_break(ctx, i, d):
    S = ctx['S']; n = ctx['n']; end, start, c = S['end'], S['start'], S['c']; t0 = end[i]
    for j in range(i + 1, n):
        if start[j] >= T.FLAT_S or end[j] - t0 > HORIZON: break
        bt, bo = T.boundary(ctx, j, d), T.boundary(ctx, j, -d)
        if (c[j] > bt) if d == 1 else (c[j] < bt): return 'T'
        if (c[j] < bo) if d == 1 else (c[j] > bo): return 'O'
    return 'N'

def shares(ev):
    b = [e for e in ev if e['r'] != 'N']
    return (sum(e['r'] == 'T' for e in b) / len(b)) if b else float('nan'), len(b) / max(1, len(ev))

def blocked_diff(a, b, rng, stat):
    da, db = {}, {}
    for e in a: da.setdefault(e['date'], []).append(e)
    for e in b: db.setdefault(e['date'], []).append(e)
    days = sorted(set(da) | set(db)); out = []
    for _ in range(BOOT):
        pick = rng.integers(0, len(days), len(days)); ea = [x for k in pick for x in da.get(days[k], [])]; eb = [x for k in pick for x in db.get(days[k], [])]
        if ea and eb: out.append(stat(ea) - stat(eb))
    out = [x for x in out if not np.isnan(x)]
    return float(np.percentile(out, 2.5)), float(np.percentile(out, 97.5))

def main():
    rng = np.random.default_rng(SEED)
    dates = sorted(os.path.basename(p)[:10] for p in glob.glob(V.ROOT + '/*.bars.tsv')); dates = [d for d in dates if d <= '2025-05-16']
    sess, stats = {}, {}
    for d in dates:
        try: S = V.load_session(d)
        except Exception as e: print('skip', d, e); continue
        sess[d] = S; stats[d] = V.session_stats(S)
    ks = sorted(sess); ctxs = {}
    for i, d in enumerate(ks):
        if i < 20: continue
        prior = ks[i - 20:i]; rngs = [stats[p][0] for p in prior if not np.isnan(stats[p][0])]
        if len(rngs) < 15: continue
        base = {h: float(np.mean([stats[p][1][h] for p in prior if h in stats[p][1]])) for h in range(24) if sum(h in stats[p][1] for p in prior) >= 15}
        c = T.prep(sess[d], float(np.mean(rngs)), base)
        if c is not None: ctxs[d] = c
    tr = []; rep = dict(fires=0, skip=0, trades=0, fallback=0)
    for d, c in ctxs.items(): tr += T.simulate(c, 'V1', rep)
    print(f'Sessions usable {len(ctxs)}; V1 tell fires {len(tr)} (expected 1760); hold-out NOT touched')
    tell, back = [], []
    for t in tr:
        c = ctxs[t['date']]; S = c['S']; i = t['sig']; d = t['dir']; cl = S['c'][i]
        e = dict(date=t['date'], d=d, r=first_break(c, i, d), near=abs(T.boundary(c, i, d) - cl) < abs(T.boundary(c, i, -d) - cl))
        (tell if T.inside_range(c, i, -d) else back).append(e)
    ctrl = []
    for dte, c in ctxs.items():
        S = c['S']; end = S['end']
        for i in range(c['n'] - 1):
            if i % 10 or not (V.DEC_FIRST <= end[i] <= V.DEC_LAST) or not S['comp'][i]: continue
            for d in (1, -1):
                if c[f'moving{d}'][i] and T.inside_range(c, i, d) and T.inside_range(c, i, -d):
                    cl = S['c'][i]; ctrl.append(dict(date=dte, d=d, r=first_break(c, i, d), near=abs(T.boundary(c, i, d) - cl) < abs(T.boundary(c, i, -d) - cl)))
    cnt = lambda ev: {k: sum(e['r'] == k for e in ev) for k in 'TON'}
    print(f"tell fires with BOTH sides inside the range: {len(tell)} on {len({e['date'] for e in tell})} dates {cnt(tell)}; opposite side ALREADY broken (failed-break-back candidates): {len(back)} {cnt(back)}")
    print(f"control (moving only, both sides inside): {len(ctrl)} points on {len({e['date'] for e in ctrl})} dates {cnt(ctrl)}")
    st, bt = shares(tell); sc, bc = shares(ctrl)
    nb = sum(e['r'] != 'N' for e in tell); ndays = len({e['date'] for e in tell if e['r'] != 'N'})
    print(f"\n=== headline: share of FIRST breaks that are on the tell's side (breaking events only) ===")
    print(f"  TELL    {100 * st:.1f}% of {nb} breaking events on {ndays} dates; break rate {100 * bt:.1f}%")
    print(f"  CONTROL {100 * sc:.1f}% of {sum(e['r'] != 'N' for e in ctrl)}; break rate {100 * bc:.1f}%")
    lo, hi = blocked_diff(tell, ctrl, rng, lambda ev: shares(ev)[0]); lo0, hi0 = lo, hi; print(f"  tell minus control share: {100 * (st - sc):+.1f} pts, day-blocked CI [{100 * lo:+.1f}, {100 * hi:+.1f}]")
    lo, hi = blocked_diff(tell, ctrl, rng, lambda ev: shares(ev)[1]); print(f"  tell minus control break rate: {100 * (bt - bc):+.1f} pts, CI [{100 * lo:+.1f}, {100 * hi:+.1f}]")
    med = sorted(e['date'] for e in tell)[len(tell) // 2]
    for lab, f in (('first half', lambda e: e['date'] < med), ('second half', lambda e: e['date'] >= med)):
        a = [e for e in tell if f(e)]; b = [e for e in ctrl if f(e)]; print(f"  {lab}: tell {100 * shares(a)[0]:.1f}% (n={sum(e['r'] != 'N' for e in a)}), control {100 * shares(b)[0]:.1f}% (n={sum(e['r'] != 'N' for e in b)})")
    verdict = 'UNDERPOWERED' if nb < 40 or ndays < 30 else ('BELOW control (user reading)' if hi0 < 0 else 'ABOVE control (design reading)' if lo0 > 0 else 'not shown')
    print(f"  READING (pre-registered rule): {verdict}")
    print('\n=== descriptive: NEAR vs FAR (tell points at the nearer / farther range side) ===')
    for lab, f in (('NEAR', lambda e: e['near']), ('FAR', lambda e: not e['near'])):
        a = [e for e in tell if f(e)]; b = [e for e in ctrl if f(e)]; print(f"  {lab}: tell {len(a)} events, first-break-on-tell-side {100 * shares(a)[0]:.1f}% (break rate {100 * shares(a)[1]:.0f}%); control {len(b)}, {100 * shares(b)[0]:.1f}% (break rate {100 * shares(b)[1]:.0f}%)")
    if back:
        print(f"\n=== descriptive: FAILED-BREAK-BACK candidates (opposite side already broken earlier in RTH): {len(back)} fires; tell side breaks first {sum(e['r'] == 'T' for e in back)}, a new break on the other side first {sum(e['r'] == 'O' for e in back)}, none {sum(e['r'] == 'N' for e in back)}")

if __name__ == "__main__": main()
