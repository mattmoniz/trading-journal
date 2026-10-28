"""POST-HOC (not pre-registered): placebo for the market-entry diagnostic. Explore only."""
import numpy as np, pandas as pd, run as R, breakout as B, engine as E
from amt_s1 import overnight_ranges
raw = E.load_sessions(); ex = [s for s in E.build_eligible(raw) if s['d'] <= R.SPLIT]; by = {s['d']: s for s in ex}
tr = pd.read_csv('trades_ignition_market_explore.csv').to_dict('records'); rng = np.random.default_rng(R.SEED)
real = np.mean([t['net'] for t in tr]); res = []
for _ in range(1000):
    v = []
    for t in tr:
        a = by[t['date']]['a']; i = int(rng.integers(B.WIN_LO + 1, B.WIN_HI + 1))
        while np.isnan(a['o'][i]): i = int(rng.integers(B.WIN_LO + 1, B.WIN_HI + 1))
        entry_slip = 2 * B.SLIP * B.DPP  # give the placebo the same 1-tick entry slippage the real market entry pays
        v.append(B.stripped(a, i, int(rng.choice([-1, 1])), B.HARD, B.TGT) - entry_slip)
    res.append(np.mean(v))
res = np.array(res)
# direction-matched: random time, but the REAL direction of each signal
res2 = []
for _ in range(1000):
    v = []
    for t in tr:
        a = by[t['date']]['a']; i = int(rng.integers(B.WIN_LO + 1, B.WIN_HI + 1))
        while np.isnan(a['o'][i]): i = int(rng.integers(B.WIN_LO + 1, B.WIN_HI + 1))
        v.append(B.stripped(a, i, t['dir'], B.HARD, B.TGT) - 2 * B.SLIP * B.DPP)
    res2.append(np.mean(v))
res2 = np.array(res2)
print(f"market-entry ignition N={len(tr)} real mean ${real:.2f}")
print(f"random time+direction placebo: p5 {np.percentile(res,5):.2f} p50 {np.percentile(res,50):.2f} p95 {np.percentile(res,95):.2f} | trials >= real {100*np.mean(res>=real):.1f}%")
print(f"random time, real direction:   p5 {np.percentile(res2,5):.2f} p50 {np.percentile(res2,50):.2f} p95 {np.percentile(res2,95):.2f} | trials >= real {100*np.mean(res2>=real):.1f}%")
