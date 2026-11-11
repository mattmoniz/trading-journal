"""ROW 30 REPLAY A10 (docs/CAPITULATION_REPLACES_TARGET_PREREG_20261109.md, A10.1): capitulation REPLACES the target. Arms per real row (dollars, cost $2): A = actual_pnl; C0 = hold with the ORIGINAL stop (gap-aware), no target, to the row's expiry;
H = C0 plus exit at the next 500V open after the first same-direction EXTENDED thrust. Primary d = H - C0 over the rows where H differs from C0 (signalled stratum, rows sharing a thrust collapsed); secondary H - A. Counted: R1_RTH (pivot_live), R2_RTH, R2_GBX (at_boundary),
Holm 0.10, day-blocked bootstrap, gates (winsor, drop-top-2, leave-one-day-out, halves, risk-set placebo, tagged minus untagged). Modes: --prep (no P&L read) | --go (look 'cap_a10_register_20261109' must exist)."""
import os, sys, json, datetime, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import capitulation_replay_lib as L_
GO = '--go' in sys.argv; PREP = '--prep' in sys.argv; DUMP = '--dump-c0' in sys.argv      # --dump-c0: parity file for scripts/lib/holdArms.mjs (no P&L, price paths only)
if (GO == PREP) and not DUMP: sys.exit('usage: --prep | --go | --dump-c0')
HOLM = 0.10
ev = L_.build_events(); D = L_.D; idx = L_.EventIndex(ev)
rows = json.load(open(os.path.join(D, 'a6_rows.json'))); tags = json.load(open(os.path.join(D, 'a10_tags.json')))
sim = L_.HoldSim(os.path.join(D, 'a10_minute_bars.tsv')); virt = L_.virt
SKIP = None if '--include-roll' in sys.argv else L_.roll_skip_dates(os.path.join(D, 'a10_minute_bars.tsv'))   # A10.4: roll-week / stitching rows excluded unless --include-roll (reproduces the first run)
R, drop = L_.build_hold_rows(idx, rows, tags, sim, skip=SKIP)
print('rows simulated', len(R), 'dropped', dict(drop), '| C0 exits', dict(collections.Counter(x['c0kind'] for x in R)))
if DUMP:
    json.dump([dict(id=x['id'], side=x['side'], kind=x['c0kind'], ms=int(np.datetime64(x['rs'].replace(microsecond=0)).astype('datetime64[s]').astype(np.int64)) * 1000, px=x['c0px'], first=(None if not x['first'] else dict(date=x['first']['date'], t=x['first']['t']))) for x in R], open(os.path.join(D, 'a10_c0_dump.json'), 'w')); print('dumped', len(R)); sys.exit(0)
sig = [x for x in R if x['first']]
print('rows where H differs from C0 (extended thrust before the stop/expiry):', len(sig))
TESTS = [('R1_RTH', lambda x: x['p'], 'RTH'), ('R2_RTH', lambda x: x['b'], 'RTH'), ('R2_GBX', lambda x: x['b'], 'GBX')]
for name, f, tr in TESTS:
    g = [x for x in sig if f(x) and x['rtrack'] == tr]; ind = {(x['first']['date'], x['first']['t']) for x in g}
    print(f'  {name}: tagged rows {sum(1 for x in R if f(x) and x["rtrack"] == tr)}, signalled {len(g)}, independent {len(ind)}, days {len({x["td"] for x in g})}')
if PREP: sys.exit(0)
pnl = {r['id']: r['pnl'] for r in json.load(open(os.path.join(D, 'a6_pnl.json')))}
bc_ = L_.BarCache(); events = L_.events; mean = L_.mean; wins = L_.wins
for x in R:
    x['A'] = pnl.get(x['id']); x['C0'] = virt(x, x['c0px']); x['Hpx'] = x['first']['o1'] if x['first'] else None
    x['d'] = (virt(x, x['Hpx']) - x['C0']) if x['first'] else None
    x['dA'] = (virt(x, x['Hpx']) - x['A']) if (x['first'] and x['A'] is not None) else None
def summ(name, g, key='d'):
    E = events(g, key); nd = len({e['td'] for e in E})
    if len(E) < 3: print(f'  {name}: events {len(E)} (too few)'); return None
    m = mean(E); bt = L_.dbb(E, np.random.default_rng(7)); p = float((bt <= 0).mean()); fl = len(E) >= 20 and nd >= 10
    print(f'  {name}: events {len(E)} days {nd} mean {m:+.1f} $ ({m/2:+.1f} pt) CI90 [{np.quantile(bt, .05):+.1f}, {np.quantile(bt, .95):+.1f}] p {p:.3f}{"" if fl else "  (BELOW FLOOR: no verdict)"}')
    return E, m, p, fl
