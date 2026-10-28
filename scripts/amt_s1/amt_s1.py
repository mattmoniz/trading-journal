"""AMT S1 study. Stages: census | explore | holdout. See PREREG.md (frozen). Usage: ../../venv/bin/python amt_s1.py <stage>"""
import sys, json, pathlib, datetime
import numpy as np
import pandas as pd
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/macro_regime')
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/ml_meta_labeling')
from loader import load_raw_sessions, build_prior_va_dict  # noqa: E402
from db import get_connection  # noqa: E402

SEED = 20261028
BOOT, BOOT_CTRL = 5000, 2000
K, TRIM_Q, MIN_STATE_N, MIN_RETAINED = 5, 90, 30, 0.5
EXPLORE_SHARE = 0.60
HERE = pathlib.Path(__file__).parent


def overnight_ranges(start='2023-01-01', end='2026-10-27'):
    conn = get_connection(); cur = conn.cursor(); cur.execute("SET statement_timeout='120s'")
    s = pd.Timestamp(start).replace(day=1); e = pd.Timestamp(end); frames = []
    while s < e:
        nxt = s + pd.offsets.MonthBegin(1)
        cur.execute("""SELECT ts, high::float, low::float FROM price_bars_primary
                       WHERE symbol='NQ' AND ts >= %s AND ts < %s AND (ts::time >= '18:00' OR ts::time < '09:30')""",
                    (max(s, pd.Timestamp(start)).to_pydatetime(), min(nxt, e).to_pydatetime()))
        rows = cur.fetchall()
        if rows: frames.append(pd.DataFrame(rows, columns=['ts', 'high', 'low']))
        s = nxt
    conn.close()
    df = pd.concat(frames); df['ts'] = pd.to_datetime(df['ts'])
    df['d'] = np.where(df.ts.dt.hour >= 18, (df.ts.dt.normalize() + pd.Timedelta(days=1)), df.ts.dt.normalize())
    g = df.groupby('d').agg(hi=('high', 'max'), lo=('low', 'min'), n=('high', 'size'))
    g.index = [pd.Timestamp(i).strftime('%Y-%m-%d') for i in g.index]
    return g


def build_table():
    S = load_raw_sessions(); prior, _ = build_prior_va_dict(S)
    ks = sorted(S); full = {k: (len(S[k]) >= 385 and S[k].index[0].strftime('%H:%M') == '09:30' and S[k].index[-1].strftime('%H:%M') == '15:59') for k in ks}
    on = overnight_ranges(); rows = []; hist_rng = []
    for i, d in enumerate(ks):
        df = S[d]
        if not full[d]:
            continue
        rng = float(df.High.max() - df.Low.min())
        ok = i > 0 and full[ks[i - 1]] and (pd.Timestamp(d) - pd.Timestamp(ks[i - 1])).days <= 5 and not np.isnan(prior[d]['vah']) and len(hist_rng) >= 20
        if ok:
            atr = float(np.mean(hist_rng[-20:])); p = S[ks[i - 1]]
            O = float(df.Open.iloc[0]); va = prior[d]
            ib = df.between_time('09:30', '10:29'); prng = float(p.High.max() - p.Low.min())
            o = on.loc[d] if d in on.index else None
            onr = (float(o.hi - o.lo) / atr) if (o is not None and o.n >= 500) else np.nan
            rows.append(dict(date=d, state='ABOVE' if O > va['vah'] else ('BELOW' if O < va['val'] else 'INSIDE'),
                             y=(float(df.Close.iloc[-1]) - O) / atr, gap=(O - float(p.Close.iloc[-1])) / atr, onr=onr,
                             prng=prng / atr, ibr=float(ib.High.max() - ib.Low.min()) / atr))
        hist_rng.append(rng)
    t = pd.DataFrame(rows); n_exp = int(len(t) * EXPLORE_SHARE)
    t['block'] = ['EXPLORE'] * n_exp + ['HOLDOUT'] * (len(t) - n_exp)
    return t


