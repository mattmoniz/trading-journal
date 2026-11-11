"""ROW 30 REPLAY A6 (docs/CAPITULATION_EXIT_ALL_SETUPS_PREREG_20261109.md): capitulation exit on WIDE-bracket rows of ALL real setups, 2026 depth-era window. EXPLORE LEAD only.
Counted (A6.2): A_RTH, A_GBX = ALL rows (signalled-stratum paired mean d, rows sharing a thrust collapsed, day-block bootstrap, Holm 0.10). d = virtual dollars at the next 500V open after the first same-direction EXTENDED thrust strictly inside the row's life - actual_pnl (dollars, cost $2).
Modes: --prep (no P&L read) | --go (reads a6_pnl.json; ledger look 'cap_a6_register_20261110' must exist). Same construction as capitulation_replay_a5.py (risk-set placebo etc.)."""
import os, sys, json, bisect, datetime, collections, re
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import features as Fm, context_exit_phase1 as P1
import capitulation_replay_phase1 as C
GO = '--go' in sys.argv; PREP = '--prep' in sys.argv
if GO == PREP: sys.exit('usage: --prep | --go')
ND, B, HOLM, SEED_MIN = 20, 4000, 0.10, 200
import capitulation_replay_lib as L_
ev = L_.build_events(); D = L_.D; idx = L_.EventIndex(ev)
rows = json.load(open(os.path.join(D, 'a6_rows.json')))
def grp(st):
    if re.match(r'^(RTH_FLUSH|GLOBEX_FLUSH)', st): return 'FLUSH'
    if re.match(r'^(MAJOR_PIVOT_DEFENDED|MINOR_DEFENDED|STALL_DEFENDED)', st): return 'DEFENDED'
    if re.match(r'^(OVERNIGHT_ORDERFLOW|STACK_VOL_BREAK|IB_LOW_PNR)', st): return 'ORDERFLOW'
    if re.match(r'^(STOP_SWEEP|FAILED_SWEEP|FAILED_AUCTION)', st): return 'SWEEP_AUCTION'
    if re.match(r'^(POC_ROTATION_JOIN|C_PAIRED|IB_BULLISH|IB_BEARISH|BRACKET_BREAKOUT|MOMENTUM_CHASE|VWAP_RECLAIM|ACD)', st): return 'CONT_DAYTYPE'
    return 'REF_LEVEL'
reopen = L_.reopen
R = []; miss = collections.Counter()
for r in rows:
    f = datetime.datetime.fromisoformat(r['f']); rs = datetime.datetime.fromisoformat(r['rs'])
    if rs <= f: continue
    suf = '_SHORT' in r['setup_type'] or '_LONG' in r['setup_type']
    if r['p0'] is None or (not suf and r['t1'] is None): miss[re.sub(r'_(LONG|SHORT)$', '', r['setup_type'])] += 1; continue
    d = -1 if '_SHORT' in r['setup_type'] else (1 if '_LONG' in r['setup_type'] else (1 if r['t1'] > r['p0'] else -1))
    tgt = abs(r['t1'] - r['p0']) / r['adr'] if (r['t1'] is not None and r['adr']) else None
    cand = idx.window(d, f, rs)
    ok = lambda c: not reopen(c['ts']) and c['o1'] == c['o1']
    ext = [c for c in cand if c['flag'] == 'EXT' and ok(c)]; non = [c for c in cand if c['flag'] == 'NONEXT' and ok(c)]
    R.append(dict(id=r['id'], st=r['setup_type'], grp=grp(r['setup_type']), td=r['td'], f=f, rs=rs, side=d, p0=r['p0'], stp=r['stp'], t1=r['t1'], tgt=tgt, origin=r['origin_status'],
                  rtrack='RTH' if (f.hour * 60 + f.minute >= 570 and f.hour < 16) else 'GBX', first=ext[0] if ext else None, firstnon=non[0] if non else None))
R.sort(key=lambda x: x['f'])
hist = []                                                      # expanding window of EARLIER rows' target distances (ADR20 units): WIDE = >= its 2/3 quantile
for x in R:
    x['wide'] = (bool(x['tgt'] >= np.quantile(hist, 2 / 3)) if (len(hist) >= SEED_MIN and x['tgt'] is not None) else None)
    if x['tgt'] is not None: hist.append(x['tgt'])
    x['all'] = True
