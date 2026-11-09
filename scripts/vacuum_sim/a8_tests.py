"""A8 tests (prereg amendment A8, ledger look 198): Wave 2 re-ignition (RTH, HOLD exits), near-touch depletion (RTH), Globex one-sided continuation (HOLD exit, two tests) + descriptive horizon shape and HOLD exits. Explore sessions only; held-back sessions are never read."""
import sys, os, glob, collections, json
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import features as Fm, v2, depth_tell2 as D
LO, HI = '2026-06-15', '2026-10-09'; COST = 2.0; BARS_H = (1, 3, 5, 10, 15, 30); SECS_H = (60, 180, 300, 900)
srcs = {}
for pat in ('scratch/volbars500_holdout_20261103/*.bars.tsv', 'scratch/amt_tell_live/*.split.bars.tsv', 'scratch/argon_vacuum_live/priors/*.bars.tsv'):
    for p in glob.glob(os.path.join(Fm.ROOT, pat)):
        d = os.path.basename(p)[:10]
        if '2026-04-15' <= d <= HI and d != '2026-11-06': srcs.setdefault(d, p)
dates = sorted(srcs); rec = collections.defaultdict(list); hist = {'RTH': [], 'GBX': []}; prevS = None; prevd = None; nsess = 0; rng = np.random.default_rng(20261109)
skews = []; osd_past = []
def hour_struct(prev):
    K = len(prev); vals = []; wts = []; hrs = []
    for Pp in prev:
        x = np.abs(Pp['ask'] - Pp['bid']) / 500.0; vals.append(x); wts.append(np.full(len(x), 1.0 / (K * len(x)))); hrs.append(Fm.hour_et(Pp['en']))
    x = np.concatenate(vals); w = np.concatenate(wts); h = np.concatenate(hrs); out = {}
    for hh in np.unique(h):
        m = h == hh; i = np.argsort(x[m], kind='stable'); out[int(hh)] = (x[m][i], np.cumsum(w[m][i]) / w[m].sum())
    return out
