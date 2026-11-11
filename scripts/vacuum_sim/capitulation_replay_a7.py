"""ROW 30 REPLAY A8 (docs/CAPITULATION_EXIT_FLUSH_PREREG_20261109.md): capitulation exit vs the FLUSH setups' own simulated exit on the explore backtest events (2023-04..2025-05-16). EXPLORE LEAD only.
Counted: F_RTH (RTH flush), F_GBX (Globex flush, continuation + reversal), signalled-stratum paired mean d, Holm 0.10, risk-set placebo, same gates as A6.2. Modes: --prep (no P&L read) | --go (look 'cap_a7_register_20261109' must exist)."""
import os, sys, json, datetime, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import capitulation_replay_lib as L_
GO = '--go' in sys.argv; PREP = '--prep' in sys.argv
if GO == PREP: sys.exit('usage: --prep | --go')
ND, HOLM = 20, 0.10
ev = L_.build_events(); D = L_.D; idx = L_.EventIndex(ev)
rows = json.load(open(os.path.join(D, 'a7_flush_rows.json')))
SKIP = None if '--include-roll' in sys.argv else L_.roll_skip_dates(os.path.join(D, 'a11_minute_bars.tsv'))      # A10.4: contract-roll / stitching dates (explore minute bars cover 2023-04..2025-05)
def _touches(r):
    if not SKIP: return False
    f = datetime.datetime.fromisoformat(r['f']); e = datetime.datetime.fromisoformat(r['rs'])
    return any((f.date() + datetime.timedelta(days=k)).isoformat() in SKIP for k in range(0, (e.date() - f.date()).days + 1))
_n0 = len(rows); rows = [r for r in rows if not _touches(r)]; print('A10.4 roll / stitching rows excluded:', _n0 - len(rows), 'of', _n0)
U = []
for r in rows:
    if not ('2023-04-10' <= r['td'] <= '2025-05-16'): continue
    f = datetime.datetime.fromisoformat(r['f']); rs = datetime.datetime.fromisoformat(r['rs'])
    if rs <= f: continue
    cand = idx.window(r['side'], f, rs); ok = lambda c: not L_.reopen(c['ts']) and c['o1'] == c['o1']
    ext = [c for c in cand if c['flag'] == 'EXT' and ok(c)]; non = [c for c in cand if c['flag'] == 'NONEXT' and ok(c)]
    U.append(dict(id=r['id'], st=r['setup_type'], mode=r['grp'], cg='RTH' if r['grp'] == 'RTH' else 'GBX', td=r['td'], f=f, rs=rs, side=r['side'], p0=r['p0'], target=r['target'], fireMin=r['fireMin'],
                  first=ext[0] if ext else None, firstnon=non[0] if non else None, rtrack=None))
print('flush rows in window', len(U), dict(collections.Counter(x['mode'] for x in U)))
sig = [x for x in U if x['first']]
for cg in ('RTH', 'GBX'):
    g = [x for x in sig if x['cg'] == cg]; ind = {(x['first']['date'], x['first']['t']) for x in g}
    print(f'  F_{cg}: rows {sum(1 for x in U if x["cg"] == cg)}, signalled {len(g)}, independent thrusts {len(ind)}, days {len({x["td"] for x in g})}')
rng = np.random.default_rng(20261111)
nc = L_.make_ctrl(idx, sig, U, lambda x: x['cg'], rng, ND)
print('risk-set controls per signalled row min/median/max', min(nc), int(np.median(nc)), max(nc), '; rows with 0 controls', sum(1 for n in nc if n == 0))
if PREP: sys.exit(0)
pnl = {r['id']: r['pnl'] for r in json.load(open(os.path.join(D, 'a7_flush_rows.json')))}
bc_ = L_.BarCache(); virt = L_.virt; events = L_.events; mean = L_.mean; wins = L_.wins
for x in U:
    x['pnl'] = pnl[x['id']]; x['d'] = virt(x, x['first']['o1']) - x['pnl'] if x['first'] else None; x['dn'] = virt(x, x['firstnon']['o1']) - x['pnl'] if x['firstnon'] else None; x['dp'] = None
    x['prog'] = x['side'] * (x['first']['c'] - x['p0']) / x['target'] if (x['first'] and x['target']) else None
for x in sig:
    dp = []
    for y, tx in sorted(x['ctrl'], key=lambda c: c[0]['td']):
        px = bc_.exit_open(y['td'], tx)
        if px is not None: dp.append(virt(y, px) - pnl[y['id']])
    x['dp'] = float(np.mean(dp)) if dp else None
