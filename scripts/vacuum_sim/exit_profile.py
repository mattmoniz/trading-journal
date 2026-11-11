"""DESCRIPTIVE (never counted): MFE / MAE survival profile of (V) the live vacuum rule's trades (ROC10 onset, 30-bar hold, V0 stop 2.5 x EMA10(TR), one position per track) on explore 2023-25, RTH and Globex apart, and (T) the tell's 1,760 explore entries (V1 management).
Reports how far trades run (MFE in ADR20 and in units of the initial stop), how many reach each gate, what the reachers did afterwards (final result, round trips to <= 0, give-back), time to the extreme, and the early-loser split at bars 3 and 5."""
import os, sys, csv, glob, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import globex_roc3_test as G
Fm, v2, SH = G.Fm, G.v2, G.SH
def vacuum_trades():
    files = sorted(p for p in glob.glob(os.path.join(Fm.BARS, '*.bars.tsv')) if os.path.basename(p)[:10] <= Fm.LAST_EXPLORE)
    hist = {'RTH': [], 'GBX': []}; prevS = None; rows = []
    for p in files:
        S = Fm.load_full(p)
        if S is None: continue
        tsp = Fm.track_split(S); close = Fm.EARLY_CLOSE if S['date'] in Fm.EARLY else Fm.CLOSE; prs = {}
        for name in ('RTH', 'GBX'):
            prev = hist[name][-Fm.K_PRIOR:]
            if len(prev) >= Fm.K_PRIOR: prs[name] = Fm.priors_of(prev)
        if len(prs) == 2:
            rt = hist['RTH'][-20:]; adr20 = float(np.mean([T['h'].max() - T['l'].min() for T in rt])) if len(rt) >= 10 else None
            P, n0, reset = v2.continuous(prevS, S); n = len(P['c']); Fm.L_ROC = 10; F = v2.feats(P, n0, reset, prs, close); etr = Fm.ema(F['tr']); en, o, h, l, c = P['en'], P['o'], P['h'], P['l'], P['c']
            idx = np.arange(n); z = F['zroc']; roc = F['roc']; ok = (idx >= n0) & ~np.isnan(z); prev_ok = np.r_[False, ~np.isnan(z[:-1])]; dd = np.where(roc > 0, 1, np.where(roc < 0, -1, 0))
            on0 = SH.onset(~np.isnan(z) & (np.abs(z) > Fm.Z_ROC) & (np.sign(z) == dd)) & prev_ok
            gw = ok & (en <= 55500.0); rw = ok & (en >= 56100.0) & (en <= close - 600.0); lock = {'GBX': -1, 'RTH': -1}
            for a in np.where(on0 & (gw | rw))[0]:
                tr = 'GBX' if gw[a] else 'RTH'
                if a < lock[tr]: continue
                lock[tr] = a + 30; s = int(dd[a]); lim = G.LIM if tr == 'GBX' else close - 300.0
                inside = n0 + np.where(en[n0:] <= lim)[0]; flat = int(inside.max()) if len(inside) else -1; ei = a + 1
                if ei > flat or ei >= n: continue
                last = min(a + 30, flat); entry = float(o[ei]); sd = 2.5 * float(etr[a]); stop = entry - s * sd; mfe = 0.0; mae = 0.0; tm = 0; stopped = False; c3 = c5 = None; fin = None
                for t in range(ei, last + 1):
                    if (s == 1 and l[t] <= stop) or (s == -1 and h[t] >= stop): stopped = True; px = (stop if t == ei else (min(stop, o[t]) if s == 1 else max(stop, o[t]))) - s * 0.25; fin = s * (px - entry); tstop = t - ei + 1; break
                    fav = s * ((h[t] if s == 1 else l[t]) - entry); adv = s * ((l[t] if s == 1 else h[t]) - entry)
                    if fav > mfe: mfe = fav; tm = t - ei + 1
                    mae = min(mae, adv)
                    if t - ei + 1 == 3: c3 = s * (c[t] - entry)
                    if t - ei + 1 == 5: c5 = s * (c[t] - entry)
                if fin is None: fin = s * (float(c[last]) - entry); tstop = None
                rows.append(dict(date=S['date'], track=tr, adr20=adr20, stop_pts=sd, mfe=mfe, mae=mae, t_mfe=tm, stopped=stopped, final=fin, c3=c3, c5=c5))
        for name, T in tsp.items(): hist[name].append(T)
        prevS = S
    return rows
