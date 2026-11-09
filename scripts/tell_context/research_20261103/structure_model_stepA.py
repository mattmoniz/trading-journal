"""Step A of the market-structure model (docs/STRUCTURE_MODEL_STEP_A_PREREG_20261104.md): do price-movement state (D), now-vs-lately (C) and auction-structure principles (S) add to HAR-X + clock for the next hour's range? 2 counted tests.
Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/structure_model_stepA.py   (look 175 is logged first, hr-023)"""
import os, sys, json, csv, datetime, warnings
import numpy as np, pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from scipy.stats import rankdata
warnings.filterwarnings('ignore')
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..')); rng = np.random.default_rng(20261104)
TIMES = (60, 120, 210, 300); WARM, STEP, ALPHAS, NPLC, B = 120, 5, (0.1, 1, 10, 100), 200, 4000; CIQ = (1.25, 98.75); SCALE_C = 0.1786
TB = pd.read_csv(os.path.join(REPO, 'scratch', 'watcher_marks_20261104', 'daytype_forecast_table.csv')).sort_values('d').reset_index(drop=True)
RF = json.load(open(os.path.join(REPO, 'scratch', 'watcher_marks_20261104', 'rth_1m_flow.json'))); LG = json.load(open(os.path.join(REPO, 'scratch', 'ovn_orderflow_20261104', 'rth_legs_at_decisions.json')))
TB['rng'] = TB.adr * np.exp(TB.lrr)


def bars(d):
    x = RF[d]; a = {k: np.full(390, np.nan) for k in ('o', 'h', 'l', 'c')}
    for i, m in enumerate(x['m']):
        for k in a: a[k][m] = x[k][i]
    return a


def ticks(d):
    fp = os.path.join(REPO, 'scratch', 'updown_1m_20261104', d + '.csv'); a = {k: np.full(390, np.nan) for k in ('up', 'dn', 'vol')}
    if not os.path.exists(fp): return None
    for r in csv.DictReader(open(fp)):
        if r['ts'][:10] == d:
            m = int(r['ts'][11:13]) * 60 + int(r['ts'][14:16]) - 570
            if 0 <= m < 390: a['up'][m] = int(r['up_vol']); a['dn'][m] = int(r['down_vol']); a['vol'][m] = int(r['volume'])
    return a


dates = [d for d in TB.d if d in RF and d in LG and os.path.exists(os.path.join(REPO, 'scratch', 'updown_1m_20261104', d + '.csv'))]
TB = TB[TB.d.isin(dates)].reset_index(drop=True); BAR = {d: bars(d) for d in TB.d}; TK = {d: ticks(d) for d in TB.d}; dl = list(TB.d)
lg = lambda k: np.log(TB.rng.shift(k) / TB.adr)
TB['har_d'] = lg(1); TB['har_w'] = sum(lg(k) for k in range(1, 6)) / 5; TB['har_m'] = sum(lg(k) for k in range(1, 23)) / 22; TB['ln_on'] = np.log(TB.on_rng.clip(lower=1e-3))
rows = []
for i in range(22, len(TB)):
    t = TB.iloc[i]; d = t.d; b = BAR[d]; k = TK[d]; adr = t.adr; pb = BAR[dl[i - 1]]; pdh, pdl = np.nanmax(pb['h']), np.nanmin(pb['l'])
    gsz = min(range(20, 201, 10), key=lambda z: abs(z - SCALE_C * adr)); prior = dl[i - 20:i]; ok = True; rr = []
    for T in TIMES:
        if np.isnan(b['h'][:T + 60]).any() or np.isnan(b['c'][:T]).any() or np.isnan(k['vol'][T - 30:T]).any(): ok = False; break
        h, l, c = b['h'][:T], b['l'][:T], b['c'][:T]; hi, lo = h.max(), l.min(); ibh, ibl = b['h'][:60].max(), b['l'][:60].min(); ibr = max(ibh - ibl, 0.25)
        last = max(int(np.where(h == hi)[0][-1]), int(np.where(l == lo)[0][-1]))
        r30 = np.log((b['h'][T - 30:T].max() - b['l'][T - 30:T].min()) / np.median([np.nanmax(BAR[p]['h'][T - 30:T]) - np.nanmin(BAR[p]['l'][T - 30:T]) for p in prior]))
        v30 = np.log(np.nansum(k['vol'][T - 30:T]) / np.median([np.nansum(TK[p]['vol'][T - 30:T]) for p in prior if TK[p] is not None]))
        up, dn = np.nansum(k['up'][T - 30:T]), np.nansum(k['dn'][T - 30:T]); cl = c[-1]
        f = dict(date=d, i=i, T=T, wk=datetime.date.fromisoformat(d).strftime('%G-%V'), y=np.log((b['h'][T:T + 60].max() - b['l'][T:T + 60].min()) / adr),
                 c120=float(T == 120), c210=float(T == 210), c300=float(T == 300), har_d=t.har_d, har_w=t.har_w, har_m=t.har_m, ln_on=t.ln_on,
                 rs=np.log((hi - lo) / adr), ln_ib=np.log(ibr / adr), ext_up=max(0.0, (b['h'][60:T].max() - ibh) / ibr) if T > 60 else 0.0, ext_dn=max(0.0, (ibl - b['l'][60:T].min()) / ibr) if T > 60 else 0.0,
                 pos=(cl - lo) / max(hi - lo, 0.25), age=(T - 1 - last) / T, legs=LG[d][str(T)][str(gsz)] / (T / 60), r30=r30, v30=v30, imb30=abs(up - dn) / max(up + dn, 1.0),
                 gap=t.gap, open_va=t.open_va, pd_mid=t.pd_mid, pd_bim=t.pd_bim, pd_imb=t.pd_imb, dist_pdh=(cl - pdh) / adr, dist_pdl=(cl - pdl) / adr, inside=float(pdl <= cl <= pdh),
                 chg5=t.chg5, chg20=t.chg20, pos20=t.pos20, streak=t.streak, delta5=t.delta5, up_unf=t.up_unf, dn_unf=t.dn_unf, n_unf=t.n_unf)
        rr.append(f)
    if ok: rows += rr
