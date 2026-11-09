"""Features + events for the user's ORIGINAL 500V liquidity-vacuum idea (prereg docs/VACUUM_COMMON_SIM_PREREG_20261108.md; indicator settings docs/USER_SIERRA_INDICATOR_SETTINGS_20261108.md).
EVERYTHING here is causal at bar close and reads NO price after the bar: no outcome is computed in this module (outcomes live in outcomes.py, run only after the prereg is frozen).
Tracks are separate series, each computed from scratch: GBX = bars finished by 09:30 ET (session starts 18:00 ET), RTH = bars starting at or after 09:30 and ending by the close (16:00; 13:15 on early closes)."""
import os, glob, json, math
import numpy as np
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
BARS = os.path.join(ROOT, 'scratch', 'volbars500_full_20261028'); assert 'holdout' not in BARS
LAST_EXPLORE = '2025-05-16'
OPEN, CLOSE, EARLY_CLOSE = 55800.0, 79200.0, 69300.0
EARLY = set(json.load(open(os.path.join(ROOT, 'scratch', 'early_close_dates_20261108.json'))))
L_EMA, L_BB, L_ROC, K_PRIOR, WARM, COOL = 10, 50, 10, 20, 60, 30
Z_RATIO, Z_ROC = 1.5, 2.0          # the user's Bollinger widths (Ratio 1.5 sd per the notes, ROC 2 sd per the screenshot)
FAMILIES = ('E0', 'E1', 'E2', 'E3', 'E4')

def load_full(path):
    rows = []
    for ln in open(path):
        p = ln.rstrip('\n').split('\t')
        if len(p) < 12 or p[11] != '1': continue
        v = float(p[7])
        if v != 500: continue
        rows.append([float(x) for x in p[1:7]] + [v, float(p[8]), float(p[9]), float(p[10])])
    if not rows: return None
    a = np.array(rows).T
    return dict(date=os.path.basename(path)[:10], st=a[0], en=a[1], o=a[2], h=a[3], l=a[4], c=a[5], v=a[6], bid=a[7], ask=a[8], ntr=a[9])

def track_split(S):
    """{'RTH': arrays, 'GBX': arrays}; a track is kept only with >= WARM+1 bars."""
    close = EARLY_CLOSE if S['date'] in EARLY else CLOSE
    out = {}
    for name, m in (('GBX', S['en'] <= OPEN), ('RTH', (S['st'] >= OPEN) & (S['en'] <= close))):
        if m.sum() > WARM: out[name] = {k: (v[m] if isinstance(v, np.ndarray) else v) for k, v in S.items()} | dict(close=close, track=name, n=int(m.sum()))
    return out

def ema(x, L=L_EMA):
    a = 2.0 / (L + 1); o = np.empty(len(x)); o[0] = x[0]
    for i in range(1, len(x)): o[i] = a * x[i] + (1 - a) * o[i - 1]
    return o

def sma_sd(x, w=L_BB):
    """Sierra Bollinger Bands: simple moving average and POPULATION standard deviation over w bars (NaN until w valid values)."""
    n = len(x); m = np.full(n, np.nan); s = np.full(n, np.nan)
    v = np.lib.stride_tricks.sliding_window_view(x, w); ok = ~np.isnan(v).any(axis=1)
    mm = v.mean(axis=1); ss = v.std(axis=1); m[w - 1:][ok] = mm[ok]; s[w - 1:][ok] = ss[ok]
    return m, s

