"""A9 size scan (look 199): continuation after ROC10 expansion ONSETS at |Z_ROC10| > k, k = 0.5..3.0, RTH and Globex. Primary = 2023-03..2025-05-16 explore files; replication = depth-era 2026-06-15..2026-10-09. Held-back sessions never read."""
import sys, os, glob, collections, json
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import features as Fm, v2, depth_tell2 as D
KS = (0.5, 1.0, 1.5, 2.0, 2.5, 3.0)
def run(files):
    rec = collections.defaultdict(list); hist = {'RTH': [], 'GBX': []}; prevS = None; ns = 0
    for p in files:
        S = Fm.load_full(p)
        if S is None: continue
        tsp = Fm.track_split(S); d = S['date']; close = Fm.EARLY_CLOSE if d in Fm.EARLY else Fm.CLOSE; prs = {}
        for name in ('RTH', 'GBX'):
            prev = hist[name][-Fm.K_PRIOR:]
            if len(prev) >= Fm.K_PRIOR: prs[name] = Fm.priors_of(prev)
        if len(prs) == 2 and prevS is not None:
            P, n0, reset = v2.continuous(prevS, S); F = v2.feats(P, n0, reset, prs, close); n = len(P['c']); en, c, o = P['en'], P['c'], P['o']; idx = np.arange(n); z = F['zroc']; ns += 1
            ok = (idx >= n0) & ~np.isnan(z); prev_ok = np.r_[False, ~np.isnan(z[:-1])]; dd = np.where(F['roc'] > 0, 1, np.where(F['roc'] < 0, -1, 0))
            wins = (('RTH', ok & (en >= 56100.0) & (en <= close - 600.0), int(np.where(en <= close - 300.0)[0].max())), ('GBX', ok & (en <= 55500.0), int(np.where(en <= 55790.0)[0].max())))
            for k in KS:
                on = D.onset(~np.isnan(z) & (np.abs(z) > k) & (np.sign(z) == dd)) & prev_ok
                for tr, w, flat in wins:
                    for a in np.where(on & w)[0]:
                        if a + 1 > flat: continue
                        rec[(tr, k)].append((d, int(dd[a]) * (c[min(a + 30, flat)] - o[a + 1])))
        for name, T in tsp.items(): hist[name].append(T)
        prevS = S
    return rec, ns
primary = sorted(p for p in glob.glob(os.path.join(Fm.BARS, '*.bars.tsv')) if os.path.basename(p)[:10] <= Fm.LAST_EXPLORE)
rep = {}
for pat in ('scratch/volbars500_holdout_20261103/*.bars.tsv', 'scratch/amt_tell_live/*.split.bars.tsv', 'scratch/argon_vacuum_live/priors/*.bars.tsv'):
    for p in glob.glob(os.path.join(Fm.ROOT, pat)):
        d = os.path.basename(p)[:10]
        if '2026-04-15' <= d <= '2026-10-09': rep.setdefault(d, p)
repf = [rep[d] for d in sorted(rep)]
R1, n1 = run(primary); R2, n2 = run(repf)
res = []; pv = []
def curve(R, label, only=None):
    for tr in ('RTH', 'GBX'):
        out = []
        for k in KS:
            L = R[(tr, k)]
            if only is not None: L = [x for x in L if x[0] >= '2026-06-15']
            m = D.mean_ci(L, int(10 * k) + 1) if L else None
            if m: out.append(f'{k:.1f}sd: {m[0]:+.2f} (N {m[3]})')
        print(f'  {label} {tr}: ' + ' | '.join(out))
print(f'A9 size scan. PRIMARY: {n1} sessions 2023-03..2025-05-16; REPLICATION: {n2} depth-era sessions 2026-06-15..2026-10-09 (the rep set also warms from 2026-04-15). Continuation = signed 30-bar change from Open[t+1] (pt).')
curve(R1, 'PRIMARY'); curve(R2, 'REPLICATION', only=True)
for tr in ('RTH', 'GBX'):
    for name, a, b in (('C1 k=1.0 > 0', R1[(tr, 1.0)], None), ('C2 k=1.0 minus k=2.0', R1[(tr, 1.0)], R1[(tr, 2.0)])):
        if b is None:
            m = D.mean_ci(a, 5); ds = D.dstats(a); dl = sorted(ds); A = np.array([ds[x] for x in dl]); rng = np.random.default_rng(3); bs = []
            for _ in range(3000):
                i = rng.integers(0, len(dl), len(dl)); s_, k_ = A[i, 0].sum(), A[i, 1].sum()
                if k_: bs.append(s_ / k_)
            p = float((1 + (np.array(bs) <= 0).sum()) / (len(bs) + 1)); r = (m[0], m[1], m[2], p)      # pre-registered direction only: continuation > 0 (an earlier draft flipped the tail when the mean was negative, which labelled a REVERSAL as a survivor)
        else: r = D.diff(a, b, 77 if tr == 'RTH' else 78)
        res.append((f'{tr} {name}', r)); pv.append((r[3], len(res) - 1)); print(f'  {tr} {name}: {r[0]:+.2f} pt [{r[1]:+.2f}, {r[2]:+.2f}] one-sided p {r[3]:.4f}')
order = sorted(pv); m = len(order); keep = set()
for rank, (p, i_) in enumerate(order):
    if p <= 0.10 / (m - rank): keep.add(i_)
    else: break
print(f'Holm 0.10 over {m} counted tests: survivors: ' + (', '.join(res[i][0] for i in sorted(keep)) or 'none'))
for tr in ('RTH', 'GBX'):
    a = R1[(tr, 1.0)]; ds = sorted({x[0] for x in a}); h = set(ds[:len(ds) // 2]); print(f'  halves of the primary k=1.0 {tr}: {np.mean([x[1] for x in a if x[0] in h]):+.2f} / {np.mean([x[1] for x in a if x[0] not in h]):+.2f}')
json.dump([dict(test=n, diff=r[0], lo=r[1], hi=r[2], p=r[3], holm=i in keep) for i, (n, r) in enumerate(res)], open(os.path.join(v2.OUT, 'size_scan_summary.json'), 'w'), indent=1)
