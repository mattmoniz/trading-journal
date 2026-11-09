"""Outcome-blind PRIOR for the turn-signal order rule: the distribution of Stage-1 extensions (S1_CLUSTER and S1_SPIKE) per track on the 68 real-depth EXPLORE sessions (2026-06-15..2026-10-09), so the live
rule starts with a data-derived top-tercile cutoff instead of a typed number; the live daemon replaces it with the rolling distribution of its own table once it has >= 60 Stage-1 events per track.
Writes scratch/vacuum_sim_20261108/turn_ext_prior.json. No price after an event's bar is read."""
import sys, os, json
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import features as Fm
import turn_signal as TS
import turn_signal_phase1 as T1
assert TS.Z_RATIO == Fm.Z_RATIO and TS.Z_ROC == Fm.Z_ROC
ext = {'RTH': [], 'GBX': []}; ns = 0; kinds = {}
for d, P, n0, F, close, adr in T1.sessions_real():
    ns += 1
    for e in TS.turn_events(P, n0, F, close, adr):
        if e['kind'] in ('S1_CLUSTER', 'S1_SPIKE') and e['ext'] == e['ext'] and e['ext'] is not None:
            ext[e['track']].append(e['ext']); kinds[(e['track'], e['kind'])] = kinds.get((e['track'], e['kind']), 0) + 1
out = {'sessions': ns, 'window': '2026-06-15..2026-10-09 real depth', 'n': {k: len(v) for k, v in ext.items()}, 'events': {f'{a}|{b}': v for (a, b), v in kinds.items()},
       'pct67': {k: float(np.percentile(v, 67)) for k, v in ext.items() if len(v) >= 30}, 'pct50': {k: float(np.percentile(v, 50)) for k, v in ext.items() if len(v) >= 30}, 'pct80': {k: float(np.percentile(v, 80)) for k, v in ext.items() if len(v) >= 30}}
json.dump(out, open(os.path.join(Fm.ROOT, 'scratch', 'vacuum_sim_20261108', 'turn_ext_prior.json'), 'w'), indent=1); print(json.dumps(out, indent=1))

# --- expected firing rate of the ORDER rule on the same explore sessions (outcome-blind counts; cutoff = the sample's own pct67, as the live prior)
cut = out['pct67']; cnt = {'RTH': dict(s2=0, linked=0, held=0, qual=0), 'GBX': dict(s2=0, linked=0, held=0, qual=0)}; qdays = {'RTH': set(), 'GBX': set()}; ns2 = 0
for d, P, n0, F, close, adr in T1.sessions_real():
    for e in TS.turn_events(P, n0, F, close, adr):
        if e['kind'] != 'S2_IGNITION': continue
        c = cnt[e['track']]; c['s2'] += 1
        if e['linked']: c['linked'] += 1
        if e['linked'] and e['linked']['held']: c['held'] += 1
        if TS.qualifies(e, cut.get(e['track'])): c['qual'] += 1; qdays[e['track']].add(d)
print('ORDER-RULE counts on the 68 explore sessions:', json.dumps(cnt), '| sessions with >= 1 qualified:', {k: len(v) for k, v in qdays.items()})
