"""Stage 3: context calibration for large moves (PREREG_STAGE3.md + Amendment 1, frozen 2026-10-29). EXPLORE only. Usage: ../../venv/bin/python run_context.py"""
import sys, numpy as np, pandas as pd
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_80rule'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_exhaust'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_marks_path'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/ml_meta_labeling')
import engine as E, spike as SP, run_path as RP, news_calendar as NC
from run_robust import did
from db import get_connection
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
SEED = 20261029; BOOT = 3000
def overnight_table(start='2023-02-01', end='2025-06-30'):
    conn = get_connection(); cur = conn.cursor(); cur.execute("SET statement_timeout='180s'"); frames = []; s = pd.Timestamp(start); e = pd.Timestamp(end)
    while s < e:
        nxt = s + pd.offsets.MonthBegin(1)
        cur.execute("SELECT ts, high::float, low::float, volume::float FROM price_bars_primary WHERE symbol='NQ' AND ts >= %s AND ts < %s AND (ts::time >= '18:00' OR ts::time < '09:30')", (s.to_pydatetime(), min(nxt, e).to_pydatetime()))
        rows = cur.fetchall()
        if rows: frames.append(pd.DataFrame(rows, columns=['ts', 'h', 'l', 'v']))
        s = nxt
    conn.close(); df = pd.concat(frames); df['ts'] = pd.to_datetime(df.ts); df['d'] = np.where(df.ts.dt.hour >= 18, df.ts.dt.normalize() + pd.Timedelta(days=1), df.ts.dt.normalize()); out = {}
    for d, g in df.groupby('d'):
        pr = E.profile(dict(h=g.h.to_numpy(), l=g.l.to_numpy(), v=np.nan_to_num(g.v.to_numpy()))); out[pd.Timestamp(d).strftime('%Y-%m-%d')] = dict(hi=float(g.h.max()), lo=float(g.l.min()), vol=float(np.nansum(g.v)), vah=pr[0] if pr else np.nan, val=pr[1] if pr else np.nan)
    return out
def loc3(x, hi, lo):                                           # +1 above, -1 below, 0 inside
    return 1 if x > hi else (-1 if x < lo else 0)
def per_session(a):
    h, l, v = a['h'], a['l'], np.nan_to_num(a['v']); n = 390; cum = np.cumsum(v); r30 = np.full(n, np.nan); rng = np.full(n, np.nan); hh = np.fmax.accumulate(np.nan_to_num(h, nan=-np.inf)); ll = np.fmin.accumulate(np.nan_to_num(l, nan=np.inf))
    for u in range(n):
        w0 = max(0, u - 29); hw = h[w0:u + 1]; lw = l[w0:u + 1]
        if np.isfinite(hw).any() and np.isfinite(lw).any(): r30[u] = np.nanmax(hw) - np.nanmin(lw)
        if np.isfinite(hh[u]) and np.isfinite(ll[u]) and hh[u] > -np.inf: rng[u] = hh[u] - ll[u]
    return dict(cum=cum, r30=r30, rng=rng)
