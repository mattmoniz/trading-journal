"""Q4-5 outcome tests (prereg docs/VACUUM_COMMON_SIM_PREREG_20261108.md, ledger look 189). Reads events.csv (from run_events.py) and the Explore bars; forward signed change of the close from the event bar to bar
min(k+h, hard-flat bar), h=30 PRIMARY (10, 60 descriptive). Points are the unit (cost context about 2.0 pt all-in per MNQ round trip, NOT subtracted). Day-blocked bootstrap (3000, seeded) for every difference;
Holm 0.10 across the 10 counted tests; thirds printed as INFORMATION only. Depth term = the D1 trade-count proxy (labelled in every line)."""
import sys, os, csv, json, math, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import features as Fm
OUT = os.path.join(Fm.ROOT, 'scratch', 'vacuum_sim_20261108'); H_PRIMARY = 30; HS = (10, 30, 60); B = 3000
ev = list(csv.DictReader(open(os.path.join(OUT, 'events.csv'))))
for r in ev: r['bar'] = int(r['bar']); r['dir'] = int(r['dir']); r['pace'] = float(r['pace'])
by_date = collections.defaultdict(list)
for r in ev: by_date[r['date']].append(r)
FLAT = {'RTH': lambda T: T['close'] - 300.0, 'GBX': lambda T: 55790.0}
fw = {}            # (date, track, fam, bar) -> {h: signed change}
base = collections.defaultdict(lambda: collections.defaultdict(list))      # track -> date -> [signed ROC-sign drift of ALL in-window bars at h=30] (the unconditional continuation baseline)
for p in sorted(os.path.join(Fm.BARS, f) for f in os.listdir(Fm.BARS) if f.endswith('.bars.tsv') and f[:10] <= Fm.LAST_EXPLORE):
    S = Fm.load_full(p)
    if S is None: continue
    for name, T in Fm.track_split(S).items():
        c = T['c']; last = np.where(T['en'] <= FLAT[name](T))[0]
        if len(last) == 0: continue
        flat = int(last.max()); w = Fm.entry_window(T)
        roc = np.full(T['n'], np.nan); roc[Fm.L_ROC:] = c[Fm.L_ROC:] - c[:-Fm.L_ROC]
        if S['date'] in by_date:
            for r in by_date[S['date']]:
                if r['track'] != name: continue
                k = r['bar']
                if k >= flat: continue
                fw[(r['date'], name, r['fam'], k)] = {h: r['dir'] * (c[min(k + h, flat)] - c[k]) for h in HS}
        # baseline: every in-window bar, direction = sign of ROC10 (the same direction rule the events use), only bars with a full 30-bar path
        idx = np.where(w & (np.arange(T['n']) < flat) & ~np.isnan(roc) & (roc != 0))[0]
        if len(idx): base[name][S['date']] = [float(np.sign(roc[k]) * (c[min(k + H_PRIMARY, flat)] - c[k])) for k in idx]

def day_stats(rows, h):
    d = collections.defaultdict(lambda: [0.0, 0])
    for r in rows:
        v = fw.get((r['date'], r['track'], r['fam'], r['bar']))
        if v is None: continue
        d[r['date']][0] += v[h]; d[r['date']][1] += 1
    return d

def boot_diff(a, b, seed):
    """a, b: {date: [sum, n]}. Day-blocked bootstrap of mean(a) - mean(b) over the union of dates; returns point, lo, hi, p_one_sided(diff<=0)."""
    dates = sorted(set(a) | set(b)); A = np.array([a.get(x, [0.0, 0]) for x in dates]); Bm = np.array([b.get(x, [0.0, 0]) for x in dates])
    if A[:, 1].sum() == 0 or Bm[:, 1].sum() == 0: return None
    pt = A[:, 0].sum() / A[:, 1].sum() - Bm[:, 0].sum() / Bm[:, 1].sum()
    rng = np.random.default_rng(seed); n = len(dates); ds = []
    for _ in range(B):
        i = rng.integers(0, n, n); sa, na, sb, nb = A[i, 0].sum(), A[i, 1].sum(), Bm[i, 0].sum(), Bm[i, 1].sum()
        if na and nb: ds.append(sa / na - sb / nb)
    ds = np.array(ds); return pt, float(np.quantile(ds, 0.025)), float(np.quantile(ds, 0.975)), float((1 + (ds <= 0).sum()) / (len(ds) + 1))

