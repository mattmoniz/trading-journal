"""Row 38 (prereg docs/GLOBEX_M4_VWAP_FADE_PREREG_20261110.md): Globex climax fade toward the ETH VWAP, data-derived stretch cutoff, with a stretched-state PLACEBO arm. Stages: test (unit tests of the exit simulator) | build | null | run."""
import os, sys, csv, glob, json, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import globex_roc3_test as G
Fm, v2 = G.Fm, G.v2
OUT = os.path.join(G.ROOT, 'scratch', 'globex_m4_20261110'); os.makedirs(OUT, exist_ok=True)
Q, WARM, BACK, HOOKW, HOLD, COST = 0.90, 10, 3, 5, 30, 2.0; SEEDS = dict(M1=501, M2=502, M3=503, M4=504)

def prep(o, h, l, c, v):
    """Per-session developing VWAP (typical price x volume, reset at bar 0), EMA10(TR) and stretch = |C - VWAP| / EMA10(TR). All causal at bar close."""
    n = len(c); pc = np.r_[c[0], c[:-1]]; tr = np.maximum.reduce([h - l, np.abs(h - pc), np.abs(l - pc)]); tr[0] = h[0] - l[0]
    vw = np.cumsum((h + l + c) / 3.0 * v) / np.maximum(np.cumsum(v), 1e-9); et = Fm.ema(tr); return vw, et, np.abs(c - vw) / np.maximum(et, 1e-6)

def sim(dr, ei, stop, o, h, l, c, vw, flat):
    """Fade trade entered at Open[ei] in direction dr (+1 long). Target = previous bar's VWAP (limit), stop = structural extreme, time exit at Close of bar ei+HOLD-1 or the hard flat. Stop before target inside one bar; gaps fill at the open. Returns (net, exit_idx, reason) or None."""
    if ei > flat or ei < 1: return None
    entry = float(o[ei]); last = min(ei + HOLD - 1, flat)
    for t in range(ei, last + 1):
        tgt = float(vw[t - 1])
        if dr == 1 and l[t] <= stop: px = min(stop, float(o[t])); return dr * (px - entry) - COST, t, 'stop'
        if dr == -1 and h[t] >= stop: px = max(stop, float(o[t])); return dr * (px - entry) - COST, t, 'stop'
        if dr == 1 and h[t] >= tgt: px = max(tgt, float(o[t])); return dr * (px - entry) - COST, t, 'target'
        if dr == -1 and l[t] <= tgt: px = min(tgt, float(o[t])); return dr * (px - entry) - COST, t, 'target'
    return dr * (float(c[last]) - entry) - COST, last, 'time'

def unit_tests():
    ok = True
    def chk(name, got, want):
        nonlocal ok; good = got is not None and got[2] == want[2] and abs(got[0] - want[0]) < 1e-9 and got[1] == want[1]; ok &= good; print(('PASS ' if good else 'FAIL ') + name, '' if good else f'got {got} want {want}')
    n = 40; o = np.full(n, 100.0); h = np.full(n, 100.5); l = np.full(n, 99.5); c = np.full(n, 100.0); vw = np.full(n, 103.0)
    h2 = h.copy(); h2[7] = 103.2; chk('1 long fade: target VWAP 103 hit at bar 7 -> +3 - 2 = +1', sim(1, 5, 95.0, o, h2, l, c, vw, 39), (1.0, 7, 'target'))
    l2 = l.copy(); l2[6] = 94.0; chk('2 long fade: stop 95 hit at bar 6 -> -5 - 2 = -7', sim(1, 5, 95.0, o, h, l2, c, vw, 39), (-7.0, 6, 'stop'))
    chk('3 stop and target in the same bar -> stop first', sim(1, 5, 95.0, o, np.where(np.arange(n) == 6, 104.0, h), np.where(np.arange(n) == 6, 94.0, l), c, vw, 39), (-7.0, 6, 'stop'))
    o3 = o.copy(); o3[6] = 92.0; l3 = l.copy(); l3[6] = 91.5; chk('4 gap through the stop fills at the open 92 -> -8 - 2 = -10', sim(1, 5, 95.0, o3, h, l3, c, vw, 39), (-10.0, 6, 'stop'))
    c4 = c.copy(); c4[34] = 101.0; chk('5 time exit at Close of bar ei+29 = 34 -> +1 - 2 = -1', sim(1, 5, 95.0, o, h, l, c4, vw, 39), (-1.0, 34, 'time'))
    chk('6 hard flat clamps the hold: flat = 20, exit at Close[20] = 100 -> -2', sim(1, 5, 95.0, o, h, l, c, vw, 20), (-2.0, 20, 'time'))
    vws = np.full(n, 97.0); l5 = l.copy(); l5[8] = 96.5; chk('7 short fade (dr -1) toward VWAP 97: target at bar 8 -> +3 - 2 = +1', sim(-1, 5, 105.0, o, h, l5, c, vws, 39), (1.0, 8, 'target'))
    print('ALL PASS' if ok else 'SOME FAILED'); return ok

