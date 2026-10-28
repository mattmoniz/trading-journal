"""Trade test of the 500-volume tell (PREREG_TRADE.md frozen). EXPLORE only. Pure simulation."""
import numpy as np
import vbars as V

TICK = SLIP = 0.25; DPP = 2.0; COMM = 2.0
QCUT, RCUT = 0.4444444444444444, 4.0            # frozen medians from the signal screen
TIMEOUT_S, FLAT_S = 7200.0, 77700.0              # 120-minute no-break time exit; flatten at the 15:55 open (seconds since 18:00)
ENTRY_FROM, ENTRY_TO = V.DEC_FIRST, V.DEC_LAST


def prep(S, atr, base):
    """Per-bar cheap components for one session; None if the session cannot be used."""
    if np.isnan(atr): return None
    end, start, c, h, l = S['end'], S['start'], S['c'], S['h'], S['l']; n = len(end)
    on = end < V.RTH_OPEN
    if on.sum() < 30: return None
    ib = (end >= V.RTH_OPEN) & (end < V.RTH_OPEN + 3600)
    ctx = dict(S=S, n=n, atr=atr, onh=float(h[on].max()), onl=float(l[on].min()), ibh=float(h[ib].max()) if ib.any() else None, ibl=float(l[ib].min()) if ib.any() else None)
    dur = end - start; delta = S['ask'] - S['bid']
    A = np.full(n, np.nan); Q = np.full(n, np.nan); R = np.full(n, np.nan)
    for i in range(V.FLOW_N, n):
        cd = dur[i - V.FLOW_N + 1:i + 1].mean(); bh = base.get(V.clock_hour(end[i]), np.nan)
        if cd > 0: A[i] = bh / cd
        dl = delta[i - V.FLOW_N + 1:i + 1]; Q[i] = np.mean(dl[1:] * dl[:-1] < 0)
        ch = np.diff(c[i - V.FLOW_N:i + 1]); nz = ch[ch != 0]; R[i] = np.sum(nz[1:] * nz[:-1] < 0) if len(nz) > 1 else 0
    ctx.update(fast=A >= 1, flip=Q >= QCUT, osc=R >= RCUT, A=A)
    for d in (1, -1):
        s1 = np.full(n, np.nan); s0 = np.full(n, np.nan)
        for i in range(40, n): s1[i] = d * (c[i] - c[i - 20]); s0[i] = d * (c[i - 20] - c[i - 40])
        ctx[f'strides{d}'] = (s1 > 0) & (s1 > s0)
        mv = np.zeros(n, bool)
        for i in range(V.MOVE_N, n): mv[i] = d * (c[i] - c[i - V.MOVE_N]) > 0
        ctx[f'moving{d}'] = mv
    lo_bin, hi_bin = int(S['vp'].min()), int(S['vp'].max()); ctx.update(lo_bin=lo_bin, hi_bin=hi_bin, ptr=np.searchsorted(S['vi'], np.arange(n), side='right'))
    return ctx


def boundary(ctx, i, d):
    ibdone = ctx['S']['end'][i] >= V.RTH_OPEN + 3600
    if d == 1: return max(ctx['onh'], ctx['ibh']) if (ibdone and ctx['ibh'] is not None) else ctx['onh']
    return min(ctx['onl'], ctx['ibl']) if (ibdone and ctx['ibl'] is not None) else ctx['onl']


def inside_range(ctx, i, d):
    S = ctx['S']; bd = boundary(ctx, i, d); rt = S['end'][:i + 1] >= V.RTH_OPEN
    if not rt.any(): return True
    cs = S['c'][:i + 1][rt]
    return not (np.any(cs > bd) if d == 1 else np.any(cs < bd))


class Prof:
    """Incremental day profile for one session."""
    def __init__(self, ctx):
        self.ctx = ctx; self.P = np.zeros(ctx['hi_bin'] - ctx['lo_bin'] + 1); self.k = 0
    def upto(self, i):
        S = self.ctx['S']; p = self.ctx['ptr'][i]
        if p > self.k: np.add.at(self.P, S['vp'][self.k:p] - self.ctx['lo_bin'], S['vv'][self.k:p]); self.k = p
        return self.P


