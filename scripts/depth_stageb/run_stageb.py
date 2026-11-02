"""Stage B analysis (docs/BOOKMAP_STAGE_B_DEPTH_PREREG_20261102.md): detectors B1-B5 on the extracted per-second heatmaps (RTH), excess over their pre-registered controls. READS OUTCOMES -> look logged first (log_look_stageb.mjs).
Usage: /home/mmoniz/trading-journal/venv/bin/python /home/mmoniz/trading-journal/scripts/depth_stageb/run_stageb.py"""
import sys, glob, os
import numpy as np
SEED, BOOT, DRAWS, R = 20261102, 3000, 1000, 20; HZ = (60, 300, 900); NS = 23400; END_OK = 23100; COST = 1.25; DIR = '/home/mmoniz/trading-journal/scratch/depth_stageb_20261102'
DETS = ('B1_WALL', 'B2_ABSORB', 'B3_ICEBERG', 'B4_PULL', 'B5_SWEEP')

def load(date):
    z = np.load(f'{DIR}/{date}.npz'); bb, ba = z['bb'].astype(int), z['ba'].astype(int)
    if (bb < 0).mean() > 0.02 or (ba < 0).mean() > 0.02: return None
    ok = (bb >= 0) & (ba >= 0); bbf = np.where(ok, bb, np.maximum.accumulate(np.where(ok, bb, 0))); baf = np.where(ok, ba, np.maximum.accumulate(np.where(ok, ba, 0)))
    pmin = int(bbf[bbf > 0].min()) - 30; W = int(baf.max()) + 30 - pmin + 1; SZ = np.full((NS, W), -1, np.int32); TRD = np.zeros((NS, W), np.int32); PULL = np.zeros((NS, W), np.int32); rows = np.arange(NS)[:, None]
    idx = bbf[:, None] + np.arange(-R, R + 1)[None, :] - pmin; good = ok[:, None] & (idx >= 0) & (idx < W)
    for M, key in ((SZ, 'sz'), (TRD, 'trd'), (PULL, 'pull')): v = z[key]; r, c = np.where(good); M[r, idx[r, c]] = v[r, c]
    return dict(bb=bbf - pmin, ba=baf - pmin, ok=ok, SZ=SZ, TRD=TRD, PULL=PULL, buy=z['buy'].astype(float), sell=z['sell'].astype(float), mid=(bbf + baf) / 8.0, pmin=pmin)

def win(M, t, cols, k):
    """sum over the last k seconds (t-k+1..t) of M at absolute columns cols[t] (cols: (n,) or (n,m)); returns (n,) (sum over m too)."""
    cols = cols if cols.ndim == 2 else cols[:, None]; tot = np.zeros(len(t))
    for j in range(k):
        tt = np.clip(t - j, 0, NS - 1)
        for m in range(cols.shape[1]): tot += M[tt, cols[:, m]]
    return tot

def stats_day(D):
    """per-second statistics used for thresholds (and detectors) of one session."""
    t = np.arange(NS); bb, ba, SZ, TRD, PULL = D['bb'], D['ba'], D['SZ'], D['TRD'], D['PULL']; S = {}
    ex_b = win(TRD, t, np.stack([bb, bb - 1], 1), 30); ex_a = win(TRD, t, np.stack([ba, ba + 1], 1), 30); S['exec_bid'], S['exec_ask'] = ex_b, ex_a
    mx = lambda col: np.max(np.stack([SZ[np.clip(t - j, 0, NS - 1), col] for j in range(30)], 1), 1); S['maxdisp_bid'], S['maxdisp_ask'] = mx(bb), mx(ba)
    S['ratio_bid'] = ex_b / np.maximum(1, S['maxdisp_bid']); S['ratio_ask'] = ex_a / np.maximum(1, S['maxdisp_ask'])
    pb = win(PULL, t, np.stack([bb - j for j in range(5)], 1), 10); tb = win(TRD, t, np.stack([bb - j for j in range(5)], 1), 10); pa = win(PULL, t, np.stack([ba + j for j in range(5)], 1), 10); ta = win(TRD, t, np.stack([ba + j for j in range(5)], 1), 10)
    S['pull_bid'], S['pull_ask'], S['pshare_bid'], S['pshare_ask'] = pb, pa, pb / np.maximum(1, pb + tb), pa / np.maximum(1, pa + ta)
    cs = lambda a: np.cumsum(np.r_[0.0, a]); cb, cl = cs(D['buy']), cs(D['sell']); k = 10; S['buy10'] = np.r_[np.zeros(k), cb[k + 1:] - cb[1:-k]][:NS] if False else np.array([cb[i + 1] - cb[max(0, i - k + 1)] for i in range(NS)]); S['sell10'] = np.array([cl[i + 1] - cl[max(0, i - k + 1)] for i in range(NS)])
    S['ask5'] = np.array([np.clip(SZ[i, ba[i]:ba[i] + 5], 0, None).sum() for i in range(NS)]); S['bid5'] = np.array([np.clip(SZ[i, bb[i] - 4:bb[i] + 1], 0, None).sum() for i in range(NS)])
    lv = np.concatenate([np.clip(SZ[i, bb[i] - 9:bb[i] + 1], 0, None) for i in range(0, NS, 10)] + [np.clip(SZ[i, ba[i]:ba[i] + 10], 0, None) for i in range(0, NS, 10)]); S['levels'] = lv[lv > 0]; return S

