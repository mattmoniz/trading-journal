"""Path study at the absorption and spike marks (PREREG.md frozen 2026-10-29). EXPLORE only. Usage: ../../venv/bin/python run_path.py"""
import sys, csv, numpy as np
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_80rule'); import engine as E
SLIP = TICK = 0.25; DPP = 2.0; COMM = 2.0; FLAT = 385; E_LO, E_HI = 5, 345; TRIALS = 50; SEED = 20261029; BOOT = 3000; SPLIT = '2025-05-16'; PRE_END = '2025-01-01'

def sim(a, e, d, stop):
    """P1 hold from entry bar e: returns dict(pts, mae, mfe, hit, xi) or None when the entry is already beyond the stop. Gap through the stop fills at the open (adverse slip); an intrabar touch fills at stop minus slip."""
    o, h, l = a['o'], a['h'], a['l']
    if np.isnan(o[e]): return None
    entry = o[e] + d * SLIP
    if d * (entry - stop) <= 0: return None
    lo, hi = e, FLAT
    touched = (l[lo:hi] <= stop) if d == 1 else (h[lo:hi] >= stop)
    idx = np.flatnonzero(touched)
    if len(idx):
        i = lo + int(idx[0]); gap = i > e and d * (o[i] - stop) <= 0
        px = (o[i] - d * SLIP) if gap else (stop - d * SLIP); hit = True; xi = i
    else:
        px = o[FLAT] - d * SLIP if not np.isnan(o[FLAT]) else np.nan; hit = False; xi = FLAT
    if np.isnan(px): return None
    seg_h = h[e:xi + 1]; seg_l = l[e:xi + 1]
    mae = (entry - np.nanmin(seg_l)) if d == 1 else (np.nanmax(seg_h) - entry); mfe = (np.nanmax(seg_h) - entry) if d == 1 else (entry - np.nanmin(seg_l))
    return dict(pts=(px - entry) * d, mae=float(mae), mfe=float(mfe), hit=hit, xi=xi, entry=entry)

def selftest():
    n = 390; a = dict(o=np.full(n, 100.0), h=np.full(n, 100.5), l=np.full(n, 99.5), c=np.full(n, 100.0))
    r = sim(a, 50, 1, 95.0); assert r and not r['hit'] and abs(r['pts'] - (-0.5)) < 1e-9, r          # flat market: exit at the flatten, two slips = -0.5
    a['l'][60] = 94.0; r = sim(a, 50, 1, 95.0); assert r['hit'] and abs(r['pts'] - ((95.0 - 0.25) - 100.25)) < 1e-9, r   # intrabar touch fills at stop - slip
    a['o'][60] = 93.0; r = sim(a, 50, 1, 95.0); assert r['hit'] and abs(r['pts'] - ((93.0 - 0.25) - 100.25)) < 1e-9, r   # gap fills at the open, not the stop
    assert sim(a, 50, 1, 100.5) is None                                                               # entry beyond the stop: excluded
    b = dict(o=np.full(n, 100.0), h=np.full(n, 100.5), l=np.full(n, 99.5), c=np.full(n, 100.0)); b['h'][70] = 106.0; r = sim(b, 50, -1, 105.0); assert r['hit'] and abs(r['pts'] - (99.75 - (105.0 + 0.25))) < 1e-9, r
selftest()

def load_events():
    ev = []
    for r in csv.DictReader(open('/home/mmoniz/trading-journal/scripts/amt_exhaust/spikes_explore.csv')):
        D = int(r['dir']); ev.append(dict(kind='spike', d=r['date'], D=D, t=int(r['t']), u=int(r['u']), strong=int(r['strong']), stop=float(r['ext']) - D * TICK))
    for r in csv.DictReader(open('/home/mmoniz/trading-journal/scripts/amt_absorb/events_explore.csv')):
        D = int(r['dir']); ev.append(dict(kind='abs', d=r['date'], D=D, t=int(r['t']), u=int(r['u']), t0=int(r['t0']), strong=int(r['strong']), stop=(float(r['wlo']) if D == 1 else float(r['whi'])) - D * TICK))
    return ev

