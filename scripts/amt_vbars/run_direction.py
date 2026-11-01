"""Direction test for the tell (PREREG_DIRECTION.md frozen 2026-11-01). EXPLORE ONLY. Usage: ../../venv/bin/python run_direction.py"""
import glob, os
import numpy as np
import vbars as V, trade as T
SEED, BOOT, TRIALS, K = 20261101, 2000, 200, 10

def dK(S, i):
    if i - K + 1 < 0: return None
    return float(np.sum(S['ask'][i - K + 1:i + 1] - S['bid'][i - K + 1:i + 1]))

def sgn(x): return 0 if x is None or x == 0 else (1 if x > 0 else -1)

def dayci(ev, vals, rng):
    """day-blocked CI of the per-event mean of vals (list aligned with ev)."""
    g = {}
    for e, v in zip(ev, vals): g.setdefault(e['date'], []).append(v)
    arrs = [np.array(a) for a in g.values()]; m = len(arrs)
    means = np.array([np.concatenate([arrs[j] for j in rng.integers(0, m, m)]).mean() for _ in range(BOOT)])
    return float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))

def splitci(ev, a_mask, vals, rng):
    """day-blocked CI of mean(vals | a_mask) - mean(vals | ~a_mask), per-trade means within the pooled resample."""
    g = {}
    for e, v, m in zip(ev, vals, a_mask): g.setdefault(e['date'], []).append((v, m))
    ds = [np.array(a) for a in g.values()]; n = len(ds); out = []
    for _ in range(BOOT):
        arr = np.concatenate([ds[j] for j in rng.integers(0, n, n)]); a = arr[arr[:, 1] == 1, 0]; b = arr[arr[:, 1] == 0, 0]
        if len(a) and len(b): out.append(a.mean() - b.mean())
    return float(np.percentile(out, 2.5)), float(np.percentile(out, 97.5))

