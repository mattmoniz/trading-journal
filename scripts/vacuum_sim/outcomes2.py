"""Q4-5 v2 outcome tests (prereg amendment A1, ledger look 190). Events from v2.py (crossing onsets); forward change scored from Open[t+1]; exits as a stateless first-passage scan with sd frozen at entry; Wave 2 two-step scan.
Depth term = D1 trade-count PROXY (labelled). Points; cost 2.0 pt per round trip subtracted ONLY in the net-P&L (exits) tests. Day-blocked bootstrap 3000, Holm 0.10 over 12 tests; thirds informational."""
import sys, os, glob, json, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import features as Fm, v2
COST = 2.0; B = 3000; MAXB = 60
files = sorted(p for p in glob.glob(os.path.join(Fm.BARS, '*.bars.tsv')) if os.path.basename(p)[:10] <= Fm.LAST_EXPLORE)

def flat_for(P, n0, end, close):
    en = P['en']
    lim = 55790.0 if end <= 55500.0 else (close - 300.0 if end < close - 300.0 else 1e12)
    ok = np.where(en <= lim)[0]; return int(ok.max()) if len(ok) else len(en) - 1

def exit_scan(P, F, a, dr, flat):
    """Entry at Open[a+1]; first bar t in (a, min(a+60, flat)] whose CLOSE satisfies the user's exit wins (sd frozen at a). Returns (exit_bar, reason, entry, exit_price)."""
    c, roc, ratio = P['c'], F['roc'], F['ratio']; sdr, sdq = F['qs'][a], F['rs'][a]
    if a + 1 > flat or np.isnan(sdr) or np.isnan(sdq): return None
    entry = P['o'][a + 1]; pk_roc = dr * roc[a]; pk_ratio = ratio[a]; last = min(a + MAXB, flat)
    for t in range(a + 1, last + 1):
        pk_roc = max(pk_roc, dr * roc[t]); pk_ratio = max(pk_ratio, ratio[t])
        if dr * roc[t] <= 0: return t, 'zero', entry, c[t]
        if (pk_roc - dr * roc[t]) >= 0.20 * sdr and (pk_ratio - ratio[t]) >= 0.25 * sdq: return t, 'hook', entry, c[t]
    return last, 'cap', entry, c[last]

def wave2(P, F, a, dr, flat, ex):
    """After the Wave-1 hook at ex[0]: pullback then re-ignition within 20 bars; returns (t2, cont) or None."""
    t1 = ex[0]
    if ex[1] != 'hook': return None
    zr, zq, roc, ratio = F['zr'], F['zroc'], F['roc'], F['ratio']; w1 = ratio[a:t1 + 1].max(); pb = False
    for t in range(t1 + 1, min(t1 + 20, flat) + 1):
        if dr * roc[t] <= 0: return None
        if not pb:
            if zr[t] <= 0.25 and dr * zq[t] <= 1.0: pb = True
            continue
        if zr[t] > 1.5 and dr * zq[t] > 1.0 and dr * (zq[t] - zq[t - 1]) > 0: return t, bool(ratio[t] >= 0.75 * w1)
    return None

