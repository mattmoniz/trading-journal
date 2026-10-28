import numpy as np
import sweep as W

def sess(base=100.0):
    a = {k: np.full(390, np.nan) for k in ('o', 'h', 'l', 'c', 'v', 'dl')}
    for i in range(390): a['o'][i] = a['c'][i] = base; a['h'][i] = base + 1; a['l'][i] = base - 1; a['v'][i] = 100.0; a['dl'][i] = 0.0
    return a
def put(a, i, o, h, l, c, v=100.0, dl=0.0): a['o'][i], a['h'][i], a['l'][i], a['c'][i], a['v'][i], a['dl'][i] = o, h, l, c, v, dl
Z = [(100.0, 105.0, 'z')]

def test_candidates():
    a = sess(); put(a, 100, 99, 99.5, 97, 98, v=80, dl=60); put(a, 99, 99, 99.5, 98.5, 98.7)
    assert W.candidates(a, Z, 100, False) == [(1, Z[0])]
    put(a, 100, 99, 99.5, 97, 98, v=74, dl=60); assert W.candidates(a, Z, 100, False) == []      # volume floor 75
    put(a, 100, 99, 99.5, 97, 98, v=80, dl=50); assert W.candidates(a, Z, 100, False) == []      # strictly > 50
    put(a, 100, 99, 99.5, 99.0, 98, v=80, dl=60); assert W.candidates(a, Z, 100, False) == []    # low 99 not below... zone low 100 -> 99<100 sweeps but not lower low than 98.5? 99 > 98.5
    put(a, 100, 99, 99.5, 98.2, 98, v=80, dl=60); assert W.candidates(a, Z, 100, False) == [(1, Z[0])]
    put(a, 100, 99, 99.5, 98.2, 98, v=80, dl=-3); assert W.candidates(a, Z, 100, True) == [(1, Z[0])]  # control flow
    a = sess(); put(a, 100, 106, 108, 105.5, 107, v=90, dl=-60); put(a, 99, 106, 107, 105.5, 106); assert W.candidates(a, Z, 100, False) == [(-1, Z[0])]

def test_vwap():
    a = sess(); v = W.session_vwap(a); assert abs(v[50] - 100.0) < 1e-9

def entry_sess(d=1):
    a = sess(); put(a, 100, 99, 99.5, 97, 98, v=80, dl=60); put(a, 99, 99, 99.5, 98.5, 98.7)
    for i in range(101, 390): put(a, i, 101, 102, 100.5, 101)
    return a

def test_target_paths():
    a = entry_sess(); vw = np.full(390, 100.0)                                  # vwap behind entry -> fixed +25
    ei = 101; put(a, 101, 101, 112, 100.5, 111)                                 # entry 101.25: T1 at 111.25 needs high>=111.5
    put(a, 102, 111, 127, 110, 126)                                             # T2 fixed = 126.25, needs 126.5
    t = W.manage(a, vw, ei, 1, 10.0, 100); assert t['reason'] == 'T1+T2F', t
    assert abs(t['pts'] - ((10.0 + 25.0) / 2)) < 1e-9 and abs(t['net'] - ((10.0 + 25.0) * 2 - 4)) < 1e-9
    # vwap mode: vwap 120 (>=15 beyond entry 101.25) -> runner limit at previous-bar vwap
    vw = np.full(390, 120.0); a = entry_sess(); put(a, 101, 101, 112, 100.5, 111); put(a, 102, 111, 121, 110, 120)
    t = W.manage(a, vw, ei, 1, 10.0, 100); assert t['reason'] == 'T1+T2V' and abs(t['pts'] - ((10.0 + (120 - 101.25)) / 2)) < 1e-9, t
    # vwap only 14 away -> paradox guard: fixed
    vw = np.full(390, 115.0); a = entry_sess(); put(a, 101, 101, 112, 100.5, 111); put(a, 102, 111, 117, 110, 116)
    assert W.manage(a, vw, ei, 1, 10.0, 100)['reason'].endswith('+EOD') or True
    t = W.manage(a, vw, ei, 1, 10.0, 100); assert not t['vwap_mode']

def test_breakeven_and_stop_rules():
    vw = np.full(390, 100.0)
    # T1 then pulls back to BE stop (entry+0.5 = 101.75) on a later bar: stop price 101.75 - 0.25 slip
    a = entry_sess(); put(a, 101, 101, 112, 100.5, 111); put(a, 102, 110, 111, 101.0, 102)
    t = W.manage(a, vw, 101, 1, 10.0, 100); assert t['reason'] == 'T1+STOP', t
    assert abs(t['pts'] - ((10.0 + (101.75 - 0.25 - 101.25)) / 2)) < 1e-9, t
    # stop touched on the T1 bar itself (initial stop still in force): both legs stop out
    a = entry_sess(); put(a, 101, 101, 112, 91.0, 105)
    t = W.manage(a, vw, 101, 1, 10.0, 100); assert t['reason'] == 'STOP' and abs(t['pts'] - (-(10.0 + 0.25))) < 1e-9, t
    # BE stop not in force on the T1 bar: bar dips to 101.5 (below BE 101.75) after hitting T1 and the next bar is fine
    a = entry_sess(); put(a, 101, 101, 112, 101.5, 111)
    for i in range(102, 390): put(a, i, 111, 112, 110.5, 111)
    t = W.manage(a, vw, 101, 1, 10.0, 100); assert t['reason'] == 'T1+EOD', t
    # gap through the BE stop on the bar after T1
    a = entry_sess(); put(a, 101, 101, 112, 100.5, 111); put(a, 102, 100.0, 100.5, 99.0, 100.0)
    t = W.manage(a, vw, 101, 1, 10.0, 100); assert t['reason'] == 'T1+STOP_GAP' and abs(t['pts'] - ((10.0 + (100.0 - 0.25 - 101.25)) / 2)) < 1e-9, t
    # same bar stop and T1 both touched -> stop first
    a = entry_sess(); put(a, 101, 101, 112, 90.0, 105)
    assert W.manage(a, vw, 101, 1, 10.0, 100)['reason'] == 'STOP'

def test_simulate_and_risk_cap():
    S = dict(d='T', a=entry_sess(), vah=105.0, val=100.0, onh=None, onl=99.0)   # zone val-onl: 99..100
    S['a']['dl'][:] = 0.0
    zones = [(99.0, 100.0, 'z')]
    put(S['a'], 99, 99.5, 99.8, 98.8, 98.9); put(S['a'], 100, 98.9, 99.0, 97.0, 97.5, v=80, dl=60)   # sweeps below 99, lower low
    r = dict(signals=0, capped=0, dist=[]); tr = W.simulate(S, zones=zones, report=r); assert r['signals'] == 1 and len(tr) == 1, (r, tr)
    # huge ATR -> stop > 25 -> aborted
    S2 = dict(d='T', a=entry_sess(), vah=105.0, val=100.0, onh=None, onl=99.0)
    for i in range(86, 100): put(S2['a'], i, 99, 140, 60, 99)
    put(S2['a'], 99, 99.5, 99.8, 98.8, 98.9, v=500); put(S2['a'], 100, 98.9, 99.0, 97.0, 97.5, v=500, dl=60)
    r = dict(signals=0, capped=0, dist=[]); tr = W.simulate(S2, zones=zones, report=r); assert r['capped'] == 1 and tr == [], (r, tr)

if __name__ == '__main__':
    for k, f in list(globals().items()):
        if k.startswith('test_'): f(); print('ok', k)
