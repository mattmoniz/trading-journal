"""Trailing-floor account simulator for the regime risk test (docs/REGIME_RISK_TEST_PREREG_20261102.md). SHADOW, pure functions, no database.
Trade model: K=4 sequential window trades per day, random direction, entry at the window open, exit at its last close; per (day, window, direction) only the worst adverse excursion `adv` and the final move `fin` (points) matter, so a stop is one comparison. Dollar P&L = 2 x points - 2.50; a stop fills SLIP points through."""
import numpy as np
D, T, COST, SLIP, PT, F, G, SMIN, K = 2000.0, 3000.0, 2.5, 1.0, 2.0, 0.15, 0.2, 9.25, 4
ARMS = {'C0': dict(stop=None, busy=False), 'C1': dict(stop='cushion', busy=False), 'C2': dict(stop='budget', busy=False), 'C3': dict(stop=None, busy=True), 'C4': dict(stop='budget', busy=True)}

def windows(bars, g):
    """adv[nd,K,2], fin[nd,K,2] in points; dir 0 long, 1 short; g = favourable drift (points per trade, linear over the window; 0 for the pure market, ((E/K)+COST)/2 for an edge scenario E dollars/day)."""
    nd = len(bars); adv = np.zeros((nd, K, 2)); fin = np.zeros((nd, K, 2))
    for d, b in enumerate(bars):
        o, h, l, c = (np.asarray(b[x], float) for x in ('o', 'h', 'l', 'c')); n = len(o); per = n // K
        for k in range(K):
            lo, hi = k * per, (n if k == K - 1 else (k + 1) * per); m = hi - lo; sh = g * np.arange(1, m + 1) / m; e = o[lo]
            adv[d, k, 0] = max(0.0, float(np.max(e - (l[lo:hi] + sh)))); fin[d, k, 0] = c[hi - 1] + sh[-1] - e
            adv[d, k, 1] = max(0.0, float(np.max((h[lo:hi] - sh) - e))); fin[d, k, 1] = e - (c[hi - 1] - sh[-1])
    return adv, fin

def run_paths(adv, fin, busy, idx, dirs, arm, bal0=None, best0=None):
    """idx[P,H] day indices, dirs[P,H,K] in {0,1}. Returns status[P] (1 pass, 2 breach, 3 frozen, 0 open at the horizon), the day of pass/breach and the final balance."""
    cfg = ARMS[arm] if isinstance(arm, str) else arm; P, H = idx.shape
    bal = np.zeros(P) if bal0 is None else np.array(bal0, float); best = np.maximum(bal, 0.0) if best0 is None else np.array(best0, float)
    status = np.zeros(P, int); when = np.full(P, -1)
    for day in range(H):
        act = status == 0
        if not act.any(): break
        di = idx[:, day]; floor = best - D; c0 = bal - floor; skip = act & (busy[di] if cfg['busy'] else False)
        if cfg['stop']:
            s0 = F * c0 / 2 if cfg['stop'] == 'cushion' else np.minimum(F * c0 / 2, G * c0 / 2)
            fr = act & (s0 < SMIN); status[fr] = 3; act = status == 0
        trading = act & ~skip; daypnl = np.zeros(P)
        for k in range(K):
            c = bal - floor
            if cfg['stop'] == 'cushion': S = F * c / 2
            elif cfg['stop'] == 'budget': S = np.minimum(F * c / 2, (G * c0 + daypnl) / 2)
            else: S = np.full(P, np.inf)
            if cfg['stop']: trading = trading & (S >= SMIN)
            a = adv[di, k, dirs[:, day, k]]; f = fin[di, k, dirs[:, day, k]]; stopped = a >= S
            dip = bal - PT * np.where(stopped, S + SLIP, a)
            pnl = np.where(stopped, -(S + SLIP) * PT - COST, f * PT - COST)
            br = trading & (dip < floor); status[br] = 2; when[br] = day; trading = trading & ~br
            bal = np.where(trading, bal + pnl, bal); daypnl = np.where(trading, daypnl + pnl, daypnl)
        live = status == 0; best = np.where(live, np.maximum(best, bal), best)
        ps = live & (bal >= T); status[ps] = 1; when[ps] = day
    return status, when, bal

def draw(ND, P, H, rng, block=1):
    if block == 1: idx = rng.integers(0, ND, (P, H))
    else:
        nb = -(-H // block); st = rng.integers(0, ND, (P, nb)); idx = ((st[:, :, None] + np.arange(block)) % ND).reshape(P, nb * block)[:, :H]
    return idx, rng.integers(0, 2, (P, H, K))

def run_arms(adv, fin, busy, arms, pools=40, paths=500, H=250, seed=1, block=1, pool_resample=True):
    """paired: every arm sees the same days and directions. Returns {arm: array[pools, 4] = pass, breach, frozen, open share} and median pass day."""
    out = {a: np.zeros((pools, 4)) for a in arms}; days = {a: [] for a in arms}
    for p in range(pools):
        rng = np.random.default_rng(seed * 1000003 + p); pool = rng.integers(0, len(busy), len(busy)) if pool_resample else np.arange(len(busy))   # one bootstrap day pool per pool: the CI then carries day-sampling uncertainty, not only Monte Carlo noise
        adv_p, fin_p, busy_p = adv[pool], fin[pool], busy[pool]; idx, dirs = draw(len(busy), paths, H, rng, block)
        for a in arms:
            s, w, _ = run_paths(adv_p, fin_p, busy_p, idx, dirs, a); out[a][p] = [np.mean(s == 1), np.mean(s == 2), np.mean(s == 3), np.mean(s == 0)]; days[a] += list(w[s == 1])
    return out, {a: (float(np.median(v)) if v else float('nan')) for a, v in days.items()}

def paired(out, a, b, col):
    """arm b minus arm a in percentage points on the paired pools: mean and 95% CI (pool-level SD)."""
    d = 100 * (out[b][:, col] - out[a][:, col]); m = float(d.mean()); h = 1.96 * float(d.std(ddof=1)) / np.sqrt(len(d)); return m, m - h, m + h
