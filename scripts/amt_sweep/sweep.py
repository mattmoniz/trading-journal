"""Revised Sweep & Absorb with 2-leg scale-out and VWAP runner (PREREG.md frozen). Pure simulation, EXPLORE only."""
import sys
import numpy as np
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_flow'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_80rule'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_s1')
import engine as E
import flow as F

TICK = SLIP = 0.25; DPP = 2.0; COMM = 2.0; NC = 2
VOL_N, VOL_FLOOR, DELTA, ATR_MULT, RISK_CAP = 20, 0.75, 50.0, 2.0, 25.0
T1, BE_TICKS, VWAP_MIN, FIXED_T2 = 10.0, 2, 15.0, 25.0
ENT_LO, ENT_HI, FLAT = 60, 345, 385


def session_vwap(a):
    h, l, c, v = a['h'], a['l'], a['c'], a['v']; tp = (h + l + c) / 3.0; ok = ~np.isnan(tp) & ~np.isnan(v)
    num = np.cumsum(np.where(ok, tp * v, 0.0)); den = np.cumsum(np.where(ok, v, 0.0))
    return np.where(den > 0, num / np.where(den > 0, den, 1), np.nan)


def manage(a, vwap, ei, d, stop_dist, t):
    """Two-contract management from the entry bar ei (market entry at its open +1 tick). Returns a trade dict or None (risk cap). t = signal bar index (VWAP guard uses bar t)."""
    o, h, l = a['o'], a['h'], a['l']; entry = o[ei] + d * SLIP
    vt = vwap[t] if t >= 0 else np.nan
    use_vwap = (not np.isnan(vt)) and d * (vt - entry) >= VWAP_MIN
    stop = entry - d * stop_dist; t1 = entry + d * T1; fixed2 = entry + d * FIXED_T2
    leg1 = leg2 = None; pend_stop = None; t1_bar = None; reason = None
    for i in range(ei, 390):
        if np.isnan(o[i]): continue
        if pend_stop is not None and i > t1_bar: stop = pend_stop; pend_stop = None
        # flatten / stop first (applies to every open leg)
        flat = i >= FLAT; gap = i > ei and d * (o[i] - stop) <= 0; touch = (d == 1 and l[i] <= stop) or (d == -1 and h[i] >= stop)
        if flat or gap or touch:
            px = (o[i] - d * SLIP) if (flat or gap) else (stop - d * SLIP); why = 'EOD' if flat else ('STOP_GAP' if gap else 'STOP')
            if leg1 is None: leg1 = (px, why)
            if leg2 is None: leg2 = (px, why)
            break
        if leg1 is None and ((d == 1 and h[i] >= t1 + TICK) or (d == -1 and l[i] <= t1 - TICK)):
            leg1 = (t1, 'T1'); t1_bar = i; pend_stop = entry + d * BE_TICKS * TICK
        if leg1 is not None and leg2 is None:
            lvl = (vwap[i - 1] if (use_vwap and i >= 1 and not np.isnan(vwap[i - 1])) else fixed2)
            if (d == 1 and h[i] >= lvl + TICK) or (d == -1 and l[i] <= lvl - TICK): leg2 = (lvl, 'T2V' if use_vwap else 'T2F'); break
    if leg1 is None or leg2 is None: return None
    p1 = (leg1[0] - entry) * d; p2 = (leg2[0] - entry) * d
    r1, r2 = leg1[1], leg2[1]
    reason = r1 + '+' + r2 if r1 == 'T1' else r1
    net = (p1 + p2) * DPP - COMM * NC
    return dict(ei=ei, xi=i, dir=d, entry=entry, stop_dist=stop_dist, vwap_mode=bool(use_vwap), reason=reason, pts=(p1 + p2) / 2.0, net=net)


def fwd15(a, ei, d):
    o, c = a['o'], a['c']; e = o[ei] + d * SLIP; j = ei + 15
    return d * (c[j] - e) if j < 390 and not np.isnan(c[j]) else np.nan


def candidates(a, zones, t, control):
    """Return list of (dir, zone) qualifying on bar t (no delta condition applied when control=None handled by caller)."""
    h, l, v, dl = a['h'], a['l'], a['v'], a['dl']
    if t < VOL_N or np.isnan(h[t - 1]) or np.isnan(dl[t]) or np.isnan(v[t]): return []
    prior = a['v'][t - VOL_N:t]
    if np.isnan(prior).any() or v[t] < VOL_FLOOR * prior.mean(): return []
    out = []
    lz = [z for z in zones if l[t] < z[0]]
    if lz and l[t] < l[t - 1] and ((dl[t] <= 0) if control else (dl[t] > DELTA)): out.append((1, max(lz, key=lambda q: q[0])))
    hz = [z for z in zones if h[t] > z[1]]
    if hz and h[t] > h[t - 1] and ((dl[t] >= 0) if control else (dl[t] < -DELTA)): out.append((-1, min(hz, key=lambda q: q[1])))
    return out


def simulate(S, control=False, zones=None, report=None):
    a = S['a']; zones = F.build_zones(S) if zones is None else zones
    if not zones: return []
    vwap = session_vwap(a); atr = E.atr14(a); trades = []; t = 0
    while t < 389:
        if np.isnan(a['o'][t]): t += 1; continue
        ei = t + 1
        if ENT_LO <= ei <= ENT_HI and not np.isnan(a['o'][ei]) and not np.isnan(atr[t]):
            c = candidates(a, zones, t, control)
            if control and len(c) > 1: c = []                       # ambiguous bars excluded from the control
            if c:
                d, z = c[0]
                entry = a['o'][ei] + d * SLIP
                stop = (a['l'][t] - ATR_MULT * atr[t]) if d == 1 else (a['h'][t] + ATR_MULT * atr[t])
                sd = abs(entry - stop)
                dist = abs((a['l'][t] - z[0]) if d == 1 else (a['h'][t] - z[1]))
                if report is not None: report['signals'] += 1; report['dist'].append(dist)
                if sd > RISK_CAP:
                    if report is not None: report['capped'] += 1
                else:
                    tr = manage(a, vwap, ei, d, sd, t)
                    if tr is not None:
                        tr.update(date=S['d'], sig=t, fwd15=fwd15(a, ei, d), dist=dist); trades.append(tr); t = tr['xi']; continue
        t += 1
    return trades
