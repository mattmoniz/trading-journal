"""Volume nodes left behind + two-sided flow on the 500-contract full-session chart (PREREG.md frozen). Pure functions, EXPLORE only."""
import os, glob
import numpy as np
ROOT = '/home/mmoniz/trading-journal/scratch/volbars500_full_20261028'
TICK = 0.25; RTH_OPEN, RTH_CLOSE = 55800.0, 79200.0      # seconds since the 18:00 open: 09:30 and 16:00
DEC_FIRST, DEC_LAST, THIN, MOVE_N, FLOW_N, HORIZON = 57600.0, 73800.0, 10, 10, 10, 3600.0   # decisions from 10:00 to 14:30, every 10th bar


def load_session(d):
    b = np.loadtxt(f'{ROOT}/{d}.bars.tsv', delimiter='\t', ndmin=2); v = np.loadtxt(f'{ROOT}/{d}.vap.tsv', delimiter='\t', ndmin=2)
    return dict(d=d, idx=b[:, 0].astype(int), start=b[:, 1], end=b[:, 2], o=b[:, 3], h=b[:, 4], l=b[:, 5], c=b[:, 6], vol=b[:, 7], bid=b[:, 8], ask=b[:, 9], comp=b[:, 11].astype(bool),
                vi=v[:, 0].astype(int), vp=np.round(v[:, 1] / TICK).astype(int), vv=v[:, 2])


def nodes_of(P, lo_bin):
    """Nodes of a profile array P (index = bin - lo_bin). Returns list of (lo_b, hi_b) in absolute bins."""
    occ = np.where(P > 0)[0]
    if len(occ) < 8: return []
    lo, hi = occ[0], occ[-1]; med = np.median(P[occ]); n = len(P); peak = np.ones(n, bool)
    for k in (1, 2, 3):
        sh_up = np.zeros(n); sh_up[:-k] = P[k:]; sh_dn = np.zeros(n); sh_dn[k:] = P[:-k]
        peak &= (P > sh_up) & (P > sh_dn)
    peak[:lo + 3] = False; peak[hi - 2:] = False; peak &= P > 0
    out = []
    for i in np.where(peak)[0]:
        a = i
        while a - 1 >= lo and P[a - 1] > med: a -= 1
        b = i
        while b + 1 <= hi and P[b + 1] > med: b += 1
        if b - a + 1 >= 3: out.append([a, b])
    out.sort(); merged = []
    for a, b in out:
        if merged and a <= merged[-1][1]: merged[-1][1] = max(merged[-1][1], b)
        else: merged.append([a, b])
    return [(a + lo_bin, b + lo_bin) for a, b in merged]


def node_time(S, nb, upto_idx):
    m = (S['vi'] <= upto_idx) & (S['vp'] >= nb[0]) & (S['vp'] <= nb[1])
    if not m.any(): return np.nan
    ii, vv = S['vi'][m], S['vv'][m]; o = np.argsort(ii, kind='stable'); ii, vv = ii[o], vv[o]; cs = np.cumsum(vv)
    return float(ii[np.searchsorted(cs, cs[-1] / 2.0)])


def ladder_len(nodes_t, d):
    """nodes_t: list of (lo_b, hi_b, time) left behind. Longest chain along price order (ascending for d=+1, descending for d=-1) with strictly increasing time."""
    seq = sorted(nodes_t, key=lambda x: (x[0] if d == 1 else -x[1])); ts = [x[2] for x in seq if not np.isnan(x[2])]
    best = []
    for t in ts:
        k = int(np.searchsorted(best, t, side='left'))
        if k == len(best): best.append(t)
        else: best[k] = t
    return len(best)


