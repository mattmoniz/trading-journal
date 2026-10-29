"""Quick checks for the marks framework: the no-order boundary (static), the calibration store (rolled-back transaction), the guard flag. The causality parity itself is parity.py (slower). Usage: ../../venv/bin/python test_parity.py"""
import sys, os, re, glob, uuid
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_marks_live'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/ml_meta_labeling')
import guard, calib_store
HERE = os.path.dirname(os.path.abspath(__file__))
# 1. hard no-order boundary: the flag is False and no module imports or references an order / DTC / active_setups writer
assert guard.ORDERS_ENABLED is False; guard.assert_no_orders()
FORBIDDEN = re.compile(r"orderSweep|sierraChart|dtcClient|placeExitOrder|submitOrder|INSERT\s+INTO\s+active_setups|UPDATE\s+active_setups", re.I)
for f in glob.glob(os.path.join(HERE, '*.py')):
    if os.path.basename(f) in ('test_parity.py', 'guard.py'): continue
    hits = FORBIDDEN.findall(open(f).read()); assert not hits, (f, hits)
guard.ORDERS_ENABLED = True
try: guard.assert_no_orders(); raise SystemExit('guard did not raise')
except RuntimeError: pass
guard.ORDERS_ENABLED = False
# 2. calibration store round trip, rolled back (writes nothing durable)
from db import get_connection
conn = get_connection(); name = 'TEST_' + uuid.uuid4().hex[:10]
try:
    assert calib_store.latest(conn, name) is None
    calib_store.write(conn, name, dict(es_cut_low=-0.12, es_cut_high=0.2), '2025-05-16', 'testsha', sample_size=836)
    r = calib_store.latest(conn, name); assert r and r['params']['es_cut_low'] == -0.12 and r['train_end'] == '2025-05-16' and r['version'] == calib_store.params_hash(dict(es_cut_low=-0.12, es_cut_high=0.2)), r
    calib_store.write(conn, name, dict(es_cut_low=-0.10, es_cut_high=0.2), '2025-06-30', 'testsha2', sample_size=900)       # same day, new params: the upsert must keep one row and the read must return it
    r2 = calib_store.latest(conn, name); assert r2['params']['es_cut_low'] == -0.10, r2
    try: calib_store.write(conn, 'x' * 61, {}, '2025-01-01', 'x'); raise SystemExit('long name accepted')
    except ValueError: pass
finally:
    conn.rollback()
conn2 = get_connection(); assert calib_store.latest(conn2, name) is None; conn2.close(); conn.close()
print('framework quick tests ok')