def match(state_df, donor_df, cols, cov_df, trim_thr=None):
    """Return (retained_mask, control_mean_y per state day, trim_thr). Mahalanobis, K nearest donors."""
    P = np.linalg.pinv(np.cov(cov_df[cols].to_numpy().T))
    def dist(A, B):
        d = A[:, None, :] - B[None, :, :]
        return np.sqrt(np.einsum('ijk,kl,ijl->ij', d, P, d))
    Xd = donor_df[cols].to_numpy(); Xs = state_df[cols].to_numpy()
    if trim_thr is None:
        dd = dist(Xd, Xd); np.fill_diagonal(dd, np.inf); trim_thr = np.percentile(dd.min(axis=1), TRIM_Q)
    D = dist(Xs, Xd); nn = np.sort(D, axis=1)[:, :K]; idx = np.argsort(D, axis=1)[:, :K]
    keep = D.min(axis=1) <= trim_thr
    ctrl = donor_df['y'].to_numpy()[idx].mean(axis=1)
    return keep, ctrl, trim_thr


def side_stats(blk, side, rng, ib_cov=False, one_sided_alpha=0.025, k_boot=BOOT, ctrl_boot=BOOT_CTRL):
    s = 1.0 if side == 'ABOVE' else -1.0
    mu = blk.y.mean(); st = blk[blk.state == side]; n = len(st)
    out = dict(side=side, n_state=n, mu=float(mu))
    if n == 0: return out
    ex = s * (st.y.to_numpy() - mu)
    bm = np.array([ex[rng.integers(0, n, n)].mean() for _ in range(k_boot)])
    out.update(E=float(ex.mean()), lo95=float(np.percentile(bm, 2.5)), hi95=float(np.percentile(bm, 97.5)),
               lb_one_sided_975=float(np.percentile(bm, 2.5)), lb_one_sided_95=float(np.percentile(bm, 5)))
    # thirds sign (descriptive)
    th = np.array_split(np.arange(n), 3); out['thirds'] = [float(ex[i].mean()) for i in th]
    cols = ['gap', 'onr', 'prng'] + (['ibr'] if ib_cov else [])
    b = blk.dropna(subset=cols); st2 = b[b.state == side]; donors = b[b.state == 'INSIDE']
    if len(st2) < MIN_STATE_N or len(donors) < K + 5:
        out.update(ctrl='NOT EVALUABLE (too few)'); return out
    keep, ctrl, thr = match(st2, donors, cols, b)
    out['retained_share'] = float(keep.mean())
    if keep.mean() < MIN_RETAINED:
        out.update(ctrl='NOT EVALUABLE (retained %.0f%% < 50%%)' % (100 * keep.mean())); return out
    cex = (s * (st2.y.to_numpy() - ctrl))[keep]
    out['ctrl_E'] = float(cex.mean())
    # joint bootstrap: resample all block days, redo matching (cov and trim threshold fixed)
    arr = b.reset_index(drop=True); m = len(arr); vals = []
    for _ in range(ctrl_boot):
        samp = arr.iloc[rng.integers(0, m, m)]
        ss = samp[samp.state == side]; dd = samp[samp.state == 'INSIDE']
        if len(ss) < 10 or len(dd) < K: continue
        kp, ct, _ = match(ss, dd, cols, b, trim_thr=thr)
        if kp.sum() < 10: continue
        vals.append((s * (ss.y.to_numpy() - ct))[kp].mean())
    vals = np.array(vals)
    out.update(ctrl_lo95=float(np.percentile(vals, 2.5)), ctrl_hi95=float(np.percentile(vals, 97.5)), ctrl_lb_one_sided_95=float(np.percentile(vals, 5)))
    return out


def show(r):
    if 'E' not in r: print('  ', r); return
    print(f"  {r['side']:6s} N={r['n_state']:3d} excess E={r['E']:+.3f} ATR20 (95% CI {r['lo95']:+.3f}..{r['hi95']:+.3f}) thirds={[round(x,3) for x in r['thirds']]}")
    if 'ctrl_E' in r:
        print(f"         matched control excess={r['ctrl_E']:+.3f} (95% CI {r['ctrl_lo95']:+.3f}..{r['ctrl_hi95']:+.3f}) retained={100*r['retained_share']:.0f}%")
    else:
        print(f"         matched control: {r.get('ctrl')}" + (f" retained={100*r['retained_share']:.0f}%" if 'retained_share' in r else ''))


