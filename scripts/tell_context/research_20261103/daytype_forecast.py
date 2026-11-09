"""Layered, probability-based next-day forecast (docs/DAYTYPE_FORECAST_PREREG_20261104.md). Explore window. Balance assumed (base rate) until the evidence moves the probability; ridge-shrunk. Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/daytype_forecast.py [--draws 200]"""
import os, sys, json, datetime, argparse, warnings
import numpy as np, pandas as pd
warnings.filterwarnings('ignore')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..')); sys.path.insert(0, os.path.join(REPO, 'scripts', 'tell_context')); import profile_shape as PS
from tpo_lib import tpo, unfinished
from block_stats import bootmean, bootdiff
from sklearn.linear_model import LogisticRegression
ap = argparse.ArgumentParser(); ap.add_argument('--dump', action='store_true', help='write the session table R to scratch/watcher_marks_20261104/daytype_forecast_table.csv and exit (used by har_width_benchmark.py)'); ap.add_argument('--draws', type=int, default=200); ap.add_argument('--vreversal', action='store_true', help='descriptive event study of a big overnight V (a large move away from the prior close that has retraced by the open) vs unfinished business above / below'); ap.add_argument('--still-balanced-12', action='store_true', help='CORRECTION run: only sessions still BALANCE at 12:00 (final-extension target is otherwise partly decided by the extension already made by 12:00); runs T3 and S1 only'); A = ap.parse_args()
ROOT = os.path.join(REPO, 'scratch', 'volbars500_full_20261028'); RTH0, RTH1 = 55800.0, 79200.0; WARM, STEP, ALPHAS = 120, 5, (0.01, 0.1, 1, 10, 100); rng = np.random.default_rng(149)
B1 = json.load(open(os.path.join(REPO, 'scratch', 'carried_levels_20261104', 'rth_1m.json'))); F = json.load(open(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'b_d_formation_rows.json'))); J = json.load(open(os.path.join(REPO, 'scratch', 'overnight_to_rth_20261103', 'overnight_1m.json')))
days = [d for d in sorted(B1) if len(B1[d]['m']) >= 380 and os.path.exists(f'{ROOT}/{d}.bars.tsv') and d in F and d in J and J[d].get('m')]; Dy = {}
for d in days:
    q = {k: np.array(v, float) for k, v in B1[d].items()}; b = np.loadtxt(f'{ROOT}/{d}.bars.tsv', delimiter='\t', ndmin=2); v = np.loadtxt(f'{ROOT}/{d}.vap.tsv', delimiter='\t', ndmin=2); end = b[:, 2]
    rth = (end >= RTH0) & (end < RTH1); on = end <= RTH0; ib = rth & (end <= RTH0 + 3600); m12 = rth & (end <= RTH0 + 9000)
    if rth.sum() < 100 or ib.sum() < 5 or on.sum() < 5: continue
    ibh, ibl = b[ib, 4].max(), b[ib, 5].min(); ibr = ibh - ibl
    if ibr <= 0: continue
    hi, lo = float(q['h'].max()), float(q['l'].min()); ir = b[rth, 0].astype(int); ft = PS.features(v[np.isin(v[:, 0].astype(int), ir), 1], v[np.isin(v[:, 0].astype(int), ir), 2])
    if ft is None: continue
    e = ft['hi'] - ft['lo']; tp = tpo(q['m'], q['o'], q['h'], q['l']); ph, pl, zones = unfinished(tp); jj = J[d]; jm, jh, jl, jo, jc = (np.array(jj[k], float) for k in ('m', 'h', 'l', 'o', 'c')); drive = 0.0
    for i in range(len(jm)): k = int(np.searchsorted(jm, jm[i] + 60, 'left')); drive = max(drive, float(jh[i:k].max() - jl[i:k].min()))
    x = lambda mask: (max(0.0, b[mask, 4].max() - ibh) + max(0.0, ibl - b[mask, 5].min())) / ibr
    Dy[d] = dict(open=float(q['o'][0]), hi=hi, lo=lo, rng=hi - lo, close=float(b[rth][-1, 6]), dl=float((b[rth, 9] - b[rth, 8]).sum()), vl=float(b[rth, 7].sum()), dl_on=float((b[on, 9] - b[on, 8]).sum()), vl_on=float(b[on, 7].sum()), ibr=ibr, xf=x(rth), x12=x(m12),
                 dl12=float((b[m12, 9] - b[m12, 8]).sum() / max(b[m12, 7].sum(), 1)), mid=ft['va_mid'], bim=ft['bimod'], val=ft['lo'] + ft['val'] * e, vah=ft['lo'] + ft['vah'] * e, ph=ph, pl=pl, zones=zones, w12=bool(F[d]['dev'].get('12:00') and F[d]['dev']['12:00']['state'] == 'BALANCE_CONFIRMED'),
                 on_rng=float(jh.max() - jl.min()), on_lo=float(jl.min()), on_hi=float(jh.max()), on_net=float(jc[-1] - jo[0]), on_drv=drive, wd=datetime.date.fromisoformat(d).weekday())
