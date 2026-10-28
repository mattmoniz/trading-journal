"""Synthetic-session tests for the Phase 3 C engine. No DB, no real data. Run: ../../venv/bin/python phase3_c_test.py"""
import numpy as np
import pandas as pd
import phase3_c as P

IDX = pd.date_range('2026-01-05 09:30', '2026-01-05 15:59', freq='1min')


def session(over=None, ib_hi=100.0, ib_lo=80.0):
    o = np.full(len(IDX), 90.0); h = o + 0.5; l = o - 0.5; c = o.copy(); v = np.full(len(IDX), 100.0)
    h[0], l[0] = ib_hi, ib_lo                     # IB extremes on the first bar
    df = pd.DataFrame({'Open': o, 'High': h, 'Low': l, 'Close': c, 'Volume': v}, index=IDX)
    for hhmm, vals in (over or {}).items():
        df.loc[pd.Timestamp(f'2026-01-05 {hhmm}')] = vals
    return df


def run(over, **kw):
    tr, _ = P.trade_session(session(over, **kw), '2026-01-05')
    return tr


# O,H,L,C,V per bar. Short reversal: low-volume close above IB high at 10:40, reclaim 10:41, entry 10:42 open.
BASE = {'10:40': (100.5, 102.0, 100.0, 101.0, 50.0), '10:41': (101.0, 101.2, 98.0, 99.0, 100.0),
        '10:42': (98.5, 98.8, 97.5, 98.0, 100.0)}


def test_short_hits_target():
    ov = dict(BASE); ov['10:50'] = (90, 90.5, 79.0, 85, 100)        # trades through 80
    t = run(ov)
    assert len(t) == 1 and t[0]['dir'] == -1 and t[0]['reason'] == 'TARGET', t
    assert abs(t[0]['entry'] - (98.5 - 0.25)) < 1e-9 and t[0]['target'] == 80.0
    assert abs(t[0]['exit'] - (80.0 + 0.25)) < 1e-9                  # buy back at target + 1 tick
    assert t[0]['stop'] >= 102.0                                      # sweep high + 0.75*ATR, rounded out
    print('ok short target')


def test_entry_is_next_bar_not_reclaim_bar():
    t = run(dict(BASE, **{'10:50': (90, 90.5, 79.0, 85, 100)}))
    assert t[0]['open_raw'] == 98.5 and t[0]['entry_idx'] == list(IDX).index(pd.Timestamp('2026-01-05 10:42'))
    print('ok no-lookahead entry bar')


def test_gap_through_stop_fills_at_open():
    ov = dict(BASE); ov['10:55'] = (110.0, 111.0, 109.0, 110.0, 100)   # opens far above any stop
    t = run(ov)
    assert t[0]['reason'] == 'STOP' and abs(t[0]['exit'] - (110.0 + 0.25)) < 1e-9, t
    print('ok gap-through-stop fills at open, not at the stop price')


def test_same_bar_stop_before_target():
    ov = dict(BASE); ov['10:50'] = (90, 120.0, 70.0, 85, 100)          # one bar reaches both
    t = run(ov)
    assert t[0]['reason'] == 'STOP', t
    print('ok same-bar stop first')


def test_high_volume_breakout_skipped():
    ov = dict(BASE); ov['10:40'] = (100.5, 102.0, 100.0, 101.0, 500.0)
    assert run(dict(ov, **{'10:50': (90, 90.5, 79.0, 85, 100)})) == []
    print('ok high-volume breakout skipped')


def test_late_reclaim_skipped():
    ov = {'10:40': (100.5, 102.0, 100.0, 101.0, 50.0)}
    for m in range(41, 47):                                            # 6 bars outside, then reclaim on the 7th
        ov[f'10:{m}'] = (101.0, 101.5, 100.5, 101.0, 100.0)
    ov['10:47'] = (101.0, 101.2, 98.0, 99.0, 100.0)
    ov['10:55'] = (90, 90.5, 79.0, 85, 100)
    assert run(ov) == []
    print('ok reclaim after >5 bars skipped')


def test_rr_below_one_skipped():
    ov = {'10:40': (100.5, 102.0, 100.0, 101.0, 50.0), '10:41': (101.0, 101.2, 80.5, 80.6, 100.0),
          '10:42': (80.3, 80.4, 79.9, 80.0, 100.0)}
    assert run(ov) == []
    print('ok R:R < 1 / invalid geometry skipped')


def test_flatten():
    ov = dict(BASE)                                                    # drifts, never reaches stop or target
    t = run(ov)
    assert t[0]['reason'] == 'FLATTEN' and abs(t[0]['exit'] - (90.0 + 0.25)) < 1e-9, t   # 15:58 open=90, short pays +1 tick
    print('ok flatten at 15:58 open')


def test_long_mirror():
    ov = {'10:40': (79.5, 80.0, 78.0, 79.0, 50.0), '10:41': (79.0, 82.0, 78.8, 81.0, 100.0), '10:42': (81.5, 82.5, 81.0, 82.0, 100.0),
          '10:50': (90, 100.5, 89.5, 95, 100)}
    t = run(ov)
    assert len(t) == 1 and t[0]['dir'] == 1 and t[0]['reason'] == 'TARGET', t
    assert abs(t[0]['entry'] - 81.75) < 1e-9 and abs(t[0]['exit'] - (100.0 - 0.25)) < 1e-9 and t[0]['stop'] <= 78.0
    print('ok long mirror')


def test_max_one_per_direction():
    ov = dict(BASE); ov['10:50'] = (90, 90.5, 79.0, 85, 100)
    ov['11:10'] = (100.5, 102.0, 100.0, 101.0, 50.0); ov['11:11'] = (101.0, 101.2, 98.0, 99.0, 100.0); ov['11:12'] = (98.5, 98.8, 97.5, 98.0, 100.0)
    ov['11:20'] = (90, 90.5, 79.0, 85, 100)
    assert len(run(ov)) == 1
    print('ok max 1 per direction')


if __name__ == '__main__':
    for f in [v for k, v in sorted(globals().items()) if k.startswith('test_')]:
        f()
    print('ALL PHASE 3 ENGINE TESTS PASSED')
