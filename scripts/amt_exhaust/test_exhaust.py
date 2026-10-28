"""Synthetic tests for exhaust.py. No DB. Run: ../../venv/bin/python test_exhaust.py"""
import numpy as np
import exhaust as X

def sess(n_push=30):
    a = {k: np.full(390, 100.0) for k in 'ohlc'}; a['v'] = np.full(390, 100.0); a['dl'] = np.zeros(390); a['n'] = 390
    for i in range(0, n_push):                                   # steady up push: +2 per bar, strong buying
        a['o'][i] = 100 + 2 * i; a['c'][i] = 102 + 2 * i; a['h'][i] = a['c'][i] + 0.5; a['l'][i] = a['o'][i] - 0.5; a['dl'][i] = 40.0 + 0.5 * i
    return a

def thr(tmin=20, v90=10.0, v75=0.5):
    t90 = np.full(390, 1e9); t90[tmin:] = v90; return t90, np.full(390, v75)

def with_fade(resp=True):
    a = sess(); t = 29
    for i in (27, 28):                                           # buying aggression fades at the tail (ask = (100 + 4)/2 = 52 instead of 70) while price still pushes
        a['dl'][i] = 4.0
    a['dl'][29] = 4.0; a['h'][29] = a['c'][29] + 2.0              # bar 29 makes the new high
    if resp:                                                     # sellers step in on bars 30..32 and price closes below the extreme bar's low (l[29] = 157.5)
        for i, (o, c) in zip((30, 31, 32), ((160, 156), (156, 150), (150, 146))):
            a['o'][i], a['c'][i], a['h'][i], a['l'][i], a['dl'][i] = o, c, o + 0.5, c - 0.5, -60.0
        a['v'][30:33] = 100.0
    return a

def t_push_and_exhaustion():
    a = with_fade(); st = X.push_stats(a)
    base = X.base_signals(a, st, thr())
    faded = [b for b in base if b['faded']]
    assert faded and faded[0]['t'] == 27 and faded[0]['dp'] == 1 and len(faded) == 1, base
    print('ok first exhaustion of the push detected at bar 27 (buying aggression fades while price still makes new highs); refractory blocks bars 28-29')

def t_e1_e2_entries():
    a = with_fade(); st = X.push_stats(a); ev = X.build_events(a, st, thr())
    assert [e['e'] for e in ev['E1']] == [28] and ev['E1'][0]['d'] == -1, ev['E1']
    assert len(ev['E2']) == 1 and ev['E2'][0]['d'] == -1 and ev['E2'][0]['e'] == 32 and ev['E2'][0]['lag'] == 4, ev['E2']    # response first satisfied at bar 31 (two counter bars, counter volume dominates, close below the extreme bar's low): entry at the open of bar 32
    print('ok E1 enters the next bar; E2 waits for the sustained counter-side response (entry bar 32, lag 4)')

def t_no_response():
    a = with_fade(resp=False); st = X.push_stats(a); ev = X.build_events(a, st, thr())
    assert len(ev['E1']) == 1 and ev['E2'] == [] and len(ev['NR']) == 1, ev
    print('ok no response: no E2, the signal is a no-response (NR) control')

def t_not_faded_is_control():
    a = sess(); a['h'][29] = a['c'][29] + 2.0                    # strong buying throughout, new high at bar 29, no fade
    for i, (o, c) in zip((30, 31, 32), ((160, 156), (156, 150), (150, 146))):
        a['o'][i], a['c'][i], a['h'][i], a['l'][i], a['dl'][i] = o, c, o + 0.5, c - 0.5, -60.0
    st = X.push_stats(a); ev = X.build_events(a, st, thr(tmin=29))
    assert ev['E1'] == [] and ev['E2'] == [] and len(ev['C2']) == 1, ev
    print('ok a response after a push that did not fade is the C2 control, not E2')

def t_one_counter_bar_not_enough():
    a = with_fade(); a['dl'][31] = 0.0; a['c'][31] = 158.0; a['l'][31] = 157.5; a['dl'][32] = 0.0; a['c'][32] = 158.0; a['l'][32] = 157.5   # only one counter-delta bar (30) and no close below the low
    st = X.push_stats(a); ev = X.build_events(a, st, thr(), window=5)
    assert ev['E2'] == [], ev['E2']
    print('ok a single counter bar does not legitimize the trade')

def t_geometry():
    a = with_fade(); st = X.push_stats(a); ev = X.build_events(a, st, thr())['E2'][0]
    atr = np.full(390, 4.0); t = X.trade(a, ev, atr)
    assert t is not None and t['dir'] == -1, t
    print('ok geometry returns a short trade with stop beyond the extreme and a 50% retracement target:', t['reason'], round(t['pts'], 2))

if __name__ == '__main__':
    for f in [v for k, v in sorted(globals().items()) if k.startswith('t_')]: f()
    print('ALL EXHAUST TESTS PASSED')