days = [d for d in days if d in Dy]; n = len(days); print(n, 'sessions with all inputs')
rows = []
for i, d in enumerate(days):
    if i < 21: continue
    p20 = [Dy[x]['rng'] for x in days[i - 20:i]]; adr = float(np.median(p20)); t = Dy[d]; y1 = Dy[days[i - 1]]
    cl = lambda k: Dy[days[i - k]]['close']; hi20 = max(Dy[x]['hi'] for x in days[i - 20:i]); lo20 = min(Dy[x]['lo'] for x in days[i - 20:i]); streak = 0
    for k in range(1, 11):
        a_, b_ = Dy[days[i - k]], Dy[days[i - k - 1]] if i - k - 1 >= 0 else None
        if b_ is not None and a_['val'] <= b_['vah'] and a_['vah'] >= b_['val']: streak += 1
        else: break
    vol5 = sum(Dy[x]['vl'] for x in days[i - 5:i]); up, dn = 3.0, 3.0; lv = []
    for k in range(1, 6):
        s = Dy[days[i - k]]
        for z in s['zones']: lv.append((k, 'z', z[0], z[1]))
        if s['ph'] is not None: lv.append((k, 'h', s['ph'], s['ph']))
        if s['pl'] is not None: lv.append((k, 'l', s['pl'], s['pl']))
    unf = []
    for k, typ, a_, b_ in lv:
        later = days[i - k + 1:i]; filled = any(((Dy[x]['lo'] <= a_ and Dy[x]['hi'] >= b_) if typ == 'z' else (Dy[x]['hi'] > b_ if typ == 'h' else Dy[x]['lo'] < a_)) for x in later)
        if not filled: unf.append((a_, b_, typ))
        if not filled:
            if a_ > t['open']: up = min(up, (a_ - t['open']) / adr)
            elif b_ < t['open']: dn = min(dn, (t['open'] - b_) / adr)
            else: up = min(up, 0.0); dn = min(dn, 0.0)
    ab = [(a_, b_, typ) for a_, b_, typ in unf if a_ > t['open']]; nr = min(ab, key=lambda z: z[0]) if ab else None; wide = max([(z[1] - z[0]) / adr for z in ab if z[2] == 'z' and (z[0] - t['open']) / adr <= 1.5] + [0.0])
    w = y1['vah'] - y1['val']
    r = dict(d=d, wk=f'{d[:4]}-{datetime.date.fromisoformat(d).isocalendar()[1]}', adr=adr, imb=float(t['xf'] > 1.0), lrr=float(np.log(t['rng'] / adr)), pb=float(F[d]['final']['letter'] != 'D'),
             wd1=float(t['wd'] == 1), wd2=float(t['wd'] == 2), wd3=float(t['wd'] == 3), wd4=float(t['wd'] == 4), pd_rng=y1['rng'] / adr,
             chg5=(cl(1) - cl(6)) / adr, chg20=(cl(1) - cl(21)) / adr, pos20=(cl(1) - lo20) / max(hi20 - lo20, 1e-9), streak=float(streak), delta5=sum(Dy[x]['dl'] for x in days[i - 5:i]) / max(vol5, 1), up_unf=up, dn_unf=dn, n_unf=float(len(unf)),
             pd_mid=y1['mid'], pd_bim=y1['bim'], pd_imb=y1['xf'], open_va=(t['open'] - y1['val']) / max(w, 1e-9), on_rng=t['on_rng'] / adr, on_net=t['on_net'] / adr, on_drv=t['on_drv'] / adr, on_dl=t['dl_on'] / max(t['vl_on'], 1),
             v_dn=(t['open'] - t['on_lo']) / adr, v_up=(t['on_hi'] - t['open']) / adr, gap=(t['open'] - y1['close']) / adr, dir_rth=(t['close'] - t['open']) / adr, hi_t=t['hi'], lo_t=t['lo'], nr_a=(nr[0] if nr else np.nan), nr_b=(nr[1] if nr else np.nan), nr_typ=(nr[2] if nr else ''), nr_dist=((nr[0] - t['open']) / adr if nr else np.nan), wide_above=wide,
             ibr_adr=t['ibr'] / adr, x12=t['x12'], w12=float(t['w12']), dl12=t['dl12'], fall5=(cl(1) - cl(6)) / adr, open=t['open'], day_i=i)
    rows.append(r)
