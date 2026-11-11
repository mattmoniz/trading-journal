"""Row 40 (prereg docs/GLOBEX_WINDOWS_PREREG_20261110.md): Globex clock windows ASIA / LONDON / PRE with HOLD and HOOK exits, 500V and 100V bars. Stages: test | build | null | run."""
import os, sys, csv, glob, json, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import globex_roc3_test as G
import globex_barsize_test as B
from globex_m4_fade import prep
Fm, v2, SH = G.Fm, G.v2, G.SH
OUT = os.path.join(G.ROOT, 'scratch', 'globex_windows_20261110'); os.makedirs(OUT, exist_ok=True)
WIN = {'ASIA': (5400.0, 32400.0), 'LONDON': (32400.0, 39600.0), 'PRE': (48600.0, 54000.0)}; LOOK, HOLD = 20, 30
CELLS = [(s, w, x) for s in (500, 100) for w, x in (('LONDON', 'HOLD'), ('LONDON', 'HOOK'), ('PRE', 'HOLD'), ('PRE', 'HOOK'), ('ASIA', 'HOLD'))]; assert len(CELLS) == 10

def sim_hook(dr, a, z, o, c, h, l, flat, stop=None):
    """Entry Open[a+1] (direction dr = sign of the spike). Exit at Open[t+1] after the first bar t >= a+1 with dr*Z[t] <= 0, else Close of bar a+HOLD, never past the flat bar. Returns (gross change, exit_idx, reason) or None."""
    ei = a + 1
    if ei > flat or ei >= len(c): return None
    entry = float(o[ei]); last = min(a + HOLD, flat)
    for t in range(ei, last + 1):
        if stop is not None and ((dr == 1 and l[t] <= stop) or (dr == -1 and h[t] >= stop)):       # V0 stop (as shadow.calc_outcome): fills at the stop, or the open if gapped, plus one tick of slippage
            px = (stop if t == ei else (min(stop, float(o[t])) if dr == 1 else max(stop, float(o[t])))) - dr * 0.25; return dr * (px - entry), t, 'stop'
        if not np.isnan(z[t]) and dr * z[t] <= 0:
            if t + 1 <= flat and t + 1 < len(o): return dr * (float(o[t + 1]) - entry), t + 1, 'hook'
            return dr * (float(c[t]) - entry), t, 'hook-close'
    return dr * (float(c[last]) - entry), last, 'time'

def unit_tests():
    ok = True
    def chk(name, got, want):
        nonlocal ok; good = got is not None and got[2] == want[2] and got[1] == want[1] and abs(got[0] - want[0]) < 1e-9; ok &= good; print(('PASS ' if good else 'FAIL ') + name, '' if good else f'got {got} want {want}')
    n = 60; o = np.full(n, 100.0); c = np.full(n, 100.0); h = c + 0.5; l = c - 0.5; z = np.full(n, 3.0)
    z2 = z.copy(); z2[8] = -0.2; o2 = o.copy(); o2[9] = 105.0
    chk('1 long: hook at bar 8 -> exit at Open[9] = 105, gross +5', sim_hook(1, 5, z2, o2, c, h, l, 59), (5.0, 9, 'hook'))
    z3 = z.copy(); z3[7] = 0.0; chk('2 hook exactly at Z == 0 counts', sim_hook(1, 5, z3, o, c, h, l, 59), (0.0, 8, 'hook'))
    c4 = c.copy(); c4[35] = 103.0; chk('3 no hook: time exit at Close[a+30] = Close[35] = 103 -> +3', sim_hook(1, 5, z, o, c4, h, l, 59), (3.0, 35, 'time'))
    chk('4 flat clamps the hold: flat = 20', sim_hook(1, 5, z, o, c, h, l, 20), (0.0, 20, 'time'))
    z5 = z.copy(); z5[20] = -1.0; chk('5 hook on the flat bar exits at Close (no next bar before the flat)', sim_hook(1, 5, z5, o, c, h, l, 20), (0.0, 20, 'hook-close'))
    zs = np.full(n, -3.0); zs2 = zs.copy(); zs2[7] = 0.5; o6 = o.copy(); o6[8] = 96.0; chk('6 short (dr -1): hook at bar 7 -> exit Open[8] = 96, gross +4', sim_hook(-1, 5, zs2, o6, c, h, l, 59), (4.0, 8, 'hook'))
    c7 = c.copy(); l7 = l.copy(); l7[7] = 94.0; chk('7 stop (long, stop 95) hit at bar 7 -> px 95 - 0.25 = 94.75, gross -5.25', sim_hook(1, 5, z, o, c7, h, l7, 59, stop=95.0), (-5.25, 7, 'stop'))
    print('ALL PASS' if ok else 'SOME FAILED'); return ok

