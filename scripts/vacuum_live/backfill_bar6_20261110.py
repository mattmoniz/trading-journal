"""One-off backfill (2026-11-10): bar-6 checkpoint flag (b6_* columns of vacuum_live_events, migration scripts/migrate_vacuum_bar6_20261110.mjs) for the live rows that were finalized BEFORE the live writer existed, from each session's SAVED bar file
(n0 = 0 because only the current session's arrays are passed, as in recompute_event_outcomes_20261109.py) and the shared scripts/vacuum_live/bar6_status.py. Arm A of every row must equal the stored net_stop25 (parity within 0.05: the stored etr column is rounded to 2 decimals while the live value was unrounded), else the row is skipped and reported.
b6_src = 'BACKFILL'. Reads no outcome labels for any decision (a descriptive flag). DRY RUN by default; --go writes. Usage: venv/bin/python scripts/vacuum_live/backfill_bar6_20261110.py [--go]"""
import os, sys, importlib.util
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
for sub in ('scripts/amt_tell_live', 'scripts/tick_microstructure', 'scripts', 'scripts/vacuum_sim'): sys.path.insert(0, os.path.join(ROOT, sub))
spec = importlib.util.spec_from_file_location('bar6s', os.path.join(HERE, 'bar6_status.py')); B6 = importlib.util.module_from_spec(spec); spec.loader.exec_module(B6)
import persist, features as Fm
GO = '--go' in sys.argv
conn = persist.connect(); cu = conn.cursor()
cu.execute("SELECT DISTINCT trade_date::text FROM vacuum_live_events WHERE outcome_at IS NOT NULL AND b6_status IS NULL AND exit_note NOT LIKE 'no-entry%%' ORDER BY 1"); dates = [r[0] for r in cu.fetchall()]
tot = ok_n = skip = 0; counts = {}
for d in dates:
    f = os.path.join(ROOT, 'scratch', 'argon_vacuum_live', 'priors', f'{d}.bars.tsv'); Sess = Fm.load_full(f) if os.path.exists(f) else None
    if Sess is None: print(d, 'no bar file; rows left empty'); continue
    en, o, h, l, c = Sess['en'], Sess['o'], Sess['h'], Sess['l'], Sess['c']; nb = len(c); close = Fm.EARLY_CLOSE if d in Fm.EARLY else Fm.CLOSE
    cu.execute("SELECT id, track, bar_idx, direction, etr, net_stop25 FROM vacuum_live_events WHERE trade_date=%s AND outcome_at IS NOT NULL AND b6_status IS NULL AND exit_note NOT LIKE 'no-entry%%' ORDER BY id", (d,)); rows = cu.fetchall()
    for rid, tr, k, dr, etr, stored in rows:
        tot += 1; a = int(k); lim = 55790.0 if tr == 'GBX' else close - 300.0; last = B6.last_bar(en, a, lim, nb, n0=0)
        if last is None or etr is None or stored is None: skip += 1; print(f'  {d} id {rid}: cannot compute (last {last})'); continue
        x = B6.bar6(o, h, l, c, a + 1, last, int(dr), 2.5 * float(etr))
        if abs(x['a'] - float(stored)) > 0.05: skip += 1; print(f'  {d} id {rid}: PARITY FAIL arm A {x["a"]:+.2f} vs stored net_stop25 {float(stored):+.2f}; skipped'); continue
        ok_n += 1; counts[x['status']] = counts.get(x['status'], 0) + 1
        if GO: cu.execute("UPDATE vacuum_live_events SET b6_status=%s, b6_close=%s, b6_net_a=%s, b6_net_b=%s, b6_net_c=%s, b6_src='BACKFILL', b6_at=now() WHERE id=%s AND b6_status IS NULL", (x['status'], None if x['close6'] is None else round(x['close6'], 2), round(x['a'], 2), round(x['b'], 2), round(x['cc'], 2), rid))
    print(f'{d}: {len(rows)} rows')
print(f'{tot} candidate rows, {ok_n} computed with parity, {skip} skipped; status {counts}; ' + ('WRITTEN' if GO else 'dry run, nothing written (pass --go)'))