R = pd.DataFrame(rows); print(f'{len(R)} sessions with features; base rate imbalance day (final extension > 1.0 IBR) {100*R.imb.mean():.0f}%; P/b {100*R.pb.mean():.0f}%; median log range ratio {R.lrr.median():+.2f}')
if A.dump: R.to_csv(os.path.join(REPO, 'scratch', 'watcher_marks_20261104', 'daytype_forecast_table.csv'), index=False); print('table written', len(R)); sys.exit(0)
if A.vreversal:
    R['fillu'] = [(float(h >= b if typ == 'z' else h > b) if typ else np.nan) for h, b, typ in zip(R.hi_t, R.nr_b, R.nr_typ)]; ev_ = []
    for i in range(60, len(R)):
        cd, cu = np.quantile(R.v_dn.values[:i], 0.8), np.quantile(R.v_up.values[:i], 0.8); gp = abs(R.gap.values[i]) <= 0.25
        ev_.append(dict(i=i, dnV=bool(R.v_dn.values[i] >= cd and gp), upV=bool(R.v_up.values[i] >= cu and gp)))
    V_ = pd.DataFrame(ev_).set_index('i'); R2 = R.iloc[60:].copy(); R2['dnV'] = V_.dnV.values; R2['upV'] = V_.upV.values; print(f'\nBIG OVERNIGHT V (descriptive; the move away from the open is in the top quintile of earlier sessions and the open is within 0.25 ADR of the prior close): DOWN-V {int(R2.dnV.sum())} sessions, UP-V {int(R2.upV.sum())}, other {int((~R2.dnV & ~R2.upV).sum())}')
    for lab, m in (('DOWN-V (fell, came back)', R2.dnV), ('UP-V (rose, came back)', R2.upV), ('all other days', ~R2.dnV & ~R2.upV)):
        g = R2[m]; f = g[g.fillu.notna()]; print(f'  {lab:26s} N={len(g):3d}  RTH close-open mean {g.dir_rth.mean():+.2f} ADR, up days {100*(g.dir_rth>0).mean():.0f}%  | nearest unfilled level ABOVE: N={len(f)} median dist {f.nr_dist.median():.2f} ADR, filled by the close {100*f.fillu.mean():.0f}%  | imbalance {100*g.imb.mean():.0f}%  range ratio median {np.exp(g.lrr.median()):.2f}' + ('  (N<20)' if len(g) < 20 else ''))
    f_ = R2[R2.fillu.notna()]; f_['tq'] = pd.qcut(f_.nr_dist, 3, labels=False, duplicates='drop'); parts = []
    for tq, g in f_.groupby('tq'):
        a, b = g[g.dnV], g[~g.dnV & ~g.upV]
        if len(a) >= 5 and len(b) >= 5: parts.append((a.fillu.mean() - b.fillu.mean(), len(a) * len(b) / (len(a) + len(b)), len(a)))
    print('  fill of the nearest unfilled level above on DOWN-V days minus other days, by distance tercile: ' + ', '.join(f'{100*x:+.0f} pts (N DOWN-V {k})' for x, w, k in parts) + (f'; weighted {100*sum(x*w for x,w,_ in parts)/sum(w for _,w,_ in parts):+.1f} pts' if parts else ''))
    sys.exit(0)
if A.still_balanced_12: R = R[R.x12 <= 1.0].reset_index(drop=True); print(f'CORRECTION RUN: {len(R)} sessions still balanced at 12:00 (extension so far <= 1.0 IBR); base rate of becoming an imbalance day {100*R.imb.mean():.0f}%')
BASE = ['wd1', 'wd2', 'wd3', 'wd4', 'pd_rng']; BIG = ['chg5', 'chg20', 'pos20', 'streak', 'delta5', 'up_unf', 'dn_unf', 'n_unf']; PRI = ['pd_mid', 'pd_bim', 'pd_imb', 'open_va']; OVN = ['on_rng', 'on_net', 'on_drv', 'on_dl']; ST1 = ['ibr_adr']; ST2 = ['x12', 'w12', 'dl12']
S0 = BASE + BIG + PRI + OVN; S1 = S0 + ST1; S2 = S1 + ST2; N = len(R); sc = np.arange(N) >= WARM
def fit_logit(X, y, alpha):
    mu, sd = X.mean(0), X.std(0) + 1e-9; m = LogisticRegression(C=1.0 / alpha, max_iter=300).fit((X - mu) / sd, y); return mu, sd, m
