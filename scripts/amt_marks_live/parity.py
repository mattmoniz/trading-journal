"""Live-versus-replay PARITY harness (docs/MARKS_BUILD_FRAMEWORK_20261029.md). Proves causality as a TEST: every mark and feature computed from the bars up to bar t must equal what the full day gives for everything decided by t.
Usage: ../../venv/bin/python parity.py [--sessions N] [--step S] [--full]    exit 1 on any violation, or if the mutation test (the old leaky detector) is NOT caught."""
import sys, numpy as np
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_80rule'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_exhaust'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_marks_live'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_marks_path'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/ml_meta_labeling')
import engine as E, spike as SP, context as CX
KEYS = ('o', 'h', 'l', 'c', 'v', 'dl'); SPLIT = '2025-05-16'

def prefix(a, t):
    p = {k: a[k].copy() for k in KEYS}
    for k in KEYS: p[k][t + 1:] = np.nan
    return p

def ekey(e): return (int(e['dir']), int(e['t']), int(e['u']), round(float(e['ext']), 6), round(float(e['base']), 6), bool(e['strong']))

def detect_leaky(a, st, thr, m=SP.M, k=SP.K, ret=SP.RET):
    """The PRE-FIX spike detector (2026-10-29 erratum): scans past the confirmation bar, deletes the event when a later bar extends the extreme and sets strong from later closes. Kept ONLY to prove the harness catches this bug class."""
    h, l, c = a['h'], a['l'], a['c']; out = []; last = {1: -10 ** 6, -1: -10 ** 6}
    for t in range(m + SP.MINK, SP.N):
        if np.isnan(thr[t]): continue
        for D, size in ((-1, st['up'][t]), (1, st['dn'][t])):
            if size < thr[t] or size <= 0 or t < last[D] + SP.REFRACT: continue
            if D == -1:
                ext = h[t]; base = float(np.min(l[t - m + 1:t + 1]))
                if not ext > np.max(h[max(0, t - m - k + 1):t - m + 1]): continue
            else:
                ext = l[t]; base = float(np.max(h[t - m + 1:t + 1]))
                if not ext < np.min(l[max(0, t - m - k + 1):t - m + 1]): continue
            mid = (ext + base) / 2.0; u = None; strong = False
            for x in range(t + 1, min(SP.N, t + ret + 1)):
                if np.isnan(c[x]): break
                if (D == -1 and h[x] > ext) or (D == 1 and l[x] < ext): u = None; break
                if u is None and ((D == -1 and c[x] < mid) or (D == 1 and c[x] > mid)): u = x
                if (D == -1 and c[x] <= ext - SP.STRONG_FRAC * (ext - base)) or (D == 1 and c[x] >= ext + SP.STRONG_FRAC * (base - ext)): strong = True
                if u is not None and x >= t + ret: break
            if u is None: continue
            out.append(dict(dir=D, t=t, u=u, ext=float(ext), base=base, strong=strong, size=float(size))); last[D] = t
    return out

def marks_parity(a, thr, detect_fn, ts):
    full = [ekey(e) for e in detect_fn(a, SP.thrust(a), thr)]; bad = []
    for t in ts:
        ap = prefix(a, t); got = {ekey(e) for e in detect_fn(ap, SP.thrust(ap), thr) if e['u'] <= t}; want = {k for k in full if k[2] <= t}
        if got != want: bad.append((t, sorted(got ^ want)[:2]))
    return bad, len(full)

def series_parity(a, ts):
    full = CX.session_series(a); bad = []
    for t in ts:
        ps = CX.session_series(prefix(a, t))
        for k in full:
            if not np.array_equal(ps[k][:t + 1], full[k][:t + 1], equal_nan=True): bad.append((t, k))
    return bad

