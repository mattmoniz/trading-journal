"""Discovery stage of docs/EVENT_SNAPSHOT_STUDY_20261102.md on the DEPTH-ERA tell events (bar-level features only; depth features are stage 2). READS OUTCOMES -> look logged first (log_look_discovery.mjs).
Usage: /home/mmoniz/trading-journal/venv/bin/python /home/mmoniz/trading-journal/scripts/event_snapshots/run_discovery.py"""
import sys, glob, json
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/event_snapshots')
import numpy as np, pandas as pd
from scipy.stats import rankdata
import snapshot_features as SF
OUT = '/home/mmoniz/trading-journal/scratch/event_snapshots_20261102'; SEED, BOOT, DRAWS = 20261102, 3000, 1000

def load_days():
    days = []
    for f in sorted(glob.glob(f'{OUT}/day_*.json')):
        m = json.load(open(f)); z = np.load(f.replace('.json', '.npz')); d = {k: z[k] for k in z.files}; d.update(vap_i=z['vap_i'], vap_px=z['vap_px'], vap_tot=z['vap_tot'], onh=m['onh'], onl=m['onl'], atr=m['atr'], date=m['date']); days.append((m, d))
    return days

def tbin(day, i): m = (day['start'][i] - SF.RTH_OPEN) / 60.0; return 0 if m < 90 else 1 if m < 180 else 2

def event_rows(days, rng):
    tells, ctrl = [], []; meta = dict(tell_total=0, p0=0, no_out=0, p_ne_dir=0)
    for m, d in days:
        for t in m['tells']:
            meta['tell_total'] += 1; i = t['sig']; p = SF.direction(d, i)
            if p == 0: meta['p0'] += 1; continue
            if p != t['dir']: meta['p_ne_dir'] += 1
            f = SF.features(d, i, p, t['c4'], t['ladder']); o = SF.outcomes(d, i, p)
            if f is None or o is None: meta['no_out'] += 1; continue
            tells.append(dict(date=m['date'], i=i, p=p, kind='TELL', bin=tbin(d, i), **f, **o))
        for (i, tell, mov, c4u, lu, c4d, ld) in m['grid']:
            if tell or not mov: continue
            p = SF.direction(d, i)
            if p == 0: continue
            f = SF.features(d, i, p, c4u if p > 0 else c4d, lu if p > 0 else ld); o = SF.outcomes(d, i, p)
            if f is None or o is None: continue
            ctrl.append(dict(date=m['date'], i=i, p=p, kind='CONTROL', bin=tbin(d, i), **f, **o))
    T, C = pd.DataFrame(tells), pd.DataFrame(ctrl); keep = []
    for b in (0, 1, 2):
        n = 4 * int((T['bin'] == b).sum()); idx = np.where(C['bin'].values == b)[0]; keep += list(rng.choice(idx, size=min(n, len(idx)), replace=False))
    return T, C.iloc[sorted(keep)].reset_index(drop=True), meta

def corr_stats(df, feat, y, rng):
    d = df[[feat, y, 'date']].dropna().sort_values('date', kind='stable'); n = len(d); rx, ry = rankdata(d[feat].values), rankdata(d[y].values); r = float(np.corrcoef(rx, ry)[0, 1])
    days = d.date.values; ud = np.unique(days); idx = [np.where(days == u)[0] for u in ud]; bs = []
    for _ in range(BOOT): pick = np.concatenate([idx[j] for j in rng.integers(0, len(ud), len(ud))]); bs.append(np.corrcoef(rx[pick], ry[pick])[0, 1])
    lo, hi = np.nanpercentile(bs, [2.5, 97.5]); sh = rng.integers(1, n, DRAWS); plc = np.array([np.corrcoef(rx, np.roll(ry, s))[0, 1] for s in sh]); p = float((np.sum(np.abs(plc) >= abs(r)) + 1) / (DRAWS + 1))
    h = n // 2; r1 = np.corrcoef(rankdata(d[feat].values[:h]), rankdata(d[y].values[:h]))[0, 1]; r2 = np.corrcoef(rankdata(d[feat].values[h:]), rankdata(d[y].values[h:]))[0, 1]
    return dict(r=r, lo=float(lo), hi=float(hi), p=p, h1=float(r1), h2=float(r2), n=n, days=len(ud))

