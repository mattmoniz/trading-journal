"""One-off repair (2026-11-09): recompute the outcome columns of vacuum_live_events and turn_signal_events rows that were finalized seconds after the fire by the calc_outcome continuous-array bug
(exit_note 'flat-clamped%'), from the session's SAVED bar file and the FIXED calc_outcome (n0 = 0 because only the current session's arrays are passed). DRY RUN by default: prints old vs new per event; --go writes (the table must be
backed up first: vacuum_live_events_backup_20261109, turn_signal_events_backup_20261109; docs/DB_BACKUP_CATALOG.md). Usage: venv/bin/python scripts/vacuum_live/recompute_event_outcomes_20261109.py [--go]"""
import os, sys, datetime, importlib.util
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
spec = importlib.util.spec_from_file_location('shadow_live', os.path.join(HERE, 'shadow.py')); S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)      # the FIXED live module (calc_outcome with n0)
import persist, features as Fm
GO = '--go' in sys.argv; DATES = ['2026-11-09']
conn = persist.connect(); cu = conn.cursor()
for d in DATES:
    f = os.path.join(ROOT, 'scratch', 'argon_vacuum_live', 'priors', f'{d}.bars.tsv')
    Sess = Fm.load_full(f)
    if Sess is None: print('no bars for', d); continue
    en, o, h, l, c = Sess['en'], Sess['o'], Sess['h'], Sess['l'], Sess['c']; nb = len(c); close = Fm.EARLY_CLOSE if d in Fm.EARLY else Fm.CLOSE
    print(f'{d}: {nb} bars in {os.path.basename(f)}')
    for table, where in (('vacuum_live_events', "exit_note LIKE 'flat-clamped%%'"), ('turn_signal_events', "kind='S2_IGNITION' AND exit_note LIKE 'flat-clamped%%'")):
        cu.execute(f"SELECT id, track, bar_idx, direction, etr, net_nostop, to_char(fired_at,'HH24:MI:SS') FROM {table} WHERE trade_date=%s AND {where} ORDER BY id", (d,)); rows = cu.fetchall()
        print(f'  {table}: {len(rows)} premature rows')
        for rid, tr, k, dr, etr, old, ft in rows:
            if etr is None: etr = float('nan')
            lim = 55790.0 if tr == 'GBX' else close - 300.0
            oc = S.calc_outcome(en, o, h, l, c, int(k), int(dr), float(etr), lim, nb, n0=0) if not np.isnan(float(etr)) else None      # etr is stored on both tables
            if oc is None or isinstance(oc, tuple): print(f'    id {rid} {ft} bar {k}: cannot recompute ({oc})'); continue
            print(f'    id {rid} {ft} {tr} dir {dr:+d} bar {k}: old net {float(old) if old is not None else float("nan"):+.2f} -> new net {oc["net_nostop"]:+.2f} (stop {oc["net_stop25"]:+.2f}, mfe {oc["mfe"]:.1f}, mae {oc["mae"]:.1f}, {oc["note"]})')
            if GO:
                cu.execute(f"UPDATE {table} SET fwd30=%s, net_nostop=%s, net_stop25=%s, mfe30=%s, mae30=%s, exit_note=%s, outcome_at=now() WHERE id=%s", (oc['fwd'], oc['net_nostop'], oc['net_stop25'], oc['mfe'], oc['mae'], (oc['note'] + '|rc')[:24], rid))
print('written' if GO else 'dry run: nothing written (pass --go)')
