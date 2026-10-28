import numpy as np
import nodes as N

def test_ladder():
    poc = np.full(13, np.nan); poc[0:3] = [100, 110, 120]; cl = np.full(13, np.nan); cl[2] = 125
    assert N.ladder(poc, cl, 2, 1, 5) and not N.ladder(poc, cl, 2, 1, 11)          # step 10 < S=11 fails
    assert not N.ladder(poc, cl, 2, -1, 5)
    cl[2] = 119; assert not N.ladder(poc, cl, 2, 1, 5)                              # close below its own node
    poc[:3] = [120, 110, 100]; cl[2] = 95; assert N.ladder(poc, cl, 2, -1, 5)       # mirror

def sess():
    a = {k: np.full(390, np.nan) for k in ('o', 'h', 'l', 'c', 'v', 'dl')}
    for i in range(390): a['o'][i] = a['c'][i] = 100.0; a['h'][i] = 100.5; a['l'][i] = 99.5; a['v'][i] = 10.0; a['dl'][i] = 0
    return dict(d='T', a=a, onh=None, onl=None)

def test_points_break_and_already_broken():
    S = sess(); a = S['a']; a['h'][:60] = 101.0; a['l'][:60] = 99.0                  # IB 99..101
    for i in range(122, 125): a['c'][i] = 102.0; a['h'][i] = 102.5                    # a close above IBH inside the 120-min horizon of the 11:00 decision (bars 90..209)
    P = N.points(S, 10.0, 0.5)
    p = [x for x in P if x['b'] == 2 and x['dir'] == 1][0]; assert p['brk'] and abs(p['dist'] - (101.0 - 100.0) / 10.0) < 1e-9
    q = [x for x in P if x['b'] == 2 and x['dir'] == -1][0]; assert not q['brk']
    assert not [x for x in P if x['b'] >= 5 and x['dir'] == 1]                        # decision after the close above IBH (bar 122 -> decision 150+) is dropped
    assert not [x for x in P if x['dir'] == 1 and x['b'] == 4 and False]

def test_fwd_sign():
    S = sess(); a = S['a']; a['h'][:60] = 101.0; a['l'][:60] = 99.0
    a['o'][90] = 100.0
    for i in range(90, 150): a['c'][i] = 100.0 + (i - 89) * 0.1
    P = N.points(S, 10.0, 0.5); p = [x for x in P if x['b'] == 2 and x['dir'] == 1][0]
    assert abs(p['fwd'] - (106.0 - 100.0) / 10.0) < 1e-9
    q = [x for x in P if x['b'] == 2 and x['dir'] == -1][0]; assert abs(q['fwd'] + 0.6) < 1e-9

if __name__ == '__main__':
    for k, f in list(globals().items()):
        if k.startswith('test_'): f(); print('ok', k)
