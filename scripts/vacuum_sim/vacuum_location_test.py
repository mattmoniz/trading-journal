"""VACUUM LOCATION x EXTENSION TEST (docs/VACUUM_LOCATION_EXTENSION_PREREG_20261109.md): 4 counted tests L1 / L2 per track on the explore events (primary), 2026 sign gate, Holm 0.10. H = the live rule's 30-bar net outcome in points (cached `context_exit_event_sims_20261109.csv`).
Frozen choices: terciles per track from the explore events; NEAR_BEHIND = behind_dist <= its tercile 1 cut (no level behind = not near); CLEAR_AIR = (no level ahead OR ahead_dist >= its tercile 3 cut) OR behind_cross_min <= 3. NO live change follows.
Modes: --prep (counts only, no outcome) | --go (reads H; ledger look 'vac_loc_register_20261109')."""
import os, sys, json
import numpy as np, pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import context_exit_tests as CT
GO = '--go' in sys.argv; PREP = '--prep' in sys.argv
if GO == PREP: sys.exit('usage: --prep | --go')
OUTD = CT.OUTD; B, PERM = 4000, 2000; rng = np.random.default_rng(20261115)
sims = pd.read_csv(os.path.join(OUTD, 'context_exit_event_sims_20261109.csv')); ev = json.load(open(os.path.join(OUTD, 'vac_events_for_tags.json'))); tags = json.load(open(os.path.join(OUTD, 'vac_location_tags.json')))
sims['key'] = sims.date + '|' + sims.track + '|' + sims.k.astype(str) + '|' + sims.dir.astype(str)
tg = pd.DataFrame.from_dict(tags, orient='index'); tg.index.name = 'key'; sims = sims.merge(tg, left_on='key', right_index=True, how='left')
sims = CT.classify(sims.drop(columns=[c for c in ['H', 'R', 'R2', 'Hm'] if (c in sims.columns and not GO)], errors='ignore'))      # extension flag by the frozen registered rule; outcome columns are dropped in --prep
sims['tagged'] = sims.adr.notna() if 'adr' in sims.columns and False else sims.n_levels.notna()
print('events', len(sims), 'tagged', int(sims.tagged.sum()), '| by corpus', sims.groupby('corpus').tagged.sum().to_dict(), '| by track', sims.groupby('track').tagged.sum().to_dict())
cuts = {}
for tr in ('RTH', 'GBX'):
    e = sims[(sims.corpus == 'replication') & (sims.track == tr) & sims.tagged]
    cuts[tr] = dict(b33=float(np.nanquantile(e.behind_dist, 1 / 3)), a67=float(np.nanquantile(e.ahead_dist, 2 / 3)))
    print(f'{tr}: tercile cuts from the explore events (n {len(e)}): NEAR_BEHIND if behind_dist <= {cuts[tr]["b33"]:.3f} ADR20; CLEAR_AIR if ahead_dist >= {cuts[tr]["a67"]:.3f} ADR20 (or no level ahead) or behind_cross_min <= 3')
def flags(d):
    d = d.copy(); c = d.track.map(cuts)
    d['near'] = d.behind_dist.notna() & (d.behind_dist <= c.map(lambda x: x['b33'])); d['clear'] = (d.ahead_dist.isna() | (d.ahead_dist >= c.map(lambda x: x['a67']))) | (d.behind_cross_min.notna() & (d.behind_cross_min <= 3)); return d
sims = flags(sims)
for corpus in ('replication', 'primary'):
    for tr in ('RTH', 'GBX'):
        e = sims[(sims.corpus == corpus) & (sims.track == tr) & sims.tagged]; x = e[e.ext == 1.0]
        print(f'{corpus:11s}{tr}: events {len(e)}; EXT {len(x)} (NEAR_BEHIND {int(x.near.sum())} / other {int((~x.near).sum())}); CLEAR_AIR {int(e.clear.sum())} / other {int((~e.clear).sum())}; days {e.date.nunique()}')
if PREP: sys.exit(0)
def contrast(d, a, y='H'):
    A = d[a]; Bg = d[~a]
    return float(A[y].mean() - Bg[y].mean()) if len(A) and len(Bg) else float('nan')
