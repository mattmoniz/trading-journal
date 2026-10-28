"""AMT option 3: accepted vs rejected first excursion. Stages census|explore|holdout. PREREG.md frozen. Usage: ../../venv/bin/python amt_excursion.py <stage>"""
import sys, json, pathlib, datetime
import numpy as np
import pandas as pd
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/macro_regime')
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/ml_meta_labeling')
from loader import load_raw_sessions  # noqa: E402
from db import get_connection  # noqa: E402

SEED, BOOT, K, TRIM_Q, MIN_STATE, MIN_RETAINED = 20261028, 3000, 5, 90, 30, 0.5
SPLIT = '2025-05-16'; WAIT, HORIZON = 30, 60
HERE = pathlib.Path(__file__).parent
COLS = ['e_off', 'depth', 'agap', 'prng', 'onr']


def day_table():
    conn = get_connection(); cur = conn.cursor()
    cur.execute("""SELECT trade_date::text, atr20::float, prior_vah::float, prior_val::float, open_0930::float, ib_high::float, ib_low::float,
                   gap_atr::float, onr_atr::float, prng_atr::float FROM amt_daily_state WHERE trade_date < '2026-10-27' ORDER BY trade_date""")
    t = pd.DataFrame(cur.fetchall(), columns=['d', 'atr', 'vah', 'val', 'O', 'ibh', 'ibl', 'gap', 'onr', 'prng']); conn.close(); return t


def min_arrays(df):
    """Per-minute arrays offset 0..389 (09:30..15:59), NaN where a minute is missing."""
    off = (df.index.hour * 60 + df.index.minute - 570).to_numpy(); a = {k: np.full(390, np.nan) for k in ('h', 'l', 'c', 'v')}
    for k, col in (('h', 'High'), ('l', 'Low'), ('c', 'Close'), ('v', 'Volume')): a[k][off] = df[col].to_numpy(float)
    return a


def build(delay=WAIT):
    S = load_raw_sessions(); t = day_table(); full_vol = []; rows = []; drops = {}
    arr = {d: min_arrays(S[d]) for d in S}
    fullset = [d for d in sorted(S) if len(S[d]) >= 385]
    prior_idx = {d: i for i, d in enumerate(fullset)}
    def bump(k): drops[k] = drops.get(k, 0) + 1
    for _, r in t.iterrows():
        d = r.d; a = arr[d]
        i = prior_idx.get(d)
        vols = [arr[x]['v'] for x in fullset[max(0, i - 20):i]] if i else []
        for fam in ('PRIOR_VALUE', 'IB'):
            if fam == 'PRIOR_VALUE':
                if not (r.val <= r.O <= r.vah): bump('PV_open_outside'); continue
                start, up_lvl, dn_lvl = 0, r.vah, r.val
            else:
                start, up_lvl, dn_lvl = 60, r.ibh, r.ibl
            e = None
            for m in range(start, 390):
                hu, ld = a['h'][m] > up_lvl, a['l'][m] < dn_lvl
                if np.isnan(a['h'][m]): continue
                if hu and ld: e = -1; break
                if hu or ld: e = m; s = 1 if hu else -1; break
            if e is None: bump(fam + '_no_excursion'); continue
            if e == -1: bump(fam + '_both_sides_same_bar'); continue
            if e > 389 - delay - HORIZON: bump(fam + '_too_late'); continue
            T = e + delay; END = T + HORIZON
            if np.isnan(a['c'][T]) or np.isnan(a['c'][END]) or np.isnan(a['h'][e:T + 1]).any(): bump(fam + '_missing_minutes'); continue
            lvl = up_lvl if s == 1 else dn_lvl
            accepted = (a['c'][T] > lvl) if s == 1 else (a['c'][T] < lvl)
            depth = (np.nanmax(a['h'][e:T + 1]) - lvl if s == 1 else lvl - np.nanmin(a['l'][e:T + 1])) / r.atr
            rv = np.nan
            if len(vols) == 20:
                base = np.mean([np.nansum(v[e:T + 1]) for v in vols]); rv = float(np.nansum(a['v'][e:T + 1]) / base) if base > 0 else np.nan
            rows.append(dict(fam=fam, d=d, s=s, e_off=e, state='ACCEPTED' if accepted else 'REJECTED', depth=float(depth), rv=rv,
                             y=float(s * (a['c'][END] - a['c'][T]) / r.atr), agap=abs(r.gap), prng=r.prng, onr=r.onr))
    df = pd.DataFrame(rows); df['block'] = np.where(df.d <= SPLIT, 'EXPLORE', 'HOLDOUT'); return df, drops