def clock_hour(end_sec): return int(((64800.0 + end_sec) % 86400) // 3600)


def session_stats(S):
    """RTH range, per-clock-hour mean seconds per bar."""
    rth = (S['end'] >= RTH_OPEN) & (S['end'] < RTH_CLOSE)
    rng = float(S['h'][rth].max() - S['l'][rth].min()) if rth.any() else np.nan
    dur = S['end'] - S['start']; hh = np.array([clock_hour(e) for e in S['end']]); hour_mean = {int(k): float(dur[hh == k].mean()) for k in np.unique(hh)}
    return rng, hour_mean


def points(S, atr, base_hour):
    """Decision points of one session. atr = ATR20 in points; base_hour = {hour: baseline mean seconds per bar} from the prior 20 sessions."""
    if np.isnan(atr): return []
    end, c, h, l, comp = S['end'], S['c'], S['h'], S['l'], S['comp']; n = len(end)
    on = end < RTH_OPEN
    if on.sum() < 30: return []
    onh, onl = float(h[on].max()), float(l[on].min())
    ib = (end >= RTH_OPEN) & (end < RTH_OPEN + 3600); ibh = float(h[ib].max()) if ib.any() else None; ibl = float(l[ib].min()) if ib.any() else None
    allp = np.concatenate([S['vp'], S['vp'] + 0]); lo_bin, hi_bin = int(S['vp'].min()), int(S['vp'].max())
    dec = [i for i in range(MOVE_N, n) if comp[i] and DEC_FIRST <= end[i] <= DEC_LAST]
    dec = dec[::THIN]; out = []; dur = S['end'] - S['start']
    delta = S['ask'] - S['bid']
    for i in dec:
        P = np.zeros(hi_bin - lo_bin + 1); m = S['vi'] <= i; np.add.at(P, S['vp'][m] - lo_bin, S['vv'][m])
        nds = nodes_of(P, lo_bin)
        for d in (1, -1):
            ib_done = end[i] >= RTH_OPEN + 3600
            bd = max(onh, ibh) if (d == 1 and ib_done and ibh is not None) else onh if d == 1 else min(onl, ibl) if (ib_done and ibl is not None) else onl
            rt = (end[:i + 1] >= RTH_OPEN)
            if rt.any() and (np.any(c[:i + 1][rt] > bd) if d == 1 else np.any(c[:i + 1][rt] < bd)): continue
            cur = c[i]; dist = d * (bd - cur) / atr
            if dist < 0: continue
            hz = (end > end[i]) & (end <= end[i] + HORIZON) & comp
            if not hz.any(): continue
            j = np.where(hz)[0][-1]; fwd = d * (c[j] - cur) / atr
            hi_ = d * ((h[hz] if d == 1 else l[hz]) - cur) / atr; adv_ = d * ((l[hz] if d == 1 else h[hz]) - cur) / atr
            mfe = float(np.max(hi_)); mae = float(-np.min(adv_)); ext = float(max(0.0, np.max(d * ((h[hz] if d == 1 else l[hz]) - bd)) / atr))
            brk = bool(np.any(c[hz] > bd) if d == 1 else np.any(c[hz] < bd))
            left = []
            for a, b in nds:
                if (d == 1 and (b + 1) * TICK < cur) or (d == -1 and a * TICK > cur): left.append((a, b, node_time(S, (a, b), i)))
            L = ladder_len(left, d); moving = d * (c[i] - c[i - MOVE_N]) > 0
            ch = np.diff(c[i - FLOW_N:i + 1]); nz = ch[ch != 0]; R = int(np.sum(nz[1:] * nz[:-1] < 0)) if len(nz) > 1 else 0
            S1 = d * (c[i] - c[i - 20]) if i >= 20 else np.nan; S0 = d * (c[i - 20] - c[i - 40]) if i >= 40 else np.nan
            strides = bool((not np.isnan(S1)) and (not np.isnan(S0)) and S1 > 0 and S1 > S0)
            cd = dur[i - FLOW_N + 1:i + 1].mean(); bh = base_hour.get(clock_hour(end[i]), np.nan); A = bh / cd if cd > 0 else np.nan
            dl = delta[i - FLOW_N + 1:i + 1]; Q = float(np.mean(dl[1:] * dl[:-1] < 0))
            out.append(dict(date=S['d'], i=int(i), t=float(end[i]), dir=d, dist=float(dist), brk=brk, fwd=float(fwd), nnodes=len(nds), nleft=len(left), L=int(L), moving=bool(moving), A=float(A), Q=Q, R=R, strides=strides, mfe=mfe, mae=mae, ext=ext))
    return out
