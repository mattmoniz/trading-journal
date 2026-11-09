"""Globex continuation candidate (prereg amendment A5, ledger look 195). Usage: globex_candidate.py explore   |   globex_candidate.py confirm (REFUSES to run unless the frozen explore gate passed; reads sessions >= 2026-10-12, never 2026-11-06).
Entry = Open[t+1] after the ROC10 expansion ONSET in the Globex track (18:00 reopen included); exits = depth_tell2.trade_exit (V0 rules, real Ratio hook); cost 2.0 pt; one position at a time; control = matched random-bar entries (same session, same hour, direction = sign of ROC10, same exits)."""
import sys, os, glob, json, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import features as Fm, v2, depth_tell2 as D
MODE = sys.argv[1] if len(sys.argv) > 1 else 'explore'; EXIT = sys.argv[2] if len(sys.argv) > 2 else 'v0'; B = 3000; COST = 2.0      # EXIT: v0 (A5, the V0 exits), scalp300 (A6 PRIMARY), hold30 (A6 descriptive)
GATE = os.path.join(v2.OUT, 'globex_explore_gate.json' if EXIT == 'v0' else f'globex_explore_gate_{EXIT}.json')
if MODE == 'confirm':
    g = json.load(open(GATE)) if os.path.exists(GATE) else {}
    if not g.get('passed'): sys.exit('REFUSED: the frozen explore gate (prereg A5) has not passed; the held-back sessions stay unread.')
    LO, HI = '2026-10-12', '2026-11-30'
else: LO, HI = '2026-06-15', '2026-10-09'
srcs = {}
for pat in ('scratch/volbars500_holdout_20261103/*.bars.tsv', 'scratch/amt_tell_live/*.split.bars.tsv', 'scratch/argon_vacuum_live/priors/*.bars.tsv'):
    for p in glob.glob(os.path.join(Fm.ROOT, pat)):
        d = os.path.basename(p)[:10]
        if '2026-04-15' <= d <= HI and d != '2026-11-06': srcs.setdefault(d, p)
dates = sorted(srcs); rec = collections.defaultdict(list); hist = {'RTH': [], 'GBX': []}; prevS = None; prevd = None; nsess = 0; rng = np.random.default_rng(20261109)
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
            gbx_w = ok & (en <= 55500.0); dd = np.where(F['roc'] > 0, 1, np.where(F['roc'] < 0, -1, 0)); c0u = ~np.isnan(z) & (np.abs(z) > Fm.Z_ROC) & (np.sign(z) == dd); on0 = D.onset(c0u) & prev_ok & gbx_w
            flat = int(np.where(en <= 55790.0)[0].max()); hr = lambda x: int(Fm.hour_et(np.array([en[x]]))[0]); win = np.where(gbx_w & (dd != 0))[0]; lock = -1
            import re as _re
            _m = _re.match(r'hold30s(\d+(?:\.\d+)?)', EXIT); MULT = float(_m.group(1)) if _m else 2.5      # hold30s4 / hold30s6 = looser stops, hold30s0 = NO stop (A10)
            def scalp_exit(a, dr, secs, bars):
                e = a + 1; entry = o[e]; stop = (entry - dr * MULT * F['etr'][a]) if MULT > 0 else (-1e18 if dr == 1 else 1e18); last = min(e + 29, flat) if bars else flat
                for t in range(e, last + 1):
                    if dr == 1 and l[t] <= stop: return t, (stop if t == e else min(stop, o[t])) - 0.25, 'stop'
                    if dr == -1 and h[t] >= stop: return t, (stop if t == e else max(stop, o[t])) + 0.25, 'stop'
                    if (not bars) and en[t] >= en[a] + secs: return t, c[t], 'clock'
                return last, c[last], ('hold' if bars else 'flat')
            def trade(a):
                if EXIT != 'v0':
                    dr = int(dd[a]); ex = scalp_exit(a, dr, 300.0, EXIT.startswith('hold30')); return (ex, dr * (ex[1] - o[a + 1]) - COST)
                dr = int(dd[a]); wo = float(l[max(n0, a - 3):a + 1].min()) if dr == 1 else float(h[max(n0, a - 3):a + 1].max()); ex = D.trade_exit(P, F, a, a + 1, dr, flat, ema20, wo, F['rs'][a], cx)
                return None if ex is None else (ex, dr * (ex[1] - o[a + 1]) - COST)
            for a in np.where(on0)[0]:
                if a + 1 <= lock or a + 1 > flat: continue
                t = trade(a)
                if t is None: continue
                lock = t[0][0]; rec['net'].append((d, t[1])); rec['why'].append(t[0][2]); rec['hold'].append(t[0][0] - a); dr = int(dd[a]); seg = slice(a + 1, t[0][0] + 1)
                rec['mfe'].append((d, float((h[seg].max() - o[a + 1]) if dr == 1 else (o[a + 1] - l[seg].min())))); rec['reopen'].append(1 if en[a] < 5400.0 else 0)
                pool = [x for x in win if hr(x) == hr(a) and x != a and x + 1 <= flat]; got = []
                for x in rng.permutation(pool)[:12]:
                    g = trade(int(x))
                    if g is not None: got.append(g[1])
                    if len(got) >= 3: break
                if got: rec['ctl'].append((d, float(np.mean(got))))
    for name, T in tsp.items(): hist[name].append(T)
    prevS = S; prevd = d