def maha(A, B, P):
    d = A[:, None, :] - B[None, :, :]; return np.sqrt(np.einsum('ijk,kl,ijl->ij', d, P, d))


def day_boot(vals, days, rng, iters=BOOT):
    g = {}
    for v, d in zip(vals, days): g.setdefault(d, []).append(v)
    arrs = [np.array(x) for x in g.values()]; m = len(arrs); out = np.empty(iters)
    for b in range(iters): out[b] = np.concatenate([arrs[j] for j in rng.integers(0, m, m)]).mean()
    return out


def contrast(b, kk=K):
    b = b.dropna(subset=COLS); acc = b[b.state == 'ACCEPTED']; rej = b[b.state == 'REJECTED']
    if len(acc) < MIN_STATE or len(rej) < max(MIN_STATE, kk + 5): return None
    P = np.linalg.pinv(np.cov(b[COLS].to_numpy().T)); Xr = rej[COLS].to_numpy()
    dd = maha(Xr, Xr, P); np.fill_diagonal(dd, np.inf); thr = np.percentile(dd.min(axis=1), TRIM_Q)
    Ds = maha(acc[COLS].to_numpy(), Xr, P); idx = np.argsort(Ds, axis=1)[:, :kk]; keep = Ds.min(axis=1) <= thr
    c = acc.y.to_numpy() - rej.y.to_numpy()[idx].mean(axis=1)
    return pd.DataFrame(dict(c=c[keep], d=acc.d.to_numpy()[keep], s=acc.s.to_numpy()[keep])), float(keep.mean())


def fam_stats(blk, fam, rng, kk=K):
    b = blk[blk.fam == fam]; out = dict(fam=fam, n=len(b), n_acc=int((b.state == 'ACCEPTED').sum()), n_rej=int((b.state == 'REJECTED').sum()))
    if out['n_acc'] < MIN_STATE or out['n_rej'] < MIN_STATE: out['status'] = 'NOT EVALUATED'; return out
    mu = b.y.mean()
    for st in ('ACCEPTED', 'REJECTED'):
        x = (b[b.state == st].y - mu).to_numpy(); bm = day_boot(x, b[b.state == st].d.to_numpy(), rng, 1500)
        out['E_' + st] = (float(x.mean()), float(np.percentile(bm, 2.5)), float(np.percentile(bm, 97.5)))
    r = contrast(b, kk)
    if r is None: out['ctrl'] = 'NOT EVALUABLE'; return out
    cdf, share = r; out['retained'] = share
    if share < MIN_RETAINED: out['ctrl'] = 'NOT EVALUABLE (retained %.0f%%)' % (100 * share); return out
    bm = day_boot(cdf.c.to_numpy(), cdf.d.to_numpy(), rng)
    out.update(D=float(cdf.c.mean()), lo95=float(np.percentile(bm, 2.5)), hi95=float(np.percentile(bm, 97.5)), lb975=float(np.percentile(bm, 2.5)), lb95=float(np.percentile(bm, 5)),
               D_up=float(cdf[cdf.s == 1].c.mean()), D_dn=float(cdf[cdf.s == -1].c.mean()), n_up=int((cdf.s == 1).sum()), n_dn=int((cdf.s == -1).sum()))
    th = np.array_split(np.arange(len(cdf)), 3); out['thirds'] = [float(cdf.c.to_numpy()[i].mean()) for i in th]
    return out


