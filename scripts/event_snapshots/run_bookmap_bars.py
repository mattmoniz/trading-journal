"""Stage A of docs/BOOKMAP_STYLE_DETECTORS_PREREG_20261102.md: bar-level Bookmap-style detectors on all explore sessions, RTH and Globex. READS OUTCOMES -> look logged first (log_look_bookmap_bars.mjs).
Usage: /home/mmoniz/trading-journal/venv/bin/python /home/mmoniz/trading-journal/scripts/event_snapshots/run_bookmap_bars.py"""
import sys
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_context'); sys.argv = sys.argv[:1]
import numpy as np
import tell_state as TS, vbars as V
SEED, BOOT, DRAWS, COOL, COST = 20261102, 3000, 1000, 10, 1.25
HZ = (5, 15, 30); SEGS = {'RTH': (57600.0, 77400.0), 'GLOBEX': (1800.0, 55800.0)}; DETS = ('D1_ABSORB', 'D2_DIVERGE', 'D3_BUBBLE', 'D4_LARGELOT', 'D5_STOPRUN'); SGN = {'D1_ABSORB': -1, 'D2_DIVERGE': -1, 'D3_BUBBLE': 1, 'D4_LARGELOT': 1, 'D5_STOPRUN': -1}

def roll(a, k, f=np.add):
    """trailing window reduction over the last k values (NaN where fewer than k)."""
    n = len(a); out = np.full(n, np.nan)
    if n < k: return out
    if f is np.add: cs = np.cumsum(np.r_[0.0, a]); out[k - 1:] = cs[k:] - cs[:-k]
    else:
        from numpy.lib.stride_tricks import sliding_window_view as sw; w = sw(a, k); out[k - 1:] = (w.max(1) if f is np.maximum else w.min(1))
    return out

def session_feats(S, ntr):
    o, h, l, c, vol, bid, ask = (S[k] for k in ('o', 'h', 'l', 'c', 'vol', 'bid', 'ask')); n = len(c); F = {}
    F['ad3'] = roll(ask - bid, 3) / roll(vol, 3); F['ad10'] = roll(ask - bid, 10) / roll(vol, 10); F['bds'] = (ask - bid) / vol
    F['prog3'] = np.r_[[np.nan] * 3, c[3:] - c[:-3]]; F['lot3'] = roll(vol, 3) / roll(ntr, 3)
    F['hi20'] = h >= roll(h, 20, np.maximum); F['lo20'] = l <= roll(l, 20, np.minimum)
    ph = np.r_[[np.nan], roll(h, 60, np.maximum)[:-1]]; pl = np.r_[[np.nan], roll(l, 60, np.minimum)[:-1]]; F['ph60'] = ph; F['pl60'] = pl; return F

def thresholds(prior):
    P = {k: np.concatenate([f[k] for f in prior]) for k in ('ad3', 'ad10', 'bds', 'prog3', 'lot3')}; P = {k: v[np.isfinite(v)] for k, v in P.items()}
    return dict(ad3_q80=np.quantile(np.abs(P['ad3']), .8), prog_q20=np.quantile(np.abs(P['prog3']), .2), ad10_q20=np.quantile(P['ad10'], .2), ad10_q80=np.quantile(P['ad10'], .8), bds_q90=np.quantile(np.abs(P['bds']), .9), bds_q75=np.quantile(np.abs(P['bds']), .75), lot_q95=np.quantile(P['lot3'], .95))

def detect(S, F, th):
    """per detector: (control mask, p_ctl array, event candidate mask) over all bars; events subsets of the control population with the same p."""
    h, l, c = S['h'], S['l'], S['c']; n = len(c); idx = np.arange(n); ok = (idx >= 60) & S['comp']; out = {}
    p1 = np.sign(F['ad3']); ctl = ok & (p1 != 0) & np.isfinite(F['ad3']); ev = ctl & (np.abs(F['ad3']) >= th['ad3_q80']) & (np.abs(F['prog3']) <= th['prog_q20']) & (((p1 > 0) & F['hi20']) | ((p1 < 0) & F['lo20'])); out['D1_ABSORB'] = (ctl, p1, ev)
    pe = np.where(F['hi20'], 1.0, np.where(F['lo20'], -1.0, 0.0)); ctl = ok & (pe != 0) & np.isfinite(F['ad10']); ev = ctl & (((pe > 0) & (F['ad10'] <= th['ad10_q20'])) | ((pe < 0) & (F['ad10'] >= th['ad10_q80']))); out['D2_DIVERGE'] = (ctl, pe, ev)
    p3 = np.sign(F['bds']); ctl = ok & (p3 != 0); ev = ctl & (np.abs(F['bds']) >= th['bds_q90']); out['D3_BUBBLE'] = (ctl, p3, ev)
    ev = (ok & (p1 != 0) & np.isfinite(F['lot3']) & (F['lot3'] >= th['lot_q95'])); out['D4_LARGELOT'] = (ctl_ := ok & (p1 != 0) & np.isfinite(F['lot3']), p1, ev)
    up = ok & np.isfinite(F['ph60']) & (h > F['ph60']) & (c < F['ph60']); dn = ok & np.isfinite(F['pl60']) & (l < F['pl60']) & (c > F['pl60']); p5 = np.where(up, 1.0, np.where(dn, -1.0, 0.0)); ctl = ok & (p5 != 0)
    ev = ctl & (F['bds'] * p5 >= th['bds_q75']); out['D5_STOPRUN'] = (ctl, p5, ev); return out

def cooldown(ev):
    out = np.zeros_like(ev); last = -10 ** 9
    for i in np.where(ev)[0]:
        if i - last >= COOL: out[i] = True; last = i
    return out

