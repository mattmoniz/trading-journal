"""ROW 30 A10 PHASE 1 (outcome-blind; docs/CAPITULATION_REPLACES_TARGET_PREREG_20261109.md). For every real row of a6_rows.json with entry-location tags (a10_tags.json): is there a same-direction EXTENDED vacuum thrust
between the entry and the row's expiry (`expires_at`; fallback the 15:55 ET flat for RTH-fired rows, 09:29:50 ET for Globex-fired rows)? Such rows are the ones where arm H can differ from arm C0.
Reads fired_at, expires_at, tags and thrust times only: NO P&L, no resolved_at, no price after the entry. Rows whose expiry is after the event corpus end (2026-10-09) are dropped (a thrust could not be seen). Usage: ../../venv/bin/python capitulation_replace_target_phase1.py"""
import os, sys, json, datetime, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import capitulation_replay_lib as L_
ev = L_.build_events(); D = L_.D; idx = L_.EventIndex(ev)
rows = json.load(open(os.path.join(D, 'a6_rows.json'))); tags = json.load(open(os.path.join(D, 'a10_tags.json')))
END = datetime.datetime(2026, 10, 9, 23, 59)
def flat(f):
    m = f.hour * 60 + f.minute
    if 570 <= m < 960: return f.replace(hour=15, minute=55, second=0, microsecond=0)
    base = f.replace(hour=9, minute=29, second=50, microsecond=0)
    return base if m < 570 else base + datetime.timedelta(days=1)
R = []; dropped = collections.Counter()
for r in rows:
    t = tags.get(str(r['id']))
    if not t: dropped['no tags'] += 1; continue
    f = datetime.datetime.fromisoformat(r['f']); exp = datetime.datetime.fromisoformat(r['exp']) if r.get('exp') else flat(f); had_exp = bool(r.get('exp'))
    if exp > END: dropped['expiry after corpus end'] += 1; continue
    if exp <= f: dropped['expiry <= fire'] += 1; continue
    cand = idx.window(t['side'], f, exp); ext = [c for c in cand if c['flag'] == 'EXT' and not L_.reopen(c['ts']) and c['o1'] == c['o1']]
    R.append(dict(id=r['id'], td=r['td'], rtrack='RTH' if (f.hour * 60 + f.minute >= 570 and f.hour < 16) else 'GBX', b=bool(t['at_boundary']), p=bool(t['pivot_live']), first=ext[0] if ext else None, had_exp=had_exp))
print('rows', len(R), 'dropped', dict(dropped), '| rows with a stored expiry', sum(1 for x in R if x['had_exp']))
def line(name, g):
    s = [x for x in g if x['first']]; ind = {(x['first']['date'], x['first']['t']) for x in s}; days = collections.Counter(x['td'] for x in s)
    top5 = 100 * sum(v for _, v in days.most_common(5)) / max(len(s), 1); ok = len(ind) >= 20 and len(days) >= 10
    print(f'{name:34s}rows {len(g):5d}  with thrust {len(s):4d} ({100*len(s)/max(len(g),1):4.1f}%)  independent {len(ind):4d}  days {len(days):3d}  top5d {top5:5.1f}%  {"PASS" if ok else "BELOW FLOOR"}')
for tr in ('ALL', 'RTH', 'GBX'):
    print(f'\n--- row track {tr} ---')
    G = [x for x in R if tr == 'ALL' or x['rtrack'] == tr]
    line('all rows', G); line('R1 at_defended_pivot (pivot_live)', [x for x in G if x['p']]); line('R2 at_boundary', [x for x in G if x['b']])
    line('either tag', [x for x in G if x['p'] or x['b']]); line('both tags', [x for x in G if x['p'] and x['b']]); line('neither tag (control)', [x for x in G if not x['p'] and not x['b']])