def pick_alpha(X, y):
    cuts = np.linspace(0, len(y), 7).astype(int); best = (1e18, 1.0)
    for a in ALPHAS:
        e = 0.0
        for k in range(1, 6):
            tr, va = slice(0, cuts[k]), slice(cuts[k], cuts[k + 1])
            if y[tr].min() == y[tr].max(): e += 1e3; continue
            mu, sd, m = fit_logit(X[tr], y[tr], a); p = np.clip(m.predict_proba((X[va] - mu) / sd)[:, 1], 1e-4, 1 - 1e-4); e += float(-np.mean(y[va] * np.log(p) + (1 - y[va]) * np.log(1 - p)))
        if e < best[0]: best = (e, a)
    return best[1]
def walk_logit(X, y, alphas=None):
    p = np.full(len(y), np.nan); used = []
    for bi, i0 in enumerate(range(WARM, len(y), STEP)):
        a = alphas[bi] if alphas is not None else pick_alpha(X[:i0], y[:i0]); used.append(a); mu, sd, m = fit_logit(X[:i0], y[:i0], a); sl = slice(i0, min(i0 + STEP, len(y))); p[sl] = m.predict_proba((X[sl] - mu) / sd)[:, 1]
    return np.clip(p, 1e-4, 1 - 1e-4), used
def ll(y, p): return -(y * np.log(p) + (1 - y) * np.log(1 - p))
def walk_ridge(X, y, alphas=None):
    p = np.full(len(y), np.nan); used = []
    for bi, i0 in enumerate(range(WARM, len(y), STEP)):
        if alphas is not None: a = alphas[bi]
        else:
            cuts = np.linspace(0, i0, 7).astype(int); best = (1e18, 1.0)
            for aa in ALPHAS:
                e = 0.0
                for k in range(1, 6):
                    tr, va = slice(0, cuts[k]), slice(cuts[k], cuts[k + 1]); mu, sd = X[tr].mean(0), X[tr].std(0) + 1e-9; Z = (X[tr] - mu) / sd; yc = y[tr].mean(); w = np.linalg.solve(Z.T @ Z + aa * np.eye(Z.shape[1]), Z.T @ (y[tr] - yc)); e += float(np.mean((y[va] - yc - ((X[va] - mu) / sd) @ w) ** 2))
                if e < best[0]: best = (e, aa)
            a = best[1]
        used.append(a); mu, sd = X[:i0].mean(0), X[:i0].std(0) + 1e-9; Z = (X[:i0] - mu) / sd; yc = y[:i0].mean(); w = np.linalg.solve(Z.T @ Z + a * np.eye(Z.shape[1]), Z.T @ (y[:i0] - yc)); sl = slice(i0, min(i0 + STEP, len(y))); p[sl] = yc + ((X[sl] - mu) / sd) @ w
    return p, used
wk = R.wk.values
def wboot(v, B=2000):
    g = {k: np.where((wk == k) & sc)[0] for k in sorted(set(wk[sc]))}; keys = list(g); out = [float(np.mean(v[np.concatenate([g[keys[j]] for j in rng.integers(0, len(keys), len(keys))])])) for _ in range(B)]; return float(np.quantile(out, .025)), float(np.quantile(out, .975))
