"""Q4-5 v2: the fixes accepted from the Argon review (docs/OPEN_THREADS.md 2026-11-08 ~23:15 ET). Signal DEFINITIONS are unchanged (the user's Sierra studies): Ratio = EMA10(TR)/EMA10(depth proxy D1), ROC10 = close - close[-10],
Bollinger = SMA50 +- k population SD. Changes: (1) triggers fire on the ONSET of the condition (a band crossing), no cooldown timer; (2) indicators run on one CONTINUOUS series (previous session + current session, gap-masked at each
session reset) so windows are warm across 09:30 and 18:00 and the user's showcase windows are scoreable; (3) the user's own pace rules as written (RTH dt <= 15 s; Globex dt <= 0.65 x SMA50(dt) and <= 120 s) next to the clock-hour percentile;
(4) strata by time of day; (5) scoring from Open[t+1]. No outcome is computed here."""
import os, sys, glob, csv, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import features as Fm
OUT = os.path.join(Fm.ROOT, 'scratch', 'vacuum_sim_20261108')
STRATA = (('REOPEN', 0.0, 5400.0), ('PRE_OPEN', 55500.0, 55800.0), ('OPEN', 55800.0, 56100.0), ('CLOSE', 78600.0, 79200.0), ('POST', 79200.0, 90000.0))   # 18:00-19:30, 09:25-09:30, 09:30-09:35, 15:50-16:00, 16:00-17:00 (descriptive, never counted)

def continuous(prev, cur):
    """prev, cur: full-session arrays. Returns the concatenated arrays and the index where cur starts. Gap-masked: the first bar of each session has TR = H-L and a displacement increment of C-O."""
    if prev is None: P = cur; n0 = 0
    else:
        P = {k: np.concatenate([prev[k], cur[k]]) if isinstance(cur[k], np.ndarray) else cur[k] for k in ('st', 'en', 'o', 'h', 'l', 'c', 'v', 'bid', 'ask', 'ntr')}; n0 = len(prev['c'])
    P['date'] = cur['date']; reset = np.zeros(len(P['c']), bool); reset[0] = True; reset[n0] = True
    return P, n0, reset

def track_of(en, close): return np.where(en <= Fm.OPEN, 'GBX', np.where(en <= close, 'RTH', 'POST'))

def feats(P, n0, reset, prs, close):
    h, l, c, o, ntr = P['h'], P['l'], P['c'], P['o'], P['ntr']; n = len(c); dur = np.maximum(P['en'] - P['st'], 1e-3)
    tr = np.where(reset, h - l, np.maximum.reduce([h - l, np.abs(h - np.r_[c[0], c[:-1]]), np.abs(l - np.r_[c[0], c[:-1]])]))
    tk = track_of(P['en'], close); fl = np.where(tk == 'GBX', prs['GBX']['floor'], prs['RTH']['floor'])
    depth = ntr * np.log(np.maximum(dur, fl) + 1.0); ratio = Fm.ema(tr) / np.maximum(Fm.ema(depth), 1e-6)
    rm, rs = Fm.sma_sd(ratio); zr = (ratio - rm) / np.where(rs > 1e-12, rs, np.nan)
    inc = np.where(reset, c - o, np.r_[0.0, np.diff(c)]); X = np.cumsum(inc)                      # gap-masked cumulative displacement
    roc = np.full(n, np.nan); roc[Fm.L_ROC:] = X[Fm.L_ROC:] - X[:-Fm.L_ROC]
    # ROC10 is valid across a session reset because the displacement series X is gap-masked (the first bar of a session adds C-O, never the gap); nothing is blanked at a reset
    qm, qs = Fm.sma_sd(roc); zroc = (roc - qm) / np.where(qs > 1e-12, qs, np.nan)
    rng = h - l; clv = np.where(rng > 0, (c - l) / np.where(rng > 0, rng, 1), 0.5); dl = P['ask'] - P['bid']; d3 = np.full(n, np.nan); d3[2:] = dl[2:] + dl[1:-1] + dl[:-2]
    dm, _ = Fm.sma_sd(dur); acc = dur / dm
    pace = np.full(n, np.nan)
    for name in ('GBX', 'RTH'):
        m = tk == name
        if m.any(): pace[m] = Fm.pace_cdf(dur[m], Fm.hour_et(P['en'][m]), prs[name])
    pace[tk == 'POST'] = np.nan
    user_fast = np.where(tk == 'GBX', (acc <= 0.65) & (dur <= 120.0), dur <= 15.0)
    fl_l = np.where(tk == 'GBX', clv >= prs['GBX']['clv_hi'], clv >= prs['RTH']['clv_hi']) & (d3 > 0)
    fl_s = np.where(tk == 'GBX', clv <= prs['GBX']['clv_lo'], clv <= prs['RTH']['clv_lo']) & (d3 < 0)
    return dict(tr=tr, ratio=ratio, zr=zr, rs=rs, roc=roc, zroc=zroc, qs=qs, dur=dur, acc=acc, pace=pace, user_fast=user_fast, fl_l=fl_l, fl_s=fl_s, tk=tk)

