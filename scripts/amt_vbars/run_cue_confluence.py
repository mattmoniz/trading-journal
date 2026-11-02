"""Cue confluence (PREREG_CUE_CONFLUENCE.md + Amendment 1, frozen 2026-11-01): tell + absorption + exhaustion + delta-flip varieties, one walk-forward model, PRE and POST. EXPLORE ONLY. Usage: ../../venv/bin/python run_cue_confluence.py"""
import csv, sys, warnings
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
import vbars as V, trade as T
import run_break_entry as B
warnings.filterwarnings('ignore')
SEED, BOOT, NPERM, TRIALS, P, S_MIN, RTH0 = 20261101, 2000, 100, 200, 10, 10, 55800.0
CORRECTED = '--corrected' in sys.argv   # Erratum 1: exclude tied events (both sides identical) from training

def series(S):
    dl = S['ask'] - S['bid']; n = len(dl); w = np.arange(1, P + 1, dtype=float); sm = np.full(n, np.nan)
    for i in range(P - 1, n): sm[i] = dl[i - P + 1:i + 1] @ w / w.sum()
    fl = np.zeros(n, int); prior = np.zeros(n, int); run = 0; prev = 0
    for i in range(n):
        if np.isnan(sm[i]): continue
        s = 1 if sm[i] > 0 else -1 if sm[i] < 0 else prev
        if prev != 0 and s != prev:
            if run >= S_MIN: fl[i] = s; prior[i] = run
            run = 1
        else: run += 1
        prev = s
    z = np.zeros(n)
    for i in range(99 + P - 1, n):
        sd = np.std(sm[i - 99:i + 1]); z[i] = sm[i] / sd if sd > 0 else 0
    ext = np.where(z >= 3, 1, np.where(z <= -3, -1, 0))
    h, l, o, c = S['h'], S['l'], S['o'], S['c']; df = np.zeros(n, int)
    for t in range(20, n):
        if l[t] < l[t - 20:t].min() and dl[t] > 0 and c[t] > o[t]: df[t] = 1
        elif h[t] > h[t - 20:t].max() and dl[t] < 0 and c[t] < o[t]: df[t] = -1
    return fl, prior, ext, df

def load_marks():
    m = {}
    for f, typ in (('../amt_absorb/events_explore.csv', 'abs'), ('../amt_exhaust/spikes_explore.csv', 'spk')):
        for r in csv.DictReader(open(f)): m.setdefault(r['date'], []).append((int(r['u']) + 1.0, int(r['dir']), typ))
    return m

FULL = ['tell_dir', 'near', 'td_near', 'drift', 'abs_bull_60', 'abs_bear_60', 'spk_bull_60', 'spk_bear_60', 'flip_up_10', 'flip_down_10', 'flip_up_30', 'flip_down_30', 'flip_x_tell', 'flip_prior_streak', 'n_flips_30', 'ext_buy_10', 'ext_sell_10', 'df_bull_10', 'df_bear_10']
BASE = ['tell_dir', 'near', 'td_near', 'drift']
POSTF = ['t_abs', 't_spk', 't_flip', 't_ext', 't_df', 'cue_dir', 'agree', 'mins', 'tell_dir', 'near', 'td_near', 'drift', 'prior_streak']
POSTB = ['tell_dir', 'near', 'td_near', 'drift', 'mins']

def fold_of(dates):
    u = sorted(set(dates)); rank = {d: k for k, d in enumerate(u)}; return np.array([min(4, int(5 * rank[d] / len(u))) for d in dates])

def walk(X, y, fold, valid=None):
    p = np.full(len(y), np.nan)
    for k in range(1, 5):
        tr, te = (fold < k) if valid is None else ((fold < k) & valid), fold == k
        if len(set(y[tr])) < 2: p[te] = 0.5; continue
        sc = StandardScaler().fit(X[tr]); m = LogisticRegression(C=1.0, max_iter=2000).fit(sc.transform(X[tr]), y[tr]); p[te] = m.predict_proba(sc.transform(X[te]))[:, 1]
    return p

def blocked(vals, dates, rng):
    g = {}
    for v, d in zip(vals, dates): g.setdefault(d, []).append(v)
    arr = [np.array(a) for a in g.values()]; m = len(arr)
    bs = np.array([np.concatenate([arr[j] for j in rng.integers(0, m, m)]).mean() for _ in range(BOOT)]); return float(np.mean(vals)), float(np.percentile(bs, 2.5)), float(np.percentile(bs, 97.5))

