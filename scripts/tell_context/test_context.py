"""Tests for context.py on synthetic 500-contract bars with known answers. Run: venv/bin/python scripts/tell_context/test_context.py"""
import os, sys, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import context as C

RTH = C.RTH_OPEN


def bar(end, lo, hi, close, vols):
    """vols: {price: volume}; a bar dict like barbuilder's (only the fields context.py reads)."""
    vap = collections.defaultdict(lambda: [0, 0.0, 0.0])
    for px, v in vols.items(): vap[px][0] += v
    return dict(end=end, h=hi, l=lo, c=close, vap=vap)


def day(profile, n_overnight=40, n_rth=200, rth_close=None):
    """Overnight bars (before 09:30) at 100, then RTH bars spreading `profile` ({price: weight}) evenly, 20 s per bar."""
    bars = [bar(RTH - 20000 + i * 60, 99.5, 100.5, 100.0, {100.0: 100}) for i in range(n_overnight)]
    prices = sorted(profile); w = np.array([profile[p] for p in prices], float); w = w / w.sum() * 500
    for i in range(n_rth):
        p = prices[i % len(prices)]; vols = {q: float(v) for q, v in zip(prices, w)}
        bars.append(bar(RTH + 60 + i * 20, p - 0.5, p + 0.5, p if rth_close is None else rth_close, vols))
    return bars


def test_value_area():
    P = {100.0: 1, 101.0: 2, 102.0: 10, 103.0: 2, 104.0: 1}
    poc, val, vah = C.value_area(P); assert poc == 102.0 and val <= 102.0 <= vah and vah - val <= 2.0, (poc, val, vah)


def test_labels_and_gate():
    prof = {p: (10 if 95 <= p <= 105 else 1) for p in range(90, 111)}          # fat middle 95-105, thin tails
    bars = day(prof, n_rth=240)                                                 # 80 min of RTH, past the 60-minute floor
    ctx_s = C.context_at_fire(bars, 104.8, -1); ctx_l = C.context_at_fire(bars, 104.8, 1)
    assert ctx_s['label'] == 'AGREES' and ctx_l['label'] == 'AGAINST', (ctx_s['label'], ctx_l['label'], ctx_s.get('vah'))     # top of value: shorts agree, longs are against
    low_s = C.context_at_fire(bars, 95.2, -1); low_l = C.context_at_fire(bars, 95.2, 1)
    assert low_s['label'] == 'AGAINST' and low_l['label'] == 'AGREES', (low_s['label'], low_l['label'])                          # bottom of value
    mid = C.context_at_fire(bars, 100.0, -1); assert mid['label'] == 'NEUTRAL', mid['label']
    young = C.context_at_fire(day(prof, n_rth=40), 104.8, -1); assert young['label'] == 'UNKNOWN' and 'younger' in young['reason']      # 13 RTH minutes
    g = C.range_gate(bars, -1); assert g['opposite_broken'] is False                                                             # no close beyond the boundary
    up = bars + [bar(RTH + 20000, 109.5, 111.5, 111.0, {111.0: 50})]; g2 = C.range_gate(up, -1)
    assert g2['up_broken'] and g2['opposite_broken'] and not g2['down_broken'], g2                                               # a close above the overnight/IB high: the long side is shut, a short is a fade of the break


def test_shape_letters():
    G = lambda lo, hi: [round(x, 2) for x in np.arange(lo, hi + 0.001, 0.25)]                                       # real prices are dense (a quarter point); the 40-bin profile needs that
    def letter(profile): return C.shape_letter(collections.defaultdict(float, profile), None)
    sym = {p: float(10 - abs(p - 100)) for p in G(90, 110)}; assert letter(sym)['letter'] == 'D', letter(sym)
    top = {p: (10.0 if p >= 100 else 1.0) for p in G(80, 120)}; assert letter(top)['letter'] == 'P', letter(top)               # fat upper half, long thin lower tail
    bot = {p: (10.0 if p <= 100 else 1.0) for p in G(80, 120)}; assert letter(bot)['letter'] == 'b', letter(bot)
    two = {p: 1.0 + 9.0 * np.exp(-((p - 90) / 3.0) ** 2) + 9.0 * np.exp(-((p - 110) / 3.0) ** 2) for p in G(80, 120)}; r = letter(two); assert r['multi_hump'] and r['humps'] >= 2, r


def test_floor_both_edges_and_long_side_gate():
    prof = {p: (10 if 95 <= p <= 105 else 1) for p in range(90, 111)}
    just_over = C.context_at_fire(day(prof, n_rth=178), 104.8, -1); just_under = C.context_at_fire(day(prof, n_rth=177), 104.8, -1)       # 20 s bars: 178 bars end exactly 60 min after the open, 177 end at 59.7
    assert just_over['label'] != 'UNKNOWN' and just_under['label'] == 'UNKNOWN', (just_over['label'], just_under['label'])
    narrow = {p: (10 if 99 <= p <= 101 else 1) for p in range(90, 111)}                                                                    # value area about 2-3 points wide: both edges are within 2 median ranges
    bars = day(narrow, n_rth=240)
    n = C.context_at_fire([dict(b, h=b['h'] + 5, l=b['l'] - 5) if b['end'] >= RTH else b for b in bars], 100.0, -1)
    assert n['label'] == 'NEUTRAL' and n['near_edge'] == 'BOTH' and 'narrower' in n['reason'], n
    down = bars + [bar(RTH + 20000, 88.0, 90.0, 89.0, {89.0: 50})]; g = C.range_gate(down, 1)
    assert g['down_broken'] and g['opposite_broken'], g                                                                                       # a close below the lower boundary shuts the short side; a long is then a fade of the break


def test_relative_lvn():
    P = {float(p): 3.0 + 10 * np.exp(-((p - 90) / 5.0) ** 2) + 10 * np.exp(-((p - 110) / 5.0) ** 2) for p in range(80, 121)}      # two humps with a trough inside value at 100
    prices = sorted(P); w = np.array([P[p] for p in prices]); w = w / w.sum() * 500
    bars = [bar(RTH - 20000 + i * 60, 99.5, 100.5, 100.0, {100.0: 1}) for i in range(40)]
    bars += [bar(RTH + 60 + i * 20, 97.5, 102.5, 100.0, {q: float(v) for q, v in zip(prices, w)}) for i in range(240)]   # 5-point bars: bin = 5 / 5 = 1 point
    lv = C.relative_lvns(bars, 110.0, -1, 5.0)
    assert lv and abs(lv[0]['price'] - 100) < 6 and lv[0]['side'] == 'AHEAD' and lv[0]['depth'] < 0.7, lv[:2]


if __name__ == '__main__':
    for name, fn in list(globals().items()):
        if name.startswith('test_'): fn(); print('ok', name)
