"""Synthetic tests for breakout.py (no DB)."""
import numpy as np
import breakout as B

def sess(n_pre=30, base=100.0):
    a = {k: np.full(390, np.nan) for k in ('o', 'h', 'l', 'c', 'v', 'dl')}
    for i in range(390): a['o'][i] = a['h'][i] = a['l'][i] = a['c'][i] = base; a['h'][i] += 1; a['l'][i] -= 1; a['v'][i] = 100.0; a['dl'][i] = 0.0
    return dict(d='T', a=a, vah=120.0, val=80.0, onh=125.0, onl=None)

def put(a, i, o, h, l, c, v=100.0, dl=0.0): a['o'][i], a['h'][i], a['l'][i], a['c'][i], a['v'][i], a['dl'][i] = o, h, l, c, v, dl

def ign(a, i, line=125.0):  # valid long ignition crossing the line
    put(a, i, line - 2, line + 14, line - 3, line + 13, v=200.0, dl=50.0)

def test_lines():
    S = sess(); assert B.lines(S, 30)[0] == 125.0 and B.lines(S, 30)[1] is None
    S['onh'] = 150.0; assert B.lines(S, 30)[0] is None            # ONH not within 20 of pdVAH, IB not usable before 10:30
    S['onh'] = 125.0; S['a']['h'][:60] = 118.0; assert B.lines(S, 30)[0] == 125.0 and B.lines(S, 60)[0] == 125.0  # IBH 118 within 20 of 120 but max stays 125
    S['onh'] = None; S['a']['h'][:60] = 130.0; assert B.lines(S, 30)[0] is None and B.lines(S, 60)[0] == 130.0   # IBH counts only from the 10:30 bar

def test_ignition_gates():
    S = sess(); a = S['a']; ign(a, 30); assert B.is_ignition(B.ignition_parts(a, 30, 125.0, 1))
    for mod in ('disp', 'clear', 'rej', 'vol', 'dlt'):
        S = sess(); a = S['a']; ign(a, 30)
        if mod == 'disp': put(a, 30, 123, 127.9 + 5, 118.0 + 1, 125 + 5.2, v=200, dl=50)  # range 14.9? set below
        if mod == 'disp': put(a, 30, 124, 138.9, 124.0, 138.0, v=200, dl=50)             # range 14.9, no cross? low=124<=125 ok
        if mod == 'clear': put(a, 30, 123, 139, 124, 129.9, v=200, dl=50)                 # close 129.9 < 130
        if mod == 'rej': put(a, 30, 123, 145, 124, 130.5, v=200, dl=50)                   # close at 31% of range
        if mod == 'vol': put(a, 30, 123, 139, 124, 138, v=149.0, dl=50)                   # 1.5*100=150
        if mod == 'dlt': put(a, 30, 123, 139, 124, 138, v=200, dl=0.0)
        assert not B.is_ignition(B.ignition_parts(a, 30, 125.0, 1)), mod
    S = sess(); a = S['a']; put(a, 30, 126, 141, 126.5, 140, v=200, dl=50); assert not B.is_ignition(B.ignition_parts(a, 30, 125.0, 1))   # low above the line: no cross

def test_fill_needs_one_tick_through():
    S = sess(); a = S['a']; ign(a, 30); put(a, 31, 130, 131, 125.0, 130)       # touches line exactly: no fill
    for j in range(32, 36): put(a, j, 130, 131, 129, 130)
    assert B.simulate(S) == []
    put(a, 31, 130, 131, 124.75, 130)                                           # trades 1 tick through: fill at 125
    for j in range(32, 390): put(a, j, 130, 131, 129, 130)
    t = B.simulate(S); assert len(t) == 1 and t[0]['entry'] == 125.0

def test_expiry_after_five_bars():
    S = sess(); a = S['a']; ign(a, 30)
    for j in range(31, 36): put(a, j, 130, 131, 129, 130)
    put(a, 36, 130, 131, 120, 130)                                              # dips only on bar t+6
    for j in range(37, 390): put(a, j, 130, 131, 129, 130)
    assert B.simulate(S) == []
    S = sess(); a = S['a']; ign(a, 30)
    for j in range(31, 35): put(a, j, 130, 131, 129, 130)
    put(a, 35, 130, 131, 124.5, 130)                                            # t+5 fills
    for j in range(36, 390): put(a, j, 130, 131, 129, 130)
    assert len(B.simulate(S)) == 1