R = pd.DataFrame(rows).replace([np.inf, -np.inf], np.nan).dropna().reset_index(drop=True); cnt = R.groupby('date').size(); R = R[R.date.isin(cnt[cnt == 4].index)].reset_index(drop=True)
dd = sorted(R.date.unique()); R['di'] = R.date.map({d: j for j, d in enumerate(dd)}); ND = len(dd); sc = (R.di >= WARM).values; y = R.y.values
CLK = ['c120', 'c210', 'c300']; HAR = ['har_d', 'har_w', 'har_m', 'ln_on']; D = ['rs', 'ln_ib', 'ext_up', 'ext_dn', 'pos', 'age', 'legs']; C = ['r30', 'v30', 'imb30']
S = ['gap', 'open_va', 'pd_mid', 'pd_bim', 'pd_imb', 'dist_pdh', 'dist_pdl', 'inside', 'chg5', 'chg20', 'pos20', 'streak', 'delta5', 'up_unf', 'dn_unf', 'n_unf']
O = ['on_net', 'on_drv', 'on_dl', 'v_dn', 'v_up', 'on_legs']
if '--o' in sys.argv:                                                              # A1: group O is attached AFTER the row set is fixed (T1 and T2 are not re-sampled)
    DAYS = json.load(open(os.path.join(REPO, 'scratch', 'ovn_orderflow_20261104', 'days.json'))); TBi = TB.set_index('d'); adr_by = TBi.adr.to_dict()
    def oleg(d): g = min(range(20, 201, 10), key=lambda z: abs(z - SCALE_C * adr_by[d])); return float(DAYS[d]['legs_grid'][str(g)])
    for c in ('on_net', 'on_drv', 'on_dl', 'v_dn', 'v_up'): R[c] = R.date.map(TBi[c].to_dict())
    R['on_legs'] = R.date.map({d: oleg(d) for d in R.date.unique()}); print(f'group O attached: missing values {int(R[O].isna().sum().sum())}'); R[O] = R[O].fillna(R[O].median())
M = {'MP': CLK + HAR + ['r30', 'rs'], 'M0': CLK + HAR, 'M1': CLK + HAR + D, 'M2': CLK + HAR + D + C, 'M3': CLK + HAR + D + C + S}
print(f'{ND} complete days ({len(R)} rows); scored from day {WARM}: {int(sc.sum())} rows on {ND - WARM} days; label y mean {y.mean():+.3f} sd {y.std():.3f}')


def ridge(Xt, yt, a):
    mu, sd = Xt.mean(0), Xt.std(0) + 1e-9; Z = (Xt - mu) / sd; yc = yt.mean(); w = np.linalg.solve(Z.T @ Z + a * np.eye(Z.shape[1]), Z.T @ (yt - yc)); return mu, sd, yc, w