def evaluate(name, ev, fcols, bcols, rng):
    dates = [e['date'] for e in ev]; fold = fold_of(dates); nl = np.array([e['nl'] for e in ev]); ns = np.array([e['ns'] for e in ev]); y = (nl > ns).astype(int); valid = (nl != ns) if CORRECTED else None
    Xf = np.array([[e[c] for c in fcols] for e in ev], float); Xb = np.array([[e[c] for c in bcols] for e in ev], float); td = np.array([e['tell_dir'] for e in ev])
    pf, pb = walk(Xf, y, fold, valid), walk(Xb, y, fold, valid); oos = fold >= 1; n = int(oos.sum())
    pay = lambda p: np.where(p > 0.5, nl, ns); full, base = pay(pf)[oos], pay(pb)[oos]; tell = np.where(td == 1, nl, ns)[oos]; d_oos = [d for d, o in zip(dates, oos) if o]
    plc = float(np.mean([np.mean(np.where(rng.integers(0, 2, n) == 1, nl[oos], ns[oos])) for _ in range(TRIALS)]))
    plc95 = float(np.percentile([np.mean(np.where(rng.integers(0, 2, n) == 1, nl[oos], ns[oos])) for _ in range(TRIALS)], 95))
    mf, lo, hi = blocked(full, d_oos, rng); _, dlo, dhi = blocked(full - base, d_oos, rng); dm = float(np.mean(full - base)); _, tlo, thi = blocked(full - tell, d_oos, rng)
    folds_pos = [float(np.mean(pay(pf)[fold == k])) for k in range(1, 5)]
    ud = sorted(set(dates)); null = []
    for _ in range(NPERM):
        sw = {d: rng.random() < 0.5 for d in ud}; swm = np.array([sw[d] for d in dates]); nl2 = np.where(swm, ns, nl); ns2 = np.where(swm, nl, ns); y2 = (nl2 > ns2).astype(int)
        p2 = walk(Xf, y2, fold, valid); null.append(float(np.mean(np.where(p2 > 0.5, nl2, ns2)[oos])))
    pval = (1 + sum(v >= mf for v in null)) / (NPERM + 1)
    ok = n >= 600 and lo > 0 and dlo > 0 and pval < 0.025 and mf > float(np.mean(tell)) and mf > plc95 and sum(f > 0 for f in folds_pos) >= 3
    print(f"\n=== {name}: events {len(ev)} on {len(set(dates))} dates; OOS events {n} ===")
    print(f"  FULL model OOS ${mf:+.2f}/trade day-blocked CI [{lo:+.2f}, {hi:+.2f}] | BASELINE (geometry only) ${np.mean(base):+.2f} | TELL direction ${np.mean(tell):+.2f} | random-side placebo ${plc:+.2f} (p95 ${plc95:+.2f})")
    print(f"  FULL minus BASELINE {dm:+.2f} CI [{dlo:+.2f}, {dhi:+.2f}] | FULL minus TELL {np.mean(full - tell):+.2f} CI [{tlo:+.2f}, {thi:+.2f}] | day-block permutation p = {pval:.3f} (null mean ${np.mean(null):+.2f}, p95 ${np.percentile(null, 95):+.2f})")
    print(f"  FULL by OOS fold: " + ', '.join(f'{f:+.2f}' for f in folds_pos) + f" | share predicted LONG {100 * np.mean(pf[oos] > 0.5):.0f}% | agrees with the tell side {100 * np.mean((pf[oos] > 0.5) == (td[oos] == 1)):.0f}%")
    sc = StandardScaler().fit(Xf); m = LogisticRegression(C=1.0, max_iter=2000).fit(sc.transform(Xf[valid]) if valid is not None else sc.transform(Xf), y[valid] if valid is not None else y)
    print('  descriptive IN-SAMPLE standardized coefficients (not evidence): ' + ', '.join(f'{c} {w:+.2f}' for c, w in sorted(zip(fcols, m.coef_[0]), key=lambda t: -abs(t[1]))[:8]))
    print(f"  READING: {'LEAD' if ok else 'not shown'}"); return ok