def sample_sessions(n):
    """Mark-rich sessions (a parity test on a day with no marks proves nothing): from the research marks file, the busiest sessions spread across the history."""
    import csv, collections
    cnt = collections.Counter(r['date'] for r in csv.DictReader(open('/home/mmoniz/trading-journal/scripts/amt_exhaust/spikes_explore.csv')))
    raw = E.load_sessions(); allS = E.build_eligible(raw); ex = [s for s in allS if s['d'] <= SPLIT]; stats = [SP.thrust(s['a']) for s in ex]; idx = {s['d']: i for i, s in enumerate(ex)}
    pool = sorted([d for d, c in cnt.items() if d in idx and idx[d] >= 40 and c >= 8], key=lambda d: d); picks = [pool[int(i)] for i in np.linspace(0, len(pool) - 1, n)] if pool else []; out = []
    for d in picks:
        si = idx[d]; thr = SP.thresholds(stats, si); out.append((d, ex[si]['a'], thr))
    return out, ex

def full_features(rows_limit=None):
    """--full: the module's features equal the research table run_context.build() (numerical equality) for every mark."""
    import run_context as RC
    rows = RC.build(); raw = None; _, ex = sample_sessions(1); ON = RC.overnight_table(); idx = {s['d']: i for i, s in enumerate(ex)}; PS = [CX.session_series(s['a']) for s in ex]; rngs = [float(np.nanmax(s['a']['h']) - np.nanmin(s['a']['l'])) for s in ex]
    on_vols = [ON.get(s['d'], {}).get('vol', np.nan) for s in ex]; cache = {}; mism = 0; maxd = 0.0; n = 0
    for r in rows[:rows_limit]:
        si = idx[r['d']]; s = ex[si]; a = s['a']
        if si not in cache: cache[si] = CX.baselines([PS[j] for j in range(si - 20, si)])
        pc = ex[si - 1]['a']['c']; ctx = dict(on=ON[r['d']], prior_vah=s['vah'], prior_val=s['val'], atr=float(np.mean(rngs[si - 20:si])), prior_close=float(pc[~np.isnan(pc)][-1]), o0=a['o'][0], c_u=a['c'][r['u']], D=r['D'], size=1.0, thr_t=1.0, on_vol_median=np.nanmedian(on_vols[si - 20:si]))
        f = CX.features_at(PS[si], r['u'], cache[si], ctx); n += 1
        if f is None: mism += 1; continue
        for k in ('rvol', 'volnow', 'rngr', 'es', 'on_pos', 'on_va', 'va_pos', 'on_range_rel', 'on_vol_rel', 'gap_rel', 'drift_w'):
            if not np.isclose(f[k], r[k], rtol=1e-9, atol=1e-12, equal_nan=True): mism += 1; maxd = max(maxd, abs(f[k] - r[k]) if np.isfinite(f[k]) and np.isfinite(r[k]) else 1.0)
    return n, mism, maxd

def main():
    args = sys.argv[1:]; ns = int(args[args.index('--sessions') + 1]) if '--sessions' in args else 4; step = int(args[args.index('--step') + 1]) if '--step' in args else 5; ts = list(range(40, 386, step)); fail = False
    sess, _ = sample_sessions(ns); tot_clean = tot_leaky = tot_series = 0; nev = 0
    for d, a, thr in sess:
        b, n = marks_parity(a, thr, SP.detect, ts); tot_clean += len(b); nev += n; tot_series += len(series_parity(a, ts[::max(1, 20 // step)]))
        bl, _ = marks_parity(a, thr, detect_leaky, ts); tot_leaky += len(bl)
        print(f'  {d}: marks {n}, prefix violations clean {len(b)}, series {0 if not tot_series else "see total"}, leaky detector violations {len(bl)}')
    print(f'sessions {len(sess)}, prefix points per session {len(ts)}, total marks {nev}; clean-detector violations {tot_clean}; series violations {tot_series}; mutation (leaky) violations {tot_leaky}')
    if tot_clean or tot_series: print('FAIL: causality violation in the current code'); fail = True
    if tot_leaky == 0: print('FAIL: the harness did not catch the re-injected lookahead bug (it is blind)'); fail = True
    if '--full' in args:
        n, mism, maxd = full_features(); print(f'--full: features vs run_context table: {n} marks, mismatching values {mism}, max abs diff {maxd:.3g}')
        if mism: fail = True
    print('PARITY OK' if not fail else 'PARITY FAILED'); sys.exit(1 if fail else 0)
if __name__ == '__main__': main()