def walk(cols, alphas=None, Xover=None, gbm=False, yv=None):
    yy = y if yv is None else yv                                              # the target: the range label by default, the signed move for the directional step (--dir)
    X = R[cols].values.astype(float) if Xover is None else Xover; p = np.full(len(R), np.nan); used = []
    for bi, bs in enumerate(range(WARM, ND, STEP)):
        tr = (R.di < bs).values; te = ((R.di >= bs) & (R.di < bs + STEP)).values
        if gbm: m = HistGradientBoostingRegressor(max_depth=3, learning_rate=0.05, max_iter=200, l2_regularization=1.0, random_state=0).fit(X[tr], yy[tr]); p[te] = m.predict(X[te]); continue
        if alphas is not None: a = alphas[bi]
        else:
            best = (1e18, 1.0); cuts = np.linspace(0, bs, 7).astype(int)
            for aa in ALPHAS:
                e = 0.0
                for f in range(1, 6):
                    t_ = (R.di < cuts[f]).values; v_ = ((R.di >= cuts[f]) & (R.di < cuts[f + 1])).values; mu, sd, yc, w = ridge(X[t_], yy[t_], aa); e += float(np.mean((yy[v_] - yc - ((X[v_] - mu) / sd) @ w) ** 2))
                if e < best[0]: best = (e, aa)
            a = best[1]
        used.append(a); mu, sd, yc, w = ridge(X[tr], yy[tr], a); p[te] = yc + ((X[te] - mu) / sd) @ w
    return p, used


P = {}; AL = {}
for nm, cols in M.items(): P[nm], AL[nm] = walk(cols)
L = {nm: (y - p) ** 2 for nm, p in P.items()}; b0 = float(L['M0'][sc].mean())
if '--dump-features' in sys.argv:                                                  # all 1,904 explore rows with the M2 features: the training base of the shadow model and the parity reference for scripts/structure_model/features.py
    os.makedirs(os.path.join(REPO, 'scratch', 'structure_model_20261105'), exist_ok=True); adrv = np.array([TB.set_index('d').adr[d] for d in R.date]); Fd = R[['date', 'T', 'di', 'y'] + CLK + HAR + D + C].copy(); Fd['adr'] = adrv; Fd.to_csv(os.path.join(REPO, 'scratch', 'structure_model_20261105', 'explore_features.csv'), index=False); print('features written', len(Fd))
if '--dump-rows' in sys.argv:                                                      # the walk-forward (out-of-sample by construction) predictions row by row, for the shadow model's historical chart (scripts/structure_model/build_payload.py)
    os.makedirs(os.path.join(REPO, 'scratch', 'structure_model_20261105'), exist_ok=True); adrv = np.array([TB.set_index('d').adr[d] for d in R.date])
    pd.DataFrame(dict(date=R.date, T=R['T'], y=y, p0=P['M0'], p2=P['M2'], p3=P['MP'], adr=adrv, scored=sc.astype(int))).to_csv(os.path.join(REPO, 'scratch', 'structure_model_20261105', 'rows_walkforward.csv'), index=False); print('rows written', int(sc.sum()), 'scored')
print('\nLOSS (mean squared error of ln(next-hour range / ADR), scored rows): ' + '; '.join(f'{nm} {L[nm][sc].mean():.4f} ({100 * (b0 - L[nm][sc].mean()) / b0:+.1f}%)' for nm in M))
wk = R.wk.values; gk = {w: np.where((wk == w) & sc)[0] for w in sorted(set(wk[sc]))}; keys = list(gk)


def boot(v):
    out = [float(v[np.concatenate([gk[keys[j]] for j in rng.integers(0, len(keys), len(keys))])].mean()) for _ in range(B)]; return np.percentile(out, CIQ), float(np.std(out))


def placebo(cols_base, cols_add, nm_full):
    Xb = R[cols_base + cols_add].values.astype(float); idx = list(range(len(cols_base), Xb.shape[1])); out = []
    for _ in range(NPLC):
        s = 4 * int(rng.integers(10, ND - 10)); Xs = Xb.copy(); Xs[:, idx] = np.roll(Xb[:, idx], s, axis=0); pp, _a = walk(None, alphas=AL[nm_full], Xover=Xs); out.append(float((L[nm_base_of[nm_full]] - (y - pp) ** 2)[sc].mean()))
    return np.array(out)