def main(stage):
    t = build_table(); rng = np.random.default_rng(SEED)
    print(f"Eligible sessions: {len(t)} ({t.date.iloc[0]}..{t.date.iloc[-1]}); EXPLORE {int((t.block=='EXPLORE').sum())} / HOLDOUT {int((t.block=='HOLDOUT').sum())}")
    if stage == 'census':
        for blk in ('EXPLORE', 'HOLDOUT'):
            b = t[t.block == blk]; print(f"\n{blk} {b.date.iloc[0]}..{b.date.iloc[-1]}: " + ', '.join(f"{k}={v}" for k, v in b.state.value_counts().items()))
            bb = b.dropna(subset=['gap', 'onr', 'prng']); print(f"  days with all pre-open covariates: {len(bb)}/{len(b)}")
            for side in ('ABOVE', 'BELOW'):
                st, dn = bb[bb.state == side], bb[bb.state == 'INSIDE']
                if len(st) < MIN_STATE_N: print(f"  {side}: N={len(st)} < {MIN_STATE_N} NOT EVALUATED"); continue
                keep, _, thr = match(st, dn, ['gap', 'onr', 'prng'], bb)
                print(f"  {side}: N={len(st)}, donors={len(dn)}, retained after support trim={100*keep.mean():.0f}% -> control {'EVALUABLE' if keep.mean()>=MIN_RETAINED else 'NOT EVALUABLE'}")
        return
    if stage == 'explore':
        b = t[t.block == 'EXPLORE']; print('\nEXPLORE (one-sided 97.5% lower bound = lower end of the 95% CI)')
        res = {}
        for side in ('ABOVE', 'BELOW'):
            r = side_stats(b, side, rng); show(r); res[side] = r
            if 'lb_one_sided_975' in r:
                r2 = side_stats(b, side, rng, ib_cov=True, ctrl_boot=500); print('         [sensitivity IB-range-matched]', end=' '); show(r2) if 'ctrl_E' in r2 else print(r2.get('ctrl'))
        sig = {s: bool(res[s].get('lb_one_sided_975', -1) > 0) for s in res}
        print('\nExplore signal:', sig)
        print('CLOSED at explore; hold-out NOT opened.' if not any(sig.values()) else 'Hold-out may be opened ONCE for: ' + ', '.join(k for k, v in sig.items() if v))
        json.dump(dict(sig=sig, res=res, run=datetime.datetime.now().isoformat()), open(HERE / 'explore_result.json', 'w'), indent=1)
        return
    if stage == 'holdout':
        ex = json.load(open(HERE / 'explore_result.json')); lock = HERE / 'holdout.lock'
        if lock.exists(): raise RuntimeError('HOLD-OUT ALREADY LOOKED AT ONCE (holdout.lock). No second look.')
        sides = [k for k, v in ex['sig'].items() if v]
        if not sides: raise RuntimeError('No explore signal: hold-out stays unopened.')
        lock.write_text(datetime.datetime.now().isoformat())
        b = t[t.block == 'HOLDOUT']; print('\nHOLD-OUT (single look; one-sided 95% lower bound = 5th percentile)')
        for side in sides:
            r = side_stats(b, side, rng); show(r)
            conf = r.get('lb_one_sided_95', -1) > 0 and r.get('ctrl_E', -1) > 0
            sup = r.get('ctrl_lb_one_sided_95', -1) > 0
            print(f"  {side}: E lb95={r.get('lb_one_sided_95',float('nan')):+.3f}; control point={r.get('ctrl_E','n/a')}; CONFIRMED ON HELD-OUT HISTORY={conf}; control-supported={sup}")
        return


if __name__ == '__main__':
    main(sys.argv[1])