def fmt(o):
    h = f"  {o['fam']:11s} events={o['n']} (accepted {o['n_acc']}, rejected {o['n_rej']})"
    if 'status' in o: return h + ' ' + o['status']
    h += f"\n     excess vs family mean: ACCEPTED {o['E_ACCEPTED'][0]:+.4f} (CI {o['E_ACCEPTED'][1]:+.4f}..{o['E_ACCEPTED'][2]:+.4f}) | REJECTED {o['E_REJECTED'][0]:+.4f} (CI {o['E_REJECTED'][1]:+.4f}..{o['E_REJECTED'][2]:+.4f})"
    if 'D' in o: h += f"\n     PRIMARY D (accepted minus matched rejected) = {o['D']:+.4f} ATR20 (95% CI {o['lo95']:+.4f}..{o['hi95']:+.4f}) retained={100 * o['retained']:.0f}% | UP {o['D_up']:+.4f} (n={o['n_up']}) DOWN {o['D_dn']:+.4f} (n={o['n_dn']}) | thirds={[round(t, 3) for t in o['thirds']]}"
    else: h += f"\n     matched contrast: {o.get('ctrl')}"
    return h


def main(stage):
    df, drops = build(); rng = np.random.default_rng(SEED)
    print(f"Events: {len(df)} | drops: {drops}")
    if stage == 'census':
        for blk in ('EXPLORE', 'HOLDOUT'):
            for fam in ('PRIOR_VALUE', 'IB'):
                b = df[(df.block == blk) & (df.fam == fam)]
                print(f"{blk} {fam}: events={len(b)} accepted={int((b.state=='ACCEPTED').sum())} rejected={int((b.state=='REJECTED').sum())} days={b.d.nunique()}")
                r = contrast(b)
                print('    matched-control support: ' + ('n/a' if r is None else f"retained {100 * r[1]:.0f}% of accepted"))
        return
    if stage == 'explore':
        print('\nEXPLORE (one-sided 97.5% lower bound = lower end of the 95% CI)'); res = {}
        for fam in ('PRIOR_VALUE', 'IB'):
            o = fam_stats(df[df.block == 'EXPLORE'], fam, rng); res[fam] = o; print(fmt(o))
            o1 = fam_stats(df[df.block == 'EXPLORE'], fam, rng, kk=1)
            if 'D' in o1: print(f"     [sensitivity K=1] D={o1['D']:+.4f} (CI {o1['lo95']:+.4f}..{o1['hi95']:+.4f})")
        sig = {f: bool(res[f].get('lb975', -1) > 0) for f in res}
        print('\nExplore signal per family:', sig)
        print('CLOSED at explore; hold-out NOT opened.' if not any(sig.values()) else 'Hold-out may be opened ONCE for: ' + ', '.join(k for k, v in sig.items() if v))
        json.dump(dict(sig=sig, res=res, run=datetime.datetime.now().isoformat()), open(HERE / 'explore_result.json', 'w'), indent=1, default=float); return
    if stage == 'holdout':
        ex = json.load(open(HERE / 'explore_result.json')); lock = HERE / 'holdout.lock'
        if lock.exists(): raise RuntimeError('HOLD-OUT ALREADY LOOKED AT ONCE (holdout.lock).')
        fams = [k for k, v in ex['sig'].items() if v]
        if not fams: raise RuntimeError('No explore signal: hold-out stays unopened.')
        lock.write_text(datetime.datetime.now().isoformat()); print('\nHOLD-OUT (single look; one-sided 95% lower bound)')
        for f in fams:
            o = fam_stats(df[df.block == 'HOLDOUT'], f, rng); print(fmt(o))
            conf = o.get('lb95', -1) > 0 and o.get('retained', 0) >= MIN_RETAINED and o.get('D_up', -1) > 0 and o.get('D_dn', -1) > 0
            print(f"  {f}: CONFIRMED ON HELD-OUT HISTORY={conf}")


if __name__ == '__main__':
    main(sys.argv[1])
