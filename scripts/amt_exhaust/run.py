"""Exhaustion reversal, EXPLORE ONLY (PREREG.md frozen). Usage: ../../venv/bin/python run.py census|explore"""
import sys, os, pathlib, numpy as np, pandas as pd
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_s1')
import exhaust as X, engine as E
from amt_s1 import overnight_ranges
SPLIT, SEED, BOOT, TRIALS, COST_PTS = '2025-05-16', 20261028, 3000, 100, 1.5
HERE = pathlib.Path(__file__).parent

def segment(e): return 'MORNING' if e < 120 else ('MIDDAY' if e < 240 else 'AFTERNOON')

def boot_mean(vals, days, rng, it=BOOT):
    g = {}
    for v, d in zip(vals, days):
        if not np.isnan(v): g.setdefault(d, []).append(v)
    arrs = [np.array(x) for x in g.values()]; m = len(arrs)
    if m == 0: return float('nan'), float('nan'), float('nan')
    means = np.array([np.concatenate([arrs[j] for j in rng.integers(0, m, m)]).mean() for _ in range(it)])
    allv = np.concatenate(arrs); return float(allv.mean()), float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))

def boot_diff(v1, d1, v2, d2, rng, it=BOOT):
    g1, g2 = {}, {}
    for v, d in zip(v1, d1):
        if not np.isnan(v): g1.setdefault(d, []).append(v)
    for v, d in zip(v2, d2):
        if not np.isnan(v): g2.setdefault(d, []).append(v)
    days = sorted(set(g1) | set(g2)); out = []
    for _ in range(it):
        pick = [days[j] for j in rng.integers(0, len(days), len(days))]
        a = [x for d in pick for x in g1.get(d, [])]; b = [x for d in pick for x in g2.get(d, [])]
        if a and b: out.append(np.mean(a) - np.mean(b))
    base = np.mean([x for l in g1.values() for x in l]) - np.mean([x for l in g2.values() for x in l])
    return float(base), float(np.percentile(out, 2.5)), float(np.percentile(out, 97.5))

def prepare():
    raw = E.load_sessions(); allS = E.build_eligible(raw); ks = sorted(raw); on = overnight_ranges(end='2026-10-27'); ex = [s for s in allS if s['d'] <= SPLIT]
    stats = [X.push_stats(s['a']) for s in ex]; rngs = [float(np.nanmax(s['a']['h']) - np.nanmin(s['a']['l'])) for s in ex]
    sess = []
    for si, s in enumerate(ex):
        thr = X.trailing_thresholds(stats, si, q_mv=int(os.environ.get('EXH_QMV', 90)), q_er=int(os.environ.get('EXH_QER', 75)))   # defaults = PREREG.md; PREREG_WIDE.md sets 80 / 60
        if thr is None: continue
        r = on.loc[s['d']] if s['d'] in on.index else None; pv = raw[ks[ks.index(s['d']) - 1]]
        s = dict(s); s['thr'], s['st'] = thr, stats[si]; s['atr20'] = float(np.mean(rngs[si - 20:si])); s['atr14'] = E.atr14(s['a'])
        s['lv'] = dict(pdVAH=s['vah'], pdVAL=s['val'], pdPOC=s['poc'], pdH=float(np.nanmax(pv['h'])), pdL=float(np.nanmin(pv['l'])))
        if r is not None and r.n >= 500: s['lv'].update(ONH=float(r.hi), ONL=float(r.lo))
        s['ib'] = (float(np.nanmax(s['a']['h'][:60])), float(np.nanmin(s['a']['l'][:60]))); sess.append(s)
    return sess

def events_for(sess, exh_q=X.Q_EXH, window=X.RESP_WINDOW, seed=SEED):
    rng = np.random.default_rng(seed); out = {k: [] for k in ('E1', 'E2', 'C2', 'NR')}; nsig = 0
    per = []
    for s in sess:
        ev = X.build_events(s['a'], s['st'], s['thr'], exh_q=exh_q, window=window); per.append(ev)
        for k in ('E1', 'E2', 'C2'):
            for e in ev[k]: e['date'] = s['d']; e['si'] = s['d']; out[k].append(e)
    lags = [e['lag'] for e in out['E2']] or [2]
    for s, ev in zip(sess, per):
        for sg in ev['NR']:
            e = sg['t'] + int(rng.choice(lags)) + 1
            if X.ENTRY_LO <= e <= X.ENTRY_HI and e < 390 and not np.isnan(s['a']['o'][e]): x = X.to_event(sg, e); x['date'] = s['d']; out['NR'].append(x)
    return out, sum(len(e['NR']) + len(e['E2']) for e in per)

def enrich(sess, out):
    by = {s['d']: s for s in sess}
    for k, evs in out.items():
        for ev in evs:
            s = by[ev['date']]; ev.update(X.fwd(s['a'], ev)); ev['seg'] = segment(ev['e']); lv = dict(s['lv'])
            if ev['t'] >= 59: lv.update(IBH=s['ib'][0], IBL=s['ib'][1])
            P = np.array(list(lv.values())); ev['d_real'] = float(np.min(np.abs(ev['ext'] - P)) / s['atr20']); ev['d_sham'] = float(np.min(np.abs(ev['ext'] - (P + 0.5 * s['atr20']))) / s['atr20'])
            g = X.trade(s['a'], ev, s['atr14']); ev['geo'] = g
    return by

