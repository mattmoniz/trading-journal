"""docs/LEVEL_HOLD_SLICE_PREREG_20261103.md. EXPLORE only, RTH. READS OUTCOME LABELS -> look logged first (log_look_hold_slice.mjs). Usage: nice python run_hold_slice.py [--primary|--sens15]"""
import sys; sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/tape_companion'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_tell_live')
import numpy as np, pandas as pd, lib, persist
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.impute import SimpleImputer
from sklearn.pipeline import make_pipeline
from sklearn.metrics import roc_auc_score
SEED, BOOT, PERM, EXPLORE_END = 20261103, 3000, 100, '2025-05-16'
PRIMARY = '--sens15' not in sys.argv
SESS = lib.GLOBEX if '--globex' in sys.argv else lib.RTH
B0 = B1 = FF = None
def set_cols(hours):
    """hour dummies for every observed clock hour except the first (RTH: 10..15 as before; Globex: whichever overnight hours occur)"""
    global B0, B1, FF
    B0 = [f'fam_{f}' for f in lib.FAMS] + ['n_levels', 'log_scale', 'side', 'dist_open', 'log_touch'] + [f'h{h}' for h in hours[1:]]
    B1 = B0 + ['approach_speed', 'dwell_frac', 'penetration', 'bounce_so_far']
    FF = B1 + ['vol_ratio', 'delta30', 'delta120', 'cumdelta', 'tussle']

def build(with_pseudo):
    conn = persist.connect()
    with conn.cursor() as c:
        c.execute("SELECT trade_date::text, level_name, price::float FROM level_prices WHERE trade_date BETWEEN '2023-04-01' AND %s AND price IS NOT NULL", (EXPLORE_END,)); rows = c.fetchall()
    LV = {}
    for d, n, p in rows: LV.setdefault(d, {})[n] = p
    rth_dates = lib.persec_dates(lib.RTH); pdates = lib.persec_dates(SESS); B = lib.Baselines(pdates, SESS); dates = [d for d in pdates if d in LV and d <= EXPLORE_END and d in rth_dates]
    real, pseu = [], []; shares = {}
    for d in dates:
        bl = B.for_date(d)
        if bl is None: continue
        scale, vr = bl; P = lib.load_day(rth_dates[rth_dates.index(d) - 1]); A = lib.load_day(d, SESS); L = LV[d]
        if 'PD_HIGH' in L and 'PD_LOW' in L and (abs(L['PD_HIGH'] - P['high'].max()) > 3.0 or abs(L['PD_LOW'] - P['low'].min()) > 3.0): continue
        evs = lib.find_touches(A, L, scale, vr, sess=SESS); cnt = {'OK': 0, 'THROUGH': 0, 'ALREADY_HELD': 0}
        for e in evs:
            st, f = lib.gate_and_features(A, e, scale, vr, sess=SESS); cnt[st] = cnt.get(st, 0) + 1
            if st != 'OK': continue
            real.append(dict(date=d, i=e['i'], center=e['center'], members='|'.join(e['members']), scale=scale, y=lib.label_event(A, e, scale, sess=SESS), **f))
        shares[d] = cnt
        if with_pseudo and evs:
            ok_names = [n for n in L if n in lib.NAME2FAM and (SESS.names is None or n in SESS.names)]
            if ok_names:
                allc = np.array(sorted(set(round(c0[0], 2) for c0 in lib.clusters(np.array([L[n] for n in ok_names]), 0.5 * scale)))); pl = {}
                for k, c0 in enumerate(allc):
                    for sg in (-2.0, 2.0):
                        pr = c0 + sg * scale
                        if np.min(np.abs(allc - pr)) < 1.0 * scale or abs(pr - 50 * round(pr / 50)) < 2.5: continue
                        pl[f'P{k}_{int(sg)}'] = float(pr)
                if pl:
                    for e in lib.find_touches(A, pl, scale, vr, pseudo=True, sess=SESS):
                        st, f = lib.gate_and_features(A, e, scale, vr, sess=SESS)
                        if st == 'OK': pseu.append(dict(date=d, i=e['i'], center=e['center'], members='', scale=scale, y=lib.label_event(A, e, scale, sess=SESS), **f))
    return pd.DataFrame(real), pd.DataFrame(pseu), shares