def X_of(cols): return R[cols].values.astype(float)
def evaluate(label, y, cols_base, cols_new, kind, shift_cols):
    """improvement vector = loss(base model) - loss(model with cols_new); placebo shifts the columns `shift_cols` circularly (penalties reused from the real run)."""
    if kind == 'logit': pb, ab = walk_logit(X_of(cols_base), y); pm, am = walk_logit(X_of(cols_new), y); lb_, lm_ = ll(y, pb), ll(y, pm)
    else: pb, ab = walk_ridge(X_of(cols_base), y); pm, am = walk_ridge(X_of(cols_new), y); lb_, lm_ = (y - pb) ** 2, (y - pm) ** 2
    d = lb_ - lm_; obs = float(np.nanmean(d[sc])); base_loss = float(np.nanmean(lb_[sc])); XN = X_of(cols_new).copy(); idx = [cols_new.index(c) for c in shift_cols]; plc = []
    for _ in range(A.draws):
        lag = int(rng.integers(10, N - 10)); Xs = XN.copy(); Xs[:, idx] = np.roll(XN[:, idx], lag, axis=0)
        if kind == 'logit': pp, _ = walk_logit(Xs, y, am); plc.append(float(np.nanmean((lb_ - ll(y, pp))[sc])))
        else: pp, _ = walk_ridge(Xs, y, am); plc.append(float(np.nanmean((lb_ - (y - pp) ** 2)[sc])))
    plc = np.array(plc); gate = max(0.0, float(np.quantile(plc - plc.mean(), .975))); ci = wboot(d); half = np.array_split(np.where(sc)[0], 2); hv = [float(np.nanmean(d[h])) for h in half]; det = 2.8 * float(plc.std())
    ok = dict(ci_lower_above_0=ci[0] > 0, above_zero_centred_placebo=obs > gate, same_sign_both_halves=min(hv) > 0)
    print(f'  {label}: improvement {obs:+.5f} ({100 * obs / base_loss:+.2f}% of the baseline loss {base_loss:.4f})  week-block CI [{ci[0]:+.5f}, {ci[1]:+.5f}]  placebo gate {gate:+.5f}  halves {hv[0]:+.5f}/{hv[1]:+.5f}  detectable {100 * det / base_loss:.1f}% of baseline')
    print(f'      conditions {ok} => ' + ('LEAD' if all(ok.values()) else 'NOT SHOWN')); return d, pm, ok
y_imb, y_lrr = R.imb.values, R.lrr.values
if A.still_balanced_12:
    print('\nT3-CORRECTED: STAGE 2 over STAGE 0 on the sessions still balanced at 12:00'); evaluate('T3c STAGE 2 over STAGE 0', y_imb, S0, S2, 'logit', ST1 + ST2); evaluate('   S1 over S0', y_imb, S0, S1, 'logit', ST1); sys.exit(0)
print('\nCOUNTED TESTS T1-T3')
d1, p_s0, ok1 = evaluate('T1 STAGE 0 (09:30) imbalance day, log-loss', y_imb, BASE, S0, 'logit', BIG + PRI + OVN)
d2, _, ok2 = evaluate('T2 STAGE 0 log range ratio, squared error', y_lrr, BASE, S0, 'ridge', BIG + PRI + OVN)
d3, p_s2, ok3 = evaluate('T3 STAGE 2 (12:00) over STAGE 0, imbalance day, log-loss', y_imb, S0, S2, 'logit', ST1 + ST2)
print('\nPRINTED: stage 1 (adds the IB range at 10:30) over stage 0'); evaluate('   S1 over S0', y_imb, S0, S1, 'logit', ST1)
print('\nCALIBRATION of the STAGE 0 and STAGE 2 probabilities (predicted-probability fifths vs realised imbalance-day frequency, scored sessions)')
for nm, pp in (('stage 0', p_s0), ('stage 2', p_s2)):
    v = np.where(sc)[0]; q = np.quantile(pp[v], [0, .2, .4, .6, .8, 1]); print(f'  {nm}: ' + '  '.join(f'[{q[k]:.2f}-{q[k+1]:.2f}] {100 * y_imb[v][(pp[v] >= q[k]) & (pp[v] <= q[k + 1])].mean():.0f}% (n={int(((pp[v] >= q[k]) & (pp[v] <= q[k + 1])).sum())})' for k in range(5)) + f'   base rate {100 * y_imb.mean():.0f}%')
# T4: the user's hypothesis -- after a large 5-day fall
R['fall'] = False
for i in range(60, N):
    cut = np.quantile(R.fall5.values[:i], 0.2); R.loc[i, 'fall'] = bool(R.fall5.values[i] <= cut)
