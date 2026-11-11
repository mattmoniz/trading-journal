"""Unit tests for scripts/lib/pass_race.py. Run:  ulimit -v 4000000; ./venv/bin/python3 -I scripts/lib/test_pass_race.py
Synthetic data only: no database, no real trades, no outcome label."""
import math, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pass_race as PR

ok = True
def chk(name, cond, got=''):
    global ok; ok &= bool(cond); print(('PASS ' if cond else 'FAIL ') + name, '' if cond else got)

# (a) zero-mean symmetric daily P&L. With small daily steps the end-of-day trailing floor behaves like a continuous one, where the
#     chance of reaching +3,000 before a 2,000 drop from the running peak is exp(-3000/2000) = 22.3 percent.
theory = math.exp(-3000 / 2000)
small = np.array([100.0, -100.0])
r = PR.race(small, n_paths=20000, horizon_days=4000, block_days=1, floor=2000.0, target=3000.0, seed=1)
chk(f'a1 symmetric +/-100 days, floor trails: P(pass) {r["p_pass"]:.4f} within 2 points of exp(-1.5) = {theory:.4f}; unresolved {r["p_unresolved"]:.4f} (must be < 0.03)',
    abs(r['p_pass'] - theory) < 0.02 and r['p_unresolved'] < 0.03, r)
print(f'     a1 detail: P(bust) {r["p_bust"]:.4f}, median days to finish {r["median_days_to_finish"]}')
# the same shape under the end-of-day rule with a realistic coarse day (normal, SD 340; memory note: about 26 percent): REPORTED, loose sanity band
rng = np.random.default_rng(7); coarse = rng.normal(0.0, 340.0, 2000); coarse -= coarse.mean()
r2 = PR.race(coarse, n_paths=20000, horizon_days=2500, block_days=1, floor=2000.0, target=3000.0, seed=2)
print(f'     a2 REPORT end-of-day rule, zero-mean normal days SD 340: P(pass) {r2["p_pass"]:.4f} (continuous-floor theory {theory:.4f}), P(bust) {r2["p_bust"]:.4f}, unresolved {r2["p_unresolved"]:.4f}')
chk('a2 coarse days pass a little more often than the continuous theory (an end-of-day floor cannot see intraday dips) and stay in 22-32 percent', theory <= r2['p_pass'] <= 0.32, r2)

# (b) all-positive days always pass, all-negative days always bust
rp = PR.race(np.array([50.0, 80.0, 120.0]), n_paths=500, horizon_days=100, block_days=3, floor=2000.0, target=3000.0, seed=3)
chk('b1 all-positive days: P(pass) = 1', rp['p_pass'] == 1.0 and rp['p_bust'] == 0.0, rp)
rn = PR.race(np.array([-50.0, -80.0, -120.0]), n_paths=500, horizon_days=100, block_days=3, floor=2000.0, target=3000.0, seed=3)
chk('b2 all-negative days: P(bust) = 1', rn['p_bust'] == 1.0 and rn['p_pass'] == 0.0, rn)
rz = PR.race(np.array([0.0, 0.0]), n_paths=100, horizon_days=50, block_days=1, floor=2000.0, target=3000.0, seed=3)
chk('b3 flat days: everything unresolved', rz['p_unresolved'] == 1.0 and rz['median_days_to_finish'] is None, rz)
# exact floor behaviour: +1,000 per day for 2 days then -1,000 per day: the peak is +2,000 after day 2, the floor 0; day 4 balance 0 is a bust
seq = np.array([1000.0, 1000.0, -1000.0, -1000.0])
d1 = PR.race(seq, n_paths=1, horizon_days=4, block_days=4, floor=2000.0, target=99999.0, seed=0)
bal = np.cumsum(np.array([[1000.0, 1000.0, -1000.0, -1000.0]]), axis=1); tp, tf = PR._walk(bal, 2000.0, 99999.0)
chk('b4 the floor follows the end-of-day peak: balances 1000, 2000, 1000, 0 with peak 2000 -> bust on day 4 (index 3)', int(tf[0]) == 3 and int(tp[0]) == PR.NEVER, (tp, tf))
# a block of 3 consecutive days stays consecutive: days [0,1,2] only (nd = 3 -> wrap), so 100,100,100 sums repeat deterministically
rb = PR.race(np.array([100.0, 100.0, 100.0]), n_paths=10, horizon_days=31, block_days=3, floor=2000.0, target=3000.0, seed=5)
chk('b5 block bootstrap on constant +100 days passes on day 30 exactly', rb['p_pass'] == 1.0 and rb['median_days_to_finish'] == 30.0, rb)

# (c) each rule builder skips exactly the hand-built trades it should
def T(date, time, direction, risk, net, session='RTH', stream='tell'):
    return dict(date=date, entry_time=time, direction=direction, risk_dollars=risk, net=net, session=session, stream=stream)
