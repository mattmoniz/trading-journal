"""Synthetic-session tests for engine.py. No DB. Run: ../../venv/bin/python test_engine.py"""
import numpy as np
import engine as E

def sess(over, vah=200.0, val=100.0, poc=130.0, mirror=False):
    a = {k: np.full(390, 150.0) for k in 'ohlc'}; a['v'] = np.ones(390); a['dl'] = np.zeros(390); a['n'] = 390
    for i, (o, h, l, c, dl) in over.items(): a['o'][i], a['h'][i], a['l'][i], a['c'][i], a['dl'][i] = o, h, l, c, dl
    S = dict(d='2026-01-05', a=a, vah=vah, val=val, poc=poc, open=float(a['o'][0]))
    if mirror:
        b = {k: np.full(390, 150.0) for k in 'ohlc'}; b['v'] = a['v']; b['dl'] = -a['dl']; b['n'] = 390
        b['o'], b['c'] = 300 - a['o'], 300 - a['c']; b['h'], b['l'] = 300 - a['l'], 300 - a['h']
        S = dict(d='2026-01-05', a=b, vah=300 - val, val=300 - vah, poc=300 - poc, open=float(b['o'][0]))
    return S

BASEEV = {10: (150, 150, 95, 95, 0), 11: (105, 106, 104, 105, 10), 12: (105, 107, 104, 106, 10), 13: (106, 107, 105.5, 106.5, 0)}
def run(extra, **kw):
    ev = dict(BASEEV); ev.update(extra); return E.simulate_session(sess(ev, **kw))

def t_t1_then_be():
    t = run({14: (106.5, 131, 106.5, 130.5, 0), 15: (130, 130.5, 106, 107, 0)})
    assert len(t) == 1, t; t = t[0]
    assert abs(t['entry'] - 106.25) < 1e-9 and abs(t['pts_a'] - 23.75) < 1e-9 and t['ra'] == 'T1', t
    assert abs(t['pts_b'] - 0.75) < 1e-9 and t['rb'] == 'STOP', t        # BE stop at entry+1 effective the bar AFTER the T1 bar, fills at 107.25 - 0.25
    print('ok T1 fill then breakeven stop next bar')
def t_be_not_same_bar():
    t = run({14: (106.5, 131, 100, 101, 0)})[0]                           # T1 and a low of 100 on the same bar: stop (92.5) not hit, runner still open, BE not yet effective
    assert t['ra'] == 'T1' and t['rb'] != 'STOP', t
    print('ok breakeven not effective inside the T1 bar')
def t_gap_stop():
    t = run({14: (80, 81, 79, 80, 0)})[0]
    assert t['ra'] == 'STOP_GAP' and abs(t['pts_a'] - (79.75 - 106.25)) < 1e-9, t
    print('ok gap through stop fills at the open')
def t_same_bar_stop_first():
    t = run({14: (106.5, 131, 90, 120, 0)})[0]
    assert t['ra'] == 'STOP' and abs(t['pts_a'] - (92.5 - 0.25 - 106.25)) < 1e-9, t
    print('ok same bar stop before T1')
def t_struct():
    t = run({14: (106.5, 107, 97, 97, 0), 15: (96, 96.5, 95.5, 96, 0)})[0]
    assert t['ra'] == 'STRUCT' and abs(t['pts_a'] - (95.75 - 106.25)) < 1e-9, t
    print('ok structural invalidation exits at the next open')
def t_bail():
    ev = {i: (106.5, 107.5, 105.5, 106.5, 0) for i in range(14, 28)}; ev[28] = (106.5, 107, 106, 106.5, 0)
    t = run(ev)[0]
    assert t['ra'] == 'BAIL' and abs(t['pts_a'] - (106.25 - 106.25)) < 1e-9, t
    print('ok time bailout after 15 bars')
def t_eod():
    ev = {14: (106.5, 115, 106.5, 107, 0)}; ev.update({i: (107, 108, 106, 107, 0) for i in range(15, 385)}); ev[385] = (108, 108.5, 107.5, 108, 0)
    t = run(ev)[0]
    assert t['ra'] == 'EOD' and abs(t['pts_a'] - (108 - 0.25 - 106.25)) < 1e-9, t
    print('ok end-of-day flatten at the 15:55 open')
def t_window():
    late = {343: (150, 150, 95, 95, 0), 344: (105, 106, 104, 105, 10), 345: (105, 107, 104, 106, 10), 346: (106, 107, 105.5, 106.5, 0)}
    assert E.simulate_session(sess(late)) == []                           # trigger bar 345 -> entry bar 346 > 15:15 (offset 345): not allowed
    ok = {342: (150, 150, 95, 95, 0), 343: (105, 106, 104, 105, 10), 344: (105, 107, 104, 106, 10), 345: (106, 107, 105.5, 106.5, 0)}
    assert len(E.simulate_session(sess(ok))) == 1                         # trigger bar 344 -> entry bar 345 allowed
    print('ok entry window ends at the 15:15 entry bar')
def t_va_width():
    assert E.simulate_session(sess(BASEEV, vah=120.0, val=100.0, poc=110.0)) == []
    print('ok VA width filter')
def t_short_mirror():
    ev = dict(BASEEV); ev.update({14: (106.5, 131, 106.5, 130.5, 0), 15: (130, 130.5, 106, 107, 0)})
    t = E.simulate_session(sess(ev, mirror=True))[0]
    assert t['dir'] == -1 and abs(t['pts_a'] - 23.75) < 1e-9 and t['ra'] == 'T1' and abs(t['pts_b'] - 0.75) < 1e-9, t
    print('ok short mirror')
def t_room_and_delta():
    ev = dict(BASEEV); ev[11] = (105, 106, 104, 105, -10); ev[12] = (105, 107, 104, 106, -10)        # negative delta on both bars
    assert run({11: ev[11], 12: ev[12]}) == []
    ev2 = {11: (120, 121, 119, 120, 10), 12: (120, 121, 119, 121, 10)}                                  # room = 130 - 121 = 9 < 15
    assert run(ev2) == []
    print('ok delta and room filters')

if __name__ == '__main__':
    for f in [v for k, v in sorted(globals().items()) if k.startswith('t_')]: f()
    print('ALL ENGINE TESTS PASSED')