def cdf_at(st, hour, v):
    e = st.get(int(hour))
    if e is None: return np.nan
    j = np.searchsorted(e[0], v, side='right') - 1; return float(e[1][j]) if j >= 0 else 0.0
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
            F['ratio'], F['zr'], F['rs'] = rr; nsess += 1; en, c, h, l, o = P['en'], P['c'], P['h'], P['l'], P['o']; idx = np.arange(n); z = F['zroc']; zr = F['zr']; roc = F['roc']
            gap = np.zeros(n)
            for i in np.where(reset)[0]:
                if i > 0: gap[i:] += o[i] - c[i - 1]
            cx = c - gap; ema20 = Fm.ema(cx, 20); ok = (idx >= n0) & ~np.isnan(z) & ~np.isnan(zr); prev_ok = np.r_[False, ~np.isnan(z[:-1]) & ~np.isnan(zr[:-1])]
            dd = np.where(roc > 0, 1, np.where(roc < 0, -1, 0)); c0u = ~np.isnan(z) & (np.abs(z) > Fm.Z_ROC) & (np.sign(z) == dd); on0 = D.onset(c0u) & prev_ok
            ontc = D.onset(c0u & ~np.isnan(zr) & (zr > Fm.Z_RATIO)) & prev_ok
            rth_w = ok & (en >= 56100.0) & (en <= close - 600.0); gbx_w = ok & (en <= 55500.0)
            flat_r = int(np.where(en <= close - 300.0)[0].max()); flat_g = int(np.where(en <= 55790.0)[0].max()); flow = np.where(dd > 0, F['fl_l'], F['fl_s'])
            ag = np.where(dd > 0, cont['ask10'] - cont['bid10'], cont['bid10'] - cont['ask10']); tot = cont['ask10'] + cont['bid10']; skew = ag / np.where(tot > 0, tot, np.nan)
            opp5 = np.where(dd > 0, cont['ask5'], cont['bid5'])
            def run_trade(a, dr, flat, use_hook, maxb):
                wo = float(l[max(n0, a - 3):a + 1].min()) if dr == 1 else float(h[max(n0, a - 3):a + 1].max())
                ex = D.trade_exit(P, F, a, a + 1, dr, flat, ema20, wo, F['rs'][a], cx, use_hook=use_hook, maxb=maxb)
                return None if ex is None else (ex[0], dr * (ex[1] - o[a + 1]) - COST, ex[2])
            def drift(a, dr, flat, key):
                for hb in BARS_H: rec[key + f'|b{hb}'].append((d, dr * (c[min(a + hb, flat)] - o[a + 1])))
                for sx in SECS_H:
                    j = min(n0 + int(np.searchsorted(en[n0:], en[a] + sx)), flat); rec[key + f'|s{sx}'].append((d, dr * (c[j] - o[a + 1])))
            # ---- descriptive horizon shape + HOLD exits (RTH E0, RTH FULL, Globex E0) and the time-of-day sensitivity
            for key, m, flat in (('RTH_E0', on0 & rth_w, flat_r), ('RTH_FULL', ontc & rth_w & F['user_fast'] & flow, flat_r), ('GBX_E0', on0 & gbx_w, flat_g)):
                lock = -1
                for a in np.where(m)[0]:
                    if a + 1 > flat: continue
                    dr = int(dd[a]); drift(a, dr, flat, key)
                    if key == 'RTH_E0': rec['RTH_E0|early' if en[a] < 59400.0 else 'RTH_E0|late'].append((d, dr * (c[min(a + 30, flat)] - o[a + 1])))
                    if a + 1 > lock:
                        t = run_trade(a, dr, flat, False, 60)
                        if t is not None: lock = t[0]; rec[key + '|holdnet'].append((d, t[1]))
            # ---- W2 (RTH): Wave 2 re-ignition with HOLD exits
            lockw = -1; lock0 = -1
            for a in np.where(ontc & rth_w)[0]:
                dr = int(dd[a]); found = None; pb = False
                for t in range(a + 1, min(a + 20, flat_r - 1) + 1):
                    if dr * roc[t] <= 0: break
                    if not pb:
                        if zr[t] <= 0.25: pb = True
                        continue
                    if dr * (roc[t] - roc[t - 1]) > 0 and zr[t] > 1.0 and F['user_fast'][t]: found = t; break
                if found is not None and found + 1 > lockw and found + 1 <= flat_r and rth_w[found]:
                    t = run_trade(found, dr, flat_r, False, 60)
                    if t is not None: lockw = t[0]; rec['W2|net'].append((d, t[1]))
            for a in np.where(on0 & rth_w)[0]:
                if a + 1 > lock0 and a + 1 <= flat_r:
                    t = run_trade(a, int(dd[a]), flat_r, False, 60)
                    if t is not None: lock0 = t[0]; rec['W2ctl|net'].append((d, t[1]))
            # ---- ND (RTH): near-touch depletion ahead
            for a in np.where(on0 & rth_w)[0]:
                if a + 1 > flat_r or np.isnan(skew[a]) or a < 3 or np.isnan(opp5[a]) or np.isnan(opp5[a - 3]): continue
                dr = int(dd[a]); f = dr * (c[min(a + 30, flat_r)] - o[a + 1])
                if len(skews) >= 100:
                    q33 = np.quantile(skews, 1 / 3); dep = (skew[a] <= q33) and (opp5[a] < opp5[a - 3]); rec['ND|dep' if dep else 'ND|other'].append((d, f))
                    if dep:
                        j = min(n0 + int(np.searchsorted(en[n0:], en[a] + 300)), flat_r); rec['ND|dep_s300'].append((d, dr * (c[j] - o[a + 1])))
                skews.append(float(skew[a]))
            # ---- G1 (Globex): one-sided continuation
            hs = hour_struct(hist['GBX'][-Fm.K_PRIOR:]) if len(hist['GBX']) >= Fm.K_PRIOR else None; lockg = -1; winG = np.where(gbx_w & (dd != 0))[0]
            if hs is not None:
                for a in np.where(on0 & gbx_w)[0]:
                    if a + 1 > flat_g or not F['user_fast'][a] or F['etr'][a] < 13.0: continue
                    osd = cdf_at(hs, int(Fm.hour_et(np.array([en[a]]))[0]), abs(P['ask'][a] - P['bid'][a]) / 500.0)
                    if np.isnan(osd) or osd < 2 / 3 or a + 1 <= lockg: continue
                    t = run_trade(a, int(dd[a]), flat_g, False, 30)
                    if t is None: continue
                    lockg = t[0]; rec['G1|net'].append((d, t[1])); hr = int(Fm.hour_et(np.array([en[a]]))[0]); pool = [x for x in winG if int(Fm.hour_et(np.array([en[x]]))[0]) == hr and x != a and x + 1 <= flat_g]; got = []
                    for x in rng.permutation(pool)[:12]:
                        g = run_trade(int(x), int(dd[x]), flat_g, False, 30)
                        if g is not None: got.append(g[1])
                        if len(got) >= 3: break
                    if got: rec['G1ctl|net'].append((d, float(np.mean(got))))
    for name, T in tsp.items(): hist[name].append(T)
    prevS = S; prevd = d