rec = collections.defaultdict(list)       # (track, group) -> list of dicts(date, v) ; groups below
def add(track, grp, date, v): rec[(track, grp)].append((date, float(v)))
strata = collections.defaultdict(list)
rows_by_date = collections.defaultdict(list)
import csv
for r in csv.DictReader(open(os.path.join(v2.OUT, 'events2.csv'))): rows_by_date[r['date']].append(r)
hist = {'RTH': [], 'GBX': []}; prevS = None
for p in files:
    S = Fm.load_full(p)
    if S is None: continue
    tsp = Fm.track_split(S); close = Fm.EARLY_CLOSE if S['date'] in Fm.EARLY else Fm.CLOSE; prs = {}
    for name in ('RTH', 'GBX'):
        prev = hist[name][-Fm.K_PRIOR:]
        if len(prev) >= Fm.K_PRIOR: prs[name] = Fm.priors_of(prev)
    if len(prs) == 2 and S['date'] in rows_by_date:
        P, n0, reset = v2.continuous(prevS, S); F = v2.feats(P, n0, reset, prs, close); d = S['date']
        evs = sorted(rows_by_date[d], key=lambda r: (r['fam'], int(r['k'])))
        locks = {}
        for r in evs:
            fam = r['fam']; k = int(r['k']); a = n0 + k; dr = int(r['dir']); end = float(r['end']); flat = flat_for(P, n0, end, close)
            if a + 1 > flat: continue
            c = P['c']; o1 = P['o'][a + 1]; tr = r['track']
            f30 = dr * (c[min(a + 30, flat)] - o1); f30c = dr * (c[min(a + 30, flat)] - c[a])
            if tr:
                add(tr, fam + '|f30', d, f30); add(tr, fam + '|f30c', d, f30c); add(tr, fam + '|f10', d, dr * (c[min(a + 10, flat)] - o1)); add(tr, fam + '|f60', d, dr * (c[min(a + 60, flat)] - o1))
                if fam == 'E0': add(tr, 'E0wall|f30' if float(r['zr']) < -1.0 else ('E0pos|f30' if float(r['zr']) >= 0 else 'E0mid|f30'), d, f30)
                if fam == 'E2' and r['pace'] != '':
                    pc = float(r['pace']); add(tr, 'E2fast|f30' if pc <= 1 / 3 else ('E2slow|f30' if pc >= 2 / 3 else 'E2mid|f30'), d, f30)
            for s in r['strata'].split('|'):
                if s and fam in ('E2', 'E4u'): strata[(s, fam)].append((d, f30))
            if fam in ('E0', 'E2', 'E4u') and tr:
                if locks.get((fam, tr), -1) >= a: continue
                ex = exit_scan(P, F, a, dr, flat)
                if ex is None: continue
                locks[(fam, tr)] = ex[0]; pnl = dr * (ex[3] - ex[2]) - COST
                add(tr, fam + '|net', d, pnl); add(tr, fam + '|hold', d, ex[0] - a)
                if fam == 'E2':
                    w = wave2(P, F, a, dr, flat, ex)
                    if w is not None and locks.get(('W2', tr), -1) < w[0]:
                        ex2 = exit_scan(P, F, w[0], dr, flat)
                        if ex2 is not None:
                            locks[('W2', tr)] = ex2[0]; add(tr, ('W2C' if w[1] else 'W2A') + '|net', d, dr * (ex2[3] - ex2[2]) - COST)
    for name, T in tsp.items(): hist[name].append(T)
    prevS = S

def daystats(lst):
    d = collections.defaultdict(lambda: [0.0, 0])
    for dt, v in lst: d[dt][0] += v; d[dt][1] += 1
    return d
def mean_ci(lst, seed):
    d = daystats(lst); ds = sorted(d)
    if not ds: return None
    A = np.array([d[x] for x in ds]); rng = np.random.default_rng(seed); n = len(ds); ms = []
    for _ in range(B):
        i = rng.integers(0, n, n); s, m = A[i, 0].sum(), A[i, 1].sum()
        if m: ms.append(s / m)
    return A[:, 0].sum() / A[:, 1].sum(), float(np.quantile(ms, 0.025)), float(np.quantile(ms, 0.975)), int(A[:, 1].sum()), n
def diff(a, b, seed):
    da, db = daystats(a), daystats(b); ds = sorted(set(da) | set(db))
    if not da or not db: return None
    A = np.array([da.get(x, [0.0, 0]) for x in ds]); Bm = np.array([db.get(x, [0.0, 0]) for x in ds]); n = len(ds)
    pt = A[:, 0].sum() / A[:, 1].sum() - Bm[:, 0].sum() / Bm[:, 1].sum(); rng = np.random.default_rng(seed); out = []
    for _ in range(B):
        i = rng.integers(0, n, n); sa, na, sb, nb = A[i, 0].sum(), A[i, 1].sum(), Bm[i, 0].sum(), Bm[i, 1].sum()
        if na and nb: out.append(sa / na - sb / nb)
    out = np.array(out); return pt, float(np.quantile(out, 0.025)), float(np.quantile(out, 0.975)), float((1 + (out <= 0).sum()) / (len(out) + 1)), len(a), len(b)
def dist(lst):
    v = np.array([x[1] for x in lst]); w = v[v > 0].sum(); l = -v[v < 0].sum()
    return f'N {len(v)} mean {v.mean():+.2f} median {np.median(v):+.2f} win {np.mean(v > 0):.2f} PF {w / l if l else float("inf"):.2f} p90 {np.quantile(v, .9):+.1f} p95 {np.quantile(v, .95):+.1f} >+10pt {np.mean(v > 10):.2f}'

