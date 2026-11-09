"""Institutional-tell scan (prereg docs/INSTITUTIONAL_TELL_SCAN_PREREG_20261108.md, ledger look 191). Population = ROC-expansion onsets (E0, events2.csv). Tells computed causally at the event bar's close; outcome = signed
continuation from Open[t+1] over 30 bars (points). Top vs bottom quintile per tell and track, day-blocked bootstrap, Holm 0.10 over 12 tests; quintile means, first/second-half signs and thirds are information only."""
import sys, os, glob, csv, collections, json
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import features as Fm, v2
B = 3000
TELLS = ('pace', 'size', 'onesided', 'range', 'zratio', 'burst')
files = sorted(p for p in glob.glob(os.path.join(Fm.BARS, '*.bars.tsv')) if os.path.basename(p)[:10] <= Fm.LAST_EXPLORE)
rows_by_date = collections.defaultdict(list)
for r in csv.DictReader(open(os.path.join(v2.OUT, 'events2.csv'))):
    if r['fam'] == 'E0' and r['track']: rows_by_date[r['date']].append(r)

def hour_struct(prev, q):
    """Same structure as Fm.priors_of()['hour'] but for an arbitrary per-bar quantity q(session) (session-equal weights, per clock hour)."""
    K = len(prev); vals = []; wts = []; hrs = []
    for P in prev:
        x = q(P); vals.append(x); wts.append(np.full(len(x), 1.0 / (K * len(x)))); hrs.append(Fm.hour_et(P['en']))
    x = np.concatenate(vals); w = np.concatenate(wts); h = np.concatenate(hrs); out = {}
    for hh in np.unique(h):
        m = h == hh; i = np.argsort(x[m], kind='stable'); out[int(hh)] = (x[m][i], np.cumsum(w[m][i]) / w[m].sum())
    return out
def cdf_at(struct, hour, v):
    e = struct.get(int(hour))
    if e is None: return np.nan
    j = np.searchsorted(e[0], v, side='right') - 1
    return float(e[1][j]) if j >= 0 else 0.0

Q = dict(size=lambda P: 500.0 / np.maximum(P['ntr'], 1.0), onesided=lambda P: np.abs(P['ask'] - P['bid']) / 500.0, range=lambda P: P['h'] - P['l'])
recs = {tr: [] for tr in ('RTH', 'GBX')}        # dict(date, tells..., f30)
hist = {'RTH': [], 'GBX': []}; prevS = None
for p in files:
    S = Fm.load_full(p)
    if S is None: continue
    tsp = Fm.track_split(S); close = Fm.EARLY_CLOSE if S['date'] in Fm.EARLY else Fm.CLOSE; prs = {}; hs = {}
    for name in ('RTH', 'GBX'):
        prev = hist[name][-Fm.K_PRIOR:]
        if len(prev) >= Fm.K_PRIOR: prs[name] = Fm.priors_of(prev); hs[name] = {k: hour_struct(prev, f) for k, f in Q.items()}
    if len(prs) == 2 and S['date'] in rows_by_date:
        P, n0, reset = v2.continuous(prevS, S); F = v2.feats(P, n0, reset, prs, close); n = len(P['c']); c = P['c']; ntr = np.maximum(P['ntr'], 1.0)
        for r in rows_by_date[S['date']]:
            a = n0 + int(r['k']); dr = int(r['dir']); tr = r['track']; end = float(r['end'])
            lim = 55790.0 if end <= 55500.0 else (close - 300.0 if end < close - 300.0 else 1e12); ok = np.where(P['en'] <= lim)[0]; flat = int(ok.max()) if len(ok) else n - 1
            if a + 1 > flat: continue
            hr = int(Fm.hour_et(np.array([P['en'][a]]))[0]); pc = F['pace'][a]
            fast5 = int(np.sum(F['pace'][max(a - 4, 0):a + 1] <= 1 / 3))
            vals = dict(pace=(1.0 - pc) if not np.isnan(pc) else np.nan, size=cdf_at(hs[tr]['size'], hr, 500.0 / ntr[a]), onesided=cdf_at(hs[tr]['onesided'], hr, abs(P['ask'][a] - P['bid'][a]) / 500.0),
                        range=cdf_at(hs[tr]['range'], hr, P['h'][a] - P['l'][a]), zratio=float(F['zr'][a]), burst=float(fast5))
            if any(np.isnan(v) for v in vals.values()): continue
            recs[tr].append(dict(date=S['date'], f30=float(dr * (c[min(a + 30, flat)] - P['o'][a + 1])), **vals))
    for name, T in tsp.items(): hist[name].append(T)
    prevS = S

