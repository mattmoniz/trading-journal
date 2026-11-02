"""docs/LAST30_MOMENTUM_PREREG_20261102.md. EXPLORE only. READS OUTCOMES -> look logged first (log_look_last30.mjs). Usage: venv/bin/python scripts/range_budget/run_last30.py"""
import json, numpy as np
from scipy.stats import rankdata
B = json.load(open('/home/mmoniz/trading-journal/scratch/range_budget_bars_20261102.json'))['bars']; dates = sorted(B); rng = np.random.default_rng(20261102 + 101); BOOT, DRAWS = 3000, 1000
rows = []
for d in dates:
    o, c = np.array(B[d]['o']), np.array(B[d]['c']); rows.append((c[29] - o[0], c[359] - o[0], c[359] - c[329], c[389] - c[359]))
R = np.array(rows); y = R[:, 3]; n = len(R); print(f'days {n} ({dates[0]}..{dates[-1]}); hold-out NOT touched; SD of the last-30-minute move {y.std():.1f} points, mean {y.mean():+.2f}')
print(f'RESOLUTION: correlation half-width about {2 / np.sqrt(n):.3f}; break-even correlation about {1.25 / (0.8 * y.std()):.3f}')
res = {}
for j, nm in enumerate(['f1 first 30 min', 'f2 open to 15:30', 'f3 15:00-15:30']):
    x = R[:, j]; rx, ry = rankdata(x), rankdata(y); r = float(np.corrcoef(rx, ry)[0, 1]); bs = []
    for _ in range(BOOT): k = rng.integers(0, n, n); bs.append(np.corrcoef(rankdata(x[k]), rankdata(y[k]))[0, 1])
    lo, hi = np.percentile(bs, [2.5, 97.5]); plc = np.array([np.corrcoef(rx, np.roll(ry, s))[0, 1] for s in rng.integers(1, n, DRAWS)]); p = float((np.sum(np.abs(plc) >= abs(r)) + 1) / (DRAWS + 1)); h = n // 2
    r1, r2 = np.corrcoef(rankdata(x[:h]), rankdata(y[:h]))[0, 1], np.corrcoef(rankdata(x[h:]), rankdata(y[h:]))[0, 1]; big = np.abs(x) >= np.quantile(np.abs(x), 2 / 3); gross = float(np.mean(np.sign(x[big]) * y[big])); gs = float(np.mean(np.sign(x[big]) * y[big]) * 1) 
    res[nm] = (r, lo, hi, p, r1, r2, gross, int(big.sum()))
order = sorted(range(3), key=lambda i: res[list(res)[i]][3]); keep = -1
for rk, ix in enumerate(order): keep = rk if res[list(res)[ix]][3] <= (rk + 1) / 3 * 0.10 else keep
sv = {list(res)[ix]: rk <= keep for rk, ix in enumerate(order)}
for nm, (r, lo, hi, p, r1, r2, gross, nb) in res.items():
    ok = sv[nm] and (lo > 0 or hi < 0) and np.sign(r1) == np.sign(r2) == np.sign(r) and abs(gross) > 1.25
    print(f'{nm:18s} Spearman {r:+.3f} CI [{lo:+.3f}, {hi:+.3f}] placebo p {p:.3f} halves {r1:+.3f} / {r2:+.3f} BH {"survives" if sv[nm] else "no"} | strong-|f| third (N {nb}) gross of trading the sign: {gross:+.2f} points (cost 1.25){"  <== CANDIDATE" if ok else ""}')
yr = np.array([d[:4] for d in dates]); print('uncounted by year (Spearman f2 vs y): ' + ', '.join(f'{u} {np.corrcoef(rankdata(R[yr == u, 1]), rankdata(y[yr == u]))[0, 1]:+.3f} (N {int((yr == u).sum())})' for u in sorted(set(yr))))