def summ(name, g, key='d', tk='first'):
    E = events(g, key, tk); nd = len({e['td'] for e in E})
    if len(E) < 3: print(f'  {name}: events {len(E)} (too few)'); return None
    m = mean(E); bt = L_.dbb(E, np.random.default_rng(7)); p = float((bt <= 0).mean()); fl = len(E) >= 20 and nd >= 10
    print(f'  {name}: events {len(E)} days {nd} mean d {m:+.1f} $ ({m/2:+.1f} pt) CI90 [{np.quantile(bt, .05):+.1f}, {np.quantile(bt, .95):+.1f}] p {p:.3f}{"" if fl else "  (BELOW FLOOR 20 events / 10 days: no verdict)"}')
    return E, m, p, fl
print('\n=== MDE (from SD of d) ===')
for cg in ('RTH', 'GBX'):
    E = events([x for x in sig if x['cg'] == cg], 'd')
    if len(E) > 3: sd = float(np.std([e['v'] for e in E], ddof=1)); mde = 2.49 * sd / np.sqrt(len(E)); print(f'F_{cg}: events {len(E)}, SD(d) {sd:.1f} $, MDE {mde:.1f} $ = {mde/2:.1f} pt = {mde/2/474:.4f} ADR20 (bar 0.015 ADR20 = 7 pt)')
print('\n=== COUNTED ===')
ps = []
for cg in ('RTH', 'GBX'):
    g = [x for x in sig if x['cg'] == cg]; r = summ(f'F_{cg}', g)
    if not r: ps.append((f'F_{cg}', 1.0, False)); continue
    E, m, p, fl = r; vals = np.array([e['v'] for e in E]); days = sorted({e['td'] for e in E}); infl = np.argsort(-(vals - m)); keep = np.delete(vals, infl[:2]).mean()
    loo = [mean([e for e in E if e['td'] != d]) for d in days]; h1 = [e for e in E if e['td'] <= days[len(days) // 2]]; h2 = [e for e in E if e['td'] > days[len(days) // 2]]
    for x in g: x['pd'] = None if (x['dp'] is None or x['d'] is None) else x['d'] - x['dp']
    EP = events(g, 'pd'); mp = mean(EP) if EP else float('nan'); bp = L_.dbb(EP, np.random.default_rng(3)) if len(EP) > 3 else np.array([np.nan])
    gates = dict(winsor=wins(vals) > 0, drop_top2=bool(keep > 0), loo=bool(min(loo) > 0), halves=bool((mean(h1) > 0) == (mean(h2) > 0) and mean(h1) > 0), placebo=bool(mp > 0))
    print(f'     winsor5 {wins(vals):+.1f}; drop-top2 {keep:+.1f}; leave-one-day-out min {min(loo):+.1f}; halves {mean(h1):+.1f}/{mean(h2):+.1f}; risk-set placebo paired diff {mp:+.1f} $ CI90 [{np.nanquantile(bp, .05):+.1f}, {np.nanquantile(bp, .95):+.1f}] on {len(EP)} events; gates {gates}')
    ps.append((f'F_{cg}', p, fl))
holm = L_.holm(ps, HOLM); print('Holm 0.10:', {n: (round(p, 3), holm[n]) for n, p, fl in ps}, '(a test below the floor cannot pass)')
print('\n=== DESCRIPTIVE (not counted) ===')
for mo in ('RTH', 'GLOBEX_CONT', 'GLOBEX_REV'): summ(f'mode {mo}', [x for x in sig if x['mode'] == mo])
for sd_, nm in ((1, 'LONG'), (-1, 'SHORT')): summ(f'side {nm}', [x for x in sig if x['side'] == sd_])
fm = sorted(x['fireMin'] for x in U); c1, c2 = fm[len(fm) // 3], fm[2 * len(fm) // 3]
for lab, f in (('fire-time early tercile', lambda m: m <= c1), ('middle', lambda m: c1 < m <= c2), ('late', lambda m: m > c2)): summ(f'{lab} (within all flush)', [x for x in sig if f(x['fireMin'])])
summ('NON-extended thrust exit', [x for x in U if x['firstnon']], key='dn', tk='firstnon')
for lab, f in (('prog<0', lambda p: p < 0), ('0-0.5 of target', lambda p: 0 <= p < .5), ('0.5-1', lambda p: .5 <= p < 1), ('>=1', lambda p: p >= 1)): summ(f'progress {lab}', [x for x in sig if x['prog'] is not None and f(x['prog'])])
print('\ntake-all mean own-exit P&L (all flush rows, $):', round(float(np.mean([x['pnl'] for x in U])), 2), '; signalled rows own-exit mean:', round(float(np.mean([x['pnl'] for x in sig])), 2), '; signalled rows virtual-exit mean:', round(float(np.mean([virt(x, x['first']['o1']) for x in sig])), 2))