HOURS = []
def prep(df):
    df = df.copy(); df['log_touch'] = np.log1p(df.touch_no)
    for h in HOURS: df[f'h{h}'] = (df.hour == h).astype(float)
    return df

def mk(): return make_pipeline(SimpleImputer(strategy='median'), StandardScaler(), LogisticRegression(C=0.1, max_iter=500))

def walk(df, cols, y):
    """expanding walk-forward by date: first 100 dates train only, refit every 20. returns oos prob aligned to df index (nan on seed dates)."""
    ds = sorted(df.date.unique()); p = np.full(len(df), np.nan); X = df[cols].values; dv = df.date.values
    for b in range(100, len(ds), 20):
        tr = np.isin(dv, ds[:b]); te = np.isin(dv, ds[b:b + 20])
        if te.sum() == 0 or len(np.unique(y[tr])) < 2: continue
        m = mk().fit(X[tr], y[tr]); p[te] = m.predict_proba(X[te])[:, 1]
    return p

def ll(p, y): p = np.clip(p, 1e-6, 1 - 1e-6); return -(y * np.log(p) + (1 - y) * np.log(1 - p))

def boot(df, d, rng):
    g = pd.DataFrame({'date': df.date.values, 'd': d}).groupby('date').d.agg(['sum', 'count']); S, C = g['sum'].values, g['count'].values; out = []
    for _ in range(BOOT):
        w = np.bincount(rng.integers(0, len(S), len(S)), minlength=len(S)).astype(float); out.append((w @ S) / (w @ C))
    return S.sum() / C.sum(), np.percentile(out, [2.5, 97.5])

