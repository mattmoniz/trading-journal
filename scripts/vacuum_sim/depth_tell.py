"""Q4-5 real-depth tell (prereg amendment A3, ledger look 193). RTH only. EXPLORE = depth-era sessions 2026-06-15..2026-10-09 with a depth cache; the confirmation sessions (>= 2026-10-12) are REFUSED here.
Ratio = EMA10(TR) / EMA10(depth_all) with the Sierra Bollinger SMA50 +- SD on the Ratio; everything else as v2 (crossing onsets, continuous windows, Open[t+1] scoring). Six counted tests, Holm 0.10; halves and thirds informational."""
import sys, os, glob, json, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import features as Fm, v2
LO, HI = '2026-06-15', '2026-10-09'; B = 3000; COST = 2.0
CACHE = os.path.join(v2.OUT, 'depth_cache')
srcs = {}
for pat in ('scratch/volbars500_holdout_20261103/*.bars.tsv', 'scratch/amt_tell_live/*.split.bars.tsv', 'scratch/argon_vacuum_live/priors/*.bars.tsv'):
    for p in glob.glob(os.path.join(Fm.ROOT, pat)):
        d = os.path.basename(p)[:10]
        if '2026-04-15' <= d <= HI: srcs.setdefault(d, p)
dates = sorted(srcs); assert max(dates) <= HI, 'confirmation sessions must not be read here'
recs = collections.defaultdict(list)
def real_ratio(P, n0, F, cache):
    n = len(P['c']); depth = np.full(n, np.nan); en_c = cache['en']; idx = np.searchsorted(P['en'], en_c)
    ok = (idx < n) & (np.abs(P['en'][np.minimum(idx, n - 1)] - en_c) < 1e-6); depth[idx[ok]] = cache['depth_all'][ok]
    first = np.where(~np.isnan(depth))[0]
    if len(first) < 100: return None
    f0 = first[0]; ratio = np.full(n, np.nan); tr = F['tr']
    ratio[f0:] = Fm.ema(tr[f0:]) / np.maximum(Fm.ema(np.nan_to_num(depth[f0:], nan=np.nanmedian(depth))), 1e-6)
    rm, rs = Fm.sma_sd(ratio); zr = (ratio - rm) / np.where(rs > 1e-12, rs, np.nan)
    return ratio, zr, rs
def onset(m): return m & ~np.r_[False, m[:-1]]
def exit_scan(P, F, a, dr, flat, zr_sd):
    c, roc, ratio, zq = P['c'], F['roc'], F['ratio'], F['zroc']
    if a + 1 > flat or np.isnan(zr_sd): return None
    entry = P['o'][a + 1]; pk = ratio[a]; last = min(a + 60, flat)
    for t in range(a + 1, last + 1):
        pk = max(pk, ratio[t])
        if dr * roc[t] <= 0: return t, entry, c[t]
        if dr * zq[t] <= 1.8 and (pk - ratio[t]) >= 0.25 * zr_sd: return t, entry, c[t]
    return last, entry, c[last]
hist = {'RTH': [], 'GBX': []}; prevS = None; nsess = 0
for d in dates:
    S = Fm.load_full(srcs[d])
    if S is None: continue
    tsp = Fm.track_split(S); close = Fm.EARLY_CLOSE if d in Fm.EARLY else Fm.CLOSE; prs = {}
    for name in ('RTH', 'GBX'):
        prev = hist[name][-Fm.K_PRIOR:]
        if len(prev) >= Fm.K_PRIOR: prs[name] = Fm.priors_of(prev)
    cp = os.path.join(CACHE, f'{d}.npz')
    if LO <= d <= HI and len(prs) == 2 and os.path.exists(cp):
        P, n0, reset = v2.continuous(prevS, S); F = v2.feats(P, n0, reset, prs, close); cache = np.load(cp)
        rr = real_ratio(P, n0, F, cache)
        if rr is not None:
            F['ratio'], F['zr'], F['rs'] = rr; n = len(P['c']); en = P['en']; idx = np.arange(n); c = P['c']; nsess += 1
            ok = (idx >= n0) & (idx >= Fm.WARM) & ~np.isnan(F['zroc']) & ~np.isnan(F['zr']); w = (en >= 56100.0) & (en <= close - 600.0) & ok
            dd = np.where(F['roc'] > 0, 1, np.where(F['roc'] < 0, -1, 0)); z = F['zroc']; zr = F['zr']
            c0 = w & (np.abs(z) > Fm.Z_ROC) & (np.sign(z) == dd); thrust = c0 & (zr > Fm.Z_RATIO)
            flow = np.where(dd > 0, F['fl_l'], F['fl_s']); full = thrust & F['user_fast'] & flow
            fast = np.nan_to_num(F['pace'], nan=1.0) <= 1 / 3; fast &= ~np.isnan(F['pace']); f3 = fast & np.r_[False, fast[:-1]] & np.r_[False, False, fast[:-2]]
            nf5 = np.zeros(n)
            for j in range(3, 8): nf5 += np.r_[np.zeros(j, bool), fast[:-j]]
            bursts = f3 & ~np.r_[False, f3[:-1]] & (nf5 <= 2); move = np.full(n, np.nan); move[3:] = c[3:] - c[:-3]; moved = ~np.isnan(move) & (np.abs(move) >= Fm.ema(F['tr'])) & (move != 0)
            lim = close - 300.0; okb = np.where(en <= lim)[0]; flat = int(okb.max())
            def f30(a): return None if a + 1 > flat else (c[min(a + 30, flat)] - P['o'][a + 1])
            fams = {'E0': onset(c0), 'R1': onset(thrust), 'R5': onset(full)}
            for fam, m in fams.items():
                lock = -1
                for a in np.where(m)[0]:
                    r = f30(a); dr = int(dd[a])
                    if r is None: continue
                    recs[fam + '|f30'].append((d, dr * r)); 
                    if fam == 'E0': recs['E0z|f30'].append((d, dr * r, float(zr[a]))) 
                    if fam in ('E0', 'R5') and a > lock:
                        ex = exit_scan(P, F, a, dr, flat, F['rs'][a])
                        if ex is not None: lock = ex[0]; recs[fam + '|net'].append((d, dr * (ex[2] - ex[1]) - COST))
            for a in np.where(w & bursts)[0]:
                r = f30(a)
                if r is None: continue
                dr = int(np.sign(move[a])); v = dr * r
                recs['BTHIN|f30' if zr[a] > 1.0 else ('BTHICK|f30' if zr[a] <= 0 else 'BMID|f30')].append((d, v))
    for name, T in tsp.items(): hist[name].append(T)
    prevS = S

