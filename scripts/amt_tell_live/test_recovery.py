"""Test of sidecar.Runner.recover_missed on EXPLORE dates only (never the sealed hold-out): a restart across session boundaries must replay the missed sessions, log their tells, book them FINAL, and the result must equal the research.
Seeds a FINAL row for 2025-03-10, builds the baseline for 2025-03-11, recovers 03-11 and 03-12, compares 03-12 split/V1 with scripts/amt_vbars/trades_V1_explore.csv, then removes every row it wrote. Usage: ../../venv/bin/python test_recovery.py"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pandas as pd
import persist, bootstrap, sidecar
RULES = ('split', 'whole'); conn = persist.connect()
def wipe():
    with conn.cursor() as c:
        for t in ('amt_tell_trades', 'amt_tell_sessions', 'amt_tell_session_stats'): c.execute(f"DELETE FROM {t} WHERE trade_date < '2026-01-01'")
        c.execute("DELETE FROM amt_tell_alarms")
wipe()
with conn.cursor() as c:
    for r in RULES: c.execute("INSERT INTO amt_tell_sessions (trade_date, bar_rule, state, updated_at) VALUES ('2025-03-10', %s, 'FINAL', %s)", (r, persist.now_et()))
bootstrap.ensure_baseline(conn, '2025-03-11', RULES, log=lambda *a: None)
run = sidecar.Runner(RULES); run.conn = conn
run.recover_missed('2025-03-13')
with conn.cursor() as c:
    c.execute("SELECT trade_date::text, bar_rule, state, n_bars, vol_diff_pct, baseline_n FROM amt_tell_sessions ORDER BY 1,2"); print(c.fetchall())
    c.execute("SELECT trade_date::text, bar_rule, book, count(*), sum((status='OPEN')::int), min(late_min) FROM amt_tell_trades GROUP BY 1,2,3 ORDER BY 1,2,3"); print(c.fetchall())
    c.execute("SELECT kind, detail::text FROM amt_tell_alarms"); print('alarms', c.fetchall())
    c.execute("SELECT sig_idx, direction, entry_price::float, stop_price::float, exit_reason, exit_points::float, net_dollars::float FROM amt_tell_trades WHERE trade_date='2025-03-12' AND bar_rule='split' AND book='V1' ORDER BY sig_idx"); db = c.fetchall()
ref = pd.read_csv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'amt_vbars', 'trades_V1_explore.csv')); ref = ref[ref.date == '2025-03-12'].sort_values('sig')
ok = len(db) == len(ref) and all(int(a[0]) == int(b.sig) and a[1] == b.dir and abs(a[2] - b.entry) < 1e-9 and abs(a[3] - b.stop) < 1e-9 and a[4] == b.reason and abs(a[5] - b.pts) < 1e-9 and abs(a[6] - b.net) < 1e-9 for a, b in zip(db, ref.itertuples()))
print('03-12 split V1 rows equal research CSV:', ok, len(db), len(ref))
wipe(); print('cleaned'); sys.exit(0 if ok else 1)