def test_target_stop_structure():
    # target
    S = sess(); a = S['a']; ign(a, 30); put(a, 31, 130, 131, 124.5, 130)
    put(a, 32, 130, 149.5, 129, 140)                                            # 149 = line+24; needs +1 tick -> 149.25
    put(a, 33, 130, 149.25, 129, 140)
    for j in range(34, 390): put(a, j, 130, 131, 129, 130)
    t = B.simulate(S); assert t[0]['reason'] == 'TGT' and abs(t[0]['pts'] - 24.0) < 1e-9, t
    # hard stop at line-12 = 113 with slippage (fill bar closes above line-4 so no structure)
    S = sess(); a = S['a']; ign(a, 30); put(a, 31, 130, 131, 112.0, 126)
    for j in range(32, 390): put(a, j, 130, 131, 129, 130)
    t = B.simulate(S); assert t[0]['reason'] == 'STOP' and abs(t[0]['pts'] - (-12.25)) < 1e-9, t
    # structure: close < line-4 = 121 -> exit next open with slippage
    S = sess(); a = S['a']; ign(a, 30); put(a, 31, 130, 131, 124.5, 130); put(a, 32, 126, 126.5, 120.0, 120.5); put(a, 33, 119.0, 120, 118, 119)
    for j in range(34, 390): put(a, j, 119, 120, 118, 119)
    t = B.simulate(S); assert t[0]['reason'] == 'STRUCT' and abs(t[0]['pts'] - (119.0 - 0.25 - 125.0)) < 1e-9, t

def test_stop_before_target_same_bar_and_gap():
    S = sess(); a = S['a']; ign(a, 30); put(a, 31, 130, 131, 124.5, 130); put(a, 32, 130, 150, 112, 130)   # both in one bar
    for j in range(33, 390): put(a, j, 130, 131, 129, 130)
    assert B.simulate(S)[0]['reason'] == 'STOP'
    S = sess(); a = S['a']; ign(a, 30); put(a, 31, 130, 131, 124.5, 130); put(a, 32, 108, 109, 107, 108)    # gaps through the stop
    for j in range(33, 390): put(a, j, 108, 109, 107, 108)
    t = B.simulate(S)[0]; assert t['reason'] == 'STOP_GAP' and abs(t['pts'] - (108 - 0.25 - 125)) < 1e-9

def test_disarm_and_plain_control():
    S = sess(); a = S['a']; ign(a, 30); put(a, 31, 130, 131, 124.5, 130); put(a, 32, 130, 150, 129, 140); put(a, 33, 140, 150, 139, 149.25 + 1)
    for j in range(34, 390): put(a, j, 130, 131, 129, 130)
    ign(a, 60)                                                                  # price is above the line the whole time: disarmed, never re-armed
    assert len(B.simulate(S)) == 1
    S = sess(); a = S['a']; put(a, 30, 124, 133, 123, 132, v=100, dl=-5)        # crosses, clears, range 10 < 15: plain break
    assert B.is_plain(B.ignition_parts(a, 30, 125.0, 1)) and not B.is_ignition(B.ignition_parts(a, 30, 125.0, 1))

def test_short_mirror():
    S = sess(); a = S['a']; S['vah'] = 160.0; S['onh'] = None; S['val'] = 75.0; S['onl'] = 75.0; ln = 75.0
    put(a, 30, ln + 2, ln + 3, ln - 14, ln - 13, v=200, dl=-50)
    assert B.lines(S, 30) == (None, 75.0) and B.is_ignition(B.ignition_parts(a, 30, ln, -1))
    put(a, 31, 70, ln + 0.25, 69, 70)                                           # trades 1 tick through
    for j in range(32, 390): put(a, j, 70, 71, 69, 70)
    t = B.simulate(S); assert t[0]['dir'] == -1 and t[0]['entry'] == 75.0

if __name__ == '__main__':
    for k, f in list(globals().items()):
        if k.startswith('test_'): f(); print('ok', k)
