"""Q4-6 / improvement register row 51 (docs/TELL_GEOMETRY_NULL_PREREG_20261110.md): does the tell know the direction? For every explore V1 tell: which is touched first, the
stop or the range edge, against a direction-blind placebo with the same two distances, the same session and the same time of day. The tell geometry comes from the live code
(tell_replay_lib.replay_rows, trade.boundary, trade.stripped; hr-022). Usage: ulimit -v 4000000; venv/bin/python scripts/vacuum_sim/tell_geometry_null.py check | build | count | run   (build replays the tells and writes rows.json; log the ledger look first)"""
import os, sys, json
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, os.path.join(HERE, '..', 'tell_context', 'research_20261103')); sys.path.insert(0, os.path.join(REPO, 'scripts', 'lib'))
OUT = os.path.join(REPO, 'scratch', 'tell_geometry_null_20261110'); ROWS = os.path.join(OUT, 'rows.json')
WIN_S = 900.0; SEED = 20261110; NBOOT = 10000


def race(h, l, k, last, g, stop, edge):
    """First touch from bar k to bar last (inclusive), direction g. Returns 'EDGE', 'STOP', 'BOTH' (same bar, scored as a stop) or 'NONE', and the bar index of the touch (or -1)."""
    hh = h[k:last + 1]; ll = l[k:last + 1]
    st = (ll <= stop) if g == 1 else (hh >= stop); ed = (hh >= edge) if g == 1 else (ll <= edge)
    js = int(np.argmax(st)) if st.any() else -1; je = int(np.argmax(ed)) if ed.any() else -1
    if js < 0 and je < 0: return 'NONE', -1
    if je >= 0 and (js < 0 or je < js): return 'EDGE', k + je
    if js >= 0 and (je < 0 or js < je): return 'STOP', k + js
    return 'BOTH', k + js


def last_bar(start, end, k, t0, T, horizon=None):
    """Last bar index that starts before the flatten (and, with a horizon, ends within `horizon` seconds of t0)."""
    ok = start < T.FLAT_S
    if horizon is not None: ok = ok & (end - t0 <= horizon)
    idx = np.nonzero(ok)[0]; idx = idx[idx >= k]
    return int(idx[-1]) if len(idx) else k - 1


def check():
    f = lambda a: np.array(a, float); ok = True
    def chk(name, got, want):
        nonlocal ok; good = got == want; ok &= good; print(('PASS ' if good else 'FAIL ') + name, got)
    chk('straight to the edge (long)', race(f([101, 103, 106]), f([100, 101, 103]), 0, 2, 1, 95.0, 105.0)[0], 'EDGE')
    chk('straight to the stop (long)', race(f([101, 100, 99]), f([99, 97, 94]), 0, 2, 1, 95.0, 105.0)[0], 'STOP')
    chk('both in one bar = BOTH', race(f([101, 106]), f([99, 94]), 0, 1, 1, 95.0, 105.0)[0], 'BOTH')
    chk('neither', race(f([101, 102]), f([99, 98]), 0, 1, 1, 95.0, 105.0)[0], 'NONE')
    chk('short mirror: edge below', race(f([101, 100, 99]), f([99, 97, 94]), 0, 2, -1, 105.0, 95.0)[0], 'EDGE')
    chk('short mirror: stop above', race(f([101, 103, 106]), f([100, 101, 103]), 0, 2, -1, 105.0, 95.0)[0], 'STOP')
    chk('stop first then edge later = STOP', race(f([101, 100, 110]), f([99, 94, 100]), 0, 2, 1, 95.0, 105.0)[0], 'STOP')
    chk('window ends before the touch = NONE', race(f([101, 102, 110]), f([99, 98, 100]), 0, 1, 1, 95.0, 105.0)[0], 'NONE')
    print('CODE CHECK', 'PASSED' if ok else 'FAILED'); return ok