def left_nodes(ctx, P, i, d):
    S = ctx['S']; cur = S['c'][i]; nds = V.nodes_of(P, ctx['lo_bin']); out = []
    for a, b in nds:
        if (d == 1 and (b + 1) * TICK < cur) or (d == -1 and a * TICK > cur): out.append((a, b))
    return out


def ncomp_at(ctx, prof, i, d, need_nodes=True):
    """Number of tell components met at completed bar i (direction d) and whether TELL5."""
    c4 = int(ctx['fast'][i]) + int(ctx['flip'][i]) + int(ctx['osc'][i]) + int(ctx[f'strides{d}'][i])
    if not need_nodes and c4 < 4: return c4, False
    P = prof.upto(i); left = left_nodes(ctx, P, i, d)
    if len(left) < 2: return c4, False
    S = ctx['S']; lt = [(a, b, V.node_time(S, (a, b), i)) for a, b in left]; L = V.ladder_len(lt, d)
    n = c4 + int(L >= 2); return n, n == 5


def lvn_behind(P, lo_bin, nodes_sorted, k, d):
    """Bin of the lowest-volume occupied bin behind node k (0-based, nearest-first). Returns (bin, used_fallback)."""
    a, b = nodes_sorted[k]; occ = np.where(P > 0)[0] + lo_bin
    far, near = (a, b) if d == 1 else (b, a)                  # far edge = the edge away from price
    if k + 1 < len(nodes_sorted):
        a2, b2 = nodes_sorted[k + 1]; lo, hi = (b2 + 1, a - 1) if d == 1 else (b + 1, a2 - 1); fb = False
    else:
        ext = occ.min() if d == 1 else occ.max(); lo, hi = (ext + 1, a - 1) if d == 1 else (b + 1, ext - 1); fb = True
    if hi < lo: return (a - 1 if d == 1 else b + 1), True
    cand = np.arange(lo, hi + 1); cand = cand[np.isin(cand, occ)]
    if len(cand) == 0: return (a - 1 if d == 1 else b + 1), True
    v = P[cand - lo_bin]; m = v.min(); idx = cand[v == m]
    return int(idx.max() if d == 1 else idx.min()), fb          # first minimum nearest the node


def stop_price(ctx, P, i, d, which):
    """which = 2 (user's rule, behind n2) or 1 (behind n1). Returns (price, fallback_used) or None."""
    left = left_nodes(ctx, P, i, d)
    if len(left) < 2: return None
    ns = sorted(left, key=lambda x: -x[1] if d == 1 else x[0])      # nearest to price first
    kbin, fb = lvn_behind(P, ctx['lo_bin'], ns, which - 1, d)
    return (kbin * TICK - TICK if d == 1 else kbin * TICK + TICK), fb


def run_position(ctx, prof, ei, d, stop, variant, entry_time):
    """Manage one position from entry bar ei. variant V1/V2 = tell-fade exit after the break, V3 = hold to EOD after the break. Returns trade dict."""
    S = ctx['S']; o, h, l, c, end, start = S['o'], S['h'], S['l'], S['c'], S['end'], S['start']; n = ctx['n']
    entry = o[ei] + d * SLIP; broke = False; pend = None; mfe = 0.0
    for j in range(ei, n):
        px = why = None
        if pend is not None: px, why = o[j] - d * SLIP, pend; pend = None
        elif start[j] >= FLAT_S: px, why = o[j] - d * SLIP, 'EOD'
        elif j > ei and d * (o[j] - stop) <= 0: px, why = o[j] - d * SLIP, 'STOP_GAP'
        elif (d == 1 and l[j] <= stop) or (d == -1 and h[j] >= stop): px, why = stop - d * SLIP, 'STOP'
        if px is not None: return _trade(ctx, ei, j, d, entry, px, why, stop, broke, mfe)
        mfe = max(mfe, d * ((h[j] if d == 1 else l[j]) - entry))
        bd = boundary(ctx, j, d)
        if not broke and ((c[j] > bd) if d == 1 else (c[j] < bd)): broke = True
        if not broke and end[j] - entry_time >= TIMEOUT_S: pend = 'TIMEOUT'
        elif broke and variant != 'V3':
            nc, _ = ncomp_at(ctx, prof, j, d, need_nodes=True)
            if nc <= 2: pend = 'FADE'
    j = n - 1; return _trade(ctx, ei, j, d, entry, c[j], 'EOS', stop, broke, mfe)