def build():
    adr = {r['date']: float(r['adr20']) for r in csv.DictReader(open(os.path.join(G.ROOT, 'scratch', 'globex_roc3_20261110', 'events.csv'))) if r['adr20'] not in ('', 'nan')}; rows = []; nsess = {}
    for size in (500, 100):
        dates = sorted(os.path.basename(p)[:10] for p in glob.glob(B.DIR(size) + '/*.bars.tsv') if os.path.basename(p)[:10] <= Fm.LAST_EXPLORE); hist = []; prevS = None; ns = 0
        for d in dates:
            S = B.load_bars(os.path.join(B.DIR(size), d + '.bars.tsv'), size)
            if S is None: continue
            S['date'] = d
            if len(hist) >= Fm.K_PRIOR and prevS is not None:
                pr = Fm.priors_of(hist[-Fm.K_PRIOR:]); prs = {'GBX': pr, 'RTH': pr}; P, n0, reset = v2.continuous(prevS, S); Fm.L_ROC = 3
                try: F = v2.feats(P, n0, reset, prs, Fm.CLOSE)
                finally: Fm.L_ROC = 10
                ns += 1; n = len(P['c']); en, o, h, l, c = P['en'], P['o'], P['h'], P['l'], P['c']; z = F['zroc']; roc = F['roc']; zr = F['zr']; etr = Fm.ema(F['tr']); m = len(S['c'])
                vw, _, _ = prep(S['o'], S['h'], S['l'], S['c'], S['v']); idx = np.arange(n); ok = (idx >= n0) & ~np.isnan(z); dd = np.where(roc > 0, 1, np.where(roc < 0, -1, 0))
                inside = n0 + np.where(en[n0:] <= G.LIM)[0]; flat = int(inside.max()) if len(inside) else -1
                spike = ~np.isnan(z) & (np.abs(z) > Fm.Z_ROC) & (np.sign(z) == dd); on = SH.onset(spike) & np.r_[False, ~np.isnan(z[:-1])] & ok
                def state_dir(a):
                    j = a - n0
                    if j < LOOK or j >= m: return 0
                    if c[a] > h[a - LOOK:a].max() and c[a] > vw[j]: return 1
                    if c[a] < l[a - LOOK:a].min() and c[a] < vw[j]: return -1
                    return 0
                base = dict(date=d, size=size, adr20=adr.get(d, float('nan')))
                for w, (lo, hi) in WIN.items():
                    inw = (en >= lo) & (en <= hi) if w != 'ASIA' else (en >= lo) & (en < hi)
                    lock_h = -1; lock_k = -1; lock_p = -1; lock_a = -1; prev_state = False
                    for a in np.where(on & inw)[0]:
                        s = int(dd[a]); sd = state_dir(a)
                        if w == 'ASIA':
                            if a < lock_a: continue
                            oc = SH.calc_outcome(en, o, h, l, c, a, s, float(etr[a]), G.LIM, n, hold=HOLD, n0=n0)
                            if oc is None or isinstance(oc, tuple): continue
                            lock_a = a + HOLD; rows.append(dict(base, win=w, exit='HOLD', arm='EVENT', dr=s, gross=oc['fwd'], net_stop=oc['net_stop25'], zr_hi=int(not np.isnan(zr[a]) and zr[a] > 1.5), macro=0)); continue
                        if sd != s: continue
                        macro = int(52200.0 - 300 <= en[a] <= 52200.0 + 300); zrh = int(not np.isnan(zr[a]) and zr[a] > 1.5)
                        if a >= lock_h:
                            oc = SH.calc_outcome(en, o, h, l, c, a, s, float(etr[a]), G.LIM, n, hold=HOLD, n0=n0)
                            if oc is not None and not isinstance(oc, tuple): lock_h = a + HOLD; rows.append(dict(base, win=w, exit='HOLD', arm='EVENT', dr=s, gross=oc['fwd'], net_stop=oc['net_stop25'], zr_hi=zrh, macro=macro))
                        if a >= lock_k:
                            r1 = sim_hook(s, a, z, o, c, h, l, flat); r2 = sim_hook(s, a, z, o, c, h, l, flat, stop=float(o[a + 1]) - s * 2.5 * float(etr[a])) if a + 1 < n else None
                            if r1 and r2: lock_k = r1[1]; rows.append(dict(base, win=w, exit='HOOK', arm='EVENT', dr=s, gross=r1[0], net_stop=r2[0] - G.COST, zr_hi=zrh, macro=macro))
                    if w == 'ASIA': continue
                    for a in np.where(inw & ok)[0]:            # PLACEBO for the HOOK exit: the breakout + VWAP-side state without a spike, first bar of the state
                        sd = state_dir(a)
                        if sd == 0 or spike[a]: prev_state = False; continue
                        if prev_state or a < lock_p: prev_state = True; continue
                        prev_state = True; r1 = sim_hook(sd, a, z, o, c, h, l, flat)
                        if r1: lock_p = r1[1]; rows.append(dict(base, win=w, exit='HOOK', arm='PLACEBO', dr=sd, gross=r1[0], net_stop=float('nan'), zr_hi=0, macro=0))
            hist.append(S); prevS = S
        nsess[size] = ns
    with open(os.path.join(OUT, 'events.csv'), 'w', newline='') as f:
        w_ = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w_.writeheader(); w_.writerows(rows)
    print('sessions', nsess)
    for (s, w, x) in CELLS:
        e = [r for r in rows if r['size'] == s and r['win'] == w and r['exit'] == x and r['arm'] == 'EVENT']; pl = [r for r in rows if r['size'] == s and r['win'] == w and r['exit'] == x and r['arm'] == 'PLACEBO']
        print(f'  {s}V {w} {x}: events {len(e)} on {len({r["date"] for r in e})} days' + (f'; placebo {len(pl)}' if pl else ''))