def boot(vals, days, rng, it=BOOT):
    g = {}
    for v, d in zip(vals, days):
        if not np.isnan(v): g.setdefault(d, []).append(v)
    arrs = [np.array(x) for x in g.values()]; m = len(arrs)
    if m == 0: return float('nan'), float('nan'), float('nan')
    means = np.array([np.concatenate([arrs[j] for j in rng.integers(0, m, m)]).mean() for _ in range(it)]); allv = np.concatenate(arrs)
    return float(allv.mean()), float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))

def main():
    raw = E.load_sessions(); allS = E.build_eligible(raw); ex = [s for s in allS if s['d'] <= SPLIT]; rngs = [float(np.nanmax(s['a']['h']) - np.nanmin(s['a']['l'])) for s in ex]
    S = {s['d']: (s, i) for i, s in enumerate(ex)}; rng = np.random.default_rng(SEED); evs = load_events(); excl = 0; rows = []
    absby = {}
    for e in evs:
        if e['kind'] == 'abs': absby.setdefault(e['d'], []).append(e)
    for e in evs:
        s, si = S.get(e['d'], (None, None))
        if s is None or si < 20: continue
        a = s['a']; atr = float(np.mean(rngs[si - 20:si])); en = e['u'] + 1
        if not (E_LO <= en <= E_HI): continue
        r = sim(a, en, e['D'], e['stop'])
        if r is None: excl += 1; continue
        risk = e['D'] * (r['entry'] - e['stop']); plc = []
        for _ in range(TRIALS):
            e2 = int(rng.integers(E_LO, E_HI + 1)); en2 = a['o'][e2] + e['D'] * SLIP
            if np.isnan(en2): continue
            r2 = sim(a, e2, e['D'], en2 - e['D'] * risk)
            if r2 is not None: plc.append(r2['pts'] * DPP - COMM)
        if len(plc) < 10: excl += 1; continue
        plcB = []; lo_b, hi_b = max(E_LO, en - 30), min(E_HI, en + 30)                       # Amendment 1: time-matched placebo (same session, +/- 30 bars)
        for _ in range(TRIALS):
            e2 = int(rng.integers(lo_b, hi_b + 1))
            if e2 == en: continue
            en2 = a['o'][e2] + e['D'] * SLIP
            if np.isnan(en2): continue
            r2 = sim(a, e2, e['D'], en2 - e['D'] * risk)
            if r2 is not None: plcB.append(r2['pts'] * DPP - COMM)
        Df = -e['D']; enC = a['o'][en] + Df * SLIP; rC = sim(a, en, Df, enC - Df * risk) if not np.isnan(enC) else None   # Amendment 1: direction flip at the same bar, same risk
        if len(plcB) < 10 or rC is None: excl += 1; continue
        net = r['pts'] * DPP - COMM; c = a['c']; f = {}
        for hh in (30, 60, 120): j = en + hh - 1; f[f'F{hh}'] = e['D'] * (c[j] - r['entry']) / atr if j < FLAT and not np.isnan(c[j]) else np.nan
        netC = rC['pts'] * DPP - COMM; row = dict(e, net=net, pts=r['pts'], plc=float(np.mean(plc)), diff=net - float(np.mean(plc)), plcB=float(np.mean(plcB)), diffB=net - float(np.mean(plcB)), netC=netC, diffC=net - netC, hit=r['hit'], mae=r['mae'] / atr, mfe=r['mfe'] / atr, risk=risk, **f, era='PRE' if e['d'] < PRE_END else 'POST')
        if e['kind'] == 'spike':
            h_, l_, o0 = a['h'], a['l'], a['o'][0]; t = e['t']; ext = (e['stop'] + e['D'] * TICK)
            row['new_ext'] = bool(ext > np.nanmax(h_[:t])) if e['D'] == -1 and t > 0 else bool(ext < np.nanmin(l_[:t])) if e['D'] == 1 and t > 0 else False
            row['against'] = bool(c[t] < o0) if e['D'] == -1 else bool(c[t] > o0)
            row['inside_abs'] = any(x['D'] == e['D'] and x['t0'] <= t <= x['u'] for x in absby.get(e['d'], []))
        rows.append(row)
    print(f'events with a valid P1 entry {len(rows)} (excluded: entry beyond the structural stop or no data {excl})')
    with open('path_events.csv', 'w', newline='') as fh:
        keys = ['kind', 'd', 'D', 't', 'u', 'strong', 'era', 'net', 'plc', 'diff', 'hit', 'risk', 'mae', 'mfe']; w = csv.writer(fh); w.writerow(keys)
        for r in rows: w.writerow([r.get(k) for k in keys])
    def cell(name, R):
        if len(R) == 0: print(f'{name}: n=0'); return
        days = [r['d'] for r in R]; nd = len(set(days)); out = {}
        for k in ('diff', 'diffB', 'diffC'): out[k] = boot([r[k] for r in R], days, rng)
        pre = [r['diff'] for r in R if r['era'] == 'PRE']; post = [r['diff'] for r in R if r['era'] == 'POST']
        byday = {}
        for r in R: byday.setdefault(r['d'], []).append(r['diff'])
        dv = sorted((sum(v) for v in byday.values()), reverse=True); tot = sum(dv); share = sum(dv[:5]) / tot if tot > 0 else float('nan'); dw = float(np.mean([np.mean(v) for v in byday.values()]))
        ok = len(R) >= 100 and nd >= 50 and out['diff'][1] > 0 and out['diffB'][1] > 0 and out['diffC'][1] > 0 and (np.mean(pre) > 0 and np.mean(post) > 0 if pre and post else False) and tot > 0 and share < 0.5
        f = lambda t: f"{t[0]:6.2f} [{t[1]:6.2f},{t[2]:6.2f}]"
        print(f"{name:42s} n={len(R):4d} days={nd:3d} stop-hit {100 * np.mean([r['hit'] for r in R]):3.0f}% risk {np.median([r['risk'] for r in R]):5.1f}pt | net {np.mean([r['net'] for r in R]):6.2f}$ | placeboA {np.mean([r['plc'] for r in R]):6.2f} B(time-matched) {np.mean([r['plcB'] for r in R]):6.2f} flip {np.mean([r['netC'] for r in R]):6.2f}" + ('  <== PASSES' if ok else ''))
        print(f"{'':42s} real-A {f(out['diff'])} | real-B {f(out['diffB'])} | real-flip {f(out['diffC'])} | PRE {np.mean(pre) if pre else float('nan'):6.2f} POST {np.mean(post) if post else float('nan'):6.2f} top5 {100 * share:4.0f}% day-weighted(A) {dw:6.2f}")
    print('\n=== P1 hold (structural stop, no target, flatten 15:55) vs random-entry placebo with the same stop distance; dollars per 1 MNQ trade, after costs ===')
    for kind, nm in (('spike', 'SPIKE'), ('abs', 'ABSORPTION')):
        for st_, snm in ((1, 'strong'), (0, 'weak')): cell(f'{nm} {snm}', [r for r in rows if r['kind'] == kind and r['strong'] == st_])
    for kind, nm in (('spike', 'SPIKE all'), ('abs', 'ABSORPTION all')): cell(nm, [r for r in rows if r['kind'] == kind])
    for D, nm in ((1, 'long (spike low / absorbed selling)'), (-1, 'short (spike high / absorbed buying)')):
        cell(f'  by side, SPIKE {nm}', [r for r in rows if r['kind'] == 'spike' and r['D'] == D]); cell(f'  by side, ABSORPTION {nm}', [r for r in rows if r['kind'] == 'abs' and r['D'] == D])
    print('\n=== INTERACTION TAGS on spike marks (descriptive) ===')
    SP = [r for r in rows if r['kind'] == 'spike']
    for tag, nm in (('inside_abs', 'INSIDE a same-direction absorption mark'), ('new_ext', 'NEW session extreme'), ('against', 'AGAINST the day drift')):
        cell(f'SPIKE with {nm}', [r for r in SP if r[tag]]); cell(f'SPIKE without {nm}', [r for r in SP if not r[tag]])
    cell('SPIKE inside absorption AND against drift', [r for r in SP if r['inside_abs'] and r['against']]); cell('SPIKE new extreme AND against drift', [r for r in SP if r['new_ext'] and r['against']])
if __name__ == '__main__': main()
