"""ROW 30 A10.2 DESCRIPTIVE EXTRAS (docs/CAPITULATION_REPLACES_TARGET_PREREG_20261109.md, amendment A10.2; look `cap_a10_extras_20261109`): same 5,177 rows and arms as capitulation_replay_a10.py. No counted test, no new p-value in any family.
1 ITT (unconditional) table; 2 matched static-target control T; 3 thrust-type arms; 4 timing / extension splits; 5 Globex diagnostics (counts). Dollars, cost $2. Usage: ../../venv/bin/python -W ignore capitulation_replay_a10_extras.py"""
import os, sys, json, datetime, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import capitulation_replay_lib as L_
ev = L_.build_events(); D = L_.D; idx = L_.EventIndex(ev)
rows = json.load(open(os.path.join(D, 'a6_rows.json'))); tags = json.load(open(os.path.join(D, 'a10_tags.json'))); pnl = {r['id']: r['pnl'] for r in json.load(open(os.path.join(D, 'a6_pnl.json')))}
sim = L_.HoldSim(os.path.join(D, 'a10_minute_bars.tsv')); virt = L_.virt; SKIP = None if '--include-roll' in sys.argv else L_.roll_skip_dates(os.path.join(D, 'a10_minute_bars.tsv'))   # A10.4: roll-week / stitching rows excluded unless --include-roll (reproduces the first run)
R, drop = L_.build_hold_rows(idx, rows, tags, sim, skip=SKIP)
R = [x for x in R if pnl.get(x['id']) is not None]
for x in R:
    x['A'] = pnl[x['id']]; x['C0'] = virt(x, x['c0px']); x['sigd'] = x['first'] is not None; x['H'] = virt(x, x['first']['o1']) if x['first'] else x['C0']
    x['d'] = x['H'] - x['C0'] if x['first'] else None
print('rows', len(R), 'dropped', dict(drop))
def ci(vals, days, B=2000, seed=5):
    rg = np.random.default_rng(seed); ud = sorted(set(days)); by = {d: [v for v, dd in zip(vals, days) if dd == d] for d in ud}; out = []
    for _ in range(B):
        pick = rg.choice(len(ud), size=len(ud)); s = [v for i in pick for v in by[ud[i]]]; out.append(np.mean(s))
    return np.quantile(out, .05), np.quantile(out, .95)
print('\n=== 1. ITT: unconditional means over ALL rows of a stratum (H equals C0 where no thrust fired) ===')
print(f'{"stratum":22s}{"rows":>6s}{"sig":>5s}{"A":>8s}{"C0":>8s}{"H":>8s}   {"H - A  [CI90]":>26s}   {"H - C0 [CI90]":>26s}   {"C0 - A":>8s}')
S = [('R2_RTH (boundary, RTH)', lambda x: x['b'] and x['rtrack'] == 'RTH'), ('R2_GBX (boundary, Globex)', lambda x: x['b'] and x['rtrack'] == 'GBX'), ('R1_RTH (pivot, RTH)', lambda x: x['p'] and x['rtrack'] == 'RTH'), ('R1_GBX (pivot, Globex)', lambda x: x['p'] and x['rtrack'] == 'GBX'),
     ('untagged RTH', lambda x: not x['p'] and not x['b'] and x['rtrack'] == 'RTH'), ('untagged Globex', lambda x: not x['p'] and not x['b'] and x['rtrack'] == 'GBX'), ('ALL RTH', lambda x: x['rtrack'] == 'RTH'), ('ALL Globex', lambda x: x['rtrack'] == 'GBX'), ('ALL rows', lambda x: True)]
for nm, f in S:
    g = [x for x in R if f(x)]
    if len(g) < 5: print(f'{nm:22s} {len(g)} rows'); continue
    days = [x['td'] for x in g]; a = [x['A'] for x in g]; c = [x['C0'] for x in g]; h = [x['H'] for x in g]; ha = [hh - aa for hh, aa in zip(h, a)]; hc = [hh - cc for hh, cc in zip(h, c)]
    la, ua = ci(ha, days); lc, uc = ci(hc, days)
    print(f'{nm:22s}{len(g):6d}{sum(x["sigd"] for x in g):5d}{np.mean(a):8.1f}{np.mean(c):8.1f}{np.mean(h):8.1f}   {np.mean(ha):+8.1f} [{la:+7.1f},{ua:+7.1f}]   {np.mean(hc):+8.1f} [{lc:+7.1f},{uc:+7.1f}]   {np.mean(c)-np.mean(a):+8.1f}')
print('\n=== 2. matched STATIC TARGET control T on R2_RTH rows (walk-forward median excursion of strictly earlier days\' H exits, ADR20 units, >= 10 earlier) ===')
g = sorted([x for x in R if x['b'] and x['rtrack'] == 'RTH' and x['adr']], key=lambda x: x['td'])
exc = [(x['td'], x['side'] * (x['first']['o1'] - x['p0']) / x['adr']) for x in g if x['first']]
used = []; hit = 0
for x in g:
    e = [v for d, v in exc if d < x['td']]
    if len(e) < 10: continue
    med = float(np.median(e)); tgt = x['p0'] + x['side'] * med * x['adr']; s = sim.c0(x['f'], x['side'], x['p0'], x['stp'], x['exp'], tgt=tgt)
    if s is None: continue
    x['Tpnl'] = virt(x, s[2]); x['Tkind'] = s[0]; x['med'] = med; used.append(x); hit += s[0] == 'TARGET'