nm_base_of = {'M2': 'M0', 'M3': 'M2'}; half = np.array_split(np.where(sc)[0], 2)
tests = [('T1 M0 -> M2 (price-movement state + now-vs-lately)', 'M0', 'M2', CLK + HAR, D + C), ('T2 M2 -> M3 (auction-structure principles)', 'M2', 'M3', CLK + HAR + D + C, S)]
print('\nCOUNTED TESTS (improvement = loss(base) - loss(full); CI 97.5% week-block; placebo = added columns shifted by whole days):')
for lab, a, bnm, cb, ca in tests:
    d = L[a] - L[bnm]; obs = float(d[sc].mean()); ci, se = boot(d); pl = placebo(cb, ca, bnm); gate = max(0.0, float(np.quantile(pl - pl.mean(), 0.975))); hv = [float(d[h].mean()) for h in half]
    ok = dict(ci_lower_above_0=bool(ci[0] > 0), both_halves_positive=bool(min(hv) > 0), placebo_gate_beaten=bool(obs > gate)); base = float(L[a][sc].mean())
    print(f'  {lab}: improvement {obs:+.5f} ({100 * obs / base:+.2f}% of the base loss) CI [{ci[0]:+.5f}, {ci[1]:+.5f}] halves {hv[0]:+.5f} / {hv[1]:+.5f}; placebo gate {gate:.5f}; detectable {100 * 2.8 * se / base:.1f}%\n      conditions {ok} => ' + ('LEAD' if all(ok.values()) else 'NOT SHOWN'))
if '--o' in sys.argv:
    M['M2O'] = M['M2'] + O; P['M2O'], AL['M2O'] = walk(M['M2O']); L['M2O'] = (y - P['M2O']) ** 2; nm_base_of['M2O'] = 'M2'
    d = L['M2'] - L['M2O']; obs = float(d[sc].mean()); CIQ = (0.835, 99.165); ci, se = boot(d); pl = placebo(CLK + HAR + D + C, O, 'M2O'); gate = max(0.0, float(np.quantile(pl - pl.mean(), 0.975))); hv = [float(d[h].mean()) for h in half]; base = float(L['M2'][sc].mean())
    ok = dict(ci_lower_above_0=bool(ci[0] > 0), both_halves_positive=bool(min(hv) > 0), placebo_gate_beaten=bool(obs > gate))
    print(f'\nT3 (A1) M2 -> M2 + O (overnight picture; CI 98.33% family of 3): improvement {obs:+.5f} ({100 * obs / base:+.2f}% of the M2 loss) CI [{ci[0]:+.5f}, {ci[1]:+.5f}] halves {hv[0]:+.5f} / {hv[1]:+.5f}; placebo gate {gate:.5f}; detectable {100 * 2.8 * se / base:.1f}%\n      conditions {ok} => ' + ('LEAD' if all(ok.values()) else 'NOT SHOWN'))
    wo = ridge(R[M['M2O']].values, y, 10.0)[3]; print('  standardized weights, group O (alpha 10, all rows): ' + ' '.join(f'{c} {w:+.3f}' for c, w in zip(M['M2O'][-len(O):], wo[-len(O):])))
print('\nREPORTED (not counted):')
d10 = L['M0'] - L['M1']; ci10, _ = boot(d10); print(f'  M1 (D only) vs M0: {100 * d10[sc].mean() / b0:+.2f}% of the baseline loss, CI [{ci10[0]:+.5f}, {ci10[1]:+.5f}]')
for nm_drop, grp in (('D', D), ('C', C), ('S', S)):
    cols = [c for c in M['M3'] if c not in grp]; pp, _a = walk(cols); print(f'  drop-one-group from M3: without {nm_drop}: loss {((y - pp) ** 2)[sc].mean():.4f} vs full {L["M3"][sc].mean():.4f} ({100 * (((y - pp) ** 2)[sc].mean() - L["M3"][sc].mean()) / L["M3"][sc].mean():+.2f}% worse)')
