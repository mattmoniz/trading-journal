"""ROW 30 A10.3 REPLICATION (docs/CAPITULATION_REPLACES_TARGET_REPLICATION_PREREG_20261109.md): the A10 design on the 2023-25 explore BACKFILL level-fade rows (3,677 rows, 126 days). C0 / H as capitulation_replay_a10.py (real minute bars and real 500V thrusts; entries, stops, expiries are the backtest's).
Counted (family of 2, Holm 0.10): REP_R2_RTH = mean H - C0 over signalled RTH at_boundary rows (collapsed by thrust, day-blocked); REP_R1_RTH = ITT mean H - A over ALL RTH pivot_live rows (A = synthetic backtest outcome). Modes: --prep (no P&L read) | --go (look 'cap_a11_register_20261109')."""
import os, sys, json, datetime, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import capitulation_replay_lib as L_
GO = '--go' in sys.argv; PREP = '--prep' in sys.argv
if GO == PREP: sys.exit('usage: --prep | --go')
ev = L_.build_events(); D = L_.D; idx = L_.EventIndex(ev)
rows = json.load(open(os.path.join(D, 'a11_rows.json'))); tags = json.load(open(os.path.join(D, 'a11_tags.json')))
sim = L_.HoldSim(os.path.join(D, 'a11_minute_bars.tsv')); virt = L_.virt
SKIP = None if '--include-roll' in sys.argv else L_.roll_skip_dates(os.path.join(D, 'a11_minute_bars.tsv'))   # A10.4
R, drop = L_.build_hold_rows(idx, rows, tags, sim, end=datetime.datetime(2025, 5, 16, 23, 59), skip=SKIP)
for x in R: x['cls'] = 'VF' if True else ''
cls = {r['id']: r['bet_class'] for r in rows}
for x in R: x['cls'] = cls[x['id']]
print('rows simulated', len(R), 'dropped', dict(drop), '| C0 exits', dict(collections.Counter(x['c0kind'] for x in R)), '| H differs from C0 in', sum(1 for x in R if x['first']))
S = [('R2_RTH', lambda x: x['b'] and x['rtrack'] == 'RTH'), ('R2_GBX', lambda x: x['b'] and x['rtrack'] == 'GBX'), ('R1_RTH', lambda x: x['p'] and x['rtrack'] == 'RTH'), ('R1_GBX', lambda x: x['p'] and x['rtrack'] == 'GBX'),
     ('untagged RTH', lambda x: not x['p'] and not x['b'] and x['rtrack'] == 'RTH'), ('untagged GBX', lambda x: not x['p'] and not x['b'] and x['rtrack'] == 'GBX')]
print(f'{"stratum":14s}{"rows":>6s}{"days":>6s}{"signalled":>10s}{"independent":>12s}{"sig days":>9s}{"top5d%":>8s}')
for nm, f in S:
    g = [x for x in R if f(x)]; s = [x for x in g if x['first']]; ind = {(x['first']['date'], x['first']['t']) for x in s}; dd = collections.Counter(x['td'] for x in s); top5 = 100 * sum(v for _, v in dd.most_common(5)) / max(len(s), 1)
    print(f'{nm:14s}{len(g):6d}{len({x["td"] for x in g}):6d}{len(s):10d}{len(ind):12d}{len(dd):9d}{top5:8.1f}')
if PREP: sys.exit(0)
pnl = {r['id']: r['pnl'] for r in json.load(open(os.path.join(D, 'a11_pnl.json')))}
R = [x for x in R if pnl.get(x['id']) is not None]
for x in R:
    x['A'] = pnl[x['id']]; x['C0'] = virt(x, x['c0px']); x['H'] = virt(x, x['first']['o1']) if x['first'] else x['C0']; x['d'] = x['H'] - x['C0'] if x['first'] else None
def boot_mean(vals, days, B=4000, seed=11):
    rg = np.random.default_rng(seed); ud = sorted(set(days)); by = {d: [v for v, dd in zip(vals, days) if dd == d] for d in ud}; out = []
    for _ in range(B):
        pick = rg.choice(len(ud), size=len(ud)); out.append(np.mean([v for i in pick for v in by[ud[i]]]))
    return np.array(out)