def main(stage):
    sess = prepare(); out, _ = events_for(sess); rng = np.random.default_rng(SEED)
    base_n = len(out['E1'])
    print(f"Explore sessions with a 20-session trailing history: {len(sess)} | exhaustion signals (E1) {len(out['E1'])} | counter-side response within {X.RESP_WINDOW} bars (E2) {len(out['E2'])} ({100 * len(out['E2']) / max(1, len(out['E2']) + len(out['NR'])):.0f}% of faded signals respond) | C2 (response, no exhaustion) {len(out['C2'])} | NR (exhaustion, no response) {len(out['NR'])}")
    for k in ('E1', 'E2', 'C2', 'NR'):
        sg = pd.Series([segment(e['e']) for e in out[k]]).value_counts(); ls = pd.Series([e['d'] for e in out[k]]).value_counts()
        print(f"  {k}: events {len(out[k])}, days {len(set(e['date'] for e in out[k]))}, per session {len(out[k]) / len(sess):.2f}; segments {dict(sg)}; long {int(ls.get(1, 0))} short {int(ls.get(-1, 0))}; median lag {np.median([e.get('lag', 0) for e in out[k]]) if k in ('E2', 'C2') else '-'}")
    if stage == 'census': print('\nCensus only: no outcomes read. E2 is the counted cell; fewer than 150 events would be UNDERPOWERED (stated, not abandoned).'); return
    by = enrich(sess, out)
    print('\n=== UNCENSORED FORWARD RETURN F15 (points, gross; trade direction = the reversal) ===')
    res = {}
    for k in ('E1', 'E2', 'C2', 'NR'):
        v = [e['F15'] for e in out[k]]; d = [e['date'] for e in out[k]]; m, lo, hi = boot_mean(v, d, rng); res[k] = (v, d)
        wr = 100 * np.nanmean(np.array(v) > 0); mfe = np.nanmean([e['mfe'] for e in out[k]]); mae = np.nanmean([e['mae'] for e in out[k]])
        print(f"  {k}: N={len(v)} gross mean {m:+.2f} (95% CI {lo:+.2f}..{hi:+.2f}) | net of {COST_PTS} pts {m - COST_PTS:+.2f} | F15>0 {wr:.0f}% | MFE30 {mfe:.1f} MAE30 {mae:.1f}")
    for k in ('E2',):
        print('    ' + ' '.join(f"F{h} {np.nanmean([e[f'F{h}'] for e in out[k]]):+.2f}" for h in (5, 15, 30, 60)))
    pl = []
    for _ in range(TRIALS):
        vals = []
        for e in out['E2']:
            a = by[e['date']]['a']; lo_, hi_ = max(X.ENTRY_LO, e['e'] - 30), min(X.ENTRY_HI, e['e'] + 30)
            for _t in range(20):
                i = int(rng.integers(lo_, hi_ + 1)); dd = int(rng.choice([-1, 1]))
                if i + 14 < 390 and not np.isnan(a['o'][i]) and not np.isnan(a['c'][i + 14]): vals.append(dd * (a['c'][i + 14] - (a['o'][i] + dd * X.SLIP))); break
        pl.append(np.mean(vals))
    pl = np.array(pl); m2 = np.nanmean(res['E2'][0]); print(f"  RANDOM-ENTRY PLACEBO (E2 times, random direction, {TRIALS} trials): placebo mean p5 {np.percentile(pl, 5):+.2f} p50 {np.percentile(pl, 50):+.2f} p95 {np.percentile(pl, 95):+.2f} | trials >= E2: {100 * np.mean(pl >= m2):.1f}%")
    for nm in ('C2', 'NR'):
        b, lo, hi = boot_diff(res['E2'][0], res['E2'][1], res[nm][0], res[nm][1], rng); print(f"  E2 minus {nm}: {b:+.2f} pts (day-blocked 95% CI {lo:+.2f}..{hi:+.2f})")
    print('\n  Descriptive splits of E2 (gross F15):')
    for nm, f in (('MORNING', lambda e: e['seg'] == 'MORNING'), ('MIDDAY', lambda e: e['seg'] == 'MIDDAY'), ('AFTERNOON', lambda e: e['seg'] == 'AFTERNOON'), ('long reversals', lambda e: e['d'] == 1), ('short reversals', lambda e: e['d'] == -1)):
        sub = [e for e in out['E2'] if f(e)]
        if sub: m, lo, hi = boot_mean([e['F15'] for e in sub], [e['date'] for e in sub], rng, 1500); print(f"    {nm}: N={len(sub)} {m:+.2f} (CI {lo:+.2f}..{hi:+.2f})")
    print('\n=== MGI INTERACTION (difference-in-differences vs sham levels; descriptive) ===')
    for k in ('E2', 'E1'):
        evs = [e for e in out[k] if not np.isnan(e['F15'])]; F = np.array([e['F15'] for e in evs]); days = [e['date'] for e in evs]
        qr, qs = np.percentile([e['d_real'] for e in evs], 25), np.percentile([e['d_sham'] for e in evs], 25)
        nr = np.array([e['d_real'] <= qr for e in evs]); ns = np.array([e['d_sham'] <= qs for e in evs])
        def did(idx):
            a = (F[idx][nr[idx]].mean() - F[idx][~nr[idx]].mean()) - (F[idx][ns[idx]].mean() - F[idx][~ns[idx]].mean()); return a
        base = did(np.arange(len(evs))); dd = {}
        for i, d in enumerate(days): dd.setdefault(d, []).append(i)
        keys = list(dd); bs = []
        for _ in range(2000):
            idx = np.concatenate([dd[keys[j]] for j in rng.integers(0, len(keys), len(keys))]).astype(int)
            if nr[idx].any() and (~nr[idx]).any() and ns[idx].any() and (~ns[idx]).any(): bs.append(did(idx))
        print(f"  {k}: near-real quartile (d <= {qr:.2f} ATR20, N={int(nr.sum())}) mean {F[nr].mean():+.2f} vs rest {F[~nr].mean():+.2f}; near-sham quartile mean {F[ns].mean():+.2f} vs rest {F[~ns].mean():+.2f}; DiD {base:+.2f} (95% CI {np.percentile(bs, 2.5):+.2f}..{np.percentile(bs, 97.5):+.2f})")
    print('\n=== GEOMETRY STAGE (descriptive): stop beyond the extreme by 1 tick + 0.5 x ATR14, target 50% retracement of the push, 30-bar time stop, flatten 15:55 ===')
    for k in ('E2', 'C2', 'NR', 'E1'):
        g = [(e['date'], e['geo']) for e in out[k] if e['geo']]
        if not g: print(f'  {k}: no trades'); continue
        net = np.array([x['net'] for _, x in g]); w, l = net[net > 0], net[net <= 0]; eq = np.cumsum(net); m, lo, hi = boot_mean(list(net), [d for d, _ in g], rng)
        mix = pd.Series([x['reason'] for _, x in g]).value_counts(normalize=True) * 100
        print(f"  {k}: N={len(g)} WR {100 * np.mean(net > 0):.0f}% PF {(w.sum() / abs(l.sum())) if l.sum() != 0 else float('inf'):.2f} mean ${m:.2f}/trade (CI {lo:.2f}..{hi:.2f}) avgW ${w.mean() if len(w) else 0:.2f} avgL ${l.mean() if len(l) else 0:.2f} maxDD ${np.max(np.maximum.accumulate(eq) - eq):.0f} | median risk {np.median([x['risk'] for _, x in g]):.1f} target {np.median([x['tdist'] for _, x in g]):.1f} pts | exits " + ', '.join(f'{a} {b:.0f}%' for a, b in mix.items()))
    gp = []
    for _ in range(TRIALS):
        v = []
        for e in out['E2']:
            if not e['geo']: continue
            a = by[e['date']]['a']; lo_, hi_ = max(X.ENTRY_LO, e['e'] - 30), min(X.ENTRY_HI, e['e'] + 30); i = int(rng.integers(lo_, hi_ + 1))
            if np.isnan(a['o'][i]): continue
            v.append(X.trade_fixed(a, i, int(rng.choice([-1, 1])), e['geo']['risk'], e['geo']['tdist']))
        gp.append(np.mean(v))
    gp = np.array(gp); real = np.mean([e['geo']['net'] for e in out['E2'] if e['geo']]); print(f"  RANDOM-ENTRY PLACEBO geometry (E2): real ${real:.2f} | placebo p5 {np.percentile(gp, 5):.2f} p50 {np.percentile(gp, 50):.2f} p95 {np.percentile(gp, 95):.2f} | trials >= real {100 * np.mean(gp >= real):.1f}%")
    print('\n=== DESCRIPTIVE SENSITIVITIES (never selected): E2 gross F15 ===')
    for lbl, kw in (('exhaustion quantile 10', dict(exh_q=10)), ('exhaustion quantile 40', dict(exh_q=40)), ('response window 3', dict(window=3)), ('response window 8', dict(window=8))):
        o2, _ = events_for(sess, **kw); enrich(sess, o2); v = [e['F15'] for e in o2['E2']]; m, lo, hi = boot_mean(v, [e['date'] for e in o2['E2']], rng, 1500); print(f"  {lbl}: E2 N={len(v)} {m:+.2f} (CI {lo:+.2f}..{hi:+.2f})")
    rows = [dict(grp=k, **{kk: vv for kk, vv in e.items() if kk not in ('geo',)}) for k in out for e in out[k]]; pd.DataFrame(rows).to_csv(HERE / f"events_explore{os.environ.get('EXH_TAG', '')}.csv", index=False)
    print('\nReading is pre-registered (PREREG.md): E2 is a lead only if gross F15 CI lower bound > 0, it beats the placebo p95, and E2-C2 and E2-NR have CI lower bounds > 0. Otherwise not shown.')

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'explore')
