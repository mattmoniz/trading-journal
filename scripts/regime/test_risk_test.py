"""Unit tests of the risk simulator's account logic (prereg section 4). Run: ./venv/bin/python3 scripts/regime/test_risk_test.py"""
import numpy as np, sys
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/regime')
import risk_sim as R

def one(adv, fin, arm='C0', H=1, busy=False, bal0=None, best0=None):
    ND = adv.shape[0]; idx = np.arange(H)[None, :] % ND
    s, w, b = R.run_paths(adv, fin, np.array([busy] * ND), idx, np.zeros((1, H, R.K), int), arm, bal0, best0); return s[0], w[0], b[0]
Z = lambda nd=1: np.zeros((nd, R.K, 2))
def t_breach_strict():
    a = Z(); a[0, 0, 0] = 1000.5; assert one(a, Z())[0] == 2, 'a dip to -2001 must breach'
    a[0, 0, 0] = 1000.0; assert one(a, Z())[0] != 2, 'a dip to exactly -2000 is not below the floor'
def t_pass():
    f = Z(); f[0, 0, 0] = 1600.0; s, w, b = one(Z(), f); assert s == 1 and w == 0 and abs(b - (1600 * 2 - 2.5 - 3 * 2.5)) < 1e-9, (s, w, b)
def t_floor_trails_on_eod_best():
    f = Z(2); f[0, 0, 0] = 400.0                     # day 0: +800 - 2.5 x 4 = +790 at EOD, so the floor moves to -1210
    a = Z(2); a[1, 0, 0] = 1000.0                    # day 1: a dip of 2000 from 790 reaches exactly -1210: not below the floor
    assert one(a, f, H=2)[0] != 2
    a[1, 0, 0] = 1000.5; s, w, _ = one(a, f, H=2); assert s == 2 and w == 1, 'the floor must follow the EOD best balance'
def t_floor_fixed_without_gain():
    a = Z(2); a[1, 0, 0] = 1000.0; s, w, _ = one(a, Z(2), H=2)   # day 0 ends at -10 (four costs, no best change): a 2000 dip from -10 is -2010, below the fixed -2000 floor
    assert s == 2 and w == 1
def t_stop_fills_through():
    a = Z(); a[0, 0, 0] = 200.0; s, _, b = one(a, Z(), arm='C1')   # trade 1 stops at S = 0.15 x 2000 / 2 = 150 (adv 200 >= 150), fills 1 point through = -304.5 with cost; trades 2-4 have adv 0: three costs
    assert abs(b - (-304.5 - 3 * 2.5)) < 1e-9, b
def t_no_stop_pnl():
    f = Z(); f[0, 0, 0] = 10.0; _, _, b = one(Z(), f); assert abs(b - (10 * 2 - 2.5 - 3 * 2.5)) < 1e-9
def t_arms_paired_share_directions():
    rng = np.random.default_rng(3); adv = np.abs(rng.normal(30, 10, (20, R.K, 2))); fin = rng.normal(0, 30, (20, R.K, 2)); busy = np.zeros(20, bool)
    idx, dirs = R.draw(20, 200, 40, np.random.default_rng(5)); s0, _, _ = R.run_paths(adv, fin, busy, idx, dirs, 'C0'); s3, _, _ = R.run_paths(adv, fin, busy, idx, dirs, 'C3'); assert (s0 == s3).all(), 'C3 with no BUSY days must equal C0'
def t_busy_standdown_skips():
    adv = Z(); adv[0, 0, 0] = 1000.5; s, _, b = one(adv, Z(), arm='C3', busy=True); assert s == 0 and b == 0, 'a BUSY day is skipped entirely'
def t_frozen_when_cushion_tiny():
    s, _, _ = one(Z(), Z(), arm='C1', bal0=[-1900.0], best0=[0.0]); assert s == 3, 'cushion 100 -> stop below Smin -> frozen'
def t_budget_binds():
    # C2, adv 400 everywhere: trade 1 S = min(150, 200) = 150 -> loss 304.5; trade 2 S = (400 - 304.5) / 2 = 47.75 -> loss 100; trade 3 S = (400 - 404.5) / 2 < Smin -> the day stops
    a = np.full((1, R.K, 2), 400.0); _, _, b = one(a, Z(), arm='C2'); assert abs(b - (-304.5 - 100.0)) < 1e-9, b
def t_mutation_nonstrict_is_caught():
    src = open(R.__file__).read(); assert 'dip < floor' in src; ns = {}; exec(compile(src.replace('dip < floor', 'dip <= floor'), 'mut', 'exec'), ns)
    a = Z(); a[0, 0, 0] = 1000.0; idx = np.zeros((1, 1), int); dirs = np.zeros((1, 1, R.K), int); good = R.run_paths(a, Z(), np.array([False]), idx, dirs, 'C0')[0][0]; bad = ns['run_paths'](a, Z(), np.array([False]), idx, dirs, 'C0')[0][0]
    assert good != 2 and bad == 2, 'the <= mutation must flip the exact-floor case to a breach'
if __name__ == '__main__':
    n = 0
    for name, fn in list(globals().items()):
        if name.startswith('t_'): fn(); n += 1; print('ok', name)
    print(n, 'tests passed')