def load():
    out = []
    for r in csv.DictReader(open(os.path.join(OUT, 'events.csv'))): out.append(dict(date=r['date'], size=int(r['size']), win=r['win'], exit=r['exit'], arm=r['arm'], dr=int(r['dr']), gross=float(r['gross']), net_stop=float(r['net_stop']), zr_hi=int(r['zr_hi']), macro=int(r['macro']), adr20=float(r['adr20'])))
    return out

def val(x, fade): return (-x['gross'] if fade else x['gross']) - G.COST
def cells(ev, draws, center=None, flip=None):
    res = {}
    for k, (s, w, x) in enumerate(CELLS):
        sub = [e for e in ev if e['size'] == s and e['win'] == w and e['exit'] == x and e['arm'] == 'EVENT']; fade = (w == 'ASIA'); v = [val(e, fade) for e in sub]
        if center:
            mu = float(np.mean(v)) if v else 0.0; v = [(q - mu) * (flip[e['date']] if flip else 1) for q, e in zip(v, sub)]
        res[(s, w, x)] = None if len(sub) < G.MIN_N or len({e['date'] for e in sub}) < G.MIN_DAYS else G.boot_mean(list(zip([e['date'] for e in sub], v)), 800 + k, draws)
    assert len(res) == 10
    return res

def null_gate(iters=200, alpha=0.10, seed=781):
    ev = load(); dates = sorted({e['date'] for e in ev}); rng = np.random.default_rng(seed); passes = 0
    for it in range(iters):
        flip = {d: int(rng.choice([-1, 1])) for d in dates}; keep, m = G.holm(cells(ev, 1000, center=True, flip=flip), alpha); passes += bool(keep)
    rate = passes / iters; print(f'NULL GATE (centered, day sign flips, cost 0): 10 cells, {iters} iterations, Holm {alpha}: family-wise false-pass {rate:.3f} (required <= 0.10)'); json.dump(dict(rate=rate, ok=rate <= 0.10, alpha=alpha, iters=iters), open(os.path.join(OUT, 'null_gate.json'), 'w'))

