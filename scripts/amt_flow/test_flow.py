"""Synthetic tests for flow.py. No DB. Run: ../../venv/bin/python test_flow.py"""
import numpy as np
import flow as F

def sess(over, base=150.0, onl=110.0, onh=400.0, vah=300.0, val=100.0):
    a = {k: np.full(390, base) for k in 'ohlc'}; a['v'] = np.ones(390); a['dl'] = np.zeros(390); a['n'] = 390
    for i, row in over.items():
        o, h, l, c, dl = row[:5]; a['o'][i], a['h'][i], a['l'][i], a['c'][i], a['dl'][i] = o, h, l, c, dl
        if len(row) > 5: a['v'][i] = row[5]
    return dict(d='2026-01-05', a=a, vah=vah, val=val, poc=150.0, open=base, onh=onh, onl=onl)

def t_zone():
    z = F.build_zones(sess({})); assert z == [(100.0, 110.0, 'pdVAL+ONL')], z; print('ok zone from VA + ON within 20 points')

def t_a_long_target():
    ev = {69: (108, 112, 108, 110, 0), 70: (110, 110, 106, 107, 10), 71: (107, 108, 106, 107, 0), 72: (107, 123, 107, 122, 0)}
    t = F.simulate(sess(ev), 'A'); assert len(t) == 1, t; t = t[0]
    assert t['dir'] == 1 and abs(t['entry'] - 107.25) < 1e-9 and abs(t['stop0'] - 100.0) < 1e-9 and t['reason'] == 'TGT' and abs(t['pts'] - 15.0) < 1e-9, t
    print('ok A long: absorption trigger, stop 6 below the setup low, 15-point target')

def t_a_needs_positive_delta():
    ev = {69: (108, 112, 108, 110, 0), 70: (110, 110, 106, 107, -10), 71: (107, 108, 106, 107, 0)}
    assert F.simulate(sess(ev), 'A') == []
    ctrl = F.simulate(sess(ev), 'A', control=True); assert len(ctrl) == 1 and ctrl[0]['dir'] == 1
    print('ok A needs delta > 0 on a lower low; the control takes the no-absorption bar')

def t_a_structural():
    ev = {69: (103, 104, 102, 103, 0), 70: (103, 103, 99, 101, 10), 71: (101, 102, 100, 101, 0), 72: (100, 100, 94.5, 94.5, 0), 73: (94, 94.5, 93.5, 94, 0)}
    t = F.simulate(sess(ev), 'A')[0]
    assert t['reason'] == 'STRUCT' and abs(t['pts'] - (93.75 - 101.25)) < 1e-9, t
    print('ok A structural exit: close 5 points beyond the zone, exit next open')

def t_a_window():
    ev = {344: (108, 112, 108, 110, 0), 345: (110, 110, 106, 107, 10), 346: (107, 108, 106, 107, 0)}   # trigger bar 345 -> entry bar 346 > 345
    assert F.simulate(sess(ev), 'A') == []
    print('ok A entry window ends at the 15:15 entry bar')

def b_session(brk_start):
    ev = {i: (105, 106, 104, 105, 0) for i in range(60, brk_start)}
    ev.update({i: (115, 116, 114, 115, 0, 100) for i in range(brk_start, brk_start + 10)}); return ev

def t_b_long_target():
    ev = b_session(66); ev[71] = (115, 116, 114, 115, 0, 100); ev[72] = (115, 136, 115, 135, 0, 100)
    t = F.simulate(sess(ev), 'B'); assert len(t) == 1, t; t = t[0]
    assert t['dir'] == 1 and abs(t['entry'] - 115.25) < 1e-9 and abs(t['stop0'] - 105.25) < 1e-9 and t['reason'] == 'TGT' and abs(t['pts'] - 20.0) < 1e-9, t
    print('ok B long: 5 closes above the zone and micro VPOC above it, stop 10, target 20')

def t_b_control_and_window():
    ev = {i: (115, 116, 114, 115, 0, 1) for i in range(66, 76)}                                 # same closes, no volume: micro VPOC stays where the heavy bars are
    ev.update({i: (105, 106, 104, 105, 0, 1000) for i in range(56, 66)})                         # heavy volume INSIDE the zone keeps the micro POC at 105 (not beyond)
    ev.update({i: (105, 106, 104, 105, 0, 1) for i in range(76, 330)})                           # price returns inside the zone afterwards, so no later valid acceptance
    assert F.simulate(sess(ev), 'B') == []
    ctrl = F.simulate(sess(ev), 'B', control=True); assert len(ctrl) >= 1
    late = b_session(331); assert F.simulate(sess(late), 'B') == []                               # trigger bar 335 -> entry bar 336 > 330
    print('ok B needs the micro VPOC beyond the zone; the control takes the no-acceptance case; entry window ends at 15:00')

if __name__ == '__main__':
    for f in [v for k, v in sorted(globals().items()) if k.startswith('t_')]: f()
    print('ALL FLOW TESTS PASSED')