def analyze(R, tag, full=True, rng=None):
    R = prep(R); R = R[R.y.notna()].reset_index(drop=True); y = R.y.values.astype(float)
    print(f'\n##### {tag}: binary events {len(R)} on {R.date.nunique()} dates; HOLD share {y.mean():.3f}')
    p0, p1, pf = walk(R, B0, y), walk(R, B1, y), walk(R, FF, y); ok = ~np.isnan(pf); E = R[ok].reset_index(drop=True); yy = y[ok]
    l0, l1, lf = ll(p0[ok], yy), ll(p1[ok], yy), ll(pf[ok], yy)
    base = np.full(len(yy), yy.mean()); lb = ll(base, yy)
    print(f'evaluated {len(E)} events on {E.date.nunique()} dates; mean log-loss: constant {lb.mean():.4f}  B0 {l0.mean():.4f}  B1 {l1.mean():.4f}  F {lf.mean():.4f}; AUC B0 {roc_auc_score(yy, p0[ok]):.3f} B1 {roc_auc_score(yy, p1[ok]):.3f} F {roc_auc_score(yy, pf[ok]):.3f}')
    res = {}
    for nm, d in (('C1 tape over price (B1-F)', l1 - lf), ('B0 over constant', lb - l0), ('price behaviour over structure (B0-B1)', l0 - l1)):
        m, ci = boot(E, d, rng); sd_ = sorted(E.date.unique()); h = (E.date.values <= sd_[len(sd_) // 2]); m1, m2 = d[h].mean(), d[~h].mean()
        print(f'{nm:<40} {m:+.5f}  CI [{ci[0]:+.5f}, {ci[1]:+.5f}]  halves {m1:+.5f} / {m2:+.5f}'); res[nm] = (m, ci, m1, m2)
    return R, E, yy, p0[ok], p1[ok], pf[ok], l1 - lf, res

def main():
    real, pseu, shares = build(with_pseudo=PRIMARY)
    global HOURS; HOURS = sorted(real.hour.unique()); set_cols(HOURS)
    real.to_csv(f'/home/mmoniz/trading-journal/scratch/tape_hold_slice_labeled_{SESS.name}_s{lib.SCALE_MIN}.csv', index=False)
    sh = pd.DataFrame(shares).T.sum(); print(f'scale {lib.SCALE_MIN} min; dates {len(shares)}; evaluable events {len(real)}; THROUGH {int(sh.get("THROUGH",0))} ALREADY_HELD {int(sh.get("ALREADY_HELD",0))} (shares of evaluable+excluded: THROUGH {sh.get("THROUGH",0)/sh.sum():.3f} ALREADY_HELD {sh.get("ALREADY_HELD",0)/sh.sum():.3f})')
    print('label shares among evaluable: HOLD %.3f SLICE %.3f NEITHER %.3f' % ((real.y == 1).mean(), (real.y == 0).mean(), real.y.isna().mean()))
    rng = np.random.default_rng(SEED); R, E, yy, p0, p1, pf, dC1, res = analyze(real, 'REAL levels', rng=rng)
    if not PRIMARY: return
    Rp = prep(R); print('\nbase HOLD share by side:', Rp[Rp.y.notna()].groupby('side').y.mean().round(3).to_dict(), '| by hour:', Rp[Rp.y.notna()].groupby('hour').y.mean().round(3).to_dict())
    print('base HOLD share by family flag:', {f: round(Rp[(Rp[f'fam_{f}'] == 1) & Rp.y.notna()].y.mean(), 3) for f in lib.FAMS})
    # permutation null for C1: shuffle labels within date, rerun the whole walk-forward for B1 and F
    obs = dC1.mean(); rp = np.random.default_rng(SEED + 1); nulls = []; Rb = prep(real); Rb = Rb[Rb.y.notna()].reset_index(drop=True); y0 = Rb.y.values.astype(float)
    for k in range(PERM):
        yp = y0.copy()
        for d, ix in Rb.groupby('date').indices.items(): yp[ix] = rp.permutation(yp[ix])
        a, b = walk(Rb, B1, yp), walk(Rb, FF, yp); o = ~np.isnan(b); nulls.append((ll(a[o], yp[o]) - ll(b[o], yp[o])).mean())
    nulls = np.array(nulls); pperm = (np.sum(nulls >= obs) + 1) / (PERM + 1)
    print(f'\n== C1 permutation: observed {obs:+.5f}; null mean {nulls.mean():+.5f} sd {nulls.std():.5f} p95 {np.percentile(nulls, 95):+.5f}; permutation p {pperm:.3f}')
    m, ci, m1, m2 = res['C1 tape over price (B1-F)']; hw = (ci[1] - ci[0]) / 2
    sup = (ci[0] > 0) and (pperm < 0.05) and m1 > 0 and m2 > 0
    verdict = 'UNINFORMATIVE' if hw > 0.034 else ('NOT SHOWN (informative null)' if ci[0] <= 0 or not sup else ('LEAD' if m >= 0.034 else 'STATISTICAL ONLY (economically dead)'))
    print(f'== C1 VERDICT: {verdict}  (point {m:+.5f}, CI half-width {hw:.5f}, supported-by-rule {sup})')
    # calibration deciles for F
    q = pd.qcut(pf, 10, labels=False, duplicates='drop'); print('calibration F by decile (mean predicted / observed HOLD / N):', [(round(pf[q == k].mean(), 3), round(yy[q == k].mean(), 3), int((q == k).sum())) for k in sorted(set(q))])
    # increment by hour block and leave-top-10-dates-out
    hb = E.hour.values
    blocks = (('09:35-11:30', hb <= 10), ('11:30-14:00', (hb >= 11) & (hb <= 13)), ('14:00-15:30', hb >= 14)) if SESS is lib.RTH else (('18:30-22:00', (hb >= 18) & (hb <= 21)), ('22:00-02:00', (hb >= 22) | (hb <= 1)), ('02:00-08:30', (hb >= 2) & (hb <= 8)))
    for nm, mk_ in blocks: print(f'C1 increment {nm}: {dC1[mk_].mean():+.5f} (N {int(mk_.sum())})')
    top = E.groupby('date').size().nlargest(10).index; print(f'C1 leaving the 10 largest dates out: {dC1[~E.date.isin(top).values].mean():+.5f}')
    # pseudo-level placebo
    if len(pseu) > 500:
        print(f'\n== PSEUDO-levels (placebo): {len(pseu)} events'); analyze(pseu, 'PSEUDO levels', rng=np.random.default_rng(SEED + 2))
main()