def dstats(l):
    o = collections.defaultdict(lambda: [0.0, 0])
    for x in l: o[x[0]][0] += x[1]; o[x[0]][1] += 1
    return o
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
def halves(l):
    ds = sorted({x[0] for x in l}); h = set(ds[:len(ds) // 2]); a = [x[1] for x in l if x[0] in h]; b = [x[1] for x in l if x[0] not in h]
    return (float(np.mean(a)) if a else float('nan'), float(np.mean(b)) if b else float('nan'))
def dist(l):
    v = np.array([x[1] for x in l]); w = v[v > 0].sum(); lo = -v[v < 0].sum()
    return f'N {len(v)} mean {v.mean():+.2f} median {np.median(v):+.2f} win {np.mean(v > 0):.2f} PF {w / lo if lo else float("inf"):.2f} p90 {np.quantile(v, .9):+.1f} p95 {np.quantile(v, .95):+.1f}'

print(f'REAL-DEPTH tell, RTH, explore sessions scored: {nsess} ({LO}..{HI}); continuation = signed 30-bar change from Open[t+1], points; exits net of {COST} pt.')
for g in ('E0', 'R1', 'R5', 'BTHIN', 'BMID', 'BTHICK'):
    m = mean_ci(recs[g + '|f30'], 3)
    if m: h1, h2 = halves(recs[g + '|f30']); print(f'  {g:7s} N {m[3]:5d} days {m[4]:3d} mean {m[0]:+6.2f} [{m[1]:+.2f}, {m[2]:+.2f}]  halves {h1:+.2f} / {h2:+.2f}')
for g in ('E0', 'R5'):
    if recs[g + '|net']: print(f'  EXITS {g}: {dist(recs[g + "|net"])}')
ez = recs['E0z|f30']; zs = np.array([x[2] for x in ez]); fq = [(x[0], x[1]) for x in ez]
lo_q, hi_q = np.quantile(zs, .2), np.quantile(zs, .8); top = [(x[0], x[1]) for x in ez if x[2] >= hi_q]; bot = [(x[0], x[1]) for x in ez if x[2] <= lo_q]
wall = [(x[0], x[1]) for x in ez if x[2] < -1.0]; nowall = [(x[0], x[1]) for x in ez if x[2] >= 0]
T = [('R1 thrust(real Ratio) - E0', recs['R1|f30'], recs['E0|f30']), ('R2 E0 top quintile - bottom quintile of Z_Ratio_real', top, bot), ('R3 burst thin book - thick book', recs['BTHIN|f30'], recs['BTHICK|f30']),
     ('R4 wall: E0 Z<-1 minus E0 Z>=0', wall, nowall), ('R5 user full rule (real Ratio) - E0', recs['R5|f30'], recs['E0|f30']), ('R6 exits net: R5 - E0', recs['R5|net'], recs['E0|net'])]
res = []; pv = []
for i, (name, a, b) in enumerate(T):
    r = diff(a, b, 900 + i)
    if r is None: print(f'  {name}: not enough'); continue
    res.append((name, r)); pv.append((r[3], len(res) - 1)); print(f'  {name}: diff {r[0]:+.2f} pt [{r[1]:+.2f}, {r[2]:+.2f}] one-sided p {r[3]:.4f}  (N {len(a)} vs {len(b)})')
order = sorted(pv); m = len(order); keep = set()
for rank, (p, idx) in enumerate(order):
    if p <= 0.10 / (m - rank): keep.add(idx)
    else: break
print(f'Holm 0.10 over {m} tests: survivors: ' + (', '.join(res[i][0] for i in sorted(keep)) or 'none'))
json.dump([dict(test=n, diff=r[0], lo=r[1], hi=r[2], p=r[3], holm=i in keep) for i, (n, r) in enumerate(res)], open(os.path.join(v2.OUT, 'depth_tell_summary.json'), 'w'), indent=1)