def main():
    rng = np.random.default_rng(SEED); ctxs = B.load_ctxs(); marks = load_marks(); ser = {d: series(c['S']) for d, c in ctxs.items()}
    rep = dict(fires=0, skip=0, trades=0, fallback=0); pre = []; post = []; nocue = 0
    for dte, c in ctxs.items():
        S = c['S']; fl, prior, ext, df = ser[dte]; end = S['end']; mk = lambda j: (end[j] - RTH0) / 60.0; n = len(end); k0 = int(np.searchsorted(S['start'], RTH0))
        for t in T.simulate(c, 'V1', rep):
            i0, ei, d, risk = t['sig'], t['ei'], t['dir'], t['risk']; mf = mk(i0); cl = S['c'][i0]; bd_t, bd_o = T.boundary(c, i0, d), T.boundary(c, i0, -d)
            near = 1.0 if abs(bd_t - cl) < abs(bd_o - cl) else 0.0; drift = float(np.sign(cl - S['o'][k0])) if k0 < n else 0.0
            ml = marks.get(dte, []); known = lambda typ, dr: float(any(u <= mf and u > mf - 60 and dd == dr and tt == typ for u, dd, tt in ml))
            w10 = slice(max(0, i0 - 9), i0 + 1); w30 = slice(max(0, i0 - 29), i0 + 1); f10 = fl[w10]; f30 = fl[w30]; nz = f10[f10 != 0]; vote = int(nz[-1]) if len(nz) else 0
            pidx = np.where(f30 != 0)[0]; pstreak = float(prior[w30][pidx[-1]]) if len(pidx) else 0.0
            base = dict(date=dte, tell_dir=float(d), near=near, td_near=d * near, drift=drift)
            nl = T.stripped(c, ei, 1, risk); ns = T.stripped(c, ei, -1, risk)
            pre.append({**base, 'nl': nl, 'ns': ns, 'abs_bull_60': known('abs', 1), 'abs_bear_60': known('abs', -1), 'spk_bull_60': known('spk', 1), 'spk_bear_60': known('spk', -1), 'flip_up_10': float((f10 == 1).any()), 'flip_down_10': float((f10 == -1).any()),
                        'flip_up_30': float((f30 == 1).any()), 'flip_down_30': float((f30 == -1).any()), 'flip_x_tell': float(vote * d), 'flip_prior_streak': pstreak, 'n_flips_30': float((f30 != 0).sum()),
                        'ext_buy_10': float((ext[w10] == 1).any()), 'ext_sell_10': float((ext[w10] == -1).any()), 'df_bull_10': float((df[w10] == 1).any()), 'df_bear_10': float((df[w10] == -1).any())})
            cues = [(u, dd, typ, 0.0) for u, dd, typ in ml if mf < u <= mf + 60]
            for j in range(i0 + 1, n):
                if mk(j) > mf + 60: break
                if fl[j] != 0: cues.append((mk(j), int(fl[j]), 'flip', float(prior[j])))
                if ext[j] != 0 and not (ext[j - 1] == ext[j]): cues.append((mk(j), int(ext[j]), 'ext', 0.0))
                if df[j] != 0: cues.append((mk(j), int(df[j]), 'df', 0.0))
            if not cues: nocue += 1; continue
            u, dd, typ, ps = min(cues, key=lambda x: x[0]); ei2 = int(np.searchsorted(S['start'], RTH0 + u * 60)); 
            if ei2 >= n - 2 or S['start'][ei2] >= T.FLAT_S: nocue += 1; continue
            post.append({**base, 'nl': T.stripped(c, ei2, 1, risk), 'ns': T.stripped(c, ei2, -1, risk), 't_abs': float(typ == 'abs'), 't_spk': float(typ == 'spk'), 't_flip': float(typ == 'flip'), 't_ext': float(typ == 'ext'), 't_df': float(typ == 'df'),
                         'cue_dir': float(dd), 'agree': float(dd * d), 'mins': u - mf, 'prior_streak': ps})
    print(f"Sessions usable {len(ctxs)}; V1 fires {len(pre)} (expected 1760); POST events {len(post)} (fires with no usable cue in 60 minutes: {nocue}); hold-out NOT touched")
    ok1 = evaluate('PRE (cues known at the fire)', pre, FULL, BASE, rng); ok2 = evaluate('POST (first cue after the fire, then enter)', post, POSTF, POSTB, rng)
    print('\nsummary', {'PRE': ok1, 'POST': ok2})

if __name__ == '__main__': main()
