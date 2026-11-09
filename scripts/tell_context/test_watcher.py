"""Tests for watcher.py on synthetic bars with known states. Run: venv/bin/python scripts/tell_context/test_watcher.py"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import watcher as W


def session(rth_path, noise=1.0, n_on=60):
    """Overnight bars flat at 100 (high 101, low 99), then RTH bars following rth_path (closes), 20 s per bar, bar range 2*noise."""
    end = [W.RTH_OPEN - 10000 + 60 * i for i in range(n_on)] + [W.RTH_OPEN + 20 * (i + 1) for i in range(len(rth_path))]
    c = [100.0] * n_on + list(rth_path); h = [101.0] * n_on + [x + noise for x in rth_path]; l = [99.0] * n_on + [x - noise for x in rth_path]
    return np.array(end), np.array(h), np.array(l), np.array(c)


def test_unknown_before_60_minutes():
    r = W.run(*session([100.0] * 150)); assert set(r['shown']) == {'UNKNOWN'}, set(r['shown'])               # 150 bars x 20 s = 50 minutes


def test_balance_confirmed_on_a_range_with_denials():
    rng = np.random.default_rng(0); path = []
    for k in range(400): path.append(100 + 6 * np.sin(k / 8.0) + rng.normal(0, 0.3))                         # oscillation inside +/- 6, never beyond the overnight range by much
    path[5] = 106.5; path[6] = 93.5                                                                           # the day extremes are set early and then stand
    r = W.run(*session(path, noise=0.5)); assert r['current'] == 'BALANCE_CONFIRMED', r['current']                         # many approaches to both edges that were denied: a defended range
    assert 'DRIVE_UP' not in r['shown'] and 'DRIVE_DOWN' not in r['shown']


def test_drive_up_on_a_trend_beyond_the_overnight_high():
    path = [100 + 0.15 * k for k in range(400)]                                                              # a steady climb through 101: a new material extreme every few bars, no stall long enough to be a fight
    r = W.run(*session(path)); assert r['current'].startswith('DRIVE_UP'), (r['current'], r['n_changes'])      # a steady climb keeps making new extremes past the IB high


def test_drive_down_and_stall():
    path = [100 - 0.1 * k for k in range(300)] + [70.0] * 250                                                 # falls through 99 making lows, then stops printing new extremes
    r = W.run(*session(path)); assert any(x.startswith('DRIVE_DOWN') for x in r['shown']), set(r['shown'])
    assert not r['current'].startswith('DRIVE_DOWN'), r['current']                                                          # a stalled drive ends (no new extreme within 40 bars)


def test_hysteresis_one_bar_does_not_flip():
    path = [100.0] * 400; path[250] = 102.0                                                                   # a single close above the overnight high
    r = W.run(*session(path)); assert 'DRIVE_UP' not in r['shown'], set(r['shown'])


def test_denied_approach_counting():
    n = 80; H = np.full(n, 90.0); L = np.full(n, 88.0); C = np.full(n, 89.0); R = np.full(n, 2.0)
    H[0] = 110.0                                                                     # the day high is set at bar 0
    H[5] = 109.0; C[9] = 105.0                                                       # an approach within 1 r20 of the high, then a close 4 below (2 r20 retreat): DENIED
    H[20:50] = 109.5                                                                 # a long grind near the high with closes that never retreat 2 r20 from it: ONE episode, never denied
    C[20:50] = 109.0
    side = W._Side(1); side.reset(0)
    for t in range(1, n): side.update(t, H, L, C, R, 110.0)
    assert side.denials == 1, side.denials
    assert side.approaches == 2, side.approaches                                    # the first (denied) episode and the grind (one episode, not thirty)


def test_new_extreme_resets_the_count():
    side = W._Side(1); side.reset(0); side.approaches = 3; side.denials = 2; side.reset(7)
    assert (side.j, side.approaches, side.denials, side.ep) == (7, 0, 0, None)


def test_one_denial_is_not_balance_confirmed():
    path = [100.0 + 0.0 * k for k in range(400)]; path[5] = 104.0; path[6] = 96.0                       # both extremes set early, no later approach at all: no defended edge
    r = W.run(*session(path, noise=0.5)); assert 'BALANCE_CONFIRMED' not in r['shown'], set(r['shown'])


def test_fight_then_push_is_counted():
    path = [100.0] * 190 + [103.0 + 0.4 * k for k in range(8)] + [106.0] * 30 + [106.0 + 0.5 * k for k in range(30)] + [121.0] * 30    # after the IB: a push out, a 30-bar stall outside, then a new extreme
    e, h, l, c = session(path); res = W.run(e, h, l, c); ev = res['evidence'][-1]
    assert ev['up_fights'] >= 1, ev
    assert 'DRIVE_UP_BUILDING' in res['shown'], set(res['shown'])                                              # the drive that had a fight and a push is its own state


def test_past_the_overnight_high_but_not_past_the_ib_is_no_drive():
    path = [100 + 0.06 * k for k in range(180)] + [104.0 + 2.0 * np.sin(k / 6.0) for k in range(300)]          # the first hour rallies to about 111 (the IB high); afterwards price stays above the overnight high (101) but under the IB high
    r = W.run(*session(path)); assert not any(x.startswith('DRIVE') for x in r['shown']), set(r['shown'])


def test_causal():
    path = [100 + 0.15 * k for k in range(400)]; e, h, l, c = session(path)
    full = W.run(e, h, l, c)['shown']; cut = W.run(e[:300], h[:300], l[:300], c[:300])['shown']
    assert full[:300] == cut, 'a bar t must not depend on bars after t'


if __name__ == '__main__':
    for name, fn in list(globals().items()):
        if name.startswith('test_'): fn(); print('ok', name)