def run_session(S, prs_hist, P, n0, F):
    """Fade and placebo trades for one session. Returns two lists of dict(date, hour, net, reason)."""
    m = int((S['en'] <= Fm.OPEN).sum()); o, h, l, c, v, en = (S[k][:m] for k in ('o', 'h', 'l', 'c', 'v', 'en')); vw, et, st = prep(o, h, l, c, v)
    vals = []; wts = []
    for T in prs_hist:
        _, _, s_ = prep(T['o'], T['h'], T['l'], T['c'], T['v']); s_ = s_[WARM:]; vals.append(s_); wts.append(np.full(len(s_), 1.0 / (len(prs_hist) * max(len(s_), 1))))
    cut = Fm.wq(np.concatenate(vals), np.concatenate(wts), Q)
    z = F['zroc'][n0:n0 + m]; roc = F['roc'][n0:n0 + m]; inside = np.where(en <= G.LIM)[0]; flat = int(inside.max()) if len(inside) else -1
    side = np.sign(c - vw); signed = side * (c - vw) / np.maximum(et, 1e-6); stretched = signed >= cut
    d = S['date']; fade, plac = [], []; lock_f = -1; lock_p = -1
    # fade arm
    a = 0
    while a < m:
        if a >= WARM and not np.isnan(z[a]) and en[a] <= 55500.0 and abs(z[a]) > Fm.Z_ROC and np.sign(z[a]) == np.sign(roc[a]) and not (a > 0 and not np.isnan(z[a - 1]) and abs(z[a - 1]) > Fm.Z_ROC and np.sign(z[a - 1]) == np.sign(roc[a - 1])):
            s = int(np.sign(roc[a]))
            if s * (c[a] - vw[a]) / max(et[a], 1e-6) >= cut:
                for j in range(a + 1, min(a + HOOKW, m - 1) + 1):
                    if en[j] > 55500.0: break
                    if not np.isnan(z[j]) and s * z[j] <= 0 and s * (c[j] - vw[j]) > 0:
                        ei = j + 1
                        if ei < m and ei > lock_f:
                            stop = float(h[max(a - BACK, 0):j + 1].max()) if s == 1 else float(l[max(a - BACK, 0):j + 1].min())
                            r = sim(-s, ei, stop, o, h, l, c, vw, flat)
                            if r: fade.append(dict(date=d, hour=int(Fm.hour_et(np.array([en[j]]))[0]), net=r[0], reason=r[2], gross=r[0] + COST)); lock_f = r[1]
                        break
        a += 1
    # placebo arm: onset of the stretched state, no spike, no hook
    for b in range(WARM, m):
        if en[b] > 55500.0 or not stretched[b] or (stretched[b - 1] and side[b - 1] == side[b]) or b + 1 >= m or b + 1 <= lock_p: continue
        s = int(side[b]); stop = float(h[max(b - BACK, 0):b + 1].max()) if s == 1 else float(l[max(b - BACK, 0):b + 1].min()); r = sim(-s, b + 1, stop, o, h, l, c, vw, flat)
        if r: plac.append(dict(date=d, hour=int(Fm.hour_et(np.array([en[b]]))[0]), net=r[0], reason=r[2], gross=r[0] + COST)); lock_p = r[1]
    return fade, plac, cut

