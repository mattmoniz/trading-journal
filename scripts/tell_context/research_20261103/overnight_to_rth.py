"""Overnight (Globex) -> next RTH shape study. Pre-registration: docs/OVERNIGHT_TO_RTH_SHAPE_PREREG_20261103.md (draft + amendment A1 + freeze section 10). Explore window only (ledger family overnight_to_rth_shape_20261103).
Inputs: scratch/volbars500_full_20261028 (500-contract bars + volume at price: Globex profile, volume, the RTH label), scratch/overnight_to_rth_20261103/overnight_1m.json (1-minute overnight bars, 15-minute ranges, rotation legs from the real detector; export_overnight_1m_20261103.mjs),
scratch/tell_context_20261103/b_d_formation_rows.json (session universe + the 11:00 watcher state). Shared shape function: scripts/tell_context/profile_shape.py. ONE run. --synthetic replaces every outcome by noise (pipeline test without reading a label).
Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/overnight_to_rth.py [--synthetic]"""
import os, sys, json, datetime, collections, argparse
import numpy as np
from zoneinfo import ZoneInfo
ap = argparse.ArgumentParser(); ap.add_argument('--synthetic', action='store_true'); ap.add_argument('--draws', type=int, default=500); A = ap.parse_args()
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(REPO, 'scripts', 'tell_context')); import profile_shape as PS
ROOT = os.path.join(REPO, 'scratch', 'volbars500_full_20261028'); RTH0, RTH1 = 55800.0, 79200.0; NB = PS.NB
J = json.load(open(os.path.join(REPO, 'scratch', 'overnight_to_rth_20261103', 'overnight_1m.json'))); F = json.load(open(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'b_d_formation_rows.json')))
CAL = json.load(open(os.path.join(REPO, 'scratch', 'contract_by_date_20261020.json'))); CUT = json.load(open(os.path.join(REPO, 'scripts', 'tell_context', 'shape_cuts.json')))['bimod_top_tercile_cut']
WARM, STEP, ALPHAS, R_BASE = 120, 5, (0.01, 0.1, 1, 10, 100), 65.0
rng = np.random.default_rng(23); BLK = (0, 360, 540, 840, 930)                    # overnight blocks (minutes since 18:00): 18-00, 00-03, 03-08, 08-09:30

def med(a): return float(np.median(a)) if len(a) else float('nan')
def dst_session(d):                                                                   # the session's overnight spans a US clock change
    et = ZoneInfo('America/New_York'); dd = datetime.date.fromisoformat(d); a = datetime.datetime.combine(dd - datetime.timedelta(days=1), datetime.time(18), et); b = datetime.datetime.combine(dd, datetime.time(9, 30), et)
    return a.utcoffset() != b.utcoffset()
