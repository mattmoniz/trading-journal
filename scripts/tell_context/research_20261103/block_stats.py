"""Day-block bootstrap helpers shared by the tell-trades studies (trades on one day are correlated, so days are resampled). Each takes the caller's numpy Generator so a script keeps its own seed and draw order."""
import collections
import numpy as np

def bootmean(x, days, rng, B=2000):
    g = collections.defaultdict(list); [g[d].append(v) for d, v in zip(days, x)]; arr = [np.array(v) for v in g.values()]; m = len(arr)
    s = [np.concatenate([arr[j] for j in rng.integers(0, m, m)]).mean() for _ in range(B)]; return float(np.quantile(s, .025)), float(np.quantile(s, .975))
def bootdiff(x1, d1, x0, d0, rng, B=2000):
    g1, g0 = collections.defaultdict(list), collections.defaultdict(list); [g1[d].append(v) for d, v in zip(d1, x1)]; [g0[d].append(v) for d, v in zip(d0, x0)]; a1, a0 = [np.array(v) for v in g1.values()], [np.array(v) for v in g0.values()]
    s = [np.concatenate([a1[j] for j in rng.integers(0, len(a1), len(a1))]).mean() - np.concatenate([a0[j] for j in rng.integers(0, len(a0), len(a0))]).mean() for _ in range(B)]; return float(np.quantile(s, .025)), float(np.quantile(s, .975))
def grp(df, col, rng): x = df[col].values; c = bootmean(x, df.date.values, rng); return f'N={len(x):4d} mean ${x.mean():+7.2f} WR {100 * (x > 0).mean():3.0f}% CI [{c[0]:+.1f}, {c[1]:+.1f}]' + ('  (N<20: not a result)' if len(x) < 20 else '')
def contrast(name, a, b, col, rng):
    if len(a) < 20 or len(b) < 20: return f'  {name}: a group has N<20, no contrast'
    c = bootdiff(a[col].values, a.date.values, b[col].values, b.date.values, rng); return f'  {name}: {a[col].mean() - b[col].mean():+7.2f} dollars/trade  day-block CI [{c[0]:+.1f}, {c[1]:+.1f}]'


def auc(x, y):
    """Mann-Whitney AUC of score x for the boolean label y (mid-ranks for ties); 0.5 = no information."""
    x = np.asarray(x, float); y = np.asarray(y, bool)
    if y.sum() == 0 or (~y).sum() == 0: return float('nan')
    o = np.argsort(x, kind='mergesort'); xs = x[o]; rk = np.empty(len(x)); i = 0
    while i < len(x):
        j = i
        while j + 1 < len(x) and xs[j + 1] == xs[i]: j += 1
        rk[o[i:j + 1]] = (i + j) / 2 + 1; i = j + 1
    return float((rk[y].sum() - y.sum() * (y.sum() + 1) / 2) / (y.sum() * (~y).sum()))


def week_boot(df, fn, rng, B=2000, key='wk'):
    """Week-block bootstrap 95 percent CI of fn(sample df); df needs a `wk` column and a clean RangeIndex."""
    g = {k: v.index.values for k, v in df.groupby(key)}; keys = list(g); out = []
    for _ in range(B):
        ix = np.concatenate([g[keys[i]] for i in rng.integers(0, len(keys), len(keys))]); out.append(fn(df.loc[ix]))
    out = [o for o in out if not np.isnan(o)]; return float(np.quantile(out, .025)), float(np.quantile(out, .975))