def mean_ci(d, seed):
    dates = sorted(d); A = np.array([d[x] for x in dates])
    if len(A) == 0 or A[:, 1].sum() == 0: return None
    rng = np.random.default_rng(seed); n = len(dates); ms = []
    for _ in range(B):
        i = rng.integers(0, n, n); s, m = A[i, 0].sum(), A[i, 1].sum()
        if m: ms.append(s / m)
    return A[:, 0].sum() / A[:, 1].sum(), float(np.quantile(ms, 0.025)), float(np.quantile(ms, 0.975)), int(A[:, 1].sum()), len(dates)

def thirds(rows, h):
    ds = sorted({r['date'] for r in rows}); out = []
    for part in np.array_split(ds, 3):
        sub = [r for r in rows if r['date'] in set(part)]; v = [fw[(r['date'], r['track'], r['fam'], r['bar'])][h] for r in sub if (r['date'], r['track'], r['fam'], r['bar']) in fw]
        out.append(round(float(np.mean(v)), 1) if v else None)
    return out

results = []; pvals = []
print('DEPTH TERM = D1 trade-count PROXY (not the real Sierra depth). Points, forward signed change of the close, h=30 primary. Cost context ~2.0 pt per MNQ round trip (not subtracted).')
for tr in ('RTH', 'GBX'):
    fam = {f: [r for r in ev if r['track'] == tr and r['fam'] == f] for f in Fm.FAMILIES}
    bs = day_stats([], 0)
    bl = {d: [sum(v), len(v)] for d, v in base[tr].items()}
    bm = sum(x[0] for x in bl.values()) / max(sum(x[1] for x in bl.values()), 1)
    print(f'\n===== {tr} =====  unconditional ROC-sign continuation baseline (all in-window bars): {bm:+.2f} pt at 30 bars (n bars {sum(x[1] for x in bl.values())})')
    for f in Fm.FAMILIES:
        for h in HS:
            m = mean_ci(day_stats(fam[f], h), 11 + h)
            if m and h == H_PRIMARY: print(f'  {f}: N {m[3]:5d} days {m[4]:4d}  mean fwd {h} bars {m[0]:+6.2f} pt  [{m[1]:+.2f}, {m[2]:+.2f}]   10 bars {mean_ci(day_stats(fam[f], 10), 3)[0]:+.2f}  60 bars {mean_ci(day_stats(fam[f], 60), 4)[0]:+.2f}   thirds(30) {thirds(fam[f], 30)}')
    e2 = fam['E2']; fast = [r for r in e2 if r['pace'] <= 1 / 3]; slow = [r for r in e2 if r['pace'] >= 2 / 3]
    tests = [('T1 E2 - E0', day_stats(fam['E2'], 30), day_stats(fam['E0'], 30)), ('T2 E4 - E0', day_stats(fam['E4'], 30), day_stats(fam['E0'], 30)), ('T3 E3 - E2', day_stats(fam['E3'], 30), day_stats(fam['E2'], 30)),
             ('T4 pace fast - slow (inside E2)', day_stats(fast, 30), day_stats(slow, 30)), ('T5 E1 - E0', day_stats(fam['E1'], 30), day_stats(fam['E0'], 30))]
    for i, (name, a, b) in enumerate(tests):
        r = boot_diff(a, b, 100 + i + (50 if tr == 'GBX' else 0))
        if r is None: print(f'  {name}: not enough events'); results.append((tr, name, None)); continue
        na = int(sum(x[1] for x in a.values())); nb = int(sum(x[1] for x in b.values()))
        print(f'  {name}: diff {r[0]:+.2f} pt [{r[1]:+.2f}, {r[2]:+.2f}]  one-sided p {r[3]:.4f}   (N {na} vs {nb}; fast {len(fast)} slow {len(slow)})' if 'pace' in name else f'  {name}: diff {r[0]:+.2f} pt [{r[1]:+.2f}, {r[2]:+.2f}]  one-sided p {r[3]:.4f}   (N {na} vs {nb})')
        results.append((tr, name, r)); pvals.append((r[3], len(results) - 1))
# Holm 0.10 across the counted tests
order = sorted(pvals); m = len(order); keep = set(); alpha = 0.10
for rank, (p, idx) in enumerate(order):
    if p <= alpha / (m - rank): keep.add(idx)
    else: break
print(f'\nHolm 0.10 over {m} tests: survivors: ' + (', '.join(f'{results[i][0]} {results[i][1]}' for i in sorted(keep)) or 'none'))
json.dump([dict(track=t, test=n, res=None if r is None else dict(diff=r[0], lo=r[1], hi=r[2], p=r[3]), holm=i in keep) for i, (t, n, r) in enumerate(results)], open(os.path.join(OUT, 'outcomes_summary.json'), 'w'), indent=1)