def dstats(l):
    o = collections.defaultdict(lambda: [0.0, 0])
    for x in l: o[x[0]][0] += x[1]; o[x[0]][1] += 1
    return o
net = rec['net']; m = D.mean_ci(net, 5); m3 = D.mean_ci([(x[0], x[1] - 1.0) for x in net], 6)
print(f'GLOBEX candidate, stage {MODE}: sessions scored {nsess} ({LO}..{HI}); trades {len(net)}; reopen-window trades {int(sum(rec["reopen"]))}')
print(f'  net per trade {m[0]:+.2f} pt [{m[1]:+.2f}, {m[2]:+.2f}] (N {m[3]}, days {m[4]}); at 3.0 pt cost {m3[0]:+.2f} [{m3[1]:+.2f}, {m3[2]:+.2f}]; halves {D.halves(net)[0]:+.2f} / {D.halves(net)[1]:+.2f}')
print('  ' + D.dist(net) + f'; median hold {np.median(rec["hold"]):.0f} bars; mean MFE {np.mean([x[1] for x in rec["mfe"]]):+.1f}; exits {dict(collections.Counter(rec["why"]))}')
vv = np.array([x[1] for x in net]); print(f'  LOSS TAIL: worst trade {vv.min():+.1f}, 1st pct {np.quantile(vv, .01):+.1f}, 5th pct {np.quantile(vv, .05):+.1f}, 10th pct {np.quantile(vv, .10):+.1f}; worst single day {min(v[0] for v in dstats(net).values()):+.1f}; trades below -50: {int((vv < -50).sum())}')
ds = dstats(net); tot = sum(v[0] for v in ds.values()); top = max(ds.values(), key=lambda v: v[0])[0] if ds else 0; share = (top / tot) if tot > 0 else float('nan'); print(f'  top single day {top:+.1f} of total {tot:+.1f} = {share:.0%} of the profit')
gb = D.diff(net, rec['ctl'], 11); ga = D.diff(net, [(x[0], 0.0) for x in net], 12) if False else None
c_m = D.mean_ci(rec['ctl'], 7); print(f'  control (matched random-bar entries, same exits) net {c_m[0]:+.2f} [{c_m[1]:+.2f}, {c_m[2]:+.2f}] (N {c_m[3]})'); print(f'  G-B candidate minus control: {gb[0]:+.2f} pt [{gb[1]:+.2f}, {gb[2]:+.2f}] one-sided p {gb[3]:.4f}')
rng2 = np.random.default_rng(31); dsd = dstats(net); dl = sorted(dsd); A = np.array([dsd[x] for x in dl]); bs = []
for _ in range(B):
    i = rng2.integers(0, len(dl), len(dl)); s, k = A[i, 0].sum(), A[i, 1].sum()
    if k: bs.append(s / k)
pA = float((1 + (np.array(bs) <= 0).sum()) / (len(bs) + 1)); print(f'  G-A net mean > 0: one-sided p {pA:.4f}')
pv = sorted([(pA, 'G-A'), (gb[3], 'G-B')]); surv = [n for r, (p, n) in enumerate(pv) if p <= 0.10 / (2 - r)] if pv[0][0] <= 0.05 else []
print(f'  Holm 0.10 over 2 tests: survivors: {surv or "none"}')
h1, h2 = D.halves(net); gate = bool(MODE == 'explore' and m[1] > 0 and h1 > 0 and h2 > 0 and gb[0] >= 0)
print(f'  FROZEN EXPLORE GATE (net CI lower bound > 0, both halves > 0, G-B not negative): {"PASSED" if gate else "NOT PASSED"}')
if MODE == 'explore': json.dump(dict(passed=gate, net=m[0], lo=m[1], hi=m[2], n=m[3], halves=[h1, h2], gb=gb[0], p_ga=pA, p_gb=gb[3]), open(GATE, 'w'), indent=1)
else:
    ok2 = m[0] > 2.0 and m3[0] > 0 and m[1] > 0 and share < 0.35 and m[3] >= 30; print(f'  FROZEN CONFIRMATION BAR (net > +2.0, > 0 at 3.0 pt, CI lower > 0, top day < 35 percent, N >= 30): {"PASSED" if ok2 else "NOT PASSED"}')