def moves(S, H):
    end, c, comp = S['end'], S['c'], S['comp']; j = np.searchsorted(end, end + H * 60.0, side='right') - 1; full = end[-1] >= end + H * 60.0 - 60.0; mv = np.where((j > np.arange(len(c))) & full & comp[np.minimum(j, len(c) - 1)], c[np.minimum(j, len(c) - 1)] - c, np.nan); return mv

def bh(ps, q=0.10):
    order = sorted(range(len(ps)), key=lambda i: ps[i]); keep = -1
    for rk, ix in enumerate(order): keep = rk if ps[ix] <= (rk + 1) / len(ps) * q else keep
    return {ix: rk <= keep for rk, ix in enumerate(order)}

def main():
    rng = np.random.default_rng(SEED + 61); sess, ctxs, _ = TS.sessions_and_contexts(); dates = sorted(sess); feats = {}; ntrs = {}
    for d in dates:
        a = np.loadtxt(f'{V.ROOT}/{d}.bars.tsv', delimiter='\t', ndmin=2); ntrs[d] = a[:, 10]; feats[d] = session_feats(sess[d], ntrs[d])
    cell = {(dt, sg, h): dict(ev=[], ct=[], y=[], isev=[], sid=[]) for dt in DETS for sg in SEGS for h in HZ}; nsess = 0; ev_counts = {dt: 0 for dt in DETS}
    for k, d in enumerate(dates):
        if k < 20: continue
        S = sess[d]; th = thresholds([feats[x] for x in dates[k - 20:k]]); det = detect(S, feats[d], th); end = S['end']; nsess += 1
        for dt in DETS:
            ctl, p, ev = det[dt]; ev = cooldown(ev); ev_counts[dt] += int(ev.sum())
            for sg, (a, b) in SEGS.items():
                seg = (end >= a) & (end <= b)
                for h in HZ:
                    mv = moves(S, h); m = ctl & seg & np.isfinite(mv); e = ev & seg & np.isfinite(mv); y = SGN[dt] * p * mv; c = cell[(dt, sg, h)]
                    c['ev'].append((int(e.sum()), float(y[e].sum()))); c['ct'].append((int(m.sum()), float(y[m].sum()))); c['y'].append(y[m]); c['isev'].append(e[m]); c['sid'].append(np.full(int(m.sum()), k))
    print(f'sessions evaluated {nsess} (first 20 only seed the thresholds); events per detector (before segment and window filters): {ev_counts}')
    keys = list(cell); res = {}; half = nsess // 2
    for key in keys:
        c = cell[key]; ev = np.array(c['ev']); ct = np.array(c['ct']); ne, se, nc, sc = ev[:, 0], ev[:, 1], ct[:, 0], ct[:, 1]
        if ne.sum() < 100 or (ne > 0).sum() < 60: res[key] = None; continue
        ex = se.sum() / ne.sum() - sc.sum() / nc.sum(); bs = []
        for _ in range(BOOT):
            w = np.bincount(rng.integers(0, nsess, nsess), minlength=nsess).astype(float); bs.append((w @ se) / (w @ ne) - (w @ sc) / (w @ nc) if (w @ ne) > 0 else np.nan)
        lo, hi = np.nanpercentile(bs, [2.5, 97.5]); y = np.concatenate(c['y']); isev = np.concatenate(c['isev']); mean_all = y.mean(); plc = []
        for s in rng.integers(1, len(y), DRAWS): r = np.roll(isev, s); plc.append(y[r].mean() - mean_all)
        p = float((np.sum(np.abs(plc) >= abs(ex)) + 1) / (DRAWS + 1)); hv = lambda a, b: (se[a:b].sum() / max(1, ne[a:b].sum())) - (sc[a:b].sum() / max(1, nc[a:b].sum())); res[key] = dict(ex=ex, lo=float(lo), hi=float(hi), p=p, h1=hv(0, half), h2=hv(half, nsess), n=int(ne.sum()), days=int((ne > 0).sum()), ev_mean=float(se.sum() / ne.sum()), hw=(hi - lo) / 2)
    live = [k for k in keys if res[k] is not None]; sv = bh([res[k]['p'] for k in live]); bhm = {k: sv[i] for i, k in enumerate(live)}
    print('\nRESOLUTION (CI half-width in points): ' + ', '.join(f'{k[0][:2]}-{k[1][:2]}-{k[2]}m {res[k]["hw"]:.2f}' for k in live[:6]) + ' ...')
    print('\ndetector | segment | H | events | sessions | event mean pts | excess vs same-direction bars (CI) | placebo p | halves | BH | tradable (|excess| > 1.25)')
    cands = []
    for k in keys:
        r = res[k]
        if r is None: print(f'{k[0]:12s} | {k[1]:6s} | {k[2]:2d}m | UNDERPOWERED'); continue
        ok = bhm[k] and (r['lo'] > 0 or r['hi'] < 0) and np.sign(r['h1']) == np.sign(r['h2']) == np.sign(r['ex'])
        if ok: cands.append((k, r['ex'], abs(r['ex']) > COST))
        print(f'{k[0]:12s} | {k[1]:6s} | {k[2]:2d}m | {r["n"]:6d} | {r["days"]:4d} | {r["ev_mean"]:+6.2f} | {r["ex"]:+6.2f} [{r["lo"]:+6.2f}, {r["hi"]:+6.2f}] | {r["p"]:.3f} | {r["h1"]:+5.2f} / {r["h2"]:+5.2f} | {"survives" if bhm[k] else "no"} | {"YES" if abs(r["ex"]) > COST and ok else "no"}{"  <== CANDIDATE" if ok else ""}')
    print(f'\nCANDIDATES: {[(c[0], round(c[1], 2), c[2]) for c in cands]}')

if __name__ == '__main__': main()
