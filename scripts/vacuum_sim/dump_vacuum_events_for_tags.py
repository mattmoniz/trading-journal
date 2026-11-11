"""Dumps every E0 vacuum onset (live detector's code, 581 scored sessions) with its ET wall time and signal-bar close, for the location tagger (docs/VACUUM_LOCATION_EXTENSION_PREREG_20261109.md). Reads no outcome."""
import os, sys, json, datetime
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import capitulation_replay_lib as L_
ev = L_.build_events(); D = L_.D
skip = L_.roll_skip_dates(os.path.join(D, 'a11_minute_bars.tsv')) | L_.roll_skip_dates(os.path.join(D, 'a10_minute_bars.tsv'))
out = []
for e in ev:
    f = L_.C.wall(e['date'], e['t']); ds = {f.date().isoformat(), e['date']}
    out.append(dict(key=f"{e['date']}|{e['track']}|{e['k']}|{e['dir']}", date=e['date'], track=e['track'], k=e['k'], dir=e['dir'], f=f.strftime('%Y-%m-%d %H:%M:%S'), px=e['c'], E=None if e['E'] != e['E'] else e['E'], flag=e['flag'], skip=bool(ds & skip)))
os.makedirs(os.path.join(D, '..', 'vacuum_sim_20261108'), exist_ok=True)
json.dump(out, open(os.path.join(D, '..', 'vacuum_sim_20261108', 'vac_events_for_tags.json'), 'w')); print('events', len(out), 'in roll/stitching dates', sum(1 for x in out if x['skip']))