def paths(days, T, K=(-20, -10, -5, -3, -1, 0, 1, 3, 5, 10, 20)):
    """mean aligned delta share per bar and mean aligned price path (ATR units from the event close), continuation (y30 > 0) versus pivot (y30 <= 0) tell events."""
    byd = {m['date']: d for m, d in days}; res = {g: {k: ([], []) for k in K} for g in ('cont', 'pivot')}
    for _, r in T.iterrows():
        d = byd[r.date]; i = int(r.i); g = 'cont' if r.y30 > 0 else 'pivot'
        for k in K:
            j = i + k
            if j < 1 or j >= len(d['c']) or not d['comp'][min(j, len(d['c']) - 1)]: continue
            res[g][k][0].append(r.p * (d['ask'][j] - d['bid'][j]) / d['vol'][j]); res[g][k][1].append(r.p * (d['c'][j] - d['c'][i]) / d['atr'])
    return res

def main():
    rng = np.random.default_rng(SEED + 41); days = load_days(); T, C, meta = event_rows(days, rng)
    print(f'depth-era days {len(days)} ({days[0][0]["date"]}..{days[-1][0]["date"]}); V1 tell events {meta["tell_total"]}; dropped p=0 {meta["p0"]}, incomplete window {meta["no_out"]}; evaluated TELL {len(T)} on {T.date.nunique()} dates (tell direction differs from the pre-event direction in {meta["p_ne_dir"]}); CONTROL {len(C)} on {C.date.nunique()} dates')
    print(f'unconditional: mean y30 TELL {T.y30.mean():+.4f} (continuation share {100 * (T.y30 > 0).mean():.1f}%), CONTROL {C.y30.mean():+.4f} ({100 * (C.y30 > 0).mean():.1f}%)')
    st = {f: corr_stats(T, f, 'y30', rng) for f in SF.FEATURES}; sc = {f: corr_stats(C, f, 'y30', rng) for f in SF.FEATURES}
    print('\nRESOLUTION (half-width of the day-blocked 95% CI of the Spearman correlation): TELL ' + f'{np.mean([(v["hi"] - v["lo"]) / 2 for v in st.values()]):.3f}, CONTROL {np.mean([(v["hi"] - v["lo"]) / 2 for v in sc.values()]):.3f}')
    ps = [st[f]['p'] for f in SF.FEATURES]; order = sorted(range(len(ps)), key=lambda i: ps[i]); keep = -1
    for rk, ix in enumerate(order): keep = rk if ps[ix] <= (rk + 1) / len(ps) * 0.10 else keep
    surv = {SF.FEATURES[ix]: rk <= keep for rk, ix in enumerate(order)}; cand = []
    print('\nCOUNTED: Spearman(feature, y30) on depth-era TELL events (y > 0 = the pre-event move continued); BH q=0.10 over 15 features')
    print('feature | r | CI | placebo p | halves | BH | CONTROL r (CI) | tell minus control')
    for f in SF.FEATURES:
        v, c = st[f], sc[f]; ok = surv[f] and (v['lo'] > 0 or v['hi'] < 0) and np.sign(v['h1']) == np.sign(v['h2']) == np.sign(v['r'])
        if ok: cand.append(dict(feature=f, r=v['r'], sign=int(np.sign(v['r']))))
        print(f'{f:11s} | {v["r"]:+.3f} | [{v["lo"]:+.3f}, {v["hi"]:+.3f}] | {v["p"]:.3f} | {v["h1"]:+.3f} / {v["h2"]:+.3f} | {"survives" if surv[f] else "no"} | {c["r"]:+.3f} [{c["lo"]:+.3f}, {c["hi"]:+.3f}] | {v["r"] - c["r"]:+.3f}{"  <== CANDIDATE" if ok else ""}')
    json.dump(cand, open(f'{OUT}/candidates.json', 'w')); print(f'\nCANDIDATES for the explore confirmation: {[c["feature"] for c in cand]}')
    for hz in ('y15', 'y60'): print(f'uncounted {hz}: ' + ', '.join(f'{f} {corr_stats(T, f, hz, rng)["r"]:+.3f}' for f in SF.FEATURES))
    print('\nSTORY PATHS (uncounted, descriptive): mean over tell events of the aligned delta share per bar and the aligned price path in ATR units, offsets in bars from the event bar; cont = y30 > 0')
    P = paths(days, T); n_c, n_p = int((T.y30 > 0).sum()), int((T.y30 <= 0).sum()); print(f'  groups: continuation N {n_c}, pivot N {n_p}')
    for k in P['cont']: print(f'  k={k:+3d}  delta cont {np.mean(P["cont"][k][0]):+.3f} pivot {np.mean(P["pivot"][k][0]):+.3f} | price cont {np.mean(P["cont"][k][1]):+.4f} pivot {np.mean(P["pivot"][k][1]):+.4f}')

if __name__ == '__main__': main()