def _trade(ctx, ei, xj, d, entry, px, why, stop, broke, mfe):
    pts = (px - entry) * d
    return dict(date=ctx['S']['d'], ei=int(ei), xj=int(xj), dir=d, entry=float(entry), stop=float(stop), risk=float(abs(entry - stop)), reason=why, broke=bool(broke), pts=float(pts), net=float(pts * DPP - COMM), mfe=float(mfe))


def simulate(ctx, variant='V1', rep=None):
    S = ctx['S']; n = ctx['n']; end = S['end']; trades = []; prof = Prof(ctx); armed = {1: True, -1: True}; i = V.MOVE_N
    while i < n - 1:
        if not (ENTRY_FROM <= end[i] <= ENTRY_TO) or not S['comp'][i]: 
            prof.upto(i) if False else None
            i += 1; continue
        cand = []
        for d in (1, -1):
            if not inside_range(ctx, i, d): continue
            nc, t5 = ncomp_at(ctx, prof, i, d, need_nodes=False)
            if not t5: armed[d] = True; continue
            if armed[d]: cand.append(d)
            if rep is not None: rep['fires'] += 1
        if len(cand) != 1: i += 1; continue
        d = cand[0]; P = prof.upto(i); sp = stop_price(ctx, P, i, d, 1 if variant == 'V2' else 2)
        if sp is None or d * (S['o'][i + 1] + d * SLIP - sp[0]) <= 0:
            if rep is not None: rep['skip'] += 1
            i += 1; continue
        if rep is not None: rep['trades'] += 1; rep['fallback'] += int(sp[1])
        tr = run_position(ctx, prof, i + 1, d, sp[0], variant, end[i]); tr['sig'] = int(i); tr['fb'] = bool(sp[1]); trades.append(tr); armed[d] = False; i = tr['xj'] + 1
    return trades


def stripped_full(ctx, ei, d, stop_dist):
    """Placebo geometry: market entry next open (+1 tick), the given stop distance, a 120-minute time exit, flatten at the 15:55 open. Returns (net dollars, exit bar)."""
    S = ctx['S']; o, h, l, end, start = S['o'], S['h'], S['l'], S['end'], S['start']; n = ctx['n']; entry = o[ei] + d * SLIP; stop = entry - d * stop_dist; t0 = end[ei - 1]; pend = False
    net = lambda px: ((px - entry) * d) * DPP - COMM
    for j in range(ei, n):
        if pend or start[j] >= FLAT_S: return net(o[j] - d * SLIP), j
        if j > ei and d * (o[j] - stop) <= 0: return net(o[j] - d * SLIP), j
        if (d == 1 and l[j] <= stop) or (d == -1 and h[j] >= stop): return net(stop - d * SLIP), j
        if end[j] - t0 >= TIMEOUT_S: pend = True
    return net(S['c'][n - 1]), n - 1


def stripped(ctx, ei, d, stop_dist): return stripped_full(ctx, ei, d, stop_dist)[0]


def simulate_control(ctx, stop_dists, rng):
    """Moving-only control: price moving in d over 10 bars, TELL5 false, inside the range; random stop distance from the tell trades; stripped geometry; one position at a time; re-arm after a bar where moving is false."""
    S = ctx['S']; n = ctx['n']; end = S['end']; trades = []; prof = Prof(ctx); armed = {1: True, -1: True}; i = V.MOVE_N
    while i < n - 1:
        if not (ENTRY_FROM <= end[i] <= ENTRY_TO) or not S['comp'][i]: i += 1; continue
        cand = []
        for d in (1, -1):
            if not ctx[f'moving{d}'][i]: armed[d] = True; continue
            if not armed[d] or not inside_range(ctx, i, d): continue
            nc, t5 = ncomp_at(ctx, prof, i, d, need_nodes=False)
            if t5: continue
            cand.append(d)
        if len(cand) != 1: i += 1; continue
        d = cand[0]; sd = float(rng.choice(stop_dists)); net, xj = stripped_full(ctx, i + 1, d, sd)
        trades.append(dict(date=S['d'], dir=d, net=net, pts=(net + COMM) / DPP, ei=i + 1, xj=xj)); armed[d] = False; i = xj + 1
    return trades
