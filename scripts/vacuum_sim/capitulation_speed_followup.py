"""Row 44 amendment A1 (descriptive, post-hoc, never counted): CIs and robustness of the reversed speed result."""
import os, sys, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import capitulation_speed as CS
G = CS.G
ev = [x for x in CS.load() if x['track'] == 'RTH']
def hour_of(x): return None
import csv
rows = list(csv.DictReader(open(os.path.join(CS.OUT, 'events_speed.csv'))))
# the clock hour is not stored: recompute from the events_raw end_sec
raw = {(r['date'], r['track'], int(r['k'])): r for r in csv.DictReader(open(os.path.join(CS.CR.OUT, 'events_raw.csv')))}
def line(label, vals, seed=51):
    r = G.boot_mean(vals, seed)
    if r: print(f'  {label:58s} N {r["n"]:4d} days {r["days"]:3d}  {r["mean"]:+7.2f} [{r["lo"]:+.2f}, {r["hi"]:+.2f}]')
fast = [x for x in ev if x['fast']]; nf = [x for x in ev if not x['fast']]
print('RTH, points, pre-cost unless stated (exit value v = minus the 30-bar stay-in change; negative = staying in GAINED)')
line('extreme-fast: exit value v', [(x['date'], -x['fwd']) for x in fast]); line('not fast: exit value v', [(x['date'], -x['fwd']) for x in nf])
line('extreme-fast: CONTINUE trade (enter with the move at the climax) net after 2.0', [(x['date'], x['fwd'] - G.COST) for x in fast]); line('not fast: BOUNCE trade (against the move) net after 2.0', [(x['date'], -x['fwd'] - G.COST) for x in nf])
line('fastest decile: CONTINUE net after 2.0', [(x['date'], x['fwd'] - G.COST) for x in ev if x['fast10']])
# hour mix: end_sec of the climax bar, seconds since 18:00 ET; RTH hour = 18 + sec//3600 mod 24
hr = {}
for r in rows:
    pass
H = collections.defaultdict(list)
for r in csv.DictReader(open(os.path.join(CS.CR.OUT, 'events_raw.csv'))):
    if r['track'] != 'RTH': continue
H[(r['date'], int(r['k']))] = int((18 + float(r['end_sec']) // 3600) % 24)
# join by order: events_speed rows are in the same order as events_raw rows that survived burn-in; match on (date, dir, pace) is not possible, so rebuild the hour from raw by date+dir order
raw_by = collections.defaultdict(list)
for r in csv.DictReader(open(os.path.join(CS.CR.OUT, 'events_raw.csv'))):
    if r['track'] == 'RTH': raw_by[(r['date'], int(r['dir']))].append(int((18 + float(r['end_sec']) // 3600) % 24))
used = collections.Counter(); hours = []
for x in ev:
    k = (x['date'], x['dir']); i = used[k]; used[k] += 1; hours.append(raw_by[k][i] if i < len(raw_by[k]) else None)
for x, h in zip(ev, hours): x['hour'] = h
mix = lambda xs: collections.Counter(x['hour'] for x in xs)
print('\nclock-hour share of climaxes (ET hour: extreme-fast share | not-fast share):')
for h in sorted({x['hour'] for x in ev if x['hour'] is not None}): print(f'  {h:02d}: {sum(1 for x in fast if x["hour"] == h) / len(fast):5.1%} | {sum(1 for x in nf if x["hour"] == h) / len(nf):5.1%}')
print('\nby hour group (exit value v; negative = staying in gained):')
for lab, hs in (('open 09-10', (9, 10)), ('midday 11-13', (11, 12, 13)), ('afternoon 14-15', (14, 15))):
    line(f'extreme-fast, {lab}', [(x['date'], -x['fwd']) for x in fast if x['hour'] in hs]); line(f'not fast,      {lab}', [(x['date'], -x['fwd']) for x in nf if x['hour'] in hs])
d = collections.Counter(x['dir'] for x in fast); print('\nextreme-fast climax direction (-1 selling, +1 buying):', dict(d), '| exit value by direction:', {k: round(float(np.mean([-x["fwd"] for x in fast if x["dir"] == k])), 2) for k in d})