def day_arrays(d, a, y='H'):
    g = pd.DataFrame(dict(date=d.date.values, a=a.values, y=d[y].values)); u = np.sort(g.date.unique()); idx = {x: i for i, x in enumerate(u)}; di = g.date.map(idx).values
    sA = np.bincount(di, weights=g.y.values * g.a.values, minlength=len(u)); nA = np.bincount(di, weights=g.a.values.astype(float), minlength=len(u)); sB = np.bincount(di, weights=g.y.values * (~g.a.values), minlength=len(u)); nB = np.bincount(di, weights=(~g.a.values).astype(float), minlength=len(u))
    return u, sA, nA, sB, nB
def boot_c(d, a):
    u, sA, nA, sB, nB = day_arrays(d, a); out = np.empty(B)
    for i in range(B):
        k = rng.integers(0, len(u), len(u)); na, nb = nA[k].sum(), nB[k].sum(); out[i] = (sA[k].sum() / na - sB[k].sum() / nb) if na and nb else np.nan
    return out[~np.isnan(out)]
def perm_p(d, a, sign):
    obs = contrast(d, a); dd = d.date.values; av = a.values.copy(); yv = d.H.values; groups = pd.Series(range(len(d))).groupby(dd).apply(list).values; cnt = 0
    for _ in range(PERM):
        p = av.copy()
        for g in groups: p[g] = av[rng.permutation(g)] if len(g) > 1 else av[g]
        c = yv[p].mean() - yv[~p].mean(); cnt += (c <= obs) if sign < 0 else (c >= obs)
    return cnt / PERM