res = []; pv = []
print('DEPTH = D1 trade-count PROXY. Forward change scored from Open[t+1] (points). Exits tests: net of 2.0 pt cost, one flat position at a time per family. Thirds informational.')
for tr in ('RTH', 'GBX'):
    print(f'\n===== {tr} =====')
    for fam in ('E0', 'E1', 'E2', 'E3', 'E3u', 'E4', 'E4u'):
        m = mean_ci(rec[(tr, fam + '|f30')], 7)
        if m: print(f'  {fam:3s} fwd30 from Open[t+1]: N {m[3]:6d} days {m[4]:4d} mean {m[0]:+6.2f} [{m[1]:+.2f}, {m[2]:+.2f}]   from Close[t] {mean_ci(rec[(tr, fam + "|f30c")], 8)[0]:+.2f}  10 bars {mean_ci(rec[(tr, fam + "|f10")], 9)[0]:+.2f}  60 bars {mean_ci(rec[(tr, fam + "|f60")], 10)[0]:+.2f}')
    for g in ('E0wall', 'E0mid', 'E0pos', 'E2fast', 'E2mid', 'E2slow'):
        m = mean_ci(rec[(tr, g + '|f30')], 5)
        if m: print(f'  {g:6s} fwd30: N {m[3]:6d} mean {m[0]:+6.2f} [{m[1]:+.2f}, {m[2]:+.2f}]')
    for g in ('E0', 'E2', 'E4u', 'W2C', 'W2A'):
        if rec[(tr, g + '|net')]: print(f'  EXITS {g:3s} net of cost: {dist(rec[(tr, g + "|net")])}  median hold {np.median([x[1] for x in rec[(tr, g + "|hold")]]) if rec[(tr, g + "|hold")] else float("nan"):.0f} bars')
    T = [('A E2 - E0 (fwd30)', rec[(tr, 'E2|f30')], rec[(tr, 'E0|f30')]), ('B E4u - E0 (fwd30)', rec[(tr, 'E4u|f30')], rec[(tr, 'E0|f30')]), ('C pace fast - slow in E2', rec[(tr, 'E2fast|f30')], rec[(tr, 'E2slow|f30')]),
         ('D wall: E0 Zr<-1 minus E0 Zr>=0', rec[(tr, 'E0wall|f30')], rec[(tr, 'E0pos|f30')]), ('E exits net: E4u - E0', rec[(tr, 'E4u|net')], rec[(tr, 'E0|net')]), ('F Wave2 continuation net - E0 net', rec[(tr, 'W2C|net')], rec[(tr, 'E0|net')])]
    for i, (name, a, b) in enumerate(T):
        r = diff(a, b, 100 + i + (60 if tr == 'GBX' else 0))
        if r is None: print(f'  {name}: not enough events'); res.append((tr, name, None)); continue
        print(f'  {name}: diff {r[0]:+.2f} pt [{r[1]:+.2f}, {r[2]:+.2f}] one-sided p {r[3]:.4f}  (N {r[4]} vs {r[5]})'); res.append((tr, name, r)); pv.append((r[3], len(res) - 1))
order = sorted(pv); m = len(order); keep = set()
for rank, (p, idx) in enumerate(order):
    if p <= 0.10 / (m - rank): keep.add(idx)
    else: break
print(f'\nHolm 0.10 over {len(res)} tests ({m} testable): survivors: ' + (', '.join(f'{res[i][0]} {res[i][1]}' for i in sorted(keep)) or 'none'))
print('\nSTRATA (descriptive, not counted; fwd30 from Open[t+1], N events):')
for (s, fam), v in sorted(strata.items()):
    mm = mean_ci(v, 3); print(f'  {s:8s} {fam:3s}: N {mm[3]:5d} days {mm[4]:4d} mean {mm[0]:+6.2f} [{mm[1]:+.2f}, {mm[2]:+.2f}]')
json.dump([dict(track=t, test=n, res=None if r is None else dict(diff=r[0], lo=r[1], hi=r[2], p=r[3]), holm=i in keep) for i, (t, n, r) in enumerate(res)], open(os.path.join(v2.OUT, 'outcomes2_summary.json'), 'w'), indent=1)
