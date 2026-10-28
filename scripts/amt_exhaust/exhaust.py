"""Exhaustion reversal (PREREG.md frozen). Pure functions + threshold precompute. EXPLORE only."""
import sys
import numpy as np
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_80rule'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_flow')
import engine as E
TICK = SLIP = 0.25; DPP = 2.0; COMM = 2.0; K = 30; FIRST_T = 15; ENTRY_LO, ENTRY_HI, FLAT = 5, 345, 385; REFRACT = 30; RESP_WINDOW = 5; Q_EXH = 25

def push_stats(a):
    """Per-bar (K_eff, |net move|, efficiency ratio, signed net move). NaN-safe."""
    c = a['c']; mv = np.full(390, np.nan); er = np.full(390, np.nan); sg = np.full(390, np.nan)
    for t in range(FIRST_T, 390):
        k = min(K, t)
        if np.isnan(c[t]) or np.isnan(c[t - k]): continue
        net = c[t] - c[t - k]; path = np.nansum(np.abs(np.diff(c[t - k:t + 1])))
        mv[t] = abs(net); sg[t] = np.sign(net); er[t] = abs(net) / path if path > 0 else np.nan
    return mv, er, sg

def trailing_thresholds(stats, si, lo_back=20, win=15, q_mv=90, q_er=75):
    """thr90 of |move| and thr75 of ER from the prior 20 sessions at the same bar +/- win. stats: list of (mv, er, sg) per session."""
    if si < lo_back: return None
    MV = np.array([stats[j][0] for j in range(si - lo_back, si)]); ER = np.array([stats[j][1] for j in range(si - lo_back, si)])
    t90 = np.full(390, np.nan); t75 = np.full(390, np.nan)
    for t in range(FIRST_T, 390):
        a, b = max(0, t - win), min(390, t + win + 1)
        t90[t] = np.nanpercentile(MV[:, a:b], q_mv); t75[t] = np.nanpercentile(ER[:, a:b], q_er)
    return t90, t75

def base_signals(a, st, thr, exh_q=Q_EXH, k_max=K):
    """PUSH + NEW EXTREME bars with the EXHAUSTION flag. Refractory 30 bars within each class (faded / not faded). Returns list of dicts."""
    o, h, l, c, v, dl = a['o'], a['h'], a['l'], a['c'], a['v'], a['dl']; mv, er, sg = st; t90, t75 = thr; out = []; last = {True: -10 ** 6, False: -10 ** 6}
    ask = (v + dl) / 2.0; bid = (v - dl) / 2.0
    for t in range(FIRST_T, 390):
        if np.isnan(mv[t]) or np.isnan(t90[t]) or np.isnan(er[t]) or np.isnan(t75[t]): continue
        k = min(k_max, t)
        if mv[t] < t90[t] or er[t] < t75[t]: continue
        D = int(sg[t])
        if D == 0 or np.sign(np.nansum(dl[t - k + 1:t + 1])) != D: continue
        if D == 1 and not h[t] > np.nanmax(h[t - k:t]): continue
        if D == -1 and not l[t] < np.nanmin(l[t - k:t]): continue
        lead = ask if D == 1 else bid
        ref = np.array([np.nanmean(lead[j - 2:j + 1]) for j in range(t - k + 2, t - 2)])
        if len(ref) < 10 or np.all(np.isnan(ref)): continue
        tail = np.nanmean(lead[t - 2:t + 1]); faded = bool(tail <= np.nanpercentile(ref, exh_q)); notfaded = bool(tail > np.nanmedian(ref))
        if not faded and not notfaded: continue                      # between the 25th percentile and the median: neither class
        if t < last[faded] + REFRACT: continue
        last[faded] = t
        out.append(dict(t=t, faded=faded, dp=D, ext=float(h[t] if D == 1 else l[t]), start=float(c[t - k]), k=k))
    return out

def response(a, sig, window=RESP_WINDOW):
    """First bar u (u - t >= 2, within `window` bars) where the counter side has stepped in on >= 2 bars, dominates aggressive volume, and price closed beyond the extreme bar's opposite end. None if absent."""
    h, l, c, v, dl = a['h'], a['l'], a['c'], a['v'], a['dl']; t, D = sig['t'], sig['dp']
    for u in range(t + 2, t + window + 1):
        if u >= 390 or np.isnan(c[u]): break
        d = dl[t + 1:u + 1]; vv = v[t + 1:u + 1]; cnt = int(np.sum(np.sign(d) == -D))
        counter = float(np.nansum((vv - D * d) / 2.0)); lead = float(np.nansum((vv + D * d) / 2.0))
        if cnt >= 2 and counter > lead and ((D == 1 and c[u] < l[t]) or (D == -1 and c[u] > h[t])): return u
    return None

def to_event(sig, e):
    return dict(t=sig['t'], e=e, d=-sig['dp'], dp=sig['dp'], ext=sig['ext'], start=sig['start'], k=sig['k'])