F_ = R[R.fall & (np.arange(N) >= 60)]; O_ = R[~R.fall & (np.arange(N) >= 60)]
print(f'\nT4 AFTER A LARGE 5-DAY FALL (lowest quintile of the 5-day change, cut from earlier sessions only; {len(F_)} fall days vs {len(O_)} others)')
c = bootdiff(F_.imb.values, F_.wk.values, O_.imb.values, O_.wk.values, rng)
print(f'  (a) imbalance-day share: fall days {100 * F_.imb.mean():.0f}% vs others {100 * O_.imb.mean():.0f}%; difference {100 * (F_.imb.mean() - O_.imb.mean()):+.1f} points, week-block CI [{100 * c[0]:+.1f}, {100 * c[1]:+.1f}]   (balance share {100 * (1 - F_.imb.mean()):.0f}% vs {100 * (1 - O_.imb.mean()):.0f}%)')
ev = []
for i in range(60, N):
    d = R.d.values[i]; adr = R.adr.values[i]; op = R.open.values[i]
    for k in range(1, 6):
        s = Dy[days[R.day_i.values[i] - k]]; lv = [(z[0], z[1], 'z') for z in s['zones']] + ([(s['ph'], s['ph'], 'h')] if s['ph'] is not None else []) + ([(s['pl'], s['pl'], 'l')] if s['pl'] is not None else [])
        for a_, b_, typ in lv:
            later = days[R.day_i.values[i] - k + 1:R.day_i.values[i]]
            if any(((Dy[x]['lo'] <= a_ and Dy[x]['hi'] >= b_) if typ == 'z' else (Dy[x]['hi'] > b_ if typ == 'h' else Dy[x]['lo'] < a_)) for x in later): continue
            if a_ <= op: continue                                                   # unfinished business ABOVE the open (left behind on the way down)
            fut = days[R.day_i.values[i]:R.day_i.values[i] + 3]; fillf = any(((Dy[x]['lo'] <= a_ and Dy[x]['hi'] >= b_) if typ == 'z' else (Dy[x]['hi'] > b_)) for x in fut) if typ != 'l' else False
            ev.append(dict(d=d, wk=R.wk.values[i], fall=bool(R.fall.values[i]), dist=(a_ - op) / adr, fill=float(fillf), typ=typ))
Ev = pd.DataFrame(ev)
if len(Ev) > 100:
    Ev['tq'] = pd.qcut(Ev.dist, 3, labels=False, duplicates='drop'); parts = []
    for tq, g in Ev.groupby('tq'):
        a, b = g[g.fall], g[~g.fall]
        if len(a) >= 5 and len(b) >= 5: parts.append((a.fill.mean() - b.fill.mean(), len(a) * len(b) / (len(a) + len(b))))
    strat = sum(x * w for x, w in parts) / sum(w for _, w in parts); gw = {k: np.where(Ev.wk.values == k)[0] for k in sorted(set(Ev.wk))}; keys = list(gw); boots = []
    for _ in range(1500):
        ix = np.concatenate([gw[keys[j]] for j in rng.integers(0, len(keys), len(keys))]); g2 = Ev.iloc[ix]; ps = []
        for tq, g in g2.groupby('tq'):
            a, b = g[g.fall], g[~g.fall]
            if len(a) >= 5 and len(b) >= 5: ps.append((a.fill.mean() - b.fill.mean(), len(a) * len(b) / (len(a) + len(b))))
        if ps: boots.append(sum(x * w for x, w in ps) / sum(w for _, w in ps))
    cb = (float(np.quantile(boots, .025)), float(np.quantile(boots, .975)))
    print(f'  (b) unfinished business ABOVE the open filled within 3 sessions: fall days {100 * Ev[Ev.fall].fill.mean():.0f}% (N={int(Ev.fall.sum())} levels) vs others {100 * Ev[~Ev.fall].fill.mean():.0f}% (N={int((~Ev.fall).sum())}); distance-stratified difference {100 * strat:+.1f} points, week-block CI [{100 * cb[0]:+.1f}, {100 * cb[1]:+.1f}]')
else: print('  (b) too few unfinished-business events')
print('\nPRINTED (uncounted): imbalance-day and range ratio by the 5-day change quintile; by balance streak; fall vs rally')
R['q5'] = pd.qcut(R.chg5, 5, labels=False)
for q_, g in R.groupby('q5'): print(f'  5-day change quintile {q_} (mean {g.chg5.mean():+.2f} ADR): N={len(g)} imbalance {100 * g.imb.mean():.0f}%  median log range ratio {g.lrr.median():+.2f}  P/b {100 * g.pb.mean():.0f}%')
for s_ in (0, 1, 2, 3):
    g = R[R.streak >= s_] if s_ == 3 else R[R.streak == s_]
    if len(g): print(f'  overlapping-value streak {s_}{"+" if s_ == 3 else ""}: N={len(g)} imbalance {100 * g.imb.mean():.0f}%  P/b {100 * g.pb.mean():.0f}%')