def top5share(ev, diffs):
    tot = sum(diffs)
    if tot <= 0: return None
    g = {}
    for e, d in zip(ev, diffs): g[e['date']] = g.get(e['date'], 0) + d
    return 100 * sum(sorted(g.values(), reverse=True)[:5]) / tot

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
    print(f'Sessions usable {len(ctxs)}; V1 tell trades {len(tr)} (expected 1760); hold-out NOT touched')
    ev = []
    for t in tr:
        S = ctxs[t['date']]['S']; ei = t['ei']; i0 = ei - 1
        d_now, d_prev = dK(S, i0), dK(S, i0 - K)
        ev.append(dict(date=t['date'], dir=t['dir'], risk=t['risk'], ei=ei, net_tell=t['net'],
                       net_same=T.stripped(ctxs[t['date']], ei, t['dir'], t['risk']), net_opp=T.stripped(ctxs[t['date']], ei, -t['dir'], t['risk']),
                       ddir=sgn(d_now), flip=(d_now is not None and d_prev is not None and sgn(d_now) != 0 and sgn(d_prev) != 0 and sgn(d_now) != sgn(d_prev))))
    N = len(ev); days = len({e['date'] for e in ev})
    print(f"events {N} on {days} dates; with a DELTA read {sum(e['ddir'] != 0 for e in ev)}; with a FLIP {sum(e['flip'] for e in ev)}; DELTA agrees with tell {sum(e['ddir'] == e['dir'] for e in ev)}, disagrees {sum(e['ddir'] == -e['dir'] for e in ev)}")
    for e in ev: e['net_d'] = None if e['ddir'] == 0 else (e['net_same'] if e['ddir'] == e['dir'] else e['net_opp'])
    for e in ev: e['net_f'] = (e['net_same'] if e['ddir'] == e['dir'] else e['net_opp']) if e['flip'] else e['net_same']
    med = sorted(e['date'] for e in ev)[N // 2]
    # Q1
    same = np.array([e['net_same'] for e in ev]); opp = np.array([e['net_opp'] for e in ev])
    pl = []
    for _ in range(TRIALS):
        r = rng.integers(0, 2, N); pl.append(np.mean(np.where(r == 1, same, opp)))
    p95 = float(np.percentile(pl, 95)); pm = float(np.mean(pl))
    print('\n=== Q1 (descriptive): tell direction vs opposite vs random-direction placebo, same entry/stop/exit (stripped geometry) ===')
    print(f"  R0 tell dir : mean ${same.mean():+.2f} CI {tuple(round(x, 2) for x in dayci(ev, same, rng))}   WR {100 * np.mean(same > 0):.1f}%")
    print(f"  R1 opposite : mean ${opp.mean():+.2f} CI {tuple(round(x, 2) for x in dayci(ev, opp, rng))}   WR {100 * np.mean(opp > 0):.1f}%")
    print(f"  PLACEBO random dir: mean ${pm:+.2f}, p95 ${p95:+.2f} over {TRIALS} draws")
    print(f"  (real V1 trade with its own exits, for reference: mean ${np.mean([e['net_tell'] for e in ev]):+.2f})")
    diff = opp - same; print(f"  R1 minus R0 paired: {diff.mean():+.2f} CI {tuple(round(x, 2) for x in dayci(ev, diff, rng))}")
    first = [e for e in ev if e['date'] < med]; second = [e for e in ev if e['date'] >= med]
    print(f"  halves (R1 minus R0): first {np.mean([e['net_opp'] - e['net_same'] for e in first]):+.2f}, second {np.mean([e['net_opp'] - e['net_same'] for e in second]):+.2f}")
    # Q2
    print('\n=== Q2: flow-based direction rules, paired against the tell direction on the same events ===')
    results = {}
    for name, key, sub in (('R2 DELTA', 'net_d', [e for e in ev if e['net_d'] is not None]), ('R3 FLIP', 'net_f', ev)):
        vals = np.array([e[key] for e in sub]); base_v = np.array([e['net_same'] for e in sub]); d = vals - base_v
        pl2 = []
        for _ in range(TRIALS):
            r = rng.integers(0, 2, len(sub)); pl2.append(np.mean(np.where(r == 1, [e['net_same'] for e in sub], [e['net_opp'] for e in sub])))
        p95b = float(np.percentile(pl2, 95)); ci_d = dayci(sub, d, rng)
        h1 = [e[key] - e['net_same'] for e in sub if e['date'] < med]; h2 = [e[key] - e['net_same'] for e in sub if e['date'] >= med]
        t5 = top5share(sub, list(d)); nd = len({e['date'] for e in sub})
        ok = len(sub) >= 200 and nd >= 100 and ci_d[0] > 0 and vals.mean() > p95b and np.mean(h1) > 0 and np.mean(h2) > 0 and (t5 is not None and t5 < 50)
        print(f"  {name}: N={len(sub)} on {nd} dates; rule mean ${vals.mean():+.2f} vs tell ${base_v.mean():+.2f}; paired diff {d.mean():+.2f} CI [{ci_d[0]:+.2f}, {ci_d[1]:+.2f}]; placebo p95 ${p95b:+.2f}; halves {np.mean(h1):+.2f}/{np.mean(h2):+.2f}; top5 share {('n/a' if t5 is None else f'{t5:.0f}%')} -> {'PASS' if ok else 'not shown'}")
        results[name] = ok
    agree = np.array([1 if e['ddir'] == e['dir'] else 0 for e in ev if e['ddir'] != 0]); sub = [e for e in ev if e['ddir'] != 0]; v = [e['net_same'] for e in sub]
    a = np.array(v)[agree == 1]; b = np.array(v)[agree == 0]; ci_s = splitci(sub, agree, v, rng)
    h1a = [e for e in sub if e['date'] < med]; h2a = [e for e in sub if e['date'] >= med]
    def dd(es):
        x = [e['net_same'] for e in es if e['ddir'] == e['dir']]; y = [e['net_same'] for e in es if e['ddir'] != e['dir']]; return np.mean(x) - np.mean(y)
    ds = [(e['net_same'] if e['ddir'] == e['dir'] else -e['net_same']) for e in sub]
    ok4 = len(sub) >= 200 and len({e['date'] for e in sub}) >= 100 and ci_s[0] > 0 and a.mean() > p95 and dd(h1a) > 0 and dd(h2a) > 0
    print(f"  R4 AGREE: tell where DELTA agrees N={len(a)} mean ${a.mean():+.2f} | disagrees N={len(b)} mean ${b.mean():+.2f}; diff {a.mean() - b.mean():+.2f} CI [{ci_s[0]:+.2f}, {ci_s[1]:+.2f}]; AGREE mean vs placebo p95 ${p95:+.2f}; halves {dd(h1a):+.2f}/{dd(h2a):+.2f} -> {'PASS' if ok4 else 'not shown'}")
    print(f"      (the opposite side on DISAGREE events: mean ${np.mean([e['net_opp'] for e in sub if e['ddir'] != e['dir']]):+.2f})")
    print('\nsummary:', {**results, 'R4 AGREE': ok4})

main()