pg, _a = walk(M['M3'], gbm=True); lg_ = (y - pg) ** 2; print(f'  gradient-boosted challenger on the M3 features: loss {lg_[sc].mean():.4f} ({100 * (b0 - lg_[sc].mean()) / b0:+.1f}% vs M0; ridge M3 {100 * (b0 - L["M3"][sc].mean()) / b0:+.1f}%)')
print('  improvement by decision time (M2 vs M0, % of the base loss): ' + ', '.join(f'{["10:30", "11:30", "13:00", "14:30"][j]} {100 * (L["M0"] - L["M2"])[sc & (R["T"].values == T)].mean() / L["M0"][sc & (R["T"].values == T)].mean():+.1f}' for j, T in enumerate(TIMES)))
q = np.quantile(P['M2'][sc], [0.2, 0.8]); print(f'  calibration (M2): mean realized y in the bottom fifth of predictions {y[sc & (P["M2"] <= q[0])].mean():+.3f}, top fifth {y[sc & (P["M2"] >= q[1])].mean():+.3f}; correlation of prediction and y {np.corrcoef(P["M2"][sc], y[sc])[0, 1]:.3f} (M0 {np.corrcoef(P["M0"][sc], y[sc])[0, 1]:.3f})')
tr = np.ones(len(R), bool); mu, sd, yc, w = ridge(R[M['M3']].values[tr], y[tr], 10.0); wt = dict(zip(M['M3'], w)); print('  standardized ridge weights (alpha 10, all rows, descriptive): ' + '; '.join(f'{g} ' + ' '.join(f'{c} {wt[c]:+.2f}' for c in cols) for g, cols in (('D', D), ('C', C))) + '; S: ' + ' '.join(f'{c} {wt[c]:+.2f}' for c in S[:8]) + ' ...')