def block(rows, label, unit_key):
    n = len(rows)
    print(f'  {label}: N {n} on {len({r["date"] for r in rows})} days; stop-outs {np.mean([r["stopped"] for r in rows]):.0%}; mean final {np.mean([r["final"] for r in rows]):+.1f} pt (median {np.median([r["final"] for r in rows]):+.1f}); MFE median {np.median([r["mfe"] for r in rows]):.1f} / p75 {np.percentile([r["mfe"] for r in rows], 75):.1f} / p90 {np.percentile([r["mfe"] for r in rows], 90):.1f} pt; MAE median {np.median([r["mae"] for r in rows]):.1f}')
    for g in unit_key[1]:
        thr = lambda r: g * r[unit_key[0]]
        re = [r for r in rows if r['mfe'] >= thr(r)]; no = [r for r in rows if r['mfe'] < thr(r)]
        if not re: print(f'    gate {g} x {unit_key[0]}: nobody reaches it'); continue
        rt = [r for r in re if r['final'] <= 0]; gb = [r['mfe'] - r['final'] for r in re]
        print(f'    gate {g} x {unit_key[0]}: {len(re) / n:.0%} reach it (N {len(re)}); of those: mean final {np.mean([r["final"] for r in re]):+.1f}, round trips to <= 0: {len(rt) / len(re):.0%}, stopped {np.mean([r["stopped"] for r in re]):.0%}, mean give-back from the peak {np.mean(gb):.1f} pt (median {np.median(gb):.1f}); median bar of the peak {np.median([r["t_mfe"] for r in re]):.0f}; non-reachers mean final {np.mean([r["final"] for r in no]) if no else float("nan"):+.1f}')
if __name__ == '__main__':
    V = vacuum_trades(); print(f'VACUUM live rule on explore 2023-25 (ROC10 onset, 30-bar hold, V0 stop 2.5 x EMA10(TR), pre-cost points, MFE counted before the stop bar): {len(V)} trades')
    for tr in ('RTH', 'GBX'):
        R = [dict(r, adr_pts=r['adr20']) for r in V if r['track'] == tr and r['adr20']]
        print(f'\n== {tr}'); block(R, 'all trades, gates in ADR20', ('adr_pts', (0.05, 0.10, 0.15, 0.20))); block(R, 'all trades, gates in initial stop distances', ('stop_pts', (0.5, 1.0, 1.5, 2.0)))
        e3 = [r for r in R if r['c3'] is not None]; w3 = [r for r in e3 if r['c3'] > 0]; l3 = [r for r in e3 if r['c3'] <= 0]
        print(f'  early split at bar 3 (alive at bar 3: {len(e3)}): winners {len(w3)} final {np.mean([r["final"] for r in w3]):+.1f}, early losers {len(l3)} final {np.mean([r["final"] for r in l3]):+.1f}; bar 5: ' + ', '.join(f'{lab} {len(sub)} final {np.mean([r["final"] for r in sub]):+.1f}' for lab, sub in (('winners', [r for r in R if r['c5'] is not None and r['c5'] > 0]), ('early losers', [r for r in R if r['c5'] is not None and r['c5'] <= 0]))))
        for y in ('2023', '2024', '2025'):
            sub = [r for r in R if r['date'][:4] == y]
            if sub: print(f'  {y}: N {len(sub)} reach 0.10 ADR20 {np.mean([r["mfe"] >= 0.1 * r["adr20"] for r in sub]):.0%}, reach 1.5 stops {np.mean([r["mfe"] >= 1.5 * r["stop_pts"] for r in sub]):.0%}')
    # tell: 1,760 explore entries (V1 management), columns of the stored replay rows
    adr = {r['date']: float(r['adr20']) for r in csv.DictReader(open(os.path.join(G.ROOT, 'scratch', 'globex_roc3_20261110', 'events.csv'))) if r['adr20'] not in ('', 'nan')}
    T = []
    for r in csv.DictReader(open(os.path.join(G.ROOT, 'scratch', 'tell_context_20261103', 'tell_floor_target_rows.csv'))):
        if r['date'] in adr and r['v1_mfe'] not in ('', 'nan'): T.append(dict(date=r['date'], adr20=adr[r['date']], stop_pts=float(r['risk_pts']), mfe=float(r['v1_mfe']), final=float(r['v1_pts']), stopped=r['v1_why'] == 'STOP', why=r['v1_why'], t_mfe=0, mae=0.0))
    print(f'\nTELL explore replay (V1 management, 1,760 entries, points; the replay stores MFE and the result, not the path): N with an ADR20 {len(T)}; exits: ' + str(dict(collections.Counter(r['why'] for r in T))))
    block(T, 'all tell entries, gates in ADR20', ('adr20', (0.05, 0.10, 0.15, 0.20))); block(T, 'all tell entries, gates in initial stop distances', ('stop_pts', (0.5, 1.0, 1.5, 2.0)))