def trimmed(v, p=.25): a = np.sort(v); k = int(len(a) * p); return float(np.mean(a[k:len(a) - k])) if len(a) - 2 * k > 0 else float(np.mean(a))
bc_ = L_.BarCache(); mean = L_.mean; wins = L_.wins; events = L_.events
print('\n=== MDE ===')
g2 = [x for x in R if x['b'] and x['rtrack'] == 'RTH' and x['first']]; E2 = events(g2, 'd')
if len(E2) > 3: sd = float(np.std([e['v'] for e in E2], ddof=1)); mde = 2.49 * sd / np.sqrt(len(E2)); print(f'REP_R2_RTH: events {len(E2)}, SD {sd:.1f} $, MDE {mde:.1f} $ = {mde/2:.1f} pt = {mde/2/474:.4f} ADR20 (bar 0.015 ADR20 = 7 pt)')
g1 = [x for x in R if x['p'] and x['rtrack'] == 'RTH']; v1 = [x['H'] - x['A'] for x in g1]
if len(v1) > 3: sd = float(np.std(v1, ddof=1)); mde = 2.49 * sd / np.sqrt(len(v1)); print(f'REP_R1_RTH: rows {len(v1)}, SD {sd:.1f} $, MDE (row-level, day clustering ignored) {mde:.1f} $ = {mde/2:.1f} pt = {mde/2/474:.4f} ADR20')
print('\n=== COUNTED ===')
ps = []
rng = np.random.default_rng(20261114)
# REP_R2_RTH
if len(E2) >= 3:
    m = mean(E2); bt = L_.dbb(E2, np.random.default_rng(7)); p = float((bt <= 0).mean()); days = sorted({e['td'] for e in E2}); fl = len(E2) >= 20 and len(days) >= 10
    vals = np.array([e['v'] for e in E2]); infl = np.argsort(-(vals - m)); keep = np.delete(vals, infl[:2]).mean(); loo = [mean([e for e in E2 if e['td'] != d]) for d in days]; h1 = [e for e in E2 if e['td'] <= days[len(days) // 2]]; h2 = [e for e in E2 if e['td'] > days[len(days) // 2]]
    pool = [x for x in R if x['rtrack'] == 'RTH']; L_.make_ctrl(idx, g2, pool, lambda y: (bool(y['b']), y['rtrack']), rng, 20)
    for x in g2:
        dp = []
        for y, tx in sorted(x['ctrl'], key=lambda c: c[0]['td']):
            px = bc_.exit_open(y['td'], tx)
            if px is not None: dp.append(virt(y, px) - y['C0'])
        x['pd'] = (x['d'] - float(np.mean(dp))) if dp else None
    EP = events(g2, 'pd'); mp = mean(EP) if EP else float('nan')
    gates = dict(winsor=bool(wins(vals) > 0), drop_top2=bool(keep > 0), loo=bool(min(loo) > 0), halves=bool((mean(h1) > 0) == (mean(h2) > 0) and mean(h1) > 0))
    print(f'  REP_R2_RTH: events {len(E2)} days {len(days)} mean H - C0 {m:+.1f} $ ({m/2:+.1f} pt) CI90 [{np.quantile(bt, .05):+.1f}, {np.quantile(bt, .95):+.1f}] p {p:.3f}{"" if fl else "  (BELOW FLOOR)"}  (Argon effect size +$20: {"reached" if m >= 20 else "not reached"})')
    print(f'     winsor5 {wins(vals):+.1f}; drop-top2 {keep:+.1f}; leave-one-day-out min {min(loo):+.1f}; halves {mean(h1):+.1f}/{mean(h2):+.1f}; gates {gates}; (descriptive) risk-set placebo diff {mp:+.1f}')
    ps.append(('REP_R2_RTH', p, fl, all(gates.values())))
else: ps.append(('REP_R2_RTH', 1.0, False, False)); print('  REP_R2_RTH: too few events')
# REP_R1_RTH
if len(v1) >= 3:
    days1 = [x['td'] for x in g1]; bt = boot_mean(v1, days1); m = float(np.mean(v1)); p = float((bt <= 0).mean()); fl = len(v1) >= 100 and len(set(days1)) >= 40
    tm = trimmed(v1); bestday = max(set(days1), key=lambda d: sum(v for v, dd in zip(v1, days1) if dd == d)); drop_best = float(np.mean([v for v, dd in zip(v1, days1) if dd != bestday]))
    ok = bool(np.quantile(bt, .05) > 0 and tm > 0 and drop_best > 0)
    print(f'  REP_R1_RTH: rows {len(v1)} days {len(set(days1))} ITT mean H - A {m:+.1f} $ CI90 [{np.quantile(bt, .05):+.1f}, {np.quantile(bt, .95):+.1f}] p {p:.3f}{"" if fl else "  (BELOW FLOOR 100 rows / 40 days)"}; trimmed25 {tm:+.1f}; dropping the best day {drop_best:+.1f}; mean C0 - A {np.mean([x["C0"] - x["A"] for x in g1]):+.1f}; thrust rows {sum(1 for x in g1 if x["first"])}')
    ps.append(('REP_R1_RTH', p, fl, ok))
else: ps.append(('REP_R1_RTH', 1.0, False, False)); print('  REP_R1_RTH: too few rows')
order = sorted(ps, key=lambda t: t[1]); alive = True; res = {}
for i, (n, p, fl, ok) in enumerate(order): alive = alive and fl and p <= 0.10 / (len(order) - i); res[n] = alive and ok
print('Holm 0.10 over the family of two, then gates:', {n: dict(p=round(p, 3), floor=fl, gates=ok, REPLICATES=res[n]) for n, p, fl, ok in ps})
print('\n=== DESCRIPTIVE ===')
print(f'{"ITT stratum (A synthetic)":28s}{"rows":>6s}{"sig":>5s}{"A":>8s}{"C0":>8s}{"H":>8s}   {"H - A [CI90]":>24s}   {"H - C0 [CI90]":>24s}')
for nm, f in S + [('ALL RTH', lambda x: x['rtrack'] == 'RTH'), ('ALL GBX', lambda x: x['rtrack'] == 'GBX'), ('ALL', lambda x: True)] + [(f'R2_RTH {c}', (lambda c: lambda x: x['b'] and x['rtrack'] == 'RTH' and x['cls'] == c)(c)) for c in ('VALUE_FADE', 'GLOBEX_LEVEL')] + [(f'R2_GBX {c}', (lambda c: lambda x: x['b'] and x['rtrack'] == 'GBX' and x['cls'] == c)(c)) for c in ('VALUE_FADE', 'GLOBEX_LEVEL')]:
    g = [x for x in R if f(x)]
    if len(g) < 5: print(f'{nm:28s}{len(g)} rows'); continue
    days = [x['td'] for x in g]; a = [x['A'] for x in g]; c = [x['C0'] for x in g]; h = [x['H'] for x in g]; ha = [hh - aa for hh, aa in zip(h, a)]; hc = [hh - cc for hh, cc in zip(h, c)]
    b1 = boot_mean(ha, days, 1500); b2 = boot_mean(hc, days, 1500)
    print(f'{nm:28s}{len(g):6d}{sum(1 for x in g if x["first"]):5d}{np.mean(a):8.1f}{np.mean(c):8.1f}{np.mean(h):8.1f}   {np.mean(ha):+8.1f} [{np.quantile(b1,.05):+7.1f},{np.quantile(b1,.95):+7.1f}]   {np.mean(hc):+8.1f} [{np.quantile(b2,.05):+7.1f},{np.quantile(b2,.95):+7.1f}]')
print('\n--- matched static target T on R2_RTH rows (walk-forward median excursion of earlier days\' H exits, ADR20 units, >= 10 earlier) ---')
g = sorted([x for x in R if x['b'] and x['rtrack'] == 'RTH' and x['adr']], key=lambda x: x['td']); exc = [(x['td'], x['side'] * (x['first']['o1'] - x['p0']) / x['adr']) for x in g if x['first']]; used = []
for x in g:
    e = [v for d, v in exc if d < x['td']]
    if len(e) < 10: continue
    med = float(np.median(e)); s = sim.c0(x['f'], x['side'], x['p0'], x['stp'], x['exp'], tgt=x['p0'] + x['side'] * med * x['adr'])
    if s is None: continue
    x['T'] = virt(x, s[2]); used.append(x)
if used:
    days = [x['td'] for x in used]
    for lab, key in (('T - C0', lambda x: x['T'] - x['C0']), ('H - C0', lambda x: x['H'] - x['C0']), ('H - T', lambda x: x['H'] - x['T'])):
        v = [key(x) for x in used]; b = boot_mean(v, days, 1500); print(f'  unconditional over {len(used)} rows  {lab:7s} {np.mean(v):+8.1f} [{np.quantile(b,.05):+7.1f},{np.quantile(b,.95):+7.1f}]')
print('\n--- thrust type on R2_RTH (H - C0 where the thrust occurs) ---')
g = [x for x in R if x['b'] and x['rtrack'] == 'RTH']
for x in g:
    a = [e for e in (x['first'], x['firstnon']) if e]; x['anyfirst'] = min(a, key=lambda e: e['ts']) if a else None
    x['d_non'] = virt(x, x['firstnon']['o1']) - x['C0'] if x['firstnon'] else None; x['d_any'] = virt(x, x['anyfirst']['o1']) - x['C0'] if x['anyfirst'] else None
for lab, key, tk in (('extended', 'd', 'first'), ('non-extended', 'd_non', 'firstnon'), ('either', 'd_any', 'anyfirst')):
    E = events(g, key, tk)
    if len(E) > 3: print(f'  {lab:13s} events {len(E):4d} mean {mean(E):+8.1f} $')