def build():
    files = sorted(p for p in glob.glob(os.path.join(Fm.BARS, '*.bars.tsv')) if os.path.basename(p)[:10] <= Fm.LAST_EXPLORE)
    hist = {'RTH': [], 'GBX': []}; prevS = None; rows = []; cuts = []
    for p in files:
        S = Fm.load_full(p)
        if S is None: continue
        tsp = Fm.track_split(S); close = Fm.EARLY_CLOSE if S['date'] in Fm.EARLY else Fm.CLOSE; prs = {}
        for name in ('RTH', 'GBX'):
            prev = hist[name][-Fm.K_PRIOR:]
            if len(prev) >= Fm.K_PRIOR: prs[name] = Fm.priors_of(prev)
        if len(prs) == 2:
            P, n0, reset = v2.continuous(prevS, S); Fm.L_ROC = 3
            try: F = v2.feats(P, n0, reset, prs, close)
            finally: Fm.L_ROC = 10
            f, pl, cut = run_session(S, hist['GBX'][-Fm.K_PRIOR:], P, n0, F); cuts.append(cut)
            rows += [dict(x, arm='FADE') for x in f] + [dict(x, arm='PLACEBO') for x in pl]
        for name, T in tsp.items(): hist[name].append(T)
        prevS = S
    with open(os.path.join(OUT, 'events.csv'), 'w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=['date', 'arm', 'hour', 'net', 'gross', 'reason']); w.writeheader(); w.writerows(rows)
    print('sessions', len(cuts), 'median cutoff (stretch, EMA_TR units)', round(float(np.median(cuts)), 2), {a: sum(1 for r in rows if r['arm'] == a) for a in ('FADE', 'PLACEBO')})

def load():
    out = []
    for r in csv.DictReader(open(os.path.join(OUT, 'events.csv'))): out.append(dict(date=r['date'], arm=r['arm'], hour=int(r['hour']), net=float(r['net']), gross=float(r['gross']), reason=r['reason']))
    return out

def counted(ev, groups, draws, center=None, flip=None):
    def val(x):
        v = x['net'] - (center[x['arm']] if center else 0.0)
        if center: v += COST          # centered null: cost 0
        return v * (flip[x['date']] if flip else 1)
    fa = [x for x in ev if x['arm'] == 'FADE']; pl = [x for x in ev if x['arm'] == 'PLACEBO']
    cells = dict(M1=('m', [(x['date'], val(x)) for x in fa]), M2=('d', [(x['date'], val(x)) for x in fa], [(x['date'], val(x)) for x in pl]),
                 M3=('m', [(x['date'], val(x)) for x in fa if x['hour'] in groups['SLOW']]), M4=('m', [(x['date'], val(x)) for x in fa if x['hour'] in groups['FAST']]))
    assert len(cells) == 4; res = {}
    for k, c in cells.items():
        if len(c[1]) < G.MIN_N or len({d for d, _ in c[1]}) < G.MIN_DAYS or (c[0] == 'd' and len(c[2]) < G.MIN_N): res[k] = None; continue
        res[k] = G.boot_diff(c[1], c[2], SEEDS[k], draws) if c[0] == 'd' else G.boot_mean(c[1], SEEDS[k], draws)
    return res

def null_gate(iters=200):
    ev = load(); groups, _ = G.hour_groups(); dates = sorted({x['date'] for x in ev}); rng = np.random.default_rng(779); passes = 0
    ctr = {a: float(np.mean([x['net'] for x in ev if x['arm'] == a])) for a in ('FADE', 'PLACEBO')}
    for it in range(iters):
        flip = {d_: int(rng.choice([-1, 1])) for d_ in dates}; keep, m = G.holm(counted(ev, groups, 1000, center=ctr, flip=flip)); passes += bool(keep)
    rate = passes / iters; print(f'NULL GATE (centered, day sign flips, cost 0): family-wise false-pass {rate:.3f} (required <= 0.10)'); json.dump(dict(rate=rate, ok=rate <= 0.10), open(os.path.join(OUT, 'null_gate.json'), 'w'))

def run():
    assert json.load(open(os.path.join(OUT, 'null_gate.json')))['ok']; ev = load(); groups, _ = G.hour_groups(); res = counted(ev, groups, G.B); keep, m = G.holm(res)
    fa = [x for x in ev if x['arm'] == 'FADE']; pl = [x for x in ev if x['arm'] == 'PLACEBO']
    names = dict(M1='fade net', M2='fade minus placebo net', M3='fade net SLOW hours', M4='fade net FAST hours'); cell = dict(M1=fa, M2=fa, M3=[x for x in fa if x['hour'] in groups['SLOW']], M4=[x for x in fa if x['hour'] in groups['FAST']])
    print(f'COUNTED (cost {COST} pt, Holm 0.10 over m={m}; survivors {sorted(keep) or "none"})')
    for k in ('M1', 'M2', 'M3', 'M4'):
        r = res[k]; ev_c = [dict(adr20=float('nan'))]
        print(f'  {k} {names[k]}: PARKED' if r is None else f'  {k} {names[k]}: {r["mean"]:+.2f} pt [{r["lo"]:+.2f}, {r["hi"]:+.2f}] p {r["p"]:.4f} t {r["t"]:+.2f} N {r["n"]}' + (f' vs {r["nb"]}' if 'nb' in r else '') + f' ({r["days"]} days) Holm {"PASS" if k in keep else "no"}')
    json.dump(dict(res=res, holm=sorted(keep)), open(os.path.join(OUT, 'summary.json'), 'w'), indent=1)
    print('\nDESCRIPTIVE')
    for lab, sub in (('FADE', fa), ('PLACEBO', pl)):
        if not sub: continue
        net = np.array([x['net'] for x in sub]); rc = collections.Counter(x['reason'] for x in sub); wins = net[net > 0]; loss = net[net <= 0]
        ds = sorted({x['date'] for x in sub}); th = [np.mean([x['net'] for x in sub if x['date'] in set(t)]) for t in np.array_split(np.array(ds), 3)]; cnt = collections.Counter(x['date'] for x in sub)
        print(f'  {lab}: N {len(sub)} on {len(ds)} days, mean net {net.mean():+.2f} median {np.median(net):+.2f} pre-cost {np.mean([x["gross"] for x in sub]):+.2f}; win rate {len(wins) / len(net):.3f} avg win {wins.mean() if len(wins) else 0:+.2f} avg loss {loss.mean() if len(loss) else 0:+.2f}; exits {dict(rc)}; thirds {[round(float(t), 2) for t in th]}; by year ' + ', '.join(f'{y}: {np.mean([x["net"] for x in sub if x["date"][:4] == y]):+.2f} (N {sum(1 for x in sub if x["date"][:4] == y)})' for y in sorted({x["date"][:4] for x in sub})) + f'; top-5-days share {sum(c_ for _, c_ in cnt.most_common(5)) / len(sub):.3f}')
        for g in ('SLOW', 'MID', 'FAST'):
            s_ = [x['net'] for x in sub if x['hour'] in groups[g]]; print(f'      {g} hours: N {len(s_)} mean {np.mean(s_) if s_ else float("nan"):+.2f}')
        cl = [x['net'] for x in sub if 19 <= x['hour'] or x['hour'] <= 2]; print(f'      19:00-02:59 clock window: N {len(cl)} mean {np.mean(cl) if cl else float("nan"):+.2f}')

if __name__ == '__main__':
    st = sys.argv[1] if len(sys.argv) > 1 else ''
    {'test': unit_tests, 'build': build, 'null': null_gate, 'run': run}.get(st, lambda: print(__doc__))()