NSESS = 0
def build():
    raw = E.load_sessions(); allS = E.build_eligible(raw); ex = [s for s in allS if s['d'] <= RP.SPLIT]; ON = overnight_table(); rngs = [float(np.nanmax(s['a']['h']) - np.nanmin(s['a']['l'])) for s in ex]
    atr20 = {s['d']: float(np.mean(rngs[i - 20:i])) for i, s in enumerate(ex) if i >= 20}; Lscale = 50.0 / float(np.median(list(atr20.values()))); PS = [per_session(s['a']) for s in ex]
    stats = [SP.thrust(s['a']) for s in ex]; news = {d: (typ, m) for d, typ, m in NC.CAND}; on_vols = [ON.get(s['d'], {}).get('vol', np.nan) for s in ex]; rows = []; skipped = 0
    for si, s in enumerate(ex):
        thr = SP.thresholds(stats, si)
        if thr is None or s['d'] not in ON: continue
        global NSESS; NSESS += 1
        a = s['a']; o0 = a['o'][0]; c = a['c']; atr = atr20[s['d']]; on = ON[s['d']]; pc = ex[si - 1]['a']['c']; prior_close = float(pc[~np.isnan(pc)][-1]); P = PS[si]; prior = range(si - 20, si)
        for e in SP.detect(a, stats[si], thr):
            D = e['dir']; u = e['u']; en = u + 1
            if not (RP.E_LO <= en <= RP.E_HI) or np.isnan(a['o'][en]): continue
            stop = e['ext'] - D * RP.TICK; rf = RP.sim(a, en, D, stop)
            if rf is None: continue
            risk = D * (rf['entry'] - stop); Df = -D; enC = a['o'][en] + Df * RP.SLIP; rc = RP.sim(a, en, Df, enC - Df * risk)
            if rc is None: continue
            med = lambda arr: float(np.nanmedian([arr(PS[j])[u] for j in prior]))                      # prior sessions only, bar u (causal)
            rvol = P['cum'][u] / max(med(lambda q: q['cum']), 1.0); volnow = P['r30'][u] / max(med(lambda q: q['r30']), 1e-9); rngr = P['rng'][u] / max(med(lambda q: q['rng']), 1e-9)
            if not np.all(np.isfinite([rvol, volnow, rngr])) or min(rvol, volnow, rngr) <= 0: skipped += 1; continue
            es = float(np.mean(np.log([rvol, volnow, rngr]))); L = Lscale * atr; dsign = 1 if c[u] > o0 else -1
            onv = np.nanmedian(on_vols[si - 20:si]); typ = news.get(s['d'], (None, None))[0]; mts = None; mto = None
            if typ in ('NFP', 'CPI'): mts = 60 + u
            elif typ == 'FOMC': mts = (u - 270) if u >= 270 else None; mto = (270 - u) if u < 270 else None
            win = 'none' if typ is None else ('settled_0830' if typ in ('NFP', 'CPI') else ('dodge' if (mto is not None and 0 < mto <= 30) else ('reaction' if (mts is not None and 0 <= mts < 15) else ('settled' if mts is not None else 'FOMC_early'))))
            rows.append(dict(d=s['d'], u=u, D=D, es=es, rvol=rvol, volnow=volnow, rngr=rngr, on_pos=loc3(c[u], on['hi'], on['lo']), on_va=loc3(c[u], on['vah'], on['val']) if np.isfinite(on['vah']) else 0, va_pos=loc3(c[u], s['vah'], s['val']),
                on_range_rel=(on['hi'] - on['lo']) / atr, on_vol_rel=on['vol'] / onv if onv else np.nan, gap_rel=(o0 - prior_close) / atr, drift_w=(c[u] - o0) / atr * (-D), size_ratio=e['size'] / thr[e['t']], rvol_u=u,
                fade=rf['pts'] * RP.DPP - RP.COMM, flip=rc['pts'] * RP.DPP - RP.COMM, fade_big=rf['mfe'] >= L, flip_big=rc['mfe'] >= L, withdrift=(rf['pts'] if D == dsign else rc['pts']) * RP.DPP - RP.COMM, dsign=dsign, en=en, wd_xi=(rf['xi'] if D == dsign else rc['xi']), news=typ, win=win, era='PRE' if s['d'] < RP.PRE_END else 'POST'))
    print(f'marks used {len(rows)}, skipped (bad ratios) {skipped}; L = 50 points x ATR20 / median ATR20 (median ATR20 {1 / Lscale * 50:.0f} points)'); return rows