def day_ratio_boot(a, b, seed):
    da = collections.defaultdict(lambda: [0.0, 0]); db = collections.defaultdict(lambda: [0.0, 0])
    for d, v in a: da[d][0] += v; da[d][1] += 1
    for d, v in b: db[d][0] += v; db[d][1] += 1
    ds = sorted(set(da) | set(db)); A = np.array([da.get(x, [0.0, 0]) for x in ds]); Bm = np.array([db.get(x, [0.0, 0]) for x in ds]); n = len(ds)
    pt = A[:, 0].sum() / A[:, 1].sum() - Bm[:, 0].sum() / Bm[:, 1].sum(); rng = np.random.default_rng(seed); out = []
    for _ in range(B):
        i = rng.integers(0, n, n); sa, na, sb, nb = A[i, 0].sum(), A[i, 1].sum(), Bm[i, 0].sum(), Bm[i, 1].sum()
        if na and nb: out.append(sa / na - sb / nb)
    out = np.array(out); return pt, float(np.quantile(out, .025)), float(np.quantile(out, .975)), float((1 + (out <= 0).sum()) / (len(out) + 1))

res = []; pv = []
print('Tell scan: continuation (points, 30 bars from Open[t+1]) after ROC expansions; top quintile minus bottom quintile of each tell. Proxy depth only in zratio. Leads, not findings.')
for tr in ('RTH', 'GBX'):
    R = recs[tr]; dates = sorted({r['date'] for r in R}); half = set(dates[:len(dates) // 2])
    print(f'\n===== {tr}: {len(R)} expansion events on {len(dates)} days; overall mean continuation {np.mean([r["f30"] for r in R]):+.2f} pt =====')
    for ti, t in enumerate(TELLS):
        x = np.array([r[t] for r in R]); f = np.array([r['f30'] for r in R]); d = [r['date'] for r in R]
        lo, hi = np.quantile(x, 0.2), np.quantile(x, 0.8)
        top = [(d[i], f[i]) for i in range(len(R)) if x[i] >= hi]; bot = [(d[i], f[i]) for i in range(len(R)) if x[i] <= lo]
        r_ = day_ratio_boot(top, bot, 500 + ti + (40 if tr == 'GBX' else 0)); res.append((tr, t, r_)); pv.append((r_[3], len(res) - 1))
        qs = np.quantile(x, [0, .2, .4, .6, .8, 1.0]); qm = [float(np.mean(f[(x >= qs[i]) & ((x < qs[i + 1]) if i < 4 else (x <= qs[5]))])) for i in range(5)]
        def half_diff(sel):
            xs = x[sel]; fs = f[sel]
            if len(xs) < 50: return float('nan')
            l2, h2 = np.quantile(xs, .2), np.quantile(xs, .8); return float(fs[xs >= h2].mean() - fs[xs <= l2].mean())
        m1 = np.array([dd in half for dd in d]); print(f'  {t:8s} top-bottom {r_[0]:+6.2f} pt [{r_[1]:+.2f}, {r_[2]:+.2f}] p {r_[3]:.4f} | quintile means {" ".join(f"{v:+.2f}" for v in qm)} | 1st half {half_diff(m1):+.2f}  2nd half {half_diff(~m1):+.2f}')
order = sorted(pv); m = len(order); keep = set()
for rank, (p, idx) in enumerate(order):
    if p <= 0.10 / (m - rank): keep.add(idx)
    else: break
print(f'\nHolm 0.10 over {m} tests (one-sided: top beats bottom): survivors: ' + (', '.join(f'{res[i][0]} {res[i][1]}' for i in sorted(keep)) or 'none'))
# the other direction (top MINUS bottom strongly negative = absorption / reversal tell), information only
neg = [(res[i][0], res[i][1], res[i][2][0], res[i][2][2]) for i in range(len(res)) if res[i][2][2] < 0]
print('Tells whose top-minus-bottom CI is entirely NEGATIVE (reversal/absorption lead, information only): ' + (', '.join(f'{a} {b} {c:+.2f} [..,{d:+.2f}]' for a, b, c, d in neg) or 'none'))
json.dump([dict(track=t, tell=n, diff=r[0], lo=r[1], hi=r[2], p=r[3], holm=i in keep) for i, (t, n, r) in enumerate(res)], open(os.path.join(v2.OUT, 'tell_scan_summary.json'), 'w'), indent=1)