def onset(m): return m & ~np.r_[False, m[:-1]]

def events2(P, n0, F, close):
    n = len(P['c']); en = P['en']; idx = np.arange(n); cur = idx >= n0
    d = np.where(F['roc'] > 0, 1, np.where(F['roc'] < 0, -1, 0)); z = F['zroc']; zr = F['zr']
    ok = cur & (idx >= Fm.WARM) & ~np.isnan(z) & ~np.isnan(zr)
    gbx_w = (en >= 1800.0) & (en <= 55500.0); rth_w = (en >= 56100.0) & (en <= close - 600.0)
    c0 = ok & (np.abs(z) > Fm.Z_ROC) & (np.sign(z) == d); c1 = ok & (zr > Fm.Z_RATIO) & (d != 0); c2 = c0 & c1
    fast = F['pace'] <= 1.0 / 3.0; flow = np.where(d > 0, F['fl_l'], F['fl_s'])
    fam = dict(E0=onset(c0), E1=onset(c1), E2=onset(c2), E3=onset(c2 & fast), E3u=onset(c2 & F['user_fast']), E4=onset(c2 & fast & flow), E4u=onset(c2 & F['user_fast'] & flow))
    rows = []
    for name, m in fam.items():
        for k in np.where(m)[0]:
            t = en[k]; labs = [s for s, a, b in STRATA if a <= t < b]
            track = 'GBX' if gbx_w[k] else ('RTH' if rth_w[k] else None)
            if track is None and not labs: continue
            rows.append(dict(date=P['date'], fam=name, k=int(k - n0), dir=int(d[k]), track=track or '', strata='|'.join(labs), end=round(float(t), 3), zr=round(float(zr[k]), 2), zroc=round(float(z[k]), 2), roc=round(float(F['roc'][k]), 1),
                             dur=round(float(F['dur'][k]), 2), pace=round(float(F['pace'][k]), 3) if not np.isnan(F['pace'][k]) else '', wall=int(zr[k] < -1.0)))
    return rows

def run(files, want=None):
    hist = {'RTH': [], 'GBX': []}; prevS = None; rows = []; ns = collections.Counter()
    for p in files:
        S = Fm.load_full(p)
        if S is None: continue
        tsp = Fm.track_split(S); close = Fm.EARLY_CLOSE if S['date'] in Fm.EARLY else Fm.CLOSE
        prs = {}
        for name in ('RTH', 'GBX'):
            prev = hist[name][-Fm.K_PRIOR:]
            if len(prev) >= Fm.K_PRIOR or (want and S['date'] == want and len(prev) >= 15): prs[name] = Fm.priors_of(prev)
        if len(prs) == 2:
            P, n0, reset = continuous(prevS, S); F = feats(P, n0, reset, prs, close)
            if not want or S['date'] == want:
                r = events2(P, n0, F, close); rows += r; ns[S['date'][:4]] += 1
            if want and S['date'] == want: return rows, ns, (P, n0, F)
        for name, T in tsp.items(): hist[name].append(T)
        prevS = S
    return rows, ns, None

if __name__ == '__main__':
    files = sorted(p for p in glob.glob(os.path.join(Fm.BARS, '*.bars.tsv')) if os.path.basename(p)[:10] <= Fm.LAST_EXPLORE)
    rows, ns, _ = run(files)
    with open(os.path.join(OUT, 'events2.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
    sess = sum(ns.values()); print('sessions scored', sess, dict(ns), 'events', len(rows))
    for tr in ('RTH', 'GBX'):
        print('==', tr)
        for fam in ('E0', 'E1', 'E2', 'E3', 'E3u', 'E4', 'E4u'):
            r = [x for x in rows if x['track'] == tr and x['fam'] == fam]; print(f'   {fam:3s}: events {len(r):6d} per session {len(r) / sess:.3f} active days {len({x["date"] for x in r}):4d}')
    for s in ('REOPEN', 'PRE_OPEN', 'OPEN', 'CLOSE', 'POST'):
        r = [x for x in rows if s in x['strata'].split('|') and x['fam'] == 'E2']; print(f'   stratum {s}: E2 events {len(r)} on {len({x["date"] for x in r})} days')
