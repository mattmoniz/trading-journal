"""Tell scan part 2 (prereg INSTITUTIONAL_TELL_SCAN_PREREG part 2, ledger look 192): pace BUILD-UP. Burst onset (3 fast bars in a row after a quiet stretch, that moved price) vs a move-only control; burst with one-sided aggression;
and ROC expansions with vs without a burst already on. Continuation = signed change over 30 bars from Open[t+1], points. Day-blocked bootstrap, Holm 0.10 over 6 tests; halves/thirds/buckets informational."""
import sys, os, glob, csv, collections, json
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import features as Fm, v2
B = 3000
files = sorted(p for p in glob.glob(os.path.join(Fm.BARS, '*.bars.tsv')) if os.path.basename(p)[:10] <= Fm.LAST_EXPLORE)
e0_by_date = collections.defaultdict(list)
for r in csv.DictReader(open(os.path.join(v2.OUT, 'events2.csv'))):
    if r['fam'] == 'E0' and r['track']: e0_by_date[r['date']].append(r)

def hour_struct(prev, q):
    K = len(prev); vals = []; wts = []; hrs = []
    for P in prev:
        x = q(P); vals.append(x); wts.append(np.full(len(x), 1.0 / (K * len(x)))); hrs.append(Fm.hour_et(P['en']))
    x = np.concatenate(vals); w = np.concatenate(wts); h = np.concatenate(hrs); out = {}
    for hh in np.unique(h):
        m = h == hh; i = np.argsort(x[m], kind='stable'); out[int(hh)] = (x[m][i], np.cumsum(w[m][i]) / w[m].sum())
    return out
def cdf_vec(struct, hrs, v):
    o = np.full(len(v), np.nan)
    for i, (h, x) in enumerate(zip(hrs, v)):
        e = struct.get(int(h))
        if e is None: continue
        j = np.searchsorted(e[0], x, side='right') - 1; o[i] = e[1][j] if j >= 0 else 0.0
    return o

recs = collections.defaultdict(list)       # (track, group) -> [(date, f30)]
hist = {'RTH': [], 'GBX': []}; prevS = None
one = lambda P: np.abs(P['ask'] - P['bid']) / 500.0
for p in files:
    S = Fm.load_full(p)
    if S is None: continue
    tsp = Fm.track_split(S); close = Fm.EARLY_CLOSE if S['date'] in Fm.EARLY else Fm.CLOSE; prs = {}; hs = {}
    for name in ('RTH', 'GBX'):
        prev = hist[name][-Fm.K_PRIOR:]
        if len(prev) >= Fm.K_PRIOR: prs[name] = Fm.priors_of(prev); hs[name] = hour_struct(prev, one)
    if len(prs) == 2:
        P, n0, reset = v2.continuous(prevS, S); F = v2.feats(P, n0, reset, prs, close); n = len(P['c']); c = P['c']; en = P['en']; idx = np.arange(n)
        fast = np.nan_to_num(F['pace'], nan=1.0) <= 1 / 3; fast &= ~np.isnan(F['pace'])
        f3 = fast & np.r_[False, fast[:-1]] & np.r_[False, False, fast[:-2]]
        nf5 = np.zeros(n); 
        for j in range(3, 8): nf5 += np.r_[np.zeros(j, bool), fast[:-j]]
        burst = f3 & ~np.r_[False, f3[:-1]] & (nf5 <= 2)
        move = np.full(n, np.nan); move[3:] = c[3:] - c[:-3]; ema_tr = Fm.ema(F['tr'])
        moved = ~np.isnan(move) & (np.abs(move) >= ema_tr) & (move != 0)
        mo_onset = moved & ~np.r_[False, moved[:-1]]
        tk = np.where((en >= 1800.0) & (en <= 55500.0), 'GBX', np.where((en >= 56100.0) & (en <= close - 600.0), 'RTH', ''))
        osd = np.full(n, np.nan)
        for name in ('GBX', 'RTH'):
            m = tk == name
            if m.any(): osd[m] = cdf_vec(hs[name], Fm.hour_et(en[m]), one(P)[m] if False else (np.abs(P['ask'] - P['bid']) / 500.0)[m])
        cur = idx >= n0; ok = cur & (idx >= Fm.WARM) & (tk != '')
        def f30(a):
            lim = 55790.0 if en[a] <= 55500.0 else (close - 300.0 if en[a] < close - 300.0 else 1e12); okb = np.where(en <= lim)[0]; flat = int(okb.max()) if len(okb) else n - 1
            return None if a + 1 > flat else (flat, c[min(a + 30, flat)] - P['o'][a + 1])
        for a in np.where(ok & (burst | mo_onset))[0]:
            r = f30(a)
            if r is None: continue
            dr = int(np.sign(move[a])); v = dr * r[1]; t = tk[a]
            if burst[a]:
                recs[(t, 'BURST')].append((S['date'], v))
                if osd[a] >= 2 / 3: recs[(t, 'BURST_ONE')].append((S['date'], v))
            elif mo_onset[a] and not f3[a]: recs[(t, 'MOVE')].append((S['date'], v))
        f3p = np.zeros(n, bool)
        for j in range(1, 6): f3p |= np.r_[np.zeros(j, bool), f3[:-j]]
        for r in e0_by_date.get(S['date'], []):
            a = n0 + int(r['k']); rr = f30(a)
            if rr is None: continue
            v = int(r['dir']) * rr[1]; recs[(r['track'], 'E0_PRE' if f3p[a] else 'E0_NOPRE')].append((S['date'], v))
    for name, T in tsp.items(): hist[name].append(T)
    prevS = S