print('\n=== MDE (SD of d = H - C0) ===')
for name, f, tr in TESTS:
    E = events([x for x in sig if f(x) and x['rtrack'] == tr], 'd')
    if len(E) > 3: sd = float(np.std([e['v'] for e in E], ddof=1)); mde = 2.49 * sd / np.sqrt(len(E)); print(f'{name}: events {len(E)}, SD {sd:.1f} $, MDE {mde:.1f} $ = {mde/2:.1f} pt = {mde/2/474:.4f} ADR20 (bar 0.015 ADR20 = 7 pt)')
print('\n=== COUNTED: d = H - C0 (hold to capitulation vs hold to expiry, same original stop) ===')
rng = np.random.default_rng(20261113); ps = []
for name, f, tr in TESTS:
    g = [x for x in sig if f(x) and x['rtrack'] == tr]
    pool = [x for x in R if x['rtrack'] == tr]
    L_.make_ctrl(idx, g, pool, lambda y: (bool(f(y)), y['rtrack']), rng, 20)
    for x in g:
        dp = []
        for y, tx in sorted(x['ctrl'], key=lambda c: c[0]['td']):
            px = bc_.exit_open(y['td'], tx)
            if px is not None: dp.append(virt(y, px) - y['C0'])
        x['pd'] = (x['d'] - float(np.mean(dp))) if dp else None
    r = summ(name, g)
    if not r: ps.append((name, 1.0, False)); continue
    E, m, p, fl = r; vals = np.array([e['v'] for e in E]); days = sorted({e['td'] for e in E}); infl = np.argsort(-(vals - m)); keep = np.delete(vals, infl[:2]).mean()
    loo = [mean([e for e in E if e['td'] != d]) for d in days]; h1 = [e for e in E if e['td'] <= days[len(days) // 2]]; h2 = [e for e in E if e['td'] > days[len(days) // 2]]
    EP = events(g, 'pd'); mp = mean(EP) if EP else float('nan'); bp = L_.dbb(EP, np.random.default_rng(3)) if len(EP) > 3 else np.array([np.nan])
    un = events([x for x in sig if not f(x) and x['rtrack'] == tr and not x['p'] and not x['b']], 'd'); mu = mean(un) if un else float('nan')
    gates = dict(winsor=bool(wins(vals) > 0), drop_top2=bool(keep > 0), loo=bool(min(loo) > 0), halves=bool((mean(h1) > 0) == (mean(h2) > 0) and mean(h1) > 0), placebo=bool(mp > 0), tagged_minus_untagged=bool(m - mu > 0))
    print(f'     winsor5 {wins(vals):+.1f}; drop-top2 {keep:+.1f}; leave-one-day-out min {min(loo):+.1f}; halves {mean(h1):+.1f}/{mean(h2):+.1f}; risk-set placebo diff {mp:+.1f} $ CI90 [{np.nanquantile(bp, .05):+.1f}, {np.nanquantile(bp, .95):+.1f}] on {len(EP)} events; untagged same-track mean {mu:+.1f} ({len(un)} events); gates {gates}')
    ps.append((name, p, fl))
holm = L_.holm(ps, HOLM); print('Holm 0.10:', {n: (round(p, 3), holm[n]) for n, p, fl in ps}, '(a test below the floor cannot pass)')
print('\n=== SECONDARY: H - A (the whole proposal against what the setup does today) ===')
for name, f, tr in TESTS: summ(name + ' H-A', [x for x in sig if f(x) and x['rtrack'] == tr], 'dA')
print('\n=== DESCRIPTIVE ===')
summ('R1_GBX (below floor expected)', [x for x in sig if x['p'] and x['rtrack'] == 'GBX']); summ('both tags', [x for x in sig if x['p'] and x['b']])
for tr in ('RTH', 'GBX'): summ(f'untagged control {tr} (d = H - C0)', [x for x in sig if not x['p'] and not x['b'] and x['rtrack'] == tr]); summ(f'untagged control {tr} (H - A)', [x for x in sig if not x['p'] and not x['b'] and x['rtrack'] == tr], 'dA')
for kd in ('STOP', 'EXP'): summ(f'all signalled rows, C0 ended by {kd}', [x for x in sig if x['c0kind'] == kd])
allc = [x for x in R if x['A'] is not None]
print('\nall rows mean $: A (own exit)', round(float(np.mean([x['A'] for x in allc])), 2), '| C0 (hold to expiry, original stop)', round(float(np.mean([x['C0'] for x in allc])), 2))
for lab, ff in (('pivot_live', lambda x: x['p']), ('at_boundary', lambda x: x['b']), ('untagged', lambda x: not x['p'] and not x['b'])):
    g = [x for x in allc if ff(x)]; print(f'  {lab}: rows {len(g)}  A {np.mean([x["A"] for x in g]):+.1f}  C0 {np.mean([x["C0"] for x in g]):+.1f}')