def thresholds(prior):
    q = lambda key, p, f=lambda x: x: np.quantile(np.concatenate([f(s[key]) for s in prior]), p); fin = lambda x: x[np.isfinite(x) & (x > 0)]
    return dict(large=q('levels', .95), exec=np.quantile(np.concatenate([fin(s['exec_bid']) for s in prior] + [fin(s['exec_ask']) for s in prior]), .90), ratio=np.quantile(np.concatenate([fin(s['ratio_bid']) for s in prior] + [fin(s['ratio_ask']) for s in prior]), .90),
                pull=np.quantile(np.concatenate([fin(s['pull_bid']) for s in prior] + [fin(s['pull_ask']) for s in prior]), .95), sweep=np.quantile(np.concatenate([fin(s['buy10']) for s in prior] + [fin(s['sell10']) for s in prior]), .95))

def cooldown(times, gap=60):
    keep, last = [], -10 ** 9
    for x in sorted(times):
        if x - last >= gap: keep.append(x); last = x
    return keep

def detect(D, S, th):
    """returns {detector: list of (td, pred_sign, group, is_event)}: every member of a detector's control population, is_event marks the pre-registered event subset; td = decision second; pred_sign = +1 up / -1 down."""
    bb, ba, SZ, TRD, mid = D['bb'], D['ba'], D['SZ'], D['TRD'], D['mid']; t = np.arange(NS); out = {d: [] for d in DETS}; lo, hi = 60, END_OK - max(HZ)
    # B2 / B3 (bid side absorbed -> up; ask side absorbed -> down)
    mnbb = np.array([bb[max(0, i - 29):i + 1].min() for i in range(NS)]); mxba = np.array([ba[max(0, i - 29):i + 1].max() for i in range(NS)])
    for side, x, sgn, mv in (('bid', bb, 1, mnbb >= bb), ('ask', ba, -1, mxba <= ba)):
        sz_now = SZ[t, x]; sz_30 = SZ[np.clip(t - 30, 0, NS - 1), x]; refill = (sz_30 > 0) & (sz_now >= 0.5 * sz_30); ex = S['exec_' + side]; ra = S['ratio_' + side]
        for det, cond_ctl, cond_ev in (('B2_ABSORB', (ex > 0) & mv, (ex >= th['exec']) & mv & refill), ('B3_ICEBERG', (ex > 0) & mv, (ra >= th['ratio']) & mv)):
            ctl = [i for i in range(lo, hi) if cond_ctl[i] and D['ok'][i]]; ev = set(cooldown([i for i in ctl if cond_ev[i]]))
            out[det] += [(i, sgn, det + side, i in ev) for i in ctl[::5] if i not in ev] + [(i, sgn, det + side, True) for i in ev]   # control members thinned 1 in 5 (no events removed)
    # B4 pull: pulled bid -> down; pulled ask -> up
    for side, sgn in (('bid', -1), ('ask', 1)):
        p = S['pull_' + side]; sh = S['pshare_' + side]; ctl = [i for i in range(lo, hi) if p[i] > 0 and D['ok'][i]]; ev = set(cooldown([i for i in ctl if p[i] >= th['pull'] and sh[i] >= 0.8]))
        out['B4_PULL'] += [(i, sgn, 'B4' + side, i in ev) for i in ctl[::5] if i not in ev] + [(i, sgn, 'B4' + side, True) for i in ev]
    # B5 sweep then reject (up sweep -> reversal DOWN; down sweep -> reversal UP); decision 30 s after the sweep second
    for dirn, vol, d5 in ((1, S['buy10'], S['ask5']), (-1, S['sell10'], S['bid5'])):
        sw = [i for i in range(70, hi - 30) if vol[i] >= th['sweep'] and dirn * (mid[i] - mid[i - 10]) >= 0.5 and d5[i] <= 0.4 * max(1, d5[i - 10]) and D['ok'][i]]
        sw = cooldown(sw); evs = set()
        for i in sw:
            j = i + 30; rej = dirn * (mid[i] - mid[j]) >= 0.5 * dirn * (mid[i] - mid[i - 10]) and d5[j] >= 0.8 * d5[i - 10]
            if rej: evs.add(i)
        out['B5_SWEEP'] += [(i + 30, -dirn, 'B5' + ('up' if dirn > 0 else 'dn'), i in evs) for i in sw]
    # B1 real vs fake large orders (bid wall real -> up, fake -> down; ask wall real -> down, fake -> up), decision 60 s after appearance
    ok = D['ok']
    for side, sgn in (('bid', 1), ('ask', -1)):
        app = []
        for k in range(10):
            col = (bb - k) if side == 'bid' else (ba + k); s_now = SZ[t, col]; s_prev = SZ[np.clip(t - 1, 0, NS - 1), col]; app += [(i, int(col[i])) for i in range(lo, hi - 60) if s_now[i] >= th['large'] and s_prev[i] >= 0 and s_prev[i] < 0.5 * s_now[i] and ok[i]]
        app.sort(); seen_t, last = [], -10 ** 9; apps = []
        for i, c in app:
            if i - last >= 60: apps.append((i, c)); last = i
        for i, c in apps:
            init = SZ[i, c]; seq = SZ[i:i + 61, c]; trd = int(TRD[i:i + 61, c].sum())
            if (seq < 0).any(): continue
            fake = seq[-1] < 0.2 * init and trd <= 0.2 * init; real = (seq.min() >= 0.5 * init) or trd >= 0.5 * init
            cls = 'FAKE' if fake and not real else ('REAL' if real and not fake else None)
            sign = sgn if cls == 'REAL' else -sgn
            out['B1_WALL'].append((i + 60, sgn, 'B1' + side + ('P' if sgn > 0 else 'N'), False)); out['B1_WALL'].append((i + 60, -sgn, 'B1' + side + ('N' if sgn > 0 else 'P'), False))   # control: every appearance, both signs
            if cls is not None: out['B1_WALL'].append((i + 60, sign, 'B1' + side + ('P' if sign > 0 else 'N'), True))
    return out

