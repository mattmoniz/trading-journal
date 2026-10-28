"""Trade test of the 500-volume tell, EXPLORE ONLY (PREREG_TRADE.md frozen). Hold-out not extracted.  Usage: ../../venv/bin/python run_trade.py"""
import glob, os, pathlib
import numpy as np, pandas as pd
import vbars as V, trade as T
SEED, BOOT, TRIALS = 20261028, 3000, 100
HERE = pathlib.Path(__file__).parent

def metrics(tr):
    p = np.array([t['net'] for t in tr]); w, lo = p[p > 0], p[p <= 0]; eq = np.cumsum(p)
    return dict(n=len(tr), wr=100 * np.mean(p > 0), pf=(w.sum() / abs(lo.sum())) if lo.sum() != 0 else float('inf'), mean=float(p.mean()), pts=float(np.mean([t['pts'] for t in tr])), avg_w=float(w.mean()) if len(w) else 0.0, avg_l=float(lo.mean()) if len(lo) else 0.0, dd=float(np.max(np.maximum.accumulate(eq) - eq)), total=float(p.sum()))

def ci(tr, rng):
    g = {}
    for t in tr: g.setdefault(t['date'], []).append(t['net'])
    arrs = [np.array(v) for v in g.values()]; m = len(arrs)
    means = np.array([np.concatenate([arrs[j] for j in rng.integers(0, m, m)]).mean() for _ in range(BOOT)]); return float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))

def line(label, tr, rng):
    if not tr: return f'  {label}: 0 trades'
    m = metrics(tr); c = ci(tr, rng); mix = pd.Series([t.get('reason', '?') for t in tr]).value_counts(normalize=True) * 100
    return (f"  {label}: N={m['n']} WR {m['wr']:.1f}% PF {m['pf']:.2f} mean ${m['mean']:.2f}/trade ({m['pts']:+.2f} pts) avgW ${m['avg_w']:.2f} avgL ${m['avg_l']:.2f} maxDD ${m['dd']:.0f} total ${m['total']:.0f} | day-blocked 95% CI [{c[0]:.2f}, {c[1]:.2f}]\n     exits " + ', '.join(f'{k} {v:.0f}%' for k, v in mix.items()))