def dstats(l):
    d = collections.defaultdict(lambda: [0.0, 0])
    for dt, v in l: d[dt][0] += v; d[dt][1] += 1
    return d
def diff(a, b, seed):
    da, db = dstats(a), dstats(b); ds = sorted(set(da) | set(db))
    if not a or not b: return None
    A = np.array([da.get(x, [0.0, 0]) for x in ds]); Bm = np.array([db.get(x, [0.0, 0]) for x in ds]); n = len(ds)
    pt = A[:, 0].sum() / A[:, 1].sum() - Bm[:, 0].sum() / Bm[:, 1].sum(); rng = np.random.default_rng(seed); out = []
    for _ in range(B):
        i = rng.integers(0, n, n); sa, na, sb, nb = A[i, 0].sum(), A[i, 1].sum(), Bm[i, 0].sum(), Bm[i, 1].sum()
        if na and nb: out.append(sa / na - sb / nb)
    out = np.array(out); return pt, float(np.quantile(out, .025)), float(np.quantile(out, .975)), float((1 + (out <= 0).sum()) / (len(out) + 1))
def mean_ci(l, seed):
    d = dstats(l); ds = sorted(d)
    if not ds: return None
    A = np.array([d[x] for x in ds]); rng = np.random.default_rng(seed); n = len(ds); ms = []
    for _ in range(B):
        i = rng.integers(0, n, n); s, m = A[i, 0].sum(), A[i, 1].sum()
        if m: ms.append(s / m)
    return A[:, 0].sum() / A[:, 1].sum(), float(np.quantile(ms, .025)), float(np.quantile(ms, .975)), int(A[:, 1].sum()), n
def half(l):
    ds = sorted({d for d, _ in l}); h = set(ds[:len(ds) // 2]); a = [v for d, v in l if d in h]; b = [v for d, v in l if d not in h]
    return (float(np.mean(a)) if a else float('nan'), float(np.mean(b)) if b else float('nan'))

res = []; pv = []
print('Pace BUILD-UP scan. Continuation = signed 30-bar change from Open[t+1] (points). Exploration; leads not findings.')
for tr in ('RTH', 'GBX'):
    print(f'\n===== {tr} =====')
    for g in ('MOVE', 'BURST', 'BURST_ONE', 'E0_NOPRE', 'E0_PRE'):
        m = mean_ci(recs[(tr, g)], 3)
        if m: h1, h2 = half(recs[(tr, g)]); print(f'  {g:9s}: N {m[3]:6d} days {m[4]:4d} mean {m[0]:+6.2f} [{m[1]:+.2f}, {m[2]:+.2f}]   halves {h1:+.2f} / {h2:+.2f}')
    T = [('T1 BURST - MOVE_ONLY', 'BURST', 'MOVE'), ('T2 BURST+ONE-SIDED - MOVE_ONLY', 'BURST_ONE', 'MOVE'), ('T3 E0 with preceding burst - E0 without', 'E0_PRE', 'E0_NOPRE')]
    for i, (name, ga, gb) in enumerate(T):
        r = diff(recs[(tr, ga)], recs[(tr, gb)], 700 + i + (30 if tr == 'GBX' else 0))
        if r is None: print(f'  {name}: not enough'); continue
        res.append((tr, name, r)); pv.append((r[3], len(res) - 1)); print(f'  {name}: diff {r[0]:+.2f} pt [{r[1]:+.2f}, {r[2]:+.2f}] one-sided p {r[3]:.4f}')
order = sorted(pv); m = len(order); keep = set()
for rank, (p, idx) in enumerate(order):
    if p <= 0.10 / (m - rank): keep.add(idx)
    else: break
print(f'\nHolm 0.10 over {m} tests: survivors: ' + (', '.join(f'{res[i][0]} {res[i][1]}' for i in sorted(keep)) or 'none'))
json.dump([dict(track=t, test=n, diff=r[0], lo=r[1], hi=r[2], p=r[3], holm=i in keep) for i, (t, n, r) in enumerate(res)], open(os.path.join(v2.OUT, 'burst_scan_summary.json'), 'w'), indent=1)