if '--dir' in sys.argv:                                                           # Step B (docs/STRUCTURE_MODEL_DIRECTION_PREREG_20261104.md): the DIRECTION of the next hour
    CIQ = (0.835, 99.165); ydir = np.zeros(len(R)); NEW = {k: np.zeros(len(R)) for k in ('ret_so', 'ret60', 'ret30', 'ret5', 'pos30', 'ext_net', 'res_d', 'sup_d', 'n_near', 'on_dl_s', 'vdiff', 'd30', 'dso', 'gap_s')}; TBi = TB.set_index('d')
    for r_i, (d, T, i) in enumerate(zip(R.date, R['T'], R.i)):
        b = BAR[d]; k = TK[d]; t = TBi.loc[d]; adr = t.adr; c = b['c']; cl = c[T - 1]; pb = BAR[dl[i - 1]]; ibh, ibl = np.nanmax(b['h'][:60]), np.nanmin(b['l'][:60]); ibr = max(ibh - ibl, 0.25)
        ydir[r_i] = (c[T + 59] - cl) / adr; NEW['ret_so'][r_i] = (cl - b['o'][0]) / adr; NEW['ret60'][r_i] = (cl - (c[T - 61] if T > 60 else b['o'][0])) / adr;  # FIXED 2026-11-05: at T=60 the index T-61 is -1 = the LAST bar of the day (a lookahead leak found from rho 0.387 at 10:30); the hour starts at the open there
        NEW['ret30'][r_i] = (cl - c[T - 31]) / adr; NEW['ret5'][r_i] = (cl - c[T - 6]) / adr
        h30, l30 = np.nanmax(b['h'][T - 30:T]), np.nanmin(b['l'][T - 30:T]); NEW['pos30'][r_i] = (cl - l30) / max(h30 - l30, 0.25)
        ext_up = max(0.0, (np.nanmax(b['h'][60:T]) - ibh) / ibr) if T > 60 else 0.0; ext_dn = max(0.0, (ibl - np.nanmin(b['l'][60:T])) / ibr) if T > 60 else 0.0; NEW['ext_net'][r_i] = ext_up - ext_dn
        lv = np.array([np.nanmax(pb['h']), np.nanmin(pb['l']), b['o'][0] + t.v_up * adr, b['o'][0] - t.v_dn * adr, ibh, ibl]); above = lv[lv > cl]; below = lv[lv < cl]
        NEW['res_d'][r_i] = (above.min() - cl) / adr if len(above) else 1.0; NEW['sup_d'][r_i] = (cl - below.max()) / adr if len(below) else 1.0; NEW['n_near'][r_i] = float((np.abs(lv - cl) <= ibr).sum())
        NEW['on_dl_s'][r_i] = t.on_dl; NEW['vdiff'][r_i] = t.v_up - t.v_dn; NEW['gap_s'][r_i] = t.gap
        up, dn = np.nansum(k['up'][T - 30:T]), np.nansum(k['dn'][T - 30:T]); NEW['d30'][r_i] = (up - dn) / max(up + dn, 1.0); up2, dn2 = np.nansum(k['up'][:T]), np.nansum(k['dn'][:T]); NEW['dso'][r_i] = (up2 - dn2) / max(up2 + dn2, 1.0)
    for c_, v_ in NEW.items(): R[c_] = v_
    R['ydir'] = ydir; R['inside_s'] = R.inside; ydir = R.ydir.values; mx = R['T'].values
    PA = ['ret_so', 'ret60', 'ret30', 'ret5', 'pos30', 'pos', 'ext_net']; SR = ['res_d', 'sup_d', 'n_near', 'inside_s']; OV = ['on_net', 'on_dl_s', 'gap_s', 'vdiff', 'on_drv', 'open_va']; FL = ['d30', 'dso']
    MOM = CLK + ['ret_so', 'ret60', 'ret30']; FULL = CLK + PA + SR + OV + FL; yd = ydir
    pf, alf = walk(FULL, yv=yd); pm, alm = walk(MOM, yv=yd); rho = lambda a, b_, m=None: float(np.corrcoef(rankdata(a[m]), rankdata(b_[m]))[0, 1]) if (m is not None) else float(np.corrcoef(rankdata(a), rankdata(b_))[0, 1])
    print(f'\n=== STEP B (direction): label y_dir mean {yd[sc].mean():+.4f} sd {yd[sc].std():.4f} (ADR units, scored rows) ===')
    def boot_rho(pred, mask):
        gk2 = {w: np.where((wk == w) & mask)[0] for w in sorted(set(wk[mask]))}; ks = [w for w in gk2 if len(gk2[w])]; out = []
        for _ in range(B): ix = np.concatenate([gk2[ks[j]] for j in rng.integers(0, len(ks), len(ks))]); out.append(rho(pred[ix], yd[ix]))
        return np.percentile(out, CIQ), float(np.std(out))
    def plc_rho(cols_base, cols_add, alphas, mask):
        Xb = R[cols_base + cols_add].values.astype(float); ix = list(range(len(cols_base), Xb.shape[1])); out = []; Lb = (yd - pm) ** 2
        for _ in range(NPLC):
            sft = 4 * int(rng.integers(10, ND - 10)); Xs = Xb.copy(); Xs[:, ix] = np.roll(Xb[:, ix], sft, axis=0); pp, _a = walk(None, alphas=alphas, Xover=Xs, yv=yd); out.append((rho(pp[mask], yd[mask]), float((Lb - (yd - pp) ** 2)[sc].mean())))
        return np.array(out)
    print(f'  reference: rho of the MOMENTUM-only model {rho(pm[sc], yd[sc]):+.4f} (the clock + ret_so + ret60 + ret30 returns)')
    r1 = rho(pf[sc], yd[sc]); c1, se1 = boot_rho(pf, sc); pl = plc_rho(MOM, [c for c in FULL if c not in MOM], alf, sc); g1 = float(np.nanpercentile(np.abs(pl[:, 0]), 97.5)); hv1 = [rho(pf[h], yd[h]) for h in half]
    d2 = (yd - pm) ** 2 - (yd - pf) ** 2; o2 = float(d2[sc].mean()); c2, se2 = boot(d2); g2 = max(0.0, float(np.quantile(pl[:, 1] - pl[:, 1].mean(), 0.975))); hv2 = [float(d2[h].mean()) for h in half]
    pr = P['M2']; reg = np.zeros(len(R), bool); idxs = np.where(sc)[0]
    for j, ii in enumerate(idxs):
        prior = pr[idxs[:j]]
        if len(prior) >= 60 and pr[ii] >= np.percentile(prior, 67): reg[ii] = True
    c3, se3 = boot_rho(pf, reg); r3 = rho(pf[reg], yd[reg]); hv3 = [rho(pf[h & reg], yd[h & reg]) if (h & reg).sum() > 20 else np.nan for h in [np.isin(np.arange(len(R)), hh) for hh in half]]
    print(f'DETECTABLE (2.8 x SE): T1 rho {2.8 * se1:.3f}; T2 improvement {2.8 * se2:.5f} (MSE units; {100 * 2.8 * se2 / float(((yd - pm) ** 2)[sc].mean()):.1f}% of the momentum loss); T3 rho {2.8 * se3:.3f} on {int(reg.sum())} regime rows')
    for lab, st, ci, h_, ok in (('T1 rho(FULL, y_dir), scored rows', r1, c1, hv1, dict(ci_excludes_0=bool(c1[0] > 0 or c1[1] < 0), halves_same_sign=bool(np.sign(hv1[0]) == np.sign(hv1[1]) == np.sign(r1)), placebo_beaten=bool(abs(r1) > g1))),
                                ('T2 FULL over MOMENTUM, squared error', o2, c2, hv2, dict(ci_lower_above_0=bool(c2[0] > 0), both_halves_positive=bool(min(hv2) > 0), placebo_beaten=bool(o2 > g2))),
                                ('T3 rho(FULL, y_dir) in the top-third predicted-range regime', r3, c3, hv3, dict(ci_excludes_0=bool(c3[0] > 0 or c3[1] < 0), halves_same_sign=bool(np.sign(hv3[0]) == np.sign(hv3[1]) == np.sign(r3))))):
        print(f'  {lab}: {st:+.4f} CI [{ci[0]:+.4f}, {ci[1]:+.4f}] halves {h_[0]:+.4f} / {h_[1]:+.4f}' + (f'; placebo gate {g1:.4f}' if lab.startswith('T1') else f'; placebo gate {g2:.5f}' if lab.startswith('T2') else '') + f'\n      conditions {ok} => ' + ('LEAD' if all(ok.values()) else 'NOT SHOWN'))
    print('\nREPORTED (not counted):'); hit = lambda p, m: float((np.sign(p[m]) == np.sign(yd[m])).mean())
    top = sc & (np.abs(pf) >= np.percentile(np.abs(pf[sc]), 80)); print(f'  sign hit rate: overall {100 * hit(pf, sc):.1f}% (always long {100 * (yd[sc] > 0).mean():.1f}%, momentum sign {100 * hit(R.ret30.values, sc):.1f}%); top fifth of |prediction| {100 * hit(pf, top):.1f}% (N {int(top.sum())})')
    cost = 3.0; adr_ = R['T'].map(lambda _: 0.0).values; adrv = np.array([TBi.loc[d].adr for d in R.date]); pnl = lambda sgn: sgn * yd * adrv * 2.0 - cost
    for nm, sgn in (('model sign rule', np.sign(pf)), ('always long', np.ones(len(R))), ('momentum sign (30 minutes)', np.sign(R.ret30.values)), ('random direction (mean of long and short)', np.zeros(len(R)))):
        v = pnl(sgn) if nm != 'random direction (mean of long and short)' else (pnl(np.ones(len(R))) + pnl(-np.ones(len(R)))) / 2; ci_, _s = boot(v); print(f'    {nm:42s} mean {v[sc].mean():+7.2f} per decision row, CI [{ci_[0]:+.2f}, {ci_[1]:+.2f}] (after $2 round trip + 1 tick slip each way, close to close)')
    pg, _a = walk(FULL, gbm=True, yv=yd); print(f'  gradient-boosted challenger rho {rho(pg[sc], yd[sc]):+.4f} (ridge {r1:+.4f})')
    print('  rho by decision time (ridge FULL): ' + ', '.join(f'{["10:30", "11:30", "13:00", "14:30"][j]} {rho(pf, yd, sc & (mx == T)):+.3f}' for j, T in enumerate(TIMES)))
    wt = ridge(R[FULL].values, yd, 10.0)[3]; print('  standardized ridge weights (alpha 10, all rows, descriptive): ' + '; '.join(f'{g} ' + ' '.join(f'{c} {wt[FULL.index(c)]:+.3f}' for c in cols) for g, cols in (('price action', PA), ('S/R', SR), ('overnight', OV), ('flow', FL))))


