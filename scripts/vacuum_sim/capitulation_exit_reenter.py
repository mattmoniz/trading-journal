"""Row 42 amendment A2 (descriptive, post-hoc, never counted): exit at the climax and re-enter versus holding. benefit = (-dir) x (px_entry - px_exit) - 2.0 per event (same end price, one extra round trip)."""
import os, sys, csv, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import capitulation_reengage as CR
import capitulation_fail as CF
G = CR.G
def line(label, vals):
    r = G.boot_mean(vals, 41)
    if not r: print(f'  {label}: none'); return
    better = np.mean([v + G.COST > 0 for _, v in vals]); print(f'  {label:44s} N {r["n"]:4d} days {r["days"]:3d}  benefit {r["mean"]:+7.2f} pt [{r["lo"]:+.2f}, {r["hi"]:+.2f}]   re-entry price better than the exit in {better:.0%}   (price improvement before the 2.0 cost {r["mean"] + G.COST:+.2f})')
ev = CR.load_out()
print('EXIT AT THE CLIMAX AND RE-ENTER vs HOLD (points per event; positive = exit-and-re-enter beat holding after one extra round trip)')
for tr in ('RTH', 'GBX'):
    for arm in ('CONTINUE', 'RESUME'):
        for lab, f in (('all', lambda x: True), ('strict defended', lambda x: x['defended'] == 1), ('pivot-live', lambda x: x['pivot_live'] == 1), ('not defended', lambda x: x['defended'] == 0)):
            sub = [x for x in ev if x['track'] == tr and x['arm'] == arm and f(x)]
            if len(sub) >= 10: line(f'{tr} {arm:8s} {lab}', [(x['date'], (-x['dr']) * (x['px_entry'] - x['px_exit']) - G.COST) for x in sub])
fk = CF.load_fork()
for tr in ('RTH', 'GBX'):
    for lab, f in (('all', lambda x: True), ('at-level', lambda x: x['at_level'] == 1)):
        sub = [x for x in fk if x['track'] == tr and x['arm'] == 'F' and f(x) and x['px_entry'] is not None]
        if len(sub) >= 10: line(f'{tr} FAIL-entry (row 43) {lab}', [(x['date'], (-x['dir']) * (x['px_entry'] - x['px_exit']) - G.COST) for x in sub])