def build():
    import tell_replay_lib as TRL
    T = TRL.T
    def extra(S, allb, sig, trd, ctxf):
        ctx = S['_ctx']; d = int(trd['dir']); ei = int(trd['ei']); o, h, l, end, start = S['o'], S['h'], S['l'], S['end'], S['start']; n = len(end)
        E = float(o[ei]) + d * T.SLIP; stop = float(trd['stop']); R = abs(E - stop); B = float(T.boundary(ctx, sig, d)); D = d * (B - E); t0 = float(end[sig])
        out = dict(R=R, D=D, t0=t0, yr=trd['date'][:4], engine_why=trd['reason'], engine_net=float(trd['net']))
        if D <= 0 or R <= 0: out['excl'] = True; return out
        lf = last_bar(start, end, ei, t0, T); l2 = last_bar(start, end, ei, t0, T, T.TIMEOUT_S)
        out.update(excl=False, tell=race(h, l, ei, lf, d, stop, B)[0], tell120=race(h, l, ei, l2, d, stop, B)[0], tell_strip=float(T.stripped(ctx, ei, d, R)))
        ks = [k for k in range(max(1, T.V.MOVE_N), n - 1) if k != ei and abs(float(end[k - 1]) - t0) <= WIN_S and start[k] < T.FLAT_S]
        cnt = {g: dict(EDGE=0, STOP=0, BOTH=0, NONE=0) for g in (1, -1)}; c120 = {g: dict(EDGE=0, STOP=0, BOTH=0, NONE=0) for g in (1, -1)}; strip = {1: 0.0, -1: 0.0}
        for k in ks:
            tk = float(end[k - 1]); lk = last_bar(start, end, k, tk, T); lk2 = last_bar(start, end, k, tk, T, T.TIMEOUT_S)
            for g in (1, -1):
                e = float(o[k]) + g * T.SLIP
                cnt[g][race(h, l, k, lk, g, e - g * R, e + g * D)[0]] += 1; c120[g][race(h, l, k, lk2, g, e - g * R, e + g * D)[0]] += 1; strip[g] += float(T.stripped(ctx, k, g, R))
        out.update(nplac=len(ks), p_long=json.dumps(cnt[1]), p_short=json.dumps(cnt[-1]), p120_long=json.dumps(c120[1]), p120_short=json.dumps(c120[-1]), strip_long=strip[1], strip_short=strip[-1])
        return out
    R_, bad = TRL.replay_rows(extra)
    keep = ['date', 'dir', 'ei', 'sig', 'R', 'D', 't0', 'yr', 'excl', 'tell', 'tell120', 'tell_strip', 'nplac', 'p_long', 'p_short', 'p120_long', 'p120_short', 'strip_long', 'strip_short', 'engine_why', 'engine_net']
    R_[[c for c in keep if c in R_.columns]].to_json(ROWS, orient='records'); print('rows', len(R_), 'replay failures', bad, '->', ROWS)


def load():
    rows = json.load(open(ROWS))
    for r in rows:
        for k in ('p_long', 'p_short', 'p120_long', 'p120_short'):
            if r.get(k): r[k] = json.loads(r[k])
    return rows


def boot(dates, vals, seed=SEED, n=NBOOT):
    """Day-blocked bootstrap of a per-row mean. Returns (mean, lo, hi, two-sided p against zero)."""
    dates = np.asarray(dates); vals = np.asarray(vals, float); u, inv = np.unique(dates, return_inverse=True)
    s = np.bincount(inv, weights=vals, minlength=len(u)); c = np.bincount(inv, minlength=len(u)).astype(float)
    rng = np.random.default_rng(seed); ix = rng.integers(0, len(u), size=(n, len(u))); m = s[ix].sum(1) / c[ix].sum(1); est = vals.mean()
    p = 2 * min((m <= 0).mean(), (m >= 0).mean()); return est, float(np.percentile(m, 2.5)), float(np.percentile(m, 97.5)), float(min(1.0, max(p, 1.0 / n)))