def win(y, q=.05): lo, hi = np.quantile(y, [q, 1 - q]); return np.clip(y, lo, hi)
def run_test(name, d, a, sign, d2):
    n1, n0 = int(a.sum()), int((~a).sum()); days1 = d[a].date.nunique(); days0 = d[~a].date.nunique(); res = dict(name=name, n1=n1, n0=n0)
    if min(n1, n0) < 30 or min(days1, days0) < 10: print(f'  {name}: cells {n1}/{n0} events, {days1}/{days0} days: BELOW the 30-events / 10-days floor, no verdict'); res['p'] = 1.0; res['floor'] = False; return res
    c = contrast(d, a); bt = boot_c(d, a); p = float((bt >= 0).mean()) if sign < 0 else float((bt <= 0).mean())
    dw = d.copy(); dw['H'] = win(d.H.values); cw = contrast(dw, a)
    days = sorted(d.date.unique()); loo = []
    for x in days: m = d.date != x; loo.append(contrast(d[m], a[m]))
    loo = np.array([v for v in loo if v == v]); dd = d.copy(); aa = a.copy(); drop = []
    for _ in range(2):
        best = None
        for x in sorted(dd.date.unique()):
            m = dd.date != x; v = contrast(dd[m], aa[m])
            if v == v and (best is None or (v > best[1] if sign < 0 else v < best[1])): best = (x, v)
        dd = dd[dd.date != best[0]]; aa = aa[dd.index]; drop.append(best[0])
    c2 = contrast(dd, aa); mid = np.sort(d.date.unique())[len(d.date.unique()) // 2]; h1 = contrast(d[d.date <= mid], a[d.date <= mid]); h2 = contrast(d[d.date > mid], a[d.date > mid])
    e2 = d2[a2_mask(d2, name)]; c26 = contrast(e2, a2_series(e2, name)) if len(e2) else float('nan')
    sd = float(np.sqrt(d[a].H.var() / n1 + d[~a].H.var() / n0)); mde = 2.49 * sd
    pp = perm_p(d, a, sign); gates = dict(winsor_sign=bool(np.sign(cw) == sign), drop_top2_sign=bool(np.sign(c2) == sign), loo_sign=bool(np.all(np.sign(loo) == sign)), halves=bool(np.sign(h1) == sign and np.sign(h2) == sign), sign_gate_2026=bool(np.sign(c26) == sign), placebo_p=bool(pp <= 0.10))
    print(f'  {name}: cells {n1}/{n0} events ({days1}/{days0} days); contrast {c:+.2f} pt CI90 [{np.quantile(bt, .05):+.2f}, {np.quantile(bt, .95):+.2f}] one-sided p {p:.3f}; winsor {cw:+.2f}; drop-top2 {c2:+.2f}; LOO sign {"stable" if gates["loo_sign"] else "FLIPS"}; halves {h1:+.2f}/{h2:+.2f}; 2026 sign gate {c26:+.2f}; label-permutation p {pp:.3f}; MDE {mde:.2f} pt = {mde/474:.4f} ADR20')
    print(f'      gates {gates}'); res.update(p=p, floor=True, gates=gates, c=c); return res
def a2_mask(d, name): return (d.ext == 1.0) if name.startswith('L1') else d.tagged
def a2_series(d, name): return d.near if name.startswith('L1') else d.clear
print('\n=== COUNTED (explore corpus; 2026 as the sign gate) ===')
results = []
for tr in ('RTH', 'GBX'):
    ex = sims[(sims.corpus == 'replication') & (sims.track == tr) & sims.tagged & sims.H.notna()]; s26 = sims[(sims.corpus == 'primary') & (sims.track == tr) & sims.tagged & sims.H.notna()]
    d1 = ex[ex.ext == 1.0]; results.append(run_test(f'L1_{tr} (EXTENDED: NEAR_BEHIND minus other; expected lower)', d1, d1.near, -1, s26))
    results.append(run_test(f'L2_{tr} (CLEAR_AIR minus other; expected higher)', ex, ex.clear, +1, s26))
order = sorted(results, key=lambda r: r['p']); alive = True; holm = {}
for i, r in enumerate(order): alive = alive and r.get('floor', False) and r['p'] <= 0.10 / (len(order) - i); holm[r['name']] = alive
print('\nHolm 0.10 over the 4 tests:'); 
for r in results: print(f'  {r["name"]}: p {r["p"]:.3f}, floor {r.get("floor")}, Holm pass {holm[r["name"]]}, gates {"all pass" if r.get("gates") and all(r["gates"].values()) else ("n/a" if not r.get("gates") else [k for k, v in r["gates"].items() if not v])} -> {"LEAD" if holm[r["name"]] and r.get("gates") and all(r["gates"].values()) else "not shown"}')
print('\n=== DESCRIPTIVE ===')
for corpus in ('replication', 'primary'):
    for tr in ('RTH', 'GBX'):
        e = sims[(sims.corpus == corpus) & (sims.track == tr) & sims.tagged & sims.H.notna()]; print(f'{corpus} {tr}: all mean H {e.H.mean():+.2f} (n {len(e)})')
        for lab, m in (('EXT & NEAR_BEHIND', (e.ext == 1.0) & e.near), ('EXT & not near', (e.ext == 1.0) & ~e.near), ('not EXT & NEAR_BEHIND', (e.ext == 0.0) & e.near), ('not EXT & not near', (e.ext == 0.0) & ~e.near), ('EXT & CLEAR', (e.ext == 1.0) & e.clear), ('EXT & not clear', (e.ext == 1.0) & ~e.clear), ('not EXT & CLEAR', (e.ext == 0.0) & e.clear), ('not EXT & not clear', (e.ext == 0.0) & ~e.clear)):
            g = e[m]; print(f'    {lab:24s} n {len(g):5d} mean H {g.H.mean() if len(g) else float("nan"):+7.2f}')
for tr in ('RTH', 'GBX'):
    e = sims[(sims.corpus == 'replication') & (sims.track == tr) & sims.tagged & sims.H.notna()].copy(); e['taken_lock'] = CT.lock_taken(e, 'holdH'); t = e[e['taken_lock']]
    if len(t) > 60: print(f'lock-applied explore {tr}: taken {len(t)}; CLEAR minus other {contrast(t, t.clear):+.2f}; EXT NEAR minus other EXT {contrast(t[t.ext == 1.0], t[t.ext == 1.0].near):+.2f}')