def run():
    ng = json.load(open(os.path.join(OUT, 'null_gate.json'))); assert ng['ok']; ALPHA = ng['alpha']; ev = load(); res = cells(ev, G.B); keep, m = G.holm(res, ALPHA)
    print(f'COUNTED: 10 cells ({m} passed the gate), cost {G.COST} pt, Holm {ALPHA} survivors: {sorted(keep) or "none"}')
    print('  cell                       N    days  pre-cost  median | net [CI]  p  t | MDE | thirds(net) | placebo net (N)')
    for (s, w, x) in CELLS:
        sub = [e for e in ev if e['size'] == s and e['win'] == w and e['exit'] == x and e['arm'] == 'EVENT']; fade = (w == 'ASIA'); r = res[(s, w, x)]
        if r is None: print(f'  {s}V {w} {x}: PARKED ({len(sub)} events)'); continue
        v = np.array([val(e, fade) for e in sub]); ds = sorted({e['date'] for e in sub}); th = [np.mean([val(e, fade) for e in sub if e['date'] in set(t)]) for t in np.array_split(np.array(ds), 3)]
        pl = [e for e in ev if e['size'] == s and e['win'] == w and e['exit'] == x and e['arm'] == 'PLACEBO']; pls = f'{np.mean([val(e, False) for e in pl]):+.2f} ({len(pl)})' if pl else '-'
        pre = np.mean([(-e['gross'] if fade else e['gross']) for e in sub]); med = np.median([(-e['gross'] if fade else e['gross']) for e in sub])
        print(f'  {s}V {w:6s} {x}{" fade" if fade else "     "}  {len(sub):5d} {r["days"]:4d}  {pre:+7.2f} {med:+7.2f} | {r["mean"]:+6.2f} [{r["lo"]:+.2f},{r["hi"]:+.2f}] p {r["p"]:.3f} t {r["t"]:+.2f} | {G.mde(r, sub):.4f} | {th[0]:+.2f} {th[1]:+.2f} {th[2]:+.2f} | {pls}  Holm {"PASS" if (s, w, x) in keep else "no"}')
    print('\nDESCRIPTIVE (never counted)')
    for s in (500, 100):
        for w in ('ASIA',):
            sub = [e for e in ev if e['size'] == s and e['win'] == w and e['exit'] == 'HOLD' and e['arm'] == 'EVENT']
            if sub: print(f'  {s}V ASIA continuation (mirror of W5) net {np.mean([val(e, False) for e in sub]):+.2f} (N {len(sub)})')
        for w in ('LONDON', 'PRE'):
            sub = [e for e in ev if e['size'] == s and e['win'] == w and e['exit'] == 'HOLD' and e['arm'] == 'EVENT']
            if sub: print(f'  {s}V {w} breakout events, REVERSION net (HOLD) {np.mean([val(e, True) for e in sub]):+.2f} (N {len(sub)})')
        for (ss, w, x) in CELLS:
            if ss != s: continue
            sub = [e for e in ev if e['size'] == s and e['win'] == w and e['exit'] == x and e['arm'] == 'EVENT']; fade = (w == 'ASIA')
            if not sub: continue
            parts = []
            hi = [val(e, fade) for e in sub if e['zr_hi']]; parts.append(f'ratio-proxy>1.5 {np.mean(hi):+.2f} (N {len(hi)})' if hi else 'ratio-proxy>1.5 none')
            mac = [val(e, fade) for e in sub if e['macro']]; parts.append(f'08:30+-5min {np.mean(mac):+.2f} (N {len(mac)})' if mac else '08:30+-5min none')
            ns_ = [e['net_stop'] for e in sub if e['net_stop'] == e['net_stop']]; parts.append(f'V0-stop net {np.mean(ns_):+.2f}' if ns_ and not fade else 'V0-stop n/a')
            yrs = ', '.join(f'{y} {np.mean([val(e, fade) for e in sub if e["date"][:4] == y]):+.2f}' for y in sorted({e["date"][:4] for e in sub})); cnt = collections.Counter(e['date'] for e in sub)
            print(f'  {s}V {w} {x}: ' + ' | '.join(parts) + f' | by year {yrs} | top-5-days share {sum(c_ for _, c_ in cnt.most_common(5)) / len(sub):.3f}')
    print('  ROC10 variants: not produced (declared descriptive in the prereg, skipped)')
    json.dump(dict(survivors=[list(k) for k in sorted(keep)], res={'_'.join(map(str, k)): v for k, v in res.items()}), open(os.path.join(OUT, 'summary.json'), 'w'), indent=1)

if __name__ == '__main__':
    st = sys.argv[1] if len(sys.argv) > 1 else ''
    if st == 'null': null_gate(int(sys.argv[2]) if len(sys.argv) > 2 else 200, float(sys.argv[3]) if len(sys.argv) > 3 else 0.10, int(sys.argv[4]) if len(sys.argv) > 4 else 781)
    else: {'test': unit_tests, 'build': build, 'run': run}.get(st, lambda: print(__doc__))()