def hour_et(en): return ((18 + (en // 3600).astype(int)) % 24)

def wq(vals, wts, q):
    i = np.argsort(vals, kind='stable'); v = vals[i]; w = wts[i]; cw = np.cumsum(w) / w.sum()
    return float(v[min(int(np.searchsorted(cw, q - 1e-12)), len(v) - 1)])

def priors_of(prev):
    """prev = the last K_PRIOR track-sessions strictly before today (same track). Session-equal weights (audit H4). Returns the pooled objects the features need."""
    K = len(prev); dts = []; clvs = []; wts = []; hrs = []
    for P in prev:
        dt = np.maximum(P['en'] - P['st'], 1e-3); rng = P['h'] - P['l']; clv = np.where(rng > 0, (P['c'] - P['l']) / np.where(rng > 0, rng, 1), 0.5)
        dts.append(dt); clvs.append(clv); hrs.append(hour_et(P['en'])); wts.append(np.full(len(dt), 1.0 / (K * len(dt))))
    dt = np.concatenate(dts); clv = np.concatenate(clvs); w = np.concatenate(wts); hr = np.concatenate(hrs)
    pos = dt > 1e-3; floor = max(wq(dt[pos], w[pos], 0.01), 1e-3) if pos.any() else 1e-3     # audit C2: the 0.01 quantile over POSITIVE durations
    hour = {}
    for h in np.unique(hr):
        m = hr == h; i = np.argsort(dt[m], kind='stable'); hour[int(h)] = (dt[m][i], np.cumsum(w[m][i]) / w[m].sum())
    return dict(floor=floor, clv_hi=wq(clv, w, 0.60), clv_lo=wq(clv, w, 0.40), hour=hour, K=K)

def pace_cdf(dt, hrs, PR):
    """Weighted share of prior same-hour bars (prior 20 sessions of this track) that were AT LEAST AS FAST (dt <= this bar's dt). Small = fast = high involvement. NaN if the hour has no history."""
    out = np.full(len(dt), np.nan)
    for i, (d, h) in enumerate(zip(dt, hrs)):
        e = PR['hour'].get(int(h))
        if e is None: continue
        j = np.searchsorted(e[0], d, side='right') - 1
        out[i] = e[1][j] if j >= 0 else 0.0
    return out

def features(T, PR):
    n = T['n']; h, l, c, ntr = T['h'], T['l'], T['c'], T['ntr']; dur = T['en'] - T['st']
    pc = np.r_[c[0], c[:-1]]; tr = np.maximum.reduce([h - l, np.abs(h - pc), np.abs(l - pc)]); tr[0] = h[0] - l[0]
    depth = ntr * np.log(np.maximum(dur, PR['floor']) + 1.0)                                  # D1 PROXY (v0): trade count x ln(duration + 1); the real Sierra depth needs the .depth files (D2, later)
    ratio = ema(tr) / np.maximum(ema(depth), 1e-6)
    rm, rs = sma_sd(ratio); zr = (ratio - rm) / np.where(rs > 1e-12, rs, np.nan)
    roc = np.full(n, np.nan); roc[L_ROC:] = c[L_ROC:] - c[:-L_ROC]
    qm, qs = sma_sd(roc); zroc = (roc - qm) / np.where(qs > 1e-12, qs, np.nan)
    rng = h - l; clv = np.where(rng > 0, (c - l) / np.where(rng > 0, rng, 1), 0.5); dl = T['ask'] - T['bid']
    d3 = np.full(n, np.nan); d3[2:] = dl[2:] + dl[1:-1] + dl[:-2]
    pace = pace_cdf(np.maximum(dur, 1e-3), hour_et(T['en']), PR)
    flow_l = (clv >= PR['clv_hi']) & (d3 > 0); flow_s = (clv <= PR['clv_lo']) & (d3 < 0)
    return dict(tr=tr, ratio=ratio, zr=zr, roc=roc, zroc=zroc, dur=dur, pace=pace, flow_l=flow_l, flow_s=flow_s)

def entry_window(T):
    idx = np.arange(T['n']); en = T['en']
    if T['track'] == 'RTH': w = (en >= 56100.0) & (en <= T['close'] - 600.0)
    else: w = (en >= 1800.0) & (en <= 55500.0)
    return w & (idx >= WARM)

def events(T, F):
    """Event families at bar close (direction = sign of ROC10; cooldown COOL bars per direction per family). pace terciles are prior-session derived (no static seconds)."""
    w = entry_window(T); z = F['zroc']; zr = F['zr']; pc = F['pace']
    d = np.where(F['roc'] > 0, 1, np.where(F['roc'] < 0, -1, 0))
    e0 = w & (np.abs(z) > Z_ROC) & (np.sign(z) == d)
    e1 = w & (zr > Z_RATIO) & (d != 0)
    e2 = e0 & (zr > Z_RATIO)
    fast = pc <= 1.0 / 3.0
    e3 = e2 & fast
    flow = np.where(d > 0, F['flow_l'], F['flow_s'])
    e4 = e3 & flow
    out = []
    for name, m in (('E0', e0), ('E1', e1), ('E2', e2), ('E3', e3), ('E4', e4)):
        last = {1: -10**9, -1: -10**9}
        for k in np.where(m)[0]:
            dr = int(d[k])
            if k - last[dr] < COOL: continue
            last[dr] = k; out.append((name, int(k), dr))
    return out