def count():
    rows = load(); use = [r for r in rows if not r['excl'] and r['nplac'] > 0]
    print(f"OUTCOME-BLIND COUNTS: rows {len(rows)}, excluded (opened through the edge) {sum(1 for r in rows if r['excl'])}, no placebo bars {sum(1 for r in rows if not r['excl'] and r['nplac'] == 0)}, used {len(use)} on {len(set(r['date'] for r in use))} sessions")
    R = np.array([r['R'] for r in use]); D = np.array([r['D'] for r in use]); q = R / (R + D); npl = np.array([r['nplac'] for r in use])
    pc = lambda a: ' / '.join(f'{np.percentile(a, x):.2f}' for x in (10, 50, 90))
    print(f"stop distance R (pts) p10/p50/p90: {pc(R)}; edge distance D: {pc(D)}; implied rate R/(R+D): {pc(q)}; placebo bars per tell: {pc(npl)}")
    print('longs', sum(1 for r in use if r['dir'] == 1), 'shorts', sum(1 for r in use if r['dir'] == -1), 'by year', {y: sum(1 for r in use if r['yr'] == y) for y in sorted(set(r['yr'] for r in use))})


def rate(c, key): n = sum(c.values()); return (c[key] / n) if n else np.nan
def stoprate(c): n = sum(c.values()); return ((c['STOP'] + c['BOTH']) / n) if n else np.nan