def session(d):
    o = J[d]; b = np.loadtxt(f'{ROOT}/{d}.bars.tsv', delimiter='\t', ndmin=2); v = np.loadtxt(f'{ROOT}/{d}.vap.tsv', delimiter='\t', ndmin=2); end = b[:, 2]
    on, rth = end <= RTH0, (end >= RTH0) & (end < RTH1)
    if rth.sum() < 100 or on.sum() < 5 or not o.get('m'): return None
    ir = b[rth, 0].astype(int); io = b[on, 0].astype(int); f = PS.features(v[np.isin(v[:, 0].astype(int), ir), 1], v[np.isin(v[:, 0].astype(int), ir), 2]); g = PS.features(v[np.isin(v[:, 0].astype(int), io), 1], v[np.isin(v[:, 0].astype(int), io), 2])
    if f is None or g is None: return None
    m, h, l, c, op = (np.array(o[k], float) for k in ('m', 'h', 'l', 'c', 'o')); hi, lo = float(h.max()), float(l.min()); drive = 0.0
    for i in range(len(m)): k = int(np.searchsorted(m, m[i] + 60, 'left')); drive = max(drive, float(h[i:k].max() - l[i:k].min()))
    br = (m // 30).astype(int); ba = np.minimum(((l - lo) / max(hi - lo, 1e-9) * NB).astype(int), NB - 1); bz = np.minimum(((h - lo) / max(hi - lo, 1e-9) * NB).astype(int), NB - 1); seen = set(); T = np.zeros(NB)
    for i in range(len(m)):
        for r in range(ba[i], bz[i] + 1):
            if (br[i], r) not in seen: seen.add((br[i], r)); T[r] += 1
    Ts = T.copy()
    for j in range(1, NB - 1): Ts[j] = T[j - 1:j + 2].mean()
    blk = lambda x: int(np.searchsorted(BLK, x, 'right') - 1)
    return dict(d=d, y=f['va_mid'], bimod=f['bimod'], letter=PS.letter(f['va_mid']), ext=f['hi'] - f['lo'], rth_lo=f['lo'], val=f['lo'] + f['val'] * (f['hi'] - f['lo']), vah=f['lo'] + f['vah'] * (f['hi'] - f['lo']), rth_last_end=float(b[rth][-1, 2]),
                g_mid=g['va_mid'], g_bimod=g['bimod'], g_letter=PS.letter(g['va_mid']), tpo_minus_vol=float((int(Ts.argmax()) + 0.5) / NB - g['poc_pos']), on_vol=float(b[on, 7].sum()), on_range=hi - lo, on_net=float(c[-1] - op[0]), drive=drive,
                open930=o['open930'], open_pos=(o['open930'] - lo) / max(hi - lo, 1e-9), q15_on=o['q15_on'], q15_rth=o['q15_rth'], rot=o['rot'], n_on=o['n_on'], n_rth=o['n_rth'], hi_blk=blk(float(m[h.argmax()])), lo_blk=blk(float(m[l.argmin()])),
                hi500=float(b[on, 4].max()), lo500=float(b[on, 5].min()), hi1=hi, lo1=lo, watch=F[d]['dev'].get('11:00', {}).get('state') if F[d]['dev'].get('11:00') else None)
S = [s for s in (session(d) for d in sorted(set(J) & set(F))) if s]
# ---- hazards (frozen rules; counts printed before any outcome is used)
H = collections.OrderedDict(); keep = []
roll = set(); ds = [s['d'] for s in S]
for i in range(1, len(ds)):
    if CAL.get(ds[i]) != CAL.get(ds[i - 1]):
        for k in range(max(0, i - 2), min(len(ds), i + 3)): roll.add(ds[k])
for s in S:
    why = [n for n, bad in (('dst_transition', dst_session(s['d'])), ('short_or_early_rth', s['n_rth'] < 380 or s['rth_last_end'] < RTH0 + 5.5 * 3600),
                              ('thin_overnight_lt200', s['n_on'] < 200),
                              ('bars_source_mismatch', s['hi500'] > s['hi1'] + 2 or s['lo500'] < s['lo1'] - 2)) if bad]
    for w in why: H[w] = H.get(w, 0) + 1
    if not why: keep.append(s)
print(f'{len(S)} sessions with all inputs; excluded by hazard rule (a session can match several): ' + (', '.join(f'{k} {v}' for k, v in H.items()) or 'none') + f'; kept {len(keep)}; roll-week sessions (kept, flagged, sensitivity printed): {sum(s["d"] in roll for s in keep)}')
S = keep
# ---- prior-20 scales and features (causal: only sessions strictly before)
for i, s in enumerate(S):
    p = S[max(0, i - 20):i]; s['has_rot'] = len(p) >= 10
    if not s['has_rot']: continue
    s['med_rng'] = med([x['ext'] for x in p]); ratio = med([x['q15_on'] for x in p]) / max(med([x['q15_rth'] for x in p]), 1e-9); s['R_on'] = int(min(100, max(15, round(R_BASE * ratio / 5) * 5))); s['rot_n'], s['rot_leg'] = s['rot'][str(s['R_on'])]
for i, s in enumerate(S):
    p = [x for x in S[max(0, i - 20):i] if x.get('has_rot')]; s['ok'] = False
    if not s.get('has_rot') or len(p) < 10: continue
    s['ok'] = True
    s['f'] = [s['on_range'] / s['med_rng'], s['on_net'] / s['med_rng'], s['drive'] / s['med_rng'], s['g_mid'], s['g_bimod'], s['tpo_minus_vol'], s['open_pos'], 0.0, s['on_vol'] / med([x['on_vol'] for x in S[max(0, i - 20):i]]),
              s['rot_n'] / max(float(np.mean([x['rot_n'] for x in p])), 1e-9), s['rot_leg'] / max(float(np.mean([x['rot_leg'] for x in p])), 1e-9)]
    pr = S[i - 1]; s['f'][7] = (s['open930'] - pr['val']) / max(pr['vah'] - pr['val'], 1e-9)
    s['b'] = [pr['y'], pr['ext'] / s['med_rng'], pr['g_mid'], pr['on_range'] / s['med_rng'], s['med_rng'] / s['open930']] + [float(datetime.date.fromisoformat(s['d']).weekday() == k) for k in (1, 2, 3, 4)]
V = [s for s in S if s.get('ok') and np.all(np.isfinite(s['f'] + s['b']))]
n = len(V); XO = np.array([s['f'] for s in V]); XB = np.array([s['b'] for s in V]); WK = sorted(set(s['watch'] for s in V if s['watch'])); XW = np.array([[float(s['watch'] == w) for w in WK[1:]] for s in V])
print(f'{n} scored-eligible sessions ({V[0]["d"]}..{V[-1]["d"]}); warm-up {WARM} -> {n - WARM} scored; overnight features {XO.shape[1]}, baseline features {XB.shape[1]}; ridge, inner time-ordered CV over {ALPHAS}, refit every {STEP} sessions; placebo draws {A.draws}' + ('   [SYNTHETIC outcomes: pipeline test only]' if A.synthetic else ''))
# ---- ridge machinery
def fit(X, y):
    m = len(y); cuts = np.linspace(0, m, 7).astype(int); best = (1e18, ALPHAS[0])
    for a in ALPHAS:
        e = 0.0
        for k in range(1, 6):
            tr, va = slice(0, cuts[k]), slice(cuts[k], cuts[k + 1]); mu, sd = X[tr].mean(0), X[tr].std(0) + 1e-9; Z = (X[tr] - mu) / sd; yc = y[tr].mean()
            w = np.linalg.solve(Z.T @ Z + a * np.eye(Z.shape[1]), Z.T @ (y[tr] - yc)); e += float(np.mean((y[va] - yc - ((X[va] - mu) / sd) @ w) ** 2))
        if e < best[0]: best = (e, a)
    mu, sd = X.mean(0), X.std(0) + 1e-9; Z = (X - mu) / sd; yc = y.mean(); w = np.linalg.solve(Z.T @ Z + best[1] * np.eye(Z.shape[1]), Z.T @ (y - yc)); return mu, sd, w, yc, best[1]
def walk(X, y):
    p = np.full(len(y), np.nan)
    for i0 in range(WARM, len(y), STEP):
        mu, sd, w, yc, _ = fit(X[:i0], y[:i0]); sl = slice(i0, min(i0 + STEP, len(y))); p[sl] = yc + ((X[sl] - mu) / sd) @ w
    return p
wk = np.array([f'{s["d"][:4]}-{datetime.date.fromisoformat(s["d"]).isocalendar()[1]}' for s in V]); qt = np.array([f'{s["d"][:4]}Q{(int(s["d"][5:7]) - 1) // 3 + 1}' for s in V]); sc = np.arange(n) >= WARM
def boot(d, B=2000):
    keys = sorted(set(wk[sc])); idx = {k: np.where((wk == k) & sc)[0] for k in keys}; out = []
    for _ in range(B): pick = rng.choice(len(keys), len(keys)); out.append(float(np.mean(d[np.concatenate([idx[keys[j]] for j in pick])])))
    return float(np.quantile(out, .025)), float(np.quantile(out, .975))
def improvement(Xb, Xc, y):
    pb, pc = walk(Xb, y), walk(Xc, y); return (y - pb) ** 2 - (y - pc) ** 2, pb, pc
YD = {'mid': np.array([s['y'] for s in V]), 'bin': np.array([float(s['letter'] != 'D') for s in V]), 'bimod': np.array([s['bimod'] for s in V]), 'range': np.array([s['ext'] / s['med_rng'] for s in V])}
if A.synthetic: YD = {k: rng.normal(size=n) for k in YD}
y = YD['mid']; XBO = np.hstack([XB, XO]); LET = np.array([s['letter'] for s in V]); GLET = np.array([s['g_letter'] for s in V])
if A.synthetic: LET = rng.choice(list('DPb'), size=n, p=[.7, .18, .12])
# ---- placebo first (resolution line), then the observed
d0, pb, pc = improvement(XB, XBO, y); base_mse = float(np.mean(((y - pb) ** 2)[sc]))
plc = []
for k in range(A.draws):
    lag = int(rng.integers(10, n - 10)); XS = np.hstack([XB, np.roll(XO, lag, axis=0)]); plc.append(float(np.mean((((y - pb) ** 2) - (y - walk(XS, y)) ** 2)[sc])))
plc = np.array(plc); det = 2.8 * float(plc.std())
print(f'\nRESOLUTION (printed before the observed result): baseline out-of-sample MSE {base_mse:.5f}; placebo improvement mean {plc.mean():+.5f} sd {plc.std():.5f}; smallest detectable improvement about {det:.5f} = {100 * det / base_mse:.1f}% of the baseline MSE -> ' + ('UNINFORMATIVE (above 10%)' if det > 0.1 * base_mse else 'informative at that scale'))
obs = float(np.mean(d0[sc])); ci = boot(d0); half = np.array_split(np.where(sc)[0], 2); hv = [float(np.mean(d0[h])) for h in half]; qs = {q: float(np.mean(d0[(qt == q) & sc])) for q in sorted(set(qt[sc]))}; pq = float(np.mean([v > 0 for v in qs.values()]))
band = (float(np.quantile(plc, .025)), float(np.quantile(plc, .975))); pct = 100 * float(np.mean(plc < obs))
print(f'\nPRIMARY: out-of-sample squared-error improvement of the RTH value-area midpoint, baseline + overnight vs baseline: {obs:+.5f} ({100 * obs / base_mse:+.2f}% of baseline MSE)   week-block 95% CI [{ci[0]:+.5f}, {ci[1]:+.5f}]')
print(f'   zero-centered placebo 97.5th percentile (the gate, amendment A2) {max(0.0, float(np.quantile(plc - plc.mean(), .975))):+.5f}')
print(f'   halves {hv[0]:+.5f} / {hv[1]:+.5f}   quarters positive {100 * pq:.0f}% ({sum(v > 0 for v in qs.values())}/{len(qs)})   placebo 95% band [{band[0]:+.5f}, {band[1]:+.5f}]  observed above {pct:.1f}% of placebo draws')
zc = float(np.quantile(plc - plc.mean(), .975)); gate = max(0.0, zc)                      # amendment A2 (DeepSeek round Q): a ZERO-CENTERED placebo threshold, so a null result cannot clear a gate sitting below 0
cond = dict(ci_lower_above_0=ci[0] > 0, both_halves_positive=min(hv) > 0, half_of_quarters_positive=pq >= 0.5, above_zero_centered_placebo=obs > gate)
print('   conditions:', cond); print('   => ' + ('SHOWN as a CANDIDATE on explore (sealed confirmation required)' if all(cond.values()) and det <= 0.1 * base_mse else ('UNINFORMATIVE' if det > 0.1 * base_mse else 'NOT SHOWN (failed: ' + ', '.join(k for k, v in cond.items() if not v) + ')')))
rm = np.array([s['d'] not in roll for s in V]); print(f'   sensitivity without roll-week sessions: {float(np.mean(d0[sc & rm])):+.5f} (N={int((sc & rm).sum())})')
print('\nSECONDARY (uncounted, printed, non-citable)')
for k, lab in (('bin', 'P/b vs D (Brier)'), ('bimod', 'final bimodality'), ('range', 'RTH range / prior-20 median')):
    d, _, _ = improvement(XB, XBO, YD[k]); b = float(np.mean(((YD[k] - walk(XB, YD[k])) ** 2)[sc])); c2 = boot(d); print(f'  {lab:28s} improvement {np.mean(d[sc]):+.5f} ({100 * np.mean(d[sc]) / b:+.2f}% of baseline)  CI [{c2[0]:+.5f}, {c2[1]:+.5f}]')
dw, _, _ = improvement(np.hstack([XB, XW]), np.hstack([XB, XW, XO]), y); cw = boot(dw); print(f'  overnight ADDED to baseline + 11:00 watcher state ({",".join(WK)}): {np.mean(dw[sc]):+.5f}  CI [{cw[0]:+.5f}, {cw[1]:+.5f}]  (does the overnight add anything the 11:00 state does not show?)')
try:
    from sklearn.linear_model import LogisticRegression
    lab = LET; ll = {}
    for nm, X in (('baseline', XB), ('baseline+overnight', XBO)):
        L = []
        for i0 in range(WARM, n, STEP):
            mu, sd = X[:i0].mean(0), X[:i0].std(0) + 1e-9; mdl = LogisticRegression(C=1.0, max_iter=2000).fit((X[:i0] - mu) / sd, lab[:i0]); pr = mdl.predict_proba((X[i0:i0 + STEP] - mu) / sd)
            for r, t in zip(pr, lab[i0:i0 + STEP]): L.append(-np.log(max(r[list(mdl.classes_).index(t)] if t in mdl.classes_ else 1e-6, 1e-6)))
        ll[nm] = np.array(L)
    print(f'  3-class log-loss (C=1 convention): baseline {ll["baseline"].mean():.4f}, baseline+overnight {ll["baseline+overnight"].mean():.4f}, improvement {ll["baseline"].mean() - ll["baseline+overnight"].mean():+.4f}')
except Exception as e: print('  3-class log-loss not computed:', e)
print('\nDESCRIPTIVE (uncounted): Globex letter -> RTH letter (rows = Globex, N<20 cells are not results)')
ct = collections.Counter(zip(GLET, LET))
for gl in 'DPb': tot = sum(ct[(gl, r)] for r in 'DPb'); print(f'  Globex {gl} (N={tot}): ' + '  '.join(f'RTH {r} {100 * ct[(gl, r)] / max(tot, 1):.0f}%' for r in 'DPb'))
Y0 = YD['mid']
print('overnight high set in block x mean RTH midpoint (blocks 18-00, 00-03, 03-08, 08-09:30):  ' + '  '.join(f'{b}: {np.mean([Y0[i] for i, s in enumerate(V) if s["hi_blk"] == b]):.2f} (N={sum(s["hi_blk"] == b for s in V)})' for b in range(4)))
print('overnight low  set in block x mean RTH midpoint:                                      ' + '  '.join(f'{b}: {np.mean([Y0[i] for i, s in enumerate(V) if s["lo_blk"] == b]):.2f} (N={sum(s["lo_blk"] == b for s in V)})' for b in range(4)))
mu, sd, w, yc, a = fit(XBO, y); names = ['prior_mid', 'prior_range', 'prior_g_mid', 'prior_on_range', 'vol_regime', 'Tue', 'Wed', 'Thu', 'Fri', 'on_range', 'on_net', 'drive', 'g_mid', 'g_bimod', 'tpo-vol_poc', 'open_pos', 'open_vs_prior_va', 'on_vol', 'rot_n', 'rot_leg']
print(f'\nstandardised ridge coefficients on the full sample (alpha {a}; descriptive only, never used to select): ' + ', '.join(f'{nm} {c:+.3f}' for nm, c in sorted(zip(names, w), key=lambda t: -abs(t[1]))[:10]))