print(f'rows with T defined {len(used)} of {len(g)} R2_RTH rows; walk-forward median excursion median {np.median([x["med"] for x in used]):.3f} ADR20; T exits by target {hit}, stop {sum(x["Tkind"] == "STOP" for x in used)}, expiry {sum(x["Tkind"] == "EXP" for x in used)}')
if used:
    days = [x['td'] for x in used]
    for lab, key in (('T - C0', lambda x: x['Tpnl'] - x['C0']), ('H - C0', lambda x: x['H'] - x['C0']), ('T - A', lambda x: x['Tpnl'] - x['A']), ('H - A', lambda x: x['H'] - x['A']), ('H - T', lambda x: x['H'] - x['Tpnl'])):
        v = [key(x) for x in used]; lo, hi = ci(v, days); print(f'  unconditional over {len(used)} rows  {lab:8s} {np.mean(v):+8.1f} [{lo:+7.1f},{hi:+7.1f}]')
    us = [x for x in used if x['sigd']]
    for lab, key in (('T - C0', lambda x: x['Tpnl'] - x['C0']), ('H - C0', lambda x: x['H'] - x['C0']), ('H - T', lambda x: x['H'] - x['Tpnl'])):
        v = [key(x) for x in us]
        if len(v) > 3: lo, hi = ci(v, [x['td'] for x in us]); print(f'  on the {len(us)} signalled rows  {lab:8s} {np.mean(v):+8.1f} [{lo:+7.1f},{hi:+7.1f}]')
print('\n=== 3. thrust type on R2_RTH rows: exit at the first thrust of the type, minus C0 (rows where it occurs) ===')
g = [x for x in R if x['b'] and x['rtrack'] == 'RTH']
for x in g:
    a = [e for e in (x['first'], x['firstnon']) if e]; x['anyfirst'] = min(a, key=lambda e: e['ts']) if a else None
    x['d_non'] = virt(x, x['firstnon']['o1']) - x['C0'] if x['firstnon'] else None; x['d_any'] = virt(x, x['anyfirst']['o1']) - x['C0'] if x['anyfirst'] else None
for lab, key, tk in (('extended only (the A10 arm)', 'd', 'first'), ('NON-extended only', 'd_non', 'firstnon'), ('first of either', 'd_any', 'anyfirst')):
    E = L_.events(g, key, tk)
    if len(E) > 3: print(f'  {lab:28s} events {len(E):4d} days {len({e["td"] for e in E}):3d} mean {L_.mean(E):+8.1f} $  CI90 [{np.quantile(L_.dbb(E, np.random.default_rng(3), 2000), .05):+7.1f},{np.quantile(L_.dbb(E, np.random.default_rng(3), 2000), .95):+7.1f}]')
print('\n=== 4. timing and extension of the R2_RTH signalled events: H - C0 by tercile ===')
sg = [x for x in g if x['first']]
for x in sg:
    x['el'] = (x['first']['ts'] - x['f']).total_seconds() / 60.0; c240 = sim.close_before(x['f'], 240); x['pre'] = (x['side'] * (x['p0'] - c240) / x['adr']) if (c240 is not None and x['adr']) else None; x['E'] = x['first']['E']
for lab, key in (('minutes from entry to the thrust', 'el'), ('pre-entry 240-min displacement (ADR20, + = already moved our way)', 'pre'), ('extension E at the thrust (ADR20)', 'E')):
    v = [x for x in sg if x.get(key) is not None and x[key] == x[key]]
    if len(v) < 9: print(f'  {lab}: {len(v)} usable'); continue
    q1, q2 = np.quantile([x[key] for x in v], [1 / 3, 2 / 3]); print(f'  {lab}: cuts {q1:.2f} / {q2:.2f}')
    for nm, f in (('low', lambda z: z <= q1), ('mid', lambda z: q1 < z <= q2), ('high', lambda z: z > q2)):
        gg = [x for x in v if f(x[key])]; E = L_.events(gg, 'd'); print(f'     {nm:5s} rows {len(gg):3d} events {len(E):3d} mean {L_.mean(E) if E else float("nan"):+8.1f} $')
print('\n=== 5. Globex diagnostics (counts only) ===')
hrs = collections.Counter(int(((e['t'] / 3600.0) + 18) % 24) for e in ev if e['track'] == 'GBX'); tot = sum(hrs.values())
print('Globex onsets by ET hour (n=%d):' % tot, ' '.join(f'{h:02d}:{hrs.get(h, 0)}' for h in list(range(18, 24)) + list(range(0, 10))))
ge = np.array([e['E'] for e in ev if e['track'] == 'GBX' and e['E'] == e['E']]); print(f'Globex events with a defined E: {len(ge)}; E = 0.84 sits at the {100*np.mean(ge < 0.84):.1f}th percentile; share >= 0.5: {100*np.mean(ge >= 0.5):.1f}%, >= 0.84: {100*np.mean(ge >= 0.84):.1f}%; median {np.median(ge):.3f}, p67 {np.quantile(ge, 2/3):.3f}')
