"""A7: hard range-per-bar floor (EMA10(TR) >= 13 / 15 / 17 pt) on ROC10 expansion onsets, depth-era explore sessions only (look 197). Same pipeline as depth_tell2 (real Ratio, gap-masked windows, V0 exits). Reads no held-back session."""
import sys, os, glob, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import features as Fm, v2, depth_tell2 as D
LO, HI = '2026-06-15', '2026-10-09'; COST = 2.0; TS = (13.0, 15.0, 17.0)
srcs = {}
for pat in ('scratch/volbars500_holdout_20261103/*.bars.tsv', 'scratch/amt_tell_live/*.split.bars.tsv', 'scratch/argon_vacuum_live/priors/*.bars.tsv'):
    for p in glob.glob(os.path.join(Fm.ROOT, pat)):
        d = os.path.basename(p)[:10]
        if '2026-04-15' <= d <= HI and d != '2026-11-06': srcs.setdefault(d, p)
dates = sorted(srcs); rec = collections.defaultdict(list); hist = {'RTH': [], 'GBX': []}; prevS = None; prevd = None; nsess = 0
for d in dates:
    S = Fm.load_full(srcs[d])
    if S is None: continue
    tsp = Fm.track_split(S); close = Fm.EARLY_CLOSE if d in Fm.EARLY else Fm.CLOSE; prs = {}
    for name in ('RTH', 'GBX'):
        prev = hist[name][-Fm.K_PRIOR:]
        if len(prev) >= Fm.K_PRIOR: prs[name] = Fm.priors_of(prev)
    cp = os.path.join(D.C2, f'{d}.npz')
    if LO <= d <= HI and len(prs) == 2 and os.path.exists(cp) and prevS is not None:
        P, n0, reset = v2.continuous(prevS, S); F = v2.feats(P, n0, reset, prs, close); n = len(P['c']); F['etr'] = Fm.ema(F['tr']); dc = D.depth_arrays(S['en'], np.load(cp))
        pcp = os.path.join(D.C2, f'{prevd}.npz'); dp = D.depth_arrays(prevS['en'], np.load(pcp)) if os.path.exists(pcp) else None; rr = None
        if dc is not None:
            cont = {k: np.concatenate([dp[k] if dp is not None else np.full(len(prevS['en']), np.nan), dc[k]]) for k in dc}; rr = D.real_ratio(F, D.ffill(cont['bid_all'] + cont['ask_all']))
        if rr is not None:
            F['ratio'], F['zr'], F['rs'] = rr; nsess += 1; en, c, h, l, o = P['en'], P['c'], P['h'], P['l'], P['o']; idx = np.arange(n); z = F['zroc']; zr = F['zr']
            gap = np.zeros(n)
            for i in np.where(reset)[0]:
                if i > 0: gap[i:] += o[i] - c[i - 1]
            cx = c - gap; ema20 = Fm.ema(cx, 20); ok = (idx >= n0) & ~np.isnan(z) & ~np.isnan(zr); prev_ok = np.r_[False, ~np.isnan(z[:-1]) & ~np.isnan(zr[:-1])]
            dd = np.where(F['roc'] > 0, 1, np.where(F['roc'] < 0, -1, 0)); c0u = ~np.isnan(z) & (np.abs(z) > Fm.Z_ROC) & (np.sign(z) == dd); on0 = D.onset(c0u) & prev_ok
            for tr, win, flat in (('RTH', ok & (en >= 56100.0) & (en <= close - 600.0), int(np.where(en <= close - 300.0)[0].max())), ('GBX', ok & (en <= 55500.0), int(np.where(en <= 55790.0)[0].max()))):
                lock = -1
                for a in np.where(on0 & win)[0]:
                    if a + 1 > flat: continue
                    dr = int(dd[a]); f = dr * (c[min(a + 30, flat)] - o[a + 1]); etr = float(F['etr'][a]); trr = float(F['tr'][a])
                    rec[(tr, 'all')].append((d, f)); rec[(tr, 'etr_list')].append(etr)
                    for T in TS:
                        rec[(tr, f'etr>={T}' if etr >= T else f'etr<{T}')].append((d, f)); rec[(tr, f'tr>={T}' if trr >= T else f'tr<{T}')].append((d, f))
                    if a + 1 > lock:
                        wo = float(l[max(n0, a - 3):a + 1].min()) if dr == 1 else float(h[max(n0, a - 3):a + 1].max()); ex = D.trade_exit(P, F, a, a + 1, dr, flat, ema20, wo, F['rs'][a], cx)
                        if ex is not None:
                            lock = ex[0]; pnl = dr * (ex[1] - o[a + 1]) - COST; rec[(tr, 'net_all')].append((d, pnl))
                            for T in TS: rec[(tr, f'net_etr>={T}' if etr >= T else f'net_etr<{T}')].append((d, pnl))
    for name, T in tsp.items(): hist[name].append(T)
    prevS = S; prevd = d
print(f'A7 hard range-per-bar floor; explore sessions {nsess} ({LO}..{HI}); continuation = signed 30-bar change from Open[t+1] (pt); V0-exit trades net of {COST} pt')
res = []; pv = []
for tr in ('RTH', 'GBX'):
    ev = np.array(rec[(tr, 'etr_list')]); print(f'\n===== {tr}: ROC expansions N {len(ev)}; EMA10(TR) at the signal bar: median {np.median(ev):.1f} pt, 10th-90th pct {np.quantile(ev, .1):.1f}-{np.quantile(ev, .9):.1f}')
    m = D.mean_ci(rec[(tr, 'all')], 1); print(f'  all expansions: N {m[3]} continuation {m[0]:+.2f} [{m[1]:+.2f}, {m[2]:+.2f}]')
    for T in TS:
        a_, b_ = rec[(tr, f'etr>={T}')], rec[(tr, f'etr<{T}')]
        if not a_ or not b_: continue
        ma = D.mean_ci(a_, 2); mb = D.mean_ci(b_, 3); r = D.diff(a_, b_, 40 + int(T)); na = D.mean_ci(rec[(tr, f'net_etr>={T}')], 4) if rec[(tr, f'net_etr>={T}')] else None
        h1, h2 = D.halves(a_)
        print(f'  floor {T:.0f} pt: above N {ma[3]:5d} ({100 * ma[3] / len(ev):.0f}%) cont {ma[0]:+6.2f} [{ma[1]:+.2f}, {ma[2]:+.2f}] halves {h1:+.2f}/{h2:+.2f} | below N {mb[3]:5d} cont {mb[0]:+6.2f} | above minus below {r[0]:+.2f} [{r[1]:+.2f}, {r[2]:+.2f}] p {r[3]:.4f}' + (f' | V0-exit net above {na[0]:+.2f} [{na[1]:+.2f}, {na[2]:+.2f}] N {na[3]}' if na else ''))
        if tr == 'RTH': res.append((f'RTH floor {T:.0f}', r)); pv.append((r[3], len(res) - 1))
        ta, tb = rec[(tr, f'tr>={T}')], rec[(tr, f'tr<{T}')]
        if ta and tb: rt = D.diff(ta, tb, 80 + int(T)); print(f'      single-bar TR >= {T:.0f}: above minus below {rt[0]:+.2f} [{rt[1]:+.2f}, {rt[2]:+.2f}] (descriptive)')
order = sorted(pv); m = len(order); keep = set()
for rank, (p, idx) in enumerate(order):
    if p <= 0.10 / (m - rank): keep.add(idx)
    else: break
print(f'\nHolm 0.10 over {m} counted tests (RTH): survivors: ' + (', '.join(res[i][0] for i in sorted(keep)) or 'none'))