def build_events(a, st, thr, rng=None, exh_q=Q_EXH, window=RESP_WINDOW):
    """Returns dict of event lists: E1, E2, C2, NR (see PREREG.md). Entry bars outside [ENTRY_LO, ENTRY_HI] are dropped."""
    base = base_signals(a, st, thr, exh_q); ok = lambda e: e is not None and ENTRY_LO <= e <= ENTRY_HI and e < 390 and not np.isnan(a['o'][e])
    E1, E2, C2, NR = [], [], [], []; lags = []
    for s in base:
        u = response(a, s, window)
        if s['faded']:
            if ok(s['t'] + 1): E1.append(to_event(s, s['t'] + 1))
            if u is not None:
                if ok(u + 1): ev = to_event(s, u + 1); ev['lag'] = u - s['t']; E2.append(ev)
            else: NR.append(s)
        elif u is not None and ok(u + 1): ev = to_event(s, u + 1); ev['lag'] = u - s['t']; C2.append(ev)
    return dict(E1=E1, E2=E2, C2=C2, NR=NR)

def fwd(a, ev, hs=(5, 15, 30, 60)):
    o, c = a['o'], a['c']; entry = o[ev['e']] + ev['d'] * SLIP; r = {}
    for hh in hs:
        j = ev['e'] + hh - 1; r[f'F{hh}'] = ev['d'] * (c[j] - entry) if j < 390 and not np.isnan(c[j]) else np.nan
    j2 = min(389, ev['e'] + 29); hi = np.nanmax(a['h'][ev['e']:j2 + 1]); lo = np.nanmin(a['l'][ev['e']:j2 + 1])
    r['mfe'] = ev['d'] * ((hi if ev['d'] == 1 else lo) - entry); r['mae'] = ev['d'] * (entry - (lo if ev['d'] == 1 else hi)); r['entry'] = entry; return r

def trade(a, ev, atr, stop_atr_mult=0.5, max_bars=30):
    """Geometry: stop beyond the exhaustion extreme by 1 tick + mult x ATR14; target = 50% retracement of the push; time stop; flatten 15:55."""
    o, h, l, c = a['o'], a['h'], a['l'], a['c']; e, d = ev['e'], ev['d']; entry = o[e] + d * SLIP
    buf = TICK + stop_atr_mult * atr[ev['t']] if not np.isnan(atr[ev['t']]) else None
    if buf is None: return None
    stop = ev['ext'] + (buf if d == -1 else -buf); tgt = ev['ext'] - ev['dp'] * 0.5 * abs(ev['ext'] - ev['start'])
    if not ((d == 1 and stop < entry < tgt) or (d == -1 and tgt < entry < stop)): return None
    pend = None
    for i in range(e, 390):
        if np.isnan(o[i]): continue
        n = i - e + 1; px = why = None
        if pend and i > e: px, why = o[i] - d * SLIP, pend
        elif i >= FLAT: px, why = o[i] - d * SLIP, 'EOD'
        elif i > e and d * (o[i] - stop) <= 0: px, why = o[i] - d * SLIP, 'STOP_GAP'
        elif (d == 1 and l[i] <= stop) or (d == -1 and h[i] >= stop): px, why = stop - d * SLIP, 'STOP'
        elif (d == 1 and h[i] >= tgt + TICK) or (d == -1 and l[i] <= tgt - TICK): px, why = tgt, 'TGT'
        if px is not None:
            pts = (px - entry) * d; return dict(pts=pts, net=pts * DPP - COMM, reason=why, risk=abs(entry - stop), tdist=abs(tgt - entry), xi=i, ei=e, dir=d, stop=stop, tgt=tgt, entry=entry, exit=px)
        if n == max_bars: pend = 'TIME'
    return None

def trade_fixed(a, e, d, S_pts, T_pts, max_bars=30):
    """Placebo geometry: stop S, target T from the entry, same time stop and flatten as trade()."""
    o, h, l = a['o'], a['h'], a['l']; entry = o[e] + d * SLIP; stop = entry - d * S_pts; tgt = entry + d * T_pts; pend = None
    for i in range(e, 390):
        if np.isnan(o[i]): continue
        px = None
        if pend and i > e: px = o[i] - d * SLIP
        elif i >= FLAT: px = o[i] - d * SLIP
        elif i > e and d * (o[i] - stop) <= 0: px = o[i] - d * SLIP
        elif (d == 1 and l[i] <= stop) or (d == -1 and h[i] >= stop): px = stop - d * SLIP
        elif (d == 1 and h[i] >= tgt + TICK) or (d == -1 and l[i] <= tgt - TICK): px = tgt
        if px is not None: return ((px - entry) * d) * DPP - COMM
        if i - e + 1 == max_bars: pend = True
    return -COMM