def main():
    rows = build(); rng = np.random.default_rng(SEED); es = np.array([r['es'] for r in rows]); q1, q2 = np.quantile(es, [1 / 3, 2 / 3])
    for r in rows: r['es_t'] = 0 if r['es'] <= q1 else (1 if r['es'] <= q2 else 2)
    def tab(name, R):
        if len(R) < 20: print(f'  {name:46s} n={len(R)} (too few)'); return
        days = [r['d'] for r in R]; m, lo, hi = RP.boot([r['fade'] - r['flip'] for r in R], days, rng, BOOT)
        print(f"  {name:46s} n={len(R):4d} fade {np.mean([r['fade'] for r in R]):6.2f} flip {np.mean([r['flip'] for r in R]):6.2f} fade-flip {m:6.2f} [{lo:6.2f},{hi:6.2f}] with-drift {np.mean([r['withdrift'] for r in R]):6.2f} | BIG_REV {100 * np.mean([r['fade_big'] for r in R]):3.0f}% BIG_CONT {100 * np.mean([r['flip_big'] for r in R]):3.0f}% both {100 * np.mean([r['fade_big'] and r['flip_big'] for r in R]):3.0f}%")
    print('\n=== P1 (counted): fade minus flip by EXPANSION SCORE tercile (rel. volume, volatility now, range so far) ===')
    G = [[r for r in rows if r['es_t'] == k] for k in range(3)]
    for k, nm in enumerate(('LOW expansion', 'MID', 'HIGH expansion')): tab(nm, G[k])
    d, lo, hi = did(G[2], G[0], rng, BOOT); pre = [np.mean([r['fade'] - r['flip'] for r in G[2] if r['era'] == e]) - np.mean([r['fade'] - r['flip'] for r in G[0] if r['era'] == e]) for e in ('PRE', 'POST')]
    print(f"  top minus bottom tercile of (fade - flip): {d:6.2f} [{lo:6.2f},{hi:6.2f}]  PRE {pre[0]:6.2f} POST {pre[1]:6.2f}  (hypothesis: negative = fade better when LOW expansion, continuation better when HIGH)")
    print('\n=== P2 (descriptive): by each factor ===')
    for fk, nm in (('rvol', 'RVOL'), ('volnow', 'VOLNOW'), ('rngr', 'RANGE_SO_FAR')):
        v = np.array([r[fk] for r in rows]); c1, c2 = np.quantile(v, [1 / 3, 2 / 3])
        for lab, sel in (('low', lambda x: x <= c1), ('mid', lambda x: c1 < x <= c2), ('high', lambda x: x > c2)): tab(f'{nm} {lab}', [r for r in rows if sel(r[fk])])
    for fk, nm in (('on_pos', 'price vs OVERNIGHT range'), ('on_va', 'price vs OVERNIGHT value'), ('va_pos', 'price vs PRIOR-DAY value')):
        for val, lab in ((1, 'above'), (0, 'inside'), (-1, 'below')): tab(f'{nm}: {lab}', [r for r in rows if r[fk] == val])
    ov = np.array([r['on_vol_rel'] for r in rows if np.isfinite(r['on_vol_rel'])]); c1, c2 = np.quantile(ov, [1 / 3, 2 / 3])
    for lab, sel in (('low', lambda x: x <= c1), ('mid', lambda x: c1 < x <= c2), ('high', lambda x: x > c2)): tab(f'OVERNIGHT relative volume {lab}', [r for r in rows if np.isfinite(r['on_vol_rel']) and sel(r['on_vol_rel'])])
    orr = np.array([r['on_range_rel'] for r in rows]); c1, c2 = np.quantile(orr, [1 / 3, 2 / 3])
    for lab, sel in (('small', lambda x: x <= c1), ('mid', lambda x: c1 < x <= c2), ('large', lambda x: x > c2)): tab(f'OVERNIGHT range {lab}', [r for r in rows if sel(r['on_range_rel'])])
    for lab, lo_, hi_ in (('first hour (before 10:30)', 0, 60), ('middle (10:30-13:30)', 60, 240), ('last two hours', 240, 391)): tab(f'time of day: {lab}', [r for r in rows if lo_ <= r['u'] < hi_])
    print('\n=== NEWS (descriptive; calendar = NFP, CPI, FOMC only) ===')
    tab('no scheduled big release today', [r for r in rows if r['news'] is None])
    for t in ('NFP', 'CPI', 'FOMC'): tab(f'{t} day, all marks', [r for r in rows if r['news'] == t])
    for w in ('settled_0830', 'FOMC_early', 'dodge', 'reaction', 'settled'): tab(f'window: {w}', [r for r in rows if r['win'] == w])
    print('\n=== P3 (causal chooser): choose FADE or FLIP by the sign of earlier marks in the same expansion tercile (>= 50) ===')
    srt = sorted(rows, key=lambda r: (r['d'], r['u'])); hist = {0: [], 1: [], 2: []}; pol = []; allf = []
    for r in srt:
        h = hist[r['es_t']]; ch = 'fade' if (len(h) >= 50 and np.mean(h) > 0) else ('flip' if len(h) >= 50 else None); h.append(r['fade'] - r['flip'])
        if ch: pol.append(dict(d=r['d'], pol=r[ch], fade=r['fade'], flip=r['flip'], wd=r['withdrift']))
    days = [p['d'] for p in pol]
    for nm, k in (('policy', 'pol'), ('always FADE', 'fade'), ('always FLIP', 'flip'), ('with-drift rule', 'wd')): print(f"  {nm:16s} n={len(pol)} mean {np.mean([p[k] for p in pol]):6.2f}")
    for nm, k in (('policy minus with-drift', 'wd'), ('policy minus always FADE', 'fade'), ('policy minus always FLIP', 'flip')): m, lo, hi = RP.boot([p['pol'] - p[k] for p in pol], days, rng, BOOT); print(f"  {nm:26s} {m:6.2f} [{lo:6.2f},{hi:6.2f}]")
    print('\n=== P4 (descriptive): walk-forward logistic regression, expanding window, monthly refit; out-of-sample AUC ===')
    FE = ['es', 'rvol', 'volnow', 'rngr', 'on_pos', 'on_va', 'va_pos', 'on_range_rel', 'on_vol_rel', 'gap_rel', 'u', 'drift_w', 'size_ratio']; X = np.array([[np.log(r[f]) if f in ('rvol', 'volnow', 'rngr') else r[f] for f in FE] for r in srt], float); months = np.array([r['d'][:7] for r in srt])
    for lab, key in (('BIG_CONT (flip captures a large move)', 'flip_big'), ('BIG_REV (fade captures a large move)', 'fade_big')):
        y = np.array([bool(r[key]) for r in srt]); pred = np.full(len(srt), np.nan)
        for m in sorted(set(months)):
            tr = np.where(months < m)[0]; te = np.where(months == m)[0]
            if len(tr) < 300 or len(set(y[tr])) < 2: continue
            mu = np.nanmedian(X[tr], 0); Xt = np.where(np.isnan(X[tr]), mu, X[tr]); sd = Xt.std(0); sd[sd == 0] = 1; m0 = Xt.mean(0); mdl = LogisticRegression(max_iter=300, C=1.0).fit((Xt - m0) / sd, y[tr]); Xe = np.where(np.isnan(X[te]), mu, X[te]); pred[te] = mdl.predict_proba((Xe - m0) / sd)[:, 1]
        ok = ~np.isnan(pred); auc = roc_auc_score(y[ok], pred[ok]); aes = roc_auc_score(y[ok], X[ok, 0]); dd = np.array([srt[i]['d'] for i in np.where(ok)[0]]); ud = sorted(set(dd)); idx = {d: np.where(dd == d)[0] for d in ud}; yy = y[ok]; pp = pred[ok]; bs = []
        for _ in range(300):
            pick = np.concatenate([idx[ud[j]] for j in rng.integers(0, len(ud), len(ud))])
            if len(set(yy[pick])) == 2: bs.append(roc_auc_score(yy[pick], pp[pick]))
        print(f"  {lab}: base rate {100 * y[ok].mean():4.1f}%, n={ok.sum()}, model AUC {auc:.3f} (day-bootstrap 95% {np.percentile(bs, 2.5):.3f}..{np.percentile(bs, 97.5):.3f}), expansion score alone AUC {aes:.3f}")
if __name__ == '__main__': main()