def moves(mid, td, H): return np.array([(mid[t + H] - mid[t]) if t + H <= END_OK else np.nan for t in td])

def bh(ps, q=0.10):
    order = sorted(range(len(ps)), key=lambda i: ps[i]); keep = -1
    for rk, ix in enumerate(order): keep = rk if ps[ix] <= (rk + 1) / len(ps) * q else keep
    return {ix: rk <= keep for rk, ix in enumerate(order)}

def main():
    rng = np.random.default_rng(SEED + 71); dates = sorted(os.path.basename(f)[:10] for f in glob.glob(f'{DIR}/20*.npz')); S_ = {}; D_ = {}; cells = {(d, h): [] for d in DETS for h in HZ}; nsess = 0
    for k, d in enumerate(dates):
        D = load(d)
        if D is None: print(d, 'dropped (book missing > 2% of seconds)'); continue
        S_[d] = stats_day(D); D_[d] = D
    ds = sorted(S_); print(f'sessions usable {len(ds)} of {len(dates)} extracted')
    for k, d in enumerate(ds):
        if k < 20: continue
        th = thresholds([S_[x] for x in ds[k - 20:k]]); det = detect(D_[d], S_[d], th); nsess += 1; mid = D_[d]['mid']
        for dt in DETS:
            if not det[dt]: continue
            td = np.array([m[0] for m in det[dt]]); sg = np.array([m[1] for m in det[dt]]); grp = np.array([m[2] for m in det[dt]]); ev = np.array([m[3] for m in det[dt]])
            for h in HZ: y = sg * moves(mid, td, h); cells[(dt, h)].append((k, grp, ev, y, np.full(len(td), mid.shape[0])))
    print(f'sessions evaluated {nsess}')
    res = {}; half = nsess // 2
    for key, lst in cells.items():
        if not lst: res[key] = None; continue
        k = np.concatenate([np.full(len(x[1]), x[0]) for x in lst]); g = np.concatenate([x[1] for x in lst]); ev = np.concatenate([x[2] for x in lst]); y = np.concatenate([x[3] for x in lst]); m = np.isfinite(y); k, g, ev, y = k[m], g[m], ev[m], y[m]
        if ev.sum() < 100 or len(np.unique(k[ev])) < 40: res[key] = None if ev.sum() < 1 else dict(under=True, n=int(ev.sum()), days=len(np.unique(k[ev]))); continue
        cm = {gg: y[g == gg].mean() for gg in np.unique(g)}; ctl_i = np.array([cm[gg] for gg in g]); ex_i = np.where(ev, y - ctl_i, 0.0); sess = np.unique(k); idx = {s: np.where(k == s)[0] for s in sess}
        se = np.array([ex_i[idx[s]].sum() for s in sess]); ne = np.array([ev[idx[s]].sum() for s in sess]); ex = se.sum() / ne.sum(); bs = []
        for _ in range(BOOT):
            w = rng.integers(0, len(sess), len(sess)); bs.append(se[w].sum() / max(1, ne[w].sum()))
        lo_, hi_ = np.percentile(bs, [2.5, 97.5]); plc = []
        for _ in range(DRAWS):
            tot = 0.0
            for gg in np.unique(g):
                e = ev & (g == gg); nE = int(e.sum())
                if nE: pool = y[g == gg]; tot += (rng.choice(pool, nE) - cm[gg]).sum()
            plc.append(tot / ev.sum())
        p = float((np.sum(np.abs(plc) >= abs(ex)) + 1) / (DRAWS + 1)); hv = lambda sel: ex_i[sel & ev].sum() / max(1, (sel & ev).sum()); res[key] = dict(ex=ex, lo=float(lo_), hi=float(hi_), p=p, h1=hv(k < sess[half]), h2=hv(k >= sess[half]), n=int(ev.sum()), days=int(len(np.unique(k[ev]))), evmean=float(y[ev].mean()), under=False)
    live = [k for k in cells if res[k] is not None and not res[k].get('under')]; sv = bh([res[k]['p'] for k in live]) if live else {}; bhm = {k: sv[i] for i, k in enumerate(live)}
    print('\ndetector | horizon | events | sessions | event mean pts | excess over control (CI) | placebo p | halves | BH | tradable')
    cands = []
    for key in cells:
        r = res[key]
        if r is None: print(f'{key[0]:11s} | {key[1]:3d}s | no events'); continue
        if r.get('under'): print(f'{key[0]:11s} | {key[1]:3d}s | {r["n"]:5d} | {r["days"]:3d} | UNDERPOWERED'); continue
        ok = bhm[key] and (r['lo'] > 0 or r['hi'] < 0) and np.sign(r['h1']) == np.sign(r['h2']) == np.sign(r['ex']); tr = ok and abs(r['ex']) > COST + 0.125
        if ok: cands.append((key, r['ex'], tr))
        print(f'{key[0]:11s} | {key[1]:3d}s | {r["n"]:5d} | {r["days"]:3d} | {r["evmean"]:+6.2f} | {r["ex"]:+6.2f} [{r["lo"]:+6.2f}, {r["hi"]:+6.2f}] | {r["p"]:.3f} | {r["h1"]:+5.2f} / {r["h2"]:+5.2f} | {"survives" if bhm[key] else "no"} | {"YES" if tr else "no"}{"  <== CANDIDATE" if ok else ""}')
    print(f'\nCANDIDATES: {[(c[0], round(c[1], 2), c[2]) for c in cands]}')

if __name__ == '__main__': main()
