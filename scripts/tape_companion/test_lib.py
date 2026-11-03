"""hand-traced tests for lib.py (synthetic days). run: python3 -I test_lib.py"""
import sys; sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/tape_companion')
import numpy as np, lib
N = lib.N
def day(path, vol=10.0, buy_frac=0.5):
    last = np.array(path, float); assert len(last) == N
    return dict(buy=np.full(N, vol * buy_frac), sell=np.full(N, vol * (1 - buy_frac)), last=last, low=last - 0.25, high=last + 0.25)
base = np.full(N, 100.0)
# T1: price walks down from 110 to the level at 100 (approach from above), dwells at 100.3 for 120s, then bounces up 12 pts: HOLD (scale 10)
p = base.copy(); p[:1000] = 110.0
p[1000:1300] = np.linspace(110, 100.3, 300); p[1300:1500] = 100.3; p[1500:1800] = np.linspace(100.3, 113, 300); p[1800:] = 113
A = day(p); ev = lib.find_touches(A, {'ONH': 100.0}, scale=10.0, vol_rate=np.full(7, 10.0))
assert len(ev) == 1 and ev[0]['side'] == 1, ev
e = ev[0]; st, f = lib.gate_and_features(A, e, 10.0, np.full(7, 10.0)); assert st == 'OK', st
y = lib.label_event(A, e, 10.0); assert y == 1.0, y
assert abs(f['vol_ratio'] - np.log(1.01)) < 1e-9, f['vol_ratio']
# T2: same approach, but slices through to 85 after the dwell: SLICE (0)
p2 = p.copy(); p2[1500:1800] = np.linspace(100.3, 85, 300); p2[1800:] = 85
A2 = day(p2); e2 = lib.find_touches(A2, {'ONH': 100.0}, 10.0, np.full(7, 10.0))[0]; st, f = lib.gate_and_features(A2, e2, 10.0, np.full(7, 10.0)); assert st == 'OK'
assert lib.label_event(A2, e2, 10.0) == 0.0
# T3: fast slice before the decision second -> THROUGH (excluded, counted)
p3 = base.copy(); p3[:1000] = 110.0; p3[1000:1030] = np.linspace(110, 80, 30); p3[1030:] = 80
A3 = day(p3); e3 = lib.find_touches(A3, {'ONH': 100.0}, 10.0, np.full(7, 10.0))[0]; assert lib.gate_and_features(A3, e3, 10.0, np.full(7, 10.0))[0] == 'THROUGH'
# T4: approach from below flips the sign: resistance at 100, price rises from 90; bounce = down
p4 = base.copy(); p4[:1000] = 90.0; p4[1000:1300] = np.linspace(90, 99.7, 300); p4[1300:1500] = 99.7; p4[1500:1800] = np.linspace(99.7, 87, 300); p4[1800:] = 87
A4 = day(p4); e4 = lib.find_touches(A4, {'ONH': 100.0}, 10.0, np.full(7, 10.0))[0]; assert e4['side'] == -1; assert lib.gate_and_features(A4, e4, 10.0, np.full(7, 10.0))[0] == 'OK'; assert lib.label_event(A4, e4, 10.0) == 1.0
# T5: aligned delta: buy-heavy tape at support (side +1) is positive (push my way); same tape at resistance negative
Ab = day(p, buy_frac=0.8); eb = lib.find_touches(Ab, {'ONH': 100.0}, 10.0, np.full(7, 10.0))[0]; fb = lib.gate_and_features(Ab, eb, 10.0, np.full(7, 10.0))[1]; assert abs(fb['delta30'] - 0.6) < 1e-9, fb['delta30']
Ar = day(p4, buy_frac=0.8); er = lib.find_touches(Ar, {'ONH': 100.0}, 10.0, np.full(7, 10.0))[0]; fr = lib.gate_and_features(Ar, er, 10.0, np.full(7, 10.0))[1]; assert abs(fr['delta30'] + 0.6) < 1e-9
# T6: no re-trigger while it hovers at the level (no arming gap), and a second episode only after moving a full scale away and returning
p6 = p.copy(); p6[1800:2500] = 113; p6[2500:2800] = np.linspace(113, 100.2, 300); p6[2800:] = 100.2
A6 = day(p6); ev6 = lib.find_touches(A6, {'ONH': 100.0}, 10.0, np.full(7, 10.0)); assert len(ev6) == 2 and ev6[1]['touch_no'] == 2, [(x['i'], x['touch_no']) for x in ev6]
# T7: a level that does not exist yet (IB, forms after 3600s) cannot be touched earlier
p7 = base.copy(); p7[:1000] = 110.0; p7[1000:1300] = np.linspace(110, 100.3, 300); p7[1300:] = 100.3
A7 = day(p7); assert lib.find_touches(A7, {'IB_HIGH': 100.0}, 10.0, np.full(7, 10.0)) == []
# T8: two levels 2 pts apart collapse into ONE event
p8 = p.copy(); p8[:1000] = 115.0; p8[1000:1300] = np.linspace(115, 100.3, 300); A8 = day(p8); ev8 = lib.find_touches(A8, {'ONH': 100.0, 'ONL': 102.0}, 10.0, np.full(7, 10.0)); assert len(ev8) == 1 and len(ev8[0]['members']) == 2
print('all lib tests pass')
# ---- Globex session ----
G = lib.GLOBEX; NG = G.n
def gday(path, vol=10.0):
    last = np.array(path, float); assert len(last) == NG
    return dict(buy=np.full(NG, vol / 2), sell=np.full(NG, vol / 2), last=last, low=last - 0.25, high=last + 0.25)
gb = np.full(NG, 100.0); gp = gb.copy(); gp[:3000] = 110.0; gp[3000:3300] = np.linspace(110, 100.3, 300); gp[3300:3500] = 100.3; gp[3500:3800] = np.linspace(100.3, 113, 300); gp[3800:] = 113
AG = gday(gp); vrG = np.full(24, 10.0)
evg = lib.find_touches(AG, {'PM_POC': 100.0}, 10.0, vrG, sess=G); assert len(evg) == 1 and evg[0]['side'] == 1, evg
st, f = lib.gate_and_features(AG, evg[0], 10.0, vrG, sess=G); assert st == 'OK' and f['hour'] == (64800 + evg[0]['i'] + 60) // 3600 % 24, (st, f and f['hour'])
assert lib.label_event(AG, evg[0], 10.0, sess=G) == 1.0
# levels that do not exist at the 18:00 open are excluded (final ONH/ONL, OR/IB, DAILY_OPEN), a same-day-future level cannot create a Globex event
assert lib.find_touches(AG, {'ONH': 100.0, 'IB_HIGH': 100.0, 'DAILY_OPEN': 100.0, 'OR5_HIGH': 100.0}, 10.0, vrG, sess=G) == []
# the 18:00-18:30 window is a no-contact zone (cv-056): the same approach finishing before index 1800 produces no event
gq = gb.copy(); gq[:300] = 110.0; gq[300:600] = np.linspace(110, 100.3, 300); gq[600:] = 100.3
assert lib.find_touches(gday(gq), {'PM_POC': 100.0}, 10.0, vrG, sess=G) == []
assert lib.hour_rates(AG, G).shape == (24,) and abs(lib.hour_rates(AG, G)[0] - 10.0) < 1e-9 and lib.hour_rates(AG, G)[15] == 10.0 and lib.hour_rates(AG, G)[16] == 0.0 and lib.hour_rates(AG, G)[23] == 0.0
print('globex lib tests pass')