# risk cap: cushion starts at 2,000 (balance 0, floor -2,000). Cap fraction 0.05 -> 100 dollars.
trades = [T('2026-01-05', '10:00', 'L', 80.0, 30.0), T('2026-01-05', '10:30', 'L', 120.0, 40.0), T('2026-01-05', '11:00', 'S', 100.0, -10.0)]
got = PR.apply_rules(trades, [PR.risk_cap(0.05)])
chk('c1 risk_cap(0.05) at cushion 2,000: keeps risk 80 and exactly 100 (boundary kept), skips risk 120', [t['entry_time'] for t in got] == ['10:00', '11:00'], got)
# the cushion shrinks after a loss: balance -1,500 -> cushion 500 -> cap 0.2 = 100: a risk of 150 is skipped, 100 is taken
loss_then = [T('2026-01-05', '10:00', 'L', 500.0, -1500.0), T('2026-01-06', '10:00', 'L', 150.0, 10.0), T('2026-01-06', '11:00', 'L', 100.0, 10.0)]
got = PR.apply_rules(loss_then, [PR.risk_cap(0.2)])
chk('c2 risk_cap(0.2): first trade (risk 500 > 0.2 x 2000 = 400) skipped, so the cushion stays 2,000 and BOTH later trades are taken', [t['entry_time'] for t in got] == ['10:00', '11:00'] and got[0]['date'] == '2026-01-06', got)
loss_taken = [T('2026-01-05', '10:00', 'L', 300.0, -1500.0), T('2026-01-06', '10:00', 'L', 150.0, 10.0), T('2026-01-06', '11:00', 'L', 100.0, 10.0)]
got = PR.apply_rules(loss_taken, [PR.risk_cap(0.2)])
chk('c3 risk_cap(0.2): first trade taken (300 <= 400), loses 1,500; cushion is then 500, cap 100: risk 150 skipped, risk 100 taken', [(t['date'], t['entry_time']) for t in got] == [('2026-01-05', '10:00'), ('2026-01-06', '11:00')], got)
broke = [T('2026-01-05', '10:00', 'L', 100.0, -2100.0), T('2026-01-06', '10:00', 'L', 1.0, 5.0)]
chk('c4 risk_cap skips everything once the cushion is zero or below', len(PR.apply_rules(broke, [PR.risk_cap(0.5)])) == 1)
# same-direction lockout
lock = [T('2026-01-05', '10:00', 'L', 50.0, -60.0),                 # full stop (net <= -risk)
        T('2026-01-05', '10:30', 'L', 50.0, 20.0),                  # same stream/day/direction after a full stop -> skipped
        T('2026-01-05', '10:45', 'S', 50.0, 20.0),                  # other direction -> taken
        T('2026-01-05', '11:00', 'L', 50.0, 20.0, stream='vac'),    # other stream -> taken
        T('2026-01-06', '10:00', 'L', 50.0, 20.0)]                  # next day -> taken
got = PR.apply_rules(lock, [PR.same_direction_lockout()])
chk('c5 same_direction_lockout skips only the long that follows a full-stopped long of the same stream and day', [t['entry_time'] for t in got] == ['10:00', '10:45', '11:00', '10:00'] and len(got) == 4, got)
lock2 = [T('2026-01-05', '10:00', 'L', 50.0, -20.0), T('2026-01-05', '10:30', 'L', 50.0, 20.0)]
chk('c6 a losing trade that was NOT a full stop (net -20, risk 50) does not lock', len(PR.apply_rules(lock2, [PR.same_direction_lockout()])) == 2)
lock3 = [T('2026-01-05', '10:00', 'L', 50.0, -60.0), T('2026-01-05', '10:30', 'L', 50.0, 20.0), T('2026-01-05', '10:45', 'L', 50.0, 20.0)]
got = PR.apply_rules(lock3, [PR.same_direction_lockout()])
chk('c7 a SKIPPED trade does not count as "previous taken": 10:00 stopped, 10:30 skipped, 10:45 is still locked by the 10:00 stop', [t['entry_time'] for t in got] == ['10:00'], got)
lock4 = [dict(T('2026-01-05', '10:00', 'L', 50.0, -20.0), full_stop=True), T('2026-01-05', '10:30', 'L', 50.0, 20.0)]
chk('c8 an explicit full_stop field overrides the net <= -risk inference', len(PR.apply_rules(lock4, [PR.same_direction_lockout()])) == 1)
# session off
mix = [T('2026-01-05', '03:00', 'L', 50.0, 5.0, session='GLOBEX'), T('2026-01-05', '10:00', 'L', 50.0, 5.0, session='RTH')]
got = PR.apply_rules(mix, [PR.session_off('GLOBEX')])
chk('c9 session_off("GLOBEX") skips the Globex trade and keeps the RTH one', [t['session'] for t in got] == ['RTH'], got)
got = PR.apply_rules(mix, [PR.session_off('GLOBEX'), PR.risk_cap(0.01)])
chk('c10 rules combine with AND: session_off + risk_cap(0.01) (cap 20): the RTH trade of risk 50 is skipped too', got == [], got)
# time order is by (date, entry_time), not by input order, and the result keeps the input order
shuffled = [T('2026-01-05', '10:30', 'L', 50.0, 20.0), T('2026-01-05', '10:00', 'L', 50.0, -60.0)]
got = PR.apply_rules(shuffled, [PR.same_direction_lockout()])
chk('c11 evaluated in time order even when the input is not: the 10:00 full stop locks the 10:30 trade; result keeps input order', [t['entry_time'] for t in got] == ['10:00'], got)

# (d) no rules: the input comes back unchanged (equal list, equal order, same objects)
src = [T('2026-01-06', '10:00', 'L', 50.0, 1.0), T('2026-01-05', '10:00', 'S', 40.0, -3.0)]
out = PR.apply_rules(src, [])
chk('d1 apply_rules with no rules returns the input unchanged', out == src and all(a is b for a, b in zip(out, src)) and out is not src)
copy = [dict(t) for t in src]; PR.apply_rules(src, [PR.risk_cap(0.5)])
chk('d2 apply_rules does not modify the trade dicts', copy == src)
chk('d3 rule builders have no default parameter values', all(f.__defaults__ is None for f in (PR.risk_cap, PR.session_off, PR.same_direction_lockout)))

print('ALL PASS' if ok else 'SOME FAILED')
sys.exit(0 if ok else 1)