U = R                                                          # A6.2: the counted tests use ALL rows with an entry price and a direction
print(f'rows {len(rows)}, with geometry {len(R)}, classified wide/narrow {len(U)}, excluded for missing p0/t1/adr {sum(miss.values())}; top missing types {miss.most_common(8)}')
sig = [x for x in U if x['first']]
print('wide rows', sum(1 for x in U if x['wide']), 'signalled', len(sig), 'wide signalled', sum(1 for x in sig if x['wide']))
for tr in ('RTH', 'GBX'):
    g = [x for x in sig if x['rtrack'] == tr]; ind = {(x['first']['date'], x['first']['t']) for x in g}
    print(f'  A_{tr}: rows {sum(1 for x in U if x["rtrack"] == tr)}, signalled {len(g)}, independent thrusts {len(ind)}, days {len({x["td"] for x in g})}')
print('by group (all rows / wide / signalled / signalled wide):', {k: (sum(1 for x in U if x['grp'] == k), sum(1 for x in U if x['grp'] == k and x['wide']), sum(1 for x in sig if x['grp'] == k), sum(1 for x in sig if x['grp'] == k and x['wide'])) for k in ('FLUSH', 'DEFENDED', 'ORDERFLOW', 'SWEEP_AUCTION', 'CONT_DAYTYPE', 'REF_LEVEL')})
rng = np.random.default_rng(20261110)
def make_ctrl(key):
    return L_.make_ctrl(idx, [x for x in U if x['first'] and x.get(key) is not None], U, lambda x: (x[key], x['rtrack']) if x.get(key) is not None else None, rng)
if PREP:
    nc = make_ctrl('all'); print('(prep) risk-set controls per signalled row min/median/max', min(nc), int(np.median(nc)), max(nc))
if PREP: sys.exit(0)
# ---------------- --go ----------------
pnl = {r['id']: r['pnl'] for r in json.load(open(os.path.join(D, 'a6_pnl.json')))}
# LARGE (amendment A6.1, user: "i mean sim pnls"): the row's setup TYPE has, among rows RESOLVED before this row fired, a median |actual_pnl| at or above the 2/3 quantile of all types' such medians (types with >= 20 earlier resolved rows). Causal, expanding.
bytype = collections.defaultdict(list)
for x in U:
    if pnl.get(x['id']) is not None: bytype[re.sub(r'_(LONG|SHORT)$', '', x['st'])].append((x['rs'], abs(pnl[x['id']])))
for t in bytype: bytype[t].sort()
nlarge = 0
for x in U:
    meds = {}
    for t, lst in bytype.items():
        a = [v for (r_, v) in lst if r_ < x['f']]
        if len(a) >= 20: meds[t] = float(np.median(a))
    me = meds.get(re.sub(r'_(LONG|SHORT)$', '', x['st']))
    x['large'] = None if (me is None or len(meds) < 6) else bool(me >= np.quantile(list(meds.values()), 2 / 3))
print('LARGE-P&L-history classification: rows classified', sum(1 for x in U if x['large'] is not None), 'large', sum(1 for x in U if x['large']), 'signalled large', sum(1 for x in U if x['large'] and x['first']))
nc = make_ctrl('all'); print('risk-set controls (all rows, matched on track) per signalled row min/median/max', min(nc), int(np.median(nc)), max(nc))
bc_ = L_.BarCache(); exit_open = bc_.exit_open
virt = L_.virt
for x in U:
    x['pnl'] = pnl.get(x['id'])
    x['d'] = virt(x, x['first']['o1']) - x['pnl'] if (x['first'] and x['pnl'] is not None) else None
    x['dn'] = virt(x, x['firstnon']['o1']) - x['pnl'] if (x['firstnon'] and x['pnl'] is not None) else None
    x['dp'] = None
for x in sig:
    if x['d'] is None: continue
    dp = []
    for y, tx in sorted(x['ctrl'], key=lambda c: c[0]['td']):
        px = exit_open(y['td'], tx)
        if px is not None and pnl.get(y['id']) is not None: dp.append(virt(y, px) - pnl[y['id']])
    x['dp'] = float(np.mean(dp)) if dp else None
    x['prog'] = x['side'] * (x['first']['c'] - x['p0']) / (x['side'] * (x['t1'] - x['p0'])) if (x['t1'] is not None and x['side'] * (x['t1'] - x['p0']) > 0) else None
events = L_.events; mean = L_.mean; wins = L_.wins
def dbb(evs, rg): return L_.dbb(evs, rg)
def summ(name, g, key='d', tk='first', full=True):
    E = events(g, key, tk); ndays = len({e['td'] for e in E})
    if len(E) < 3: print(f'  {name}: events {len(E)} (too few)'); return None
    m = mean(E); bt = dbb(E, np.random.default_rng(7)); p = float((bt <= 0).mean()); floor = len(E) >= 20 and ndays >= 10
    print(f'  {name}: events {len(E)} days {ndays} mean d {m:+.1f} $ ({m/2:+.1f} pt) CI90 [{np.quantile(bt, .05):+.1f}, {np.quantile(bt, .95):+.1f}] p {p:.3f}{"" if floor else "  (BELOW FLOOR 20 events / 10 days: no verdict)"}')
    return E, m, p, floor