def run():
    if not check(): sys.exit('code check failed')
    rows = load(); use = [r for r in rows if not r['excl'] and r['nplac'] > 0]; dts = [r['date'] for r in use]; N = len(use)
    pl = np.array([rate(r['p_long'], 'EDGE') for r in use]); ps = np.array([rate(r['p_short'], 'EDGE') for r in use])
    g = boot(dts, pl - ps); gate = (g[1] <= 0 <= g[2]) or abs(g[0]) < 0.02
    print(f"NULL GATE (placebo is direction-blind): long-placebo EDGE rate {pl.mean():.4f}, short-placebo {ps.mean():.4f}, difference {g[0]:+.4f} [{g[1]:+.4f}, {g[2]:+.4f}] -> {'PASSED' if gate else 'FAILED'}")
    if not gate: sys.exit('null gate failed: T1 not read')
    pe = (pl + ps) / 2; te = np.array([1.0 if r['tell'] == 'EDGE' else 0.0 for r in use]); t1 = boot(dts, te - pe)
    print(f"\nT1 (counted): tell EDGE-first rate {te.mean():.4f} vs direction-blind placebo {pe.mean():.4f}; difference {t1[0]:+.4f} [{t1[1]:+.4f}, {t1[2]:+.4f}], two-sided p {t1[3]:.4f}; N {N} tells on {len(set(dts))} sessions")
    q = np.array([r['R'] / (r['R'] + r['D']) for r in use]); print(f"  implied driftless rate R/(R+D), mean {q.mean():.4f} (descriptive; ignores the flatten)")
    # descriptive
    ts = np.array([1.0 if r['tell'] in ('STOP', 'BOTH') else 0.0 for r in use]); psr = np.array([(stoprate(r['p_long']) + stoprate(r['p_short'])) / 2 for r in use]); s = boot(dts, ts - psr)
    tn = np.array([1.0 if r['tell'] == 'NONE' else 0.0 for r in use]); pn = np.array([(rate(r['p_long'], 'NONE') + rate(r['p_short'], 'NONE')) / 2 for r in use])
    print(f"\nDESCRIPTIVE to the flatten: STOP-first tell {ts.mean():.4f} vs placebo {psr.mean():.4f}, difference {s[0]:+.4f} [{s[1]:+.4f}, {s[2]:+.4f}]; NONE tell {tn.mean():.4f} vs placebo {pn.mean():.4f}; same-bar BOTH among tells {sum(1 for r in use if r['tell'] == 'BOTH')}")
    for nm, key in (('EDGE', 'EDGE'), ('NONE', 'NONE')):
        t = np.array([1.0 if r['tell120'] == key else 0.0 for r in use]); p = np.array([(rate(r['p120_long'], key) + rate(r['p120_short'], key)) / 2 for r in use]); b = boot(dts, t - p)
        print(f"DESCRIPTIVE within 120 minutes: {nm} tell {t.mean():.4f} vs placebo {p.mean():.4f}, difference {b[0]:+.4f} [{b[1]:+.4f}, {b[2]:+.4f}]")
    t = np.array([1.0 if r['tell120'] in ('STOP', 'BOTH') else 0.0 for r in use]); p = np.array([(stoprate(r['p120_long']) + stoprate(r['p120_short'])) / 2 for r in use]); b = boot(dts, t - p)
    print(f"DESCRIPTIVE within 120 minutes: STOP tell {t.mean():.4f} vs placebo {p.mean():.4f}, difference {b[0]:+.4f} [{b[1]:+.4f}, {b[2]:+.4f}]")
    print('\nBY DECILE of the implied rate R/(R+D):  decile  n  implied  tell EDGE  placebo EDGE  difference')
    order = np.argsort(q, kind='stable'); 
    for i, ch in enumerate(np.array_split(order, 10)): print(f"  {i + 1:>2}  {len(ch):>4}  {q[ch].mean():.3f}  {te[ch].mean():.3f}  {pe[ch].mean():.3f}  {(te[ch] - pe[ch]).mean():+.3f}")
    dr = np.array([r['dir'] for r in use]); yr = np.array([r['yr'] for r in use])
    for nm, m in [('long', dr == 1), ('short', dr == -1)] + [(y, yr == y) for y in sorted(set(yr))]:
        b = boot(np.array(dts)[m], (te - pe)[m]); print(f"  {nm}: n {int(m.sum())}, tell {te[m].mean():.4f}, placebo {pe[m].mean():.4f}, difference {b[0]:+.4f} [{b[1]:+.4f}, {b[2]:+.4f}]")
    sd = np.array([r['tell_strip'] for r in use]); sp = np.array([(r['strip_long'] + r['strip_short']) / (2 * r['nplac']) for r in use]); b = boot(dts, sd - sp)
    same = np.array([(r['strip_long'] if r['dir'] == 1 else r['strip_short']) / r['nplac'] for r in use]); b2 = boot(dts, sd - same)
    print(f"\nGEOMETRY-ONLY DOLLARS (stop R, 120-minute time exit, flatten; net of $2): tell {sd.mean():+.2f} vs direction-blind placebo {sp.mean():+.2f}, difference {b[0]:+.2f} [{b[1]:+.2f}, {b[2]:+.2f}] p {b[3]:.4f}")
    print(f"  against the same-direction placebo only (nearby bars taken the tell's way): {same.mean():+.2f}, difference {b2[0]:+.2f} [{b2[1]:+.2f}, {b2[2]:+.2f}]")
    en = np.array([r['engine_net'] for r in use]); print(f"  the engine's own V1 net on the same rows (full exits): {en.mean():+.2f}")
    import nq_roll_stitch as NR
    bad = NR.unsafe_dates(NR.load(), days_before=0, days_after=1)
    m = np.array([d not in bad for d in dts]); b = boot(np.array(dts)[m], (te - pe)[m]); print(f"\nSENSITIVITY without stitch / bad-bar sessions ({int((~m).sum())} tells dropped): difference {b[0]:+.4f} [{b[1]:+.4f}, {b[2]:+.4f}] p {b[3]:.4f}")
    json.dump(dict(n=N, sessions=len(set(dts)), gate=dict(diff=g[0], lo=g[1], hi=g[2]), t1=dict(tell=float(te.mean()), placebo=float(pe.mean()), diff=t1[0], lo=t1[1], hi=t1[2], p=t1[3]), stop=dict(tell=float(ts.mean()), placebo=float(psr.mean()), diff=s[0], lo=s[1], hi=s[2]),
                   strip=dict(tell=float(sd.mean()), placebo=float(sp.mean()), diff=float((sd - sp).mean()))), open(os.path.join(OUT, 'result.json'), 'w'), indent=1)


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'check': sys.exit(0 if check() else 1)
    elif cmd == 'build': build()
    elif cmd == 'count': count()
    elif cmd == 'run': run()
    else: print(__doc__)