def main():
    rng = np.random.default_rng(SEED)
    dates = sorted(os.path.basename(p)[:10] for p in glob.glob(V.ROOT + '/*.bars.tsv')); dates = [d for d in dates if d <= '2025-05-16']
    sess, stats = {}, {}
    for d in dates:
        try: S = V.load_session(d)
        except Exception as e: print('skip', d, e); continue
        sess[d] = S; stats[d] = V.session_stats(S)
    ks = sorted(sess); ctxs = {}
    for i, d in enumerate(ks):
        if i < 20: continue
        prior = ks[i - 20:i]; rngs = [stats[p][0] for p in prior if not np.isnan(stats[p][0])]
        if len(rngs) < 15: continue
        base = {h: float(np.mean([stats[p][1][h] for p in prior if h in stats[p][1]])) for h in range(24) if sum(h in stats[p][1] for p in prior) >= 15}
        c = T.prep(sess[d], float(np.mean(rngs)), base)
        if c is not None: ctxs[d] = c
    print(f"Sessions {len(ks)}; usable {len(ctxs)}; hold-out NOT extracted")
    res = {}; reps = {}
    for var in ('V1', 'V2', 'V3'):
        rep = dict(fires=0, skip=0, trades=0, fallback=0); tr = []
        for d, c in ctxs.items(): tr += T.simulate(c, var, rep)
        res[var] = tr; reps[var] = rep
    t1 = res['V1']; rep = reps['V1']
    print(f"FUNNEL (V1): tell-true bars while armed {rep['fires']}, skipped (no valid stop) {rep['skip']}, trades {rep['trades']} on {len(set(t['date'] for t in t1))} dates ({rep['trades'] / len(ctxs):.2f} per session); stops using the no-next-node fallback {rep['fallback']} ({100 * rep['fallback'] / max(1, rep['trades']):.0f}%)")
    rk = np.array([t['risk'] for t in t1]); print(f"  stop distance, points: p10 {np.percentile(rk, 10):.1f} p25 {np.percentile(rk, 25):.1f} median {np.median(rk):.1f} p75 {np.percentile(rk, 75):.1f} p90 {np.percentile(rk, 90):.1f} max {rk.max():.1f}; dollars (1 MNQ) median {np.median(rk) * 2:.0f} p90 {np.percentile(rk, 90) * 2:.0f}")
    for var, lab in (('V1', 'V1: stop at the 2nd LVN (behind n2), tell-fade exit after the break  [PRIMARY]'), ('V2', 'V2: stop at the 1st LVN (behind n1)'), ('V3', 'V3: stop as V1, hold to the 15:55 flatten after the break')):
        tr = res[var]; print(f'\n=== {lab} ==='); print(line('result', tr, rng))
        if tr:
            b = [t for t in tr if t['broke']]; nb = [t for t in tr if not t['broke']]
            print(f"     broke the range {len(b)} ({100 * len(b) / len(tr):.0f}%): mean ${np.mean([t['net'] for t in b]):.2f} | no break {len(nb)}: mean ${np.mean([t['net'] for t in nb]):.2f} | long {sum(t['dir'] == 1 for t in tr)} short {sum(t['dir'] == -1 for t in tr)}")
            if var == 'V1':
                q = np.percentile([t['risk'] for t in tr], [33.3, 66.7])
                for lab2, f in (('tight stop third', lambda t: t['risk'] <= q[0]), ('middle third', lambda t: q[0] < t['risk'] <= q[1]), ('wide stop third', lambda t: t['risk'] > q[1])):
                    g = [t for t in tr if f(t)]; print(f"     {lab2:18s} N={len(g):4d} mean ${np.mean([t['net'] for t in g]):+.2f} WR {100 * np.mean([t['net'] > 0 for t in g]):.0f}%")
    # like-for-like stripped real, placebo, control
    if t1:
        real = np.mean([T.stripped(ctxs[t['date']], t['ei'], t['dir'], t['risk']) for t in t1]); res_p = []
        for _ in range(TRIALS):
            v = []
            for t in t1:
                c = ctxs[t['date']]; S = c['S']
                while True:
                    i = int(rng.integers(0, c['n'] - 1))
                    if T.ENTRY_FROM <= S['end'][i] <= T.ENTRY_TO and S['comp'][i]: break
                v.append(T.stripped(c, i + 1, int(rng.choice([-1, 1])), t['risk']))
            res_p.append(np.mean(v))
        res_p = np.array(res_p); pq = np.percentile(res_p, [5, 50, 95])
        print(f"\nRANDOM-ENTRY PLACEBO (stripped geometry, {TRIALS} trials): tell trades re-simulated on it ${real:.2f}/trade | placebo p5 {pq[0]:.2f} p50 {pq[1]:.2f} p95 {pq[2]:.2f} | trials >= real {100 * np.mean(res_p >= real):.1f}%")
        sds = [t['risk'] for t in t1]; ctl = []
        for d, c in ctxs.items(): ctl += T.simulate_control(c, sds, rng)
        print(f"MOVING-ONLY CONTROL (stripped geometry, stop distance drawn from the tell trades): " + line('', ctl, rng).strip())
        print(f"  tell re-simulated on the same stripped geometry ${real:.2f}/trade vs moving-only control ${np.mean([t['net'] for t in ctl]):.2f}/trade")
        pd.DataFrame(t1).to_csv(HERE / 'trades_V1_explore.csv', index=False)
    print('\nReading is pre-registered (PREREG_TRADE.md): lead = V1 CI lower bound > 0 AND beats the placebo p95 on the stripped geometry AND beats the moving-only control. Under 150 trades = underpowered.')

if __name__ == '__main__':
    main()