print(f'A8 tests; explore sessions {nsess} ({LO}..{HI}); entry Open[t+1]; trades net of {COST} pt; HOLD exits = no hook.')
for key in ('RTH_E0', 'RTH_FULL', 'GBX_E0'):
    s1 = ' '.join(f'{hb}b:{D.mean_ci(rec[key + f"|b{hb}"], 3)[0]:+.2f}' for hb in BARS_H if rec[key + f'|b{hb}']); s2 = ' '.join(f'{sx}s:{D.mean_ci(rec[key + f"|s{sx}"], 4)[0]:+.2f}' for sx in SECS_H if rec[key + f'|s{sx}'])
    n_ = len(rec[key + '|b1']); print(f'  DRIFT {key} (N {n_}): bars {s1} | clock {s2}')
    if rec[key + '|holdnet']: print(f'     HOLD-exit trades: {D.dist(rec[key + "|holdnet"])}')
e_, l_ = rec['RTH_E0|early'], rec['RTH_E0|late']
if e_ and l_: me = D.mean_ci(e_, 5); ml = D.mean_ci(l_, 6); print(f'  RTH E0 30-bar drift by time of day: 09:35-10:30 N {me[3]} {me[0]:+.2f} | later N {ml[3]} {ml[0]:+.2f}')
res = []; pv = []
def test(name, a, b, seed):
    if not a or not b: print(f'  {name}: not enough ({len(a)} vs {len(b)})'); return
    r = D.diff(a, b, seed); res.append((name, r)); pv.append((r[3], len(res) - 1)); print(f'  {name}: diff {r[0]:+.2f} pt [{r[1]:+.2f}, {r[2]:+.2f}] one-sided p {r[3]:.4f} (N {len(a)} vs {len(b)})')
if rec['W2|net']: print(f'  W2 trades: {D.dist(rec["W2|net"])}   control E0-HOLD: {D.dist(rec["W2ctl|net"])}')
test('W2 Wave-2 net - E0 HOLD net (RTH)', rec['W2|net'], rec['W2ctl|net'], 31)
test('ND depleted-ahead - other E0, 30 bars (RTH)', rec['ND|dep'], rec['ND|other'], 32)
if rec['ND|dep_s300']: m = D.mean_ci(rec['ND|dep_s300'], 8); print(f'     ND depleted 300 s continuation {m[0]:+.2f} [{m[1]:+.2f}, {m[2]:+.2f}] N {m[3]}')
if rec['G1|net']:
    print(f'  G1 trades: {D.dist(rec["G1|net"])}   halves {D.halves(rec["G1|net"])[0]:+.2f} / {D.halves(rec["G1|net"])[1]:+.2f}   control: {D.dist(rec["G1ctl|net"]) if rec["G1ctl|net"] else "n/a"}')
    ds = D.dstats(rec['G1|net']); tot = sum(v[0] for v in ds.values()); top = max(v[0] for v in ds.values()); print(f'     top single day {top:+.1f} of total {tot:+.1f}' + (f' = {top / tot:.0%}' if tot > 0 else ''))
    mm = D.mean_ci(rec['G1|net'], 9); rng2 = np.random.default_rng(33); dl = sorted(ds); A = np.array([ds[x] for x in dl]); bs = []
    for _ in range(3000):
        i = rng2.integers(0, len(dl), len(dl)); s_, k = A[i, 0].sum(), A[i, 1].sum()
        if k: bs.append(s_ / k)
    pA = float((1 + (np.array(bs) <= 0).sum()) / (len(bs) + 1)); res.append(('G1 net per trade > 0 (Globex)', (mm[0], mm[1], mm[2], pA))); pv.append((pA, len(res) - 1)); print(f'  G1 net per trade {mm[0]:+.2f} [{mm[1]:+.2f}, {mm[2]:+.2f}] one-sided p {pA:.4f} (N {mm[3]}, days {mm[4]})')
test('G1 net - matched random-bar control (Globex)', rec['G1|net'], rec['G1ctl|net'], 34)
order = sorted(pv); m = len(order); keep = set()
for rank, (p, idx_) in enumerate(order):
    if p <= 0.10 / (m - rank): keep.add(idx_)
    else: break
print(f'Holm 0.10 over {m} counted tests: survivors: ' + (', '.join(res[i][0] for i in sorted(keep)) or 'none'))
json.dump([dict(test=n, diff=r[0], lo=r[1], hi=r[2], p=r[3], holm=i in keep) for i, (n, r) in enumerate(res)], open(os.path.join(v2.OUT, 'a8_summary.json'), 'w'), indent=1)
