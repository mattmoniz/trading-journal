"""AMT intraday option 1: swing-turn location vs prior value area. Stages: census | explore | holdout. PREREG.md frozen.
Usage: ../../venv/bin/python amt_events.py <stage>"""
import sys, json, pathlib, datetime
import numpy as np
import pandas as pd
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/ml_meta_labeling')
from db import get_connection  # noqa: E402

SEED, BOOT, K, TRIM_Q, MIN_EVENTS, MIN_DAYS, MIN_RETAINED = 20261028, 3000, 5, 90, 100, 30, 0.5
SPLIT = '2025-05-16'
HERE = pathlib.Path(__file__).parent
COLS = ['tod_min', 'vwap_dist_atr', 'plp', 'minutes_to_confirm', 'agap']


def load():
    conn = get_connection(); cur = conn.cursor(); cur.execute("SET statement_timeout='120s'")
    cur.execute("""SELECT e.session, e.trade_date::text, e.pivot_type, e.pivot_price::float, e.atr20::float, e.tod_min, e.vwap_dist_atr::float,
                   e.prior_leg_pts::float, e.minutes_to_confirm, e.out_ret_15::float, e.out_ret_30::float, e.out_ret_60::float,
                   e.out_ret_120::float, e.out_ret_240::float, s.prior_vah::float, s.prior_val::float, s.gap_atr::float
                   FROM rotation_events e JOIN amt_daily_state s ON s.trade_date = e.trade_date
                   WHERE e.trade_date >= '2023-03-01' AND e.trade_date < '2026-10-27' AND NOT e.roll_gap_day AND e.out_ret_60 IS NOT NULL
                   ORDER BY e.trade_date, e.pivot_ts""")
    cols = ['session', 'd', 'ptype', 'P', 'atr', 'tod_min', 'vwap_dist_atr', 'plp_pts', 'minutes_to_confirm', 'r15', 'r30', 'y', 'r120', 'r240', 'vah', 'val', 'gap']
    df = pd.DataFrame(cur.fetchall(), columns=cols); conn.close()
    df['plp'] = df.plp_pts / df.atr; df['agap'] = df.gap.abs()
    hi = df.ptype == 'HIGH'
    df['state'] = np.where(hi, np.where(df.P > df.vah, 'TOWARD', np.where(df.P < df.val, 'AWAY', 'INSIDE')),
                           np.where(df.P < df.val, 'TOWARD', np.where(df.P > df.vah, 'AWAY', 'INSIDE')))
    df['block'] = np.where(df.d <= SPLIT, 'EXPLORE', 'HOLDOUT')
    df['mu'] = df.groupby(['session', 'block', 'ptype']).y.transform('mean'); df['x'] = df.y - df.mu
    return df


def day_boot(vals, days, rng, iters=BOOT):
    g = {}
    for v, d in zip(vals, days): g.setdefault(d, []).append(v)
    arrs = [np.array(a) for a in g.values()]; m = len(arrs); out = np.empty(iters)
    for b in range(iters):
        out[b] = np.concatenate([arrs[j] for j in rng.integers(0, m, m)]).mean()
    return out


def maha(A, B, P):
    d = A[:, None, :] - B[None, :, :]
    return np.sqrt(np.einsum('ijk,kl,ijl->ij', d, P, d))


def control(blk_type, st, kk=K):
    """st: state events (subset of blk_type). Returns per-event contrast array (retained), retained share, days of retained."""
    b = blk_type.dropna(subset=COLS); st = st.dropna(subset=COLS); dn = b[b.state == 'INSIDE']
    if len(st) < 20 or len(dn) < kk + 5: return None
    P = np.linalg.pinv(np.cov(b[COLS].to_numpy().T))
    Xd = dn[COLS].to_numpy(); dd = maha(Xd, Xd, P); np.fill_diagonal(dd, np.inf); thr = np.percentile(dd.min(axis=1), TRIM_Q)
    Ds = maha(st[COLS].to_numpy(), Xd, P); idx = np.argsort(Ds, axis=1)[:, :kk]; keep = Ds.min(axis=1) <= thr
    ctrl = dn.y.to_numpy()[idx].mean(axis=1); c = (st.y.to_numpy() - ctrl)
    return c[keep], float(keep.mean()), st.d.to_numpy()[keep]


def cell(blk, sess, state, rng, subtype=None):
    b = blk[blk.session == sess]; st = b[b.state == state]
    if subtype: st = st[st.ptype == subtype]
    out = dict(session=sess, state=state, subtype=subtype, n=len(st), days=int(st.d.nunique()))
    if len(st) < MIN_EVENTS and not subtype: out['status'] = 'NOT EVALUATED'; return out
    if len(st) == 0: return out
    bm = day_boot(st.x.to_numpy(), st.d.to_numpy(), rng)
    out.update(E=float(st.x.mean()), lo95=float(np.percentile(bm, 2.5)), hi95=float(np.percentile(bm, 97.5)), lb975=float(np.percentile(bm, 2.5)), lb95=float(np.percentile(bm, 5)))
    th = np.array_split(np.arange(len(st)), 3); out['thirds'] = [float(st.x.to_numpy()[i].mean()) for i in th]
    if state == 'TOWARD' and not subtype:
        cs = []
        for pt in ('HIGH', 'LOW'):
            r = control(b[b.ptype == pt], st[st.ptype == pt]); 
            if r is not None: cs.append(r)
        if cs:
            c = np.concatenate([r[0] for r in cs]); dd = np.concatenate([r[2] for r in cs]); share = np.mean([r[1] for r in cs])
            out['retained'] = float(share)
            if share < MIN_RETAINED: out['ctrl'] = 'NOT EVALUABLE (retained %.0f%%)' % (100 * share)
            else:
                cb = day_boot(c, dd, rng); out.update(ctrl_E=float(c.mean()), ctrl_lo95=float(np.percentile(cb, 2.5)), ctrl_hi95=float(np.percentile(cb, 97.5)), ctrl_lb95=float(np.percentile(cb, 5)))
        else: out['ctrl'] = 'NOT EVALUABLE (too few)'
    return out