print('\n=== MDE (from SD of d; variance only) ===')
for tr in ('RTH', 'GBX'):
    E = events([x for x in sig if x['rtrack'] == tr], 'd')
    if len(E) > 3: sd = float(np.std([e['v'] for e in E], ddof=1)); mde = 2.49 * sd / np.sqrt(len(E)); print(f'A_{tr}: events {len(E)}, SD(d) {sd:.1f} $, MDE {mde:.1f} $ = {mde/2:.1f} pt = {mde/2/474:.4f} ADR20 (bar 0.015 ADR20 = 7 pt)')
print('\n=== COUNTED ===')
ps = []
for tr in ('RTH', 'GBX'):
    g = [x for x in sig if x['rtrack'] == tr]; r = summ(f'A_{tr}', g)
    if not r: ps.append((f'A_{tr}', 1.0, False)); continue
    E, m, p, floor = r; vals = np.array([e['v'] for e in E]); days = sorted({e['td'] for e in E}); infl = np.argsort(-(vals - m)); keep = np.delete(vals, infl[:2]).mean()
    loo = [mean([e for e in E if e['td'] != d]) for d in days]; h1 = [e for e in E if e['td'] <= days[len(days) // 2]]; h2 = [e for e in E if e['td'] > days[len(days) // 2]]
    for x in g: x['pd'] = None if (x['dp'] is None or x['d'] is None) else x['d'] - x['dp']
    EP = events(g, 'pd'); mp = mean(EP) if EP else float('nan'); bp = dbb(EP, np.random.default_rng(3)) if len(EP) > 3 else np.array([np.nan])
    gates = dict(winsor=wins(vals) > 0, drop_top2=keep > 0, loo=min(loo) > 0, halves=(mean(h1) > 0) == (mean(h2) > 0) and mean(h1) > 0, placebo=mp > 0)
    print(f'     winsor5 {wins(vals):+.1f}; drop-top2 {keep:+.1f}; leave-one-day-out min {min(loo):+.1f}; halves {mean(h1):+.1f}/{mean(h2):+.1f}; risk-set placebo paired diff {mp:+.1f} $ CI90 [{np.nanquantile(bp, .05):+.1f}, {np.nanquantile(bp, .95):+.1f}] on {len(EP)} events; gates {gates}')
    ps.append((f'A_{tr}', p, floor))
holm = L_.holm(ps, HOLM)
print('Holm 0.10:', {n: (round(p, 3), holm[n]) for n, p, fl in ps}, '(a test below the floor cannot pass)')
print('\n=== DESCRIPTIVE (not counted) ===')
for k in ('FLUSH', 'DEFENDED', 'ORDERFLOW', 'SWEEP_AUCTION', 'CONT_DAYTYPE', 'REF_LEVEL'):
    summ(f'group {k} all', [x for x in sig if x['grp'] == k]); summ(f'group {k} wide', [x for x in sig if x['grp'] == k and x['wide']])
summ('LARGE-history types (sim pnl)', [x for x in sig if x['large']]); summ('all not-large', [x for x in sig if x['large'] is False]); summ('all wide (geometry)', [x for x in sig if x['wide']]); summ('all narrow', [x for x in sig if not x['wide']])
for o in ('ACTIVE', 'SHADOW'): summ(f'wide {o}', [x for x in sig if x['wide'] and x['origin'] == o])
summ('wide, NON-extended thrust exit', [x for x in U if x['wide'] and x['firstnon']], key='dn', tk='firstnon')
for lab, f in (('prog<0', lambda p: p < 0), ('0-0.5', lambda p: 0 <= p < .5), ('0.5-0.75', lambda p: .5 <= p < .75), ('0.75-1', lambda p: .75 <= p < 1), ('>=1', lambda p: p >= 1)):
    summ(f'wide progress {lab}', [x for x in sig if x['wide'] and x.get('prog') is not None and f(x['prog'])])
byst = collections.defaultdict(list)
for x in sig:
    if x['wide']: byst[re.sub(r'_(LONG|SHORT)$', '', x['st'])].append(x)
print('  hints (wide, >= 20 signalled rows):')
for st, g in sorted(byst.items(), key=lambda kv: -len(kv[1])):
    if len(g) >= 20: summ(st, g)
from scipy.stats import spearmanr
a = [(x['tgt'], abs(x['pnl'])) for x in U if x['pnl'] is not None and x['tgt'] is not None]; print(f'\ncheck: Spearman(target distance ADR20, |actual_pnl|) over all classified rows = {spearmanr([p[0] for p in a], [p[1] for p in a])[0]:.3f} (N {len(a)})')