if '--vwap' in sys.argv and '--dir' in sys.argv:                                  # docs/STRUCTURE_MODEL_VWAP_PREREG_20261105.md: group V (needs the --dir block's names)
    CIQ = (1.25, 98.75); V = ['rv_d', 'gv_d', 'rv_abs', 'gv_abs', 'rv_gv', 'rv_z']; VW = {c_: np.zeros(len(R)) for c_ in V}; GV = {}
    for d in set(R.date):
        num = den = 0.0
        for r_ in csv.DictReader(open(os.path.join(REPO, 'scratch', 'updown_1m_20261104', d + '.csv'))):
            if r_['ts'][:10] == d and r_['ts'][11:16] >= '09:30': break
            num += float(r_['close']) * int(r_['volume']); den += int(r_['volume'])
        GV[d] = num / den
    for r_i, (d, T) in enumerate(zip(R.date, R['T'])):
        b = BAR[d]; k = TK[d]; adr = TBi.loc[d].adr; tp = (b['h'][:T] + b['l'][:T] + b['c'][:T]) / 3; vol = k['vol'][:T]; rv = np.nansum(tp * vol) / np.nansum(vol); cl = b['c'][T - 1]; sdc = np.nanstd(b['c'][:T])
        VW['rv_d'][r_i] = (cl - rv) / adr; VW['gv_d'][r_i] = (cl - GV[d]) / adr; VW['rv_abs'][r_i] = abs(cl - rv) / adr; VW['gv_abs'][r_i] = abs(cl - GV[d]) / adr; VW['rv_gv'][r_i] = (rv - GV[d]) / adr; VW['rv_z'][r_i] = (cl - rv) / max(sdc, 0.25)
    for c_ in V: R[c_] = VW[c_]
    print('\n=== VWAP GROUP (docs/STRUCTURE_MODEL_VWAP_PREREG_20261105.md) ===')
    M2c = CLK + HAR + D + C; pv, alv = walk(M2c + V); Lv = (y - pv) ** 2; d4 = L['M2'] - Lv; o4 = float(d4[sc].mean()); c4, se4 = boot(d4); hv4 = [float(d4[h].mean()) for h in half]
    Xb = R[M2c + V].values.astype(float); ix = list(range(len(M2c), Xb.shape[1])); pl4 = []
    for _ in range(NPLC):
        sft = 4 * int(rng.integers(10, ND - 10)); Xs = Xb.copy(); Xs[:, ix] = np.roll(Xb[:, ix], sft, axis=0); pp, _a = walk(None, alphas=alv, Xover=Xs); pl4.append(float((L['M2'] - (y - pp) ** 2)[sc].mean()))
    g4 = max(0.0, float(np.quantile(np.array(pl4) - np.mean(pl4), 0.975))); base4 = float(L['M2'][sc].mean())
    pfv, alfv = walk(FULL + V, yv=yd); d5 = (yd - pf) ** 2 - (yd - pfv) ** 2; o5 = float(d5[sc].mean()); c5, se5 = boot(d5); hv5 = [float(d5[h].mean()) for h in half]
    Xb = R[FULL + V].values.astype(float); ix = list(range(len(FULL), Xb.shape[1])); pl5 = []
    for _ in range(NPLC):
        sft = 4 * int(rng.integers(10, ND - 10)); Xs = Xb.copy(); Xs[:, ix] = np.roll(Xb[:, ix], sft, axis=0); pp, _a = walk(None, alphas=alfv, Xover=Xs, yv=yd); pl5.append(float(((yd - pf) ** 2 - (yd - pp) ** 2)[sc].mean()))
    g5 = max(0.0, float(np.quantile(np.array(pl5) - np.mean(pl5), 0.975))); base5 = float(((yd - pf) ** 2)[sc].mean())
    print(f'DETECTABLE (2.8 x SE): T4 {100 * 2.8 * se4 / base4:.1f}% of the M2 loss; T5 {100 * 2.8 * se5 / base5:.1f}% of the FULL loss')
    for lab, o_, c_, h_, g_, base_ in (('T4 M2 -> M2 + V (next-hour RANGE)', o4, c4, hv4, g4, base4), ('T5 FULL -> FULL + V (next-hour DIRECTION)', o5, c5, hv5, g5, base5)):
        ok = dict(ci_lower_above_0=bool(c_[0] > 0), both_halves_positive=bool(min(h_) > 0), placebo_gate_beaten=bool(o_ > g_)); print(f'  {lab}: improvement {o_:+.5f} ({100 * o_ / base_:+.2f}% of the base loss) CI [{c_[0]:+.5f}, {c_[1]:+.5f}] halves {h_[0]:+.5f} / {h_[1]:+.5f}; placebo gate {g_:.5f}\n      conditions {ok} => ' + ('LEAD' if all(ok.values()) else 'NOT SHOWN'))
    print('\nFILTER VIEW (reported, not counted): next-hour signed move y_dir (ADR units), sign hit rate (up), mean ln range, by the side of the close vs the VWAPs (scored rows)')
    ra, ga = R.rv_d.values > 0, R.gv_d.values > 0
    for nm, m in (('above RTH VWAP', ra), ('below RTH VWAP', ~ra), ('above Globex VWAP', ga), ('below Globex VWAP', ~ga), ('above BOTH', ra & ga), ('below BOTH', ~ra & ~ga), ('between (above one, below the other)', ra != ga)):
        mm = sc & m; print(f'  {nm:38s} N={int(mm.sum()):4d}  mean move {yd[mm].mean():+.4f}  up {100 * (yd[mm] > 0).mean():4.1f}%  mean ln range {y[mm].mean():+.3f}')
    print(f'  all scored rows: mean move {yd[sc].mean():+.4f}, up {100 * (yd[sc] > 0).mean():.1f}%, mean ln range {y[sc].mean():+.3f}; standardized ridge weights (range, M2 + V): ' + ' '.join(f'{c_} {ridge(R[M2c + V].values, y, 10.0)[3][M2c.index(c_) if c_ in M2c else len(M2c) + V.index(c_)]:+.3f}' for c_ in V))