def fmt(o):
    if 'E' not in o: return f"  {o['session']:6s} {o['state']:7s}{'/' + o['subtype'] if o.get('subtype') else '':5s} n={o['n']} days={o['days']} {o.get('status','')}"
    s = f"  {o['session']:6s} {o['state']:7s}{'/' + o['subtype'] if o.get('subtype') else '':5s} n={o['n']:5d} days={o['days']:3d} E={o['E']:+.4f} ATR20 (95% CI {o['lo95']:+.4f}..{o['hi95']:+.4f}) thirds={[round(t, 3) for t in o['thirds']]}"
    if 'ctrl_E' in o: s += f"\n         matched control {o['ctrl_E']:+.4f} (95% CI {o['ctrl_lo95']:+.4f}..{o['ctrl_hi95']:+.4f}) retained={100 * o['retained']:.0f}%"
    elif 'ctrl' in o: s += f"\n         matched control: {o['ctrl']}"
    return s


def main(stage):
    df = load(); rng = np.random.default_rng(SEED)
    print(f"Events used: {len(df)} ({df.d.min()}..{df.d.max()}) | EXPLORE {int((df.block=='EXPLORE').sum())} / HOLDOUT {int((df.block=='HOLDOUT').sum())}")
    if stage == 'census':
        for blk in ('EXPLORE', 'HOLDOUT'):
            for sess in ('RTH', 'GLOBEX'):
                b = df[(df.block == blk) & (df.session == sess)]
                print(f"{blk} {sess}: events={len(b)} days={b.d.nunique()} | " + ', '.join(f"{k}={v}" for k, v in b.state.value_counts().items()) +
                      ' | TOWARD by type: ' + ', '.join(f"{k}={v}" for k, v in b[b.state == 'TOWARD'].ptype.value_counts().items()))
                for pt in ('HIGH', 'LOW'):
                    bt = b[b.ptype == pt]; st = bt[bt.state == 'TOWARD']
                    r = control(bt, st)
                    print(f"    control support {pt}: " + ('n/a' if r is None else f"retained {100 * r[1]:.0f}% of {len(st.dropna(subset=COLS))}"))
        return
    if stage == 'explore':
        res = []; print('\nEXPLORE (one-sided 97.5% lower bound = lower end of the 95% CI)')
        for sess in ('RTH', 'GLOBEX'):
            blk = df[df.block == 'EXPLORE']
            for state in ('TOWARD', 'AWAY', 'INSIDE'):
                o = cell(blk, sess, state, rng); res.append(o); print(fmt(o))
                if state == 'TOWARD':
                    for sub in ('HIGH', 'LOW'):
                        o2 = cell(blk, sess, state, rng, subtype=sub); res.append(o2); print('   subtype' + fmt(o2).strip().rjust(0))
        sig = {s: bool(next((o.get('lb975', -1) for o in res if o['session'] == s and o['state'] == 'TOWARD' and not o.get('subtype')), -1) > 0) for s in ('RTH', 'GLOBEX')}
        print('\nExplore signal (TOWARD, per session):', sig)
        print('CLOSED at explore; hold-out NOT opened.' if not any(sig.values()) else 'Hold-out may be opened ONCE for: ' + ', '.join(k for k, v in sig.items() if v))
        json.dump(dict(sig=sig, res=res, run=datetime.datetime.now().isoformat()), open(HERE / 'explore_result.json', 'w'), indent=1, default=float)
        return
    if stage == 'holdout':
        ex = json.load(open(HERE / 'explore_result.json')); lock = HERE / 'holdout.lock'
        if lock.exists(): raise RuntimeError('HOLD-OUT ALREADY LOOKED AT ONCE (holdout.lock).')
        sess = [k for k, v in ex['sig'].items() if v]
        if not sess: raise RuntimeError('No explore signal: hold-out stays unopened.')
        lock.write_text(datetime.datetime.now().isoformat()); blk = df[df.block == 'HOLDOUT']; print('\nHOLD-OUT (single look; one-sided 95% lower bound)')
        for s in sess:
            o = cell(blk, s, 'TOWARD', rng); print(fmt(o)); subs = [cell(blk, s, 'TOWARD', rng, subtype=t) for t in ('HIGH', 'LOW')]
            for x in subs: print('   subtype' + fmt(x).strip())
            conf = o.get('lb95', -1) > 0 and o.get('ctrl_E', -1) > 0 and all(x.get('E', -1) > 0 for x in subs)
            print(f"  {s}: CONFIRMED ON HELD-OUT HISTORY={conf}; control-supported={o.get('ctrl_lb95', -1) > 0}")


if __name__ == '__main__':
    main(sys.argv[1])
