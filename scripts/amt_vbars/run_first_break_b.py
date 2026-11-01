"""Amendment 1 of PREREG_FIRST_BREAK_SIDE.md: corrected failed-break-back split and near/far standardisation. EXPLORE ONLY."""
import glob, os
import numpy as np
import vbars as V, trade as T
import run_first_break as R

def main():
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
    tr = []; rep = dict(fires=0, skip=0, trades=0, fallback=0)
    for d, c in ctxs.items(): tr += T.simulate(c, 'V1', rep)
    tell, ctrl, still, inside = [], [], [], []
    for t in tr:
        c = ctxs[t['date']]; S = c['S']; i = t['sig']; d = t['dir']; cl = S['c'][i]; bo = T.boundary(c, i, -d)
        near = abs(T.boundary(c, i, d) - cl) < abs(bo - cl); r = R.first_break(c, i, d)
        if T.inside_range(c, i, -d): tell.append(dict(date=t['date'], r=r, near=near)); continue
        outside = (cl < bo) if d == 1 else (cl > bo)
        if outside:
            back = False
            for j in range(i + 1, c['n']):
                if S['start'][j] >= T.FLAT_S or S['end'][j] - S['end'][i] > R.HORIZON: break
                bb = T.boundary(c, j, -d)
                if (S['c'][j] >= bb) if d == 1 else (S['c'][j] <= bb): back = True; break
            still.append(dict(back=back, r=r))
        else: inside.append(dict(r=r))
    for dte, c in ctxs.items():
        S = c['S']; end = S['end']
        for i in range(c['n'] - 1):
            if i % 10 or not (V.DEC_FIRST <= end[i] <= V.DEC_LAST) or not S['comp'][i]: continue
            for d in (1, -1):
                if c[f'moving{d}'][i] and T.inside_range(c, i, d) and T.inside_range(c, i, -d):
                    cl = S['c'][i]; ctrl.append(dict(date=dte, r=R.first_break(c, i, d), near=abs(T.boundary(c, i, d) - cl) < abs(T.boundary(c, i, -d) - cl)))
    nt = sum(e['near'] for e in tell) / len(tell); nc = sum(e['near'] for e in ctrl) / len(ctrl)
    print(f"near share of events: tell {100 * nt:.1f}% (n={len(tell)}), control {100 * nc:.1f}% (n={len(ctrl)})")
    sh = lambda ev: R.shares(ev)[0]
    cn = sh([e for e in ctrl if e['near']]); cf = sh([e for e in ctrl if not e['near']]); tn = sh([e for e in tell if e['near']]); tf = sh([e for e in tell if not e['near']])
    std = nt * cn + (1 - nt) * cf
    print(f"first-break-on-own-side share: tell NEAR {100 * tn:.1f} FAR {100 * tf:.1f}; control NEAR {100 * cn:.1f} FAR {100 * cf:.1f}")
    print(f"headline tell {100 * sh(tell):.1f}% vs control {100 * sh(ctrl):.1f}% (raw +{100 * (sh(tell) - sh(ctrl)):.1f}); control standardised to the tell's near/far mix {100 * std:.1f}% -> tell minus standardised control {100 * (sh(tell) - std):+.1f} pts")
    rng = np.random.default_rng(R.SEED + 1)
    def stdstat(ev_t, ev_c):
        a = sum(e['near'] for e in ev_t) / len(ev_t); return sh(ev_t) - (a * sh([e for e in ev_c if e['near']]) + (1 - a) * sh([e for e in ev_c if not e['near']]))
    days = sorted({e['date'] for e in tell} | {e['date'] for e in ctrl}); dt, dc = {}, {}
    for e in tell: dt.setdefault(e['date'], []).append(e)
    for e in ctrl: dc.setdefault(e['date'], []).append(e)
    out = []
    for _ in range(R.BOOT):
        pk = rng.integers(0, len(days), len(days)); a = [x for k in pk for x in dt.get(days[k], [])]; b = [x for k in pk for x in dc.get(days[k], [])]
        if a and b: out.append(stdstat(a, b))
    out = [x for x in out if not np.isnan(x)]; print(f"  standardised difference day-blocked CI [{100 * np.percentile(out, 2.5):+.1f}, {100 * np.percentile(out, 97.5):+.1f}]")
    print(f"\nFAILED-BREAK-BACK class corrected: {len(still) + len(inside)} fires = STILL_OUTSIDE at the fire {len(still)}, BACK_INSIDE {len(inside)}")
    print(f"  STILL_OUTSIDE: closes back inside the range within the window {sum(e['back'] for e in still)} ({100 * np.mean([e['back'] for e in still]):.0f}%)")
    cb = {k: sum(e['r'] == k for e in inside) for k in 'TON'}; print(f"  BACK_INSIDE first break: tell side {cb['T']}, the already-broken side again {cb['O']}, none {cb['N']}")

if __name__ == '__main__': main()
