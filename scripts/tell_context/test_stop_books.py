"""Parity test for the forward stop-placement books (shadow.simulate_stop_books, books D, E, F): on a spread of explore dates, every fire's stop, 'changed' flag and net must equal the saved research rows of
docs/TELL_STOP_PLACEMENT_ARMS_PREREG_20261104.md (the FROZEN copy scratch/tell_context_20261103/tell_stop_placement_rows_ORIGINAL_20261104.csv, byte-identical to a rerun of the research script after the dedupe: k4, sie, ext), i.e. the live-path functions are the ones that produced the claim (hr-022).
Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/test_stop_books.py [N_DATES]   (default 8 dates; exit 1 on any mismatch)"""
import os, sys
import numpy as np, pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(HERE, 'research_20261103'))
from tell_replay_lib import replay_rows, SH, REPO, TR

n_dates = int(sys.argv[1]) if len(sys.argv) > 1 else 8
ALL = pd.read_csv(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'tell_stop_placement_rows_ORIGINAL_20261104.csv'))
dates = sorted(ALL.date.unique()); pick = set(dates[:: max(1, len(dates) // n_dates)][:n_dates])


def extra(S, allb, sig, t, ctxf):
    out = SH.simulate_stop_books(S['_ctx'], dict(sig_idx=sig, direction=int(t['dir']), tell_stop=float(t['stop'])), final=True); r = {}
    for b in SH.STOP_BOOKS: r[f'{b}_net'] = out[b]['net']; r[f'{b}_changed'] = not out[b]['followed_a']; r[f'{b}_stop'] = out[b]['stop']
    return r


R, bad = replay_rows(extra, only=pick)
M = R.merge(ALL, on=['date', 'sig'], suffixes=('', '_ref')); print(f'{len(R)} fires on {len(pick)} dates, {len(M)} matched to the saved research rows ({bad} without an entry bar)')
fails = 0
if len(M) != len(R): print('FAIL: not every fire matched a saved row'); fails += 1
for b, ref in (('D', 'k4'), ('E', 'sie'), ('F', 'ext')):
    dn = (M[f'{b}_net'] - M[f'{ref}_net']).abs(); dc = (M[f'{b}_changed'] != M[f'{ref}_changed'])
    print(f'  book {b} vs research {ref}: max |net diff| {dn.max():.4f}, net mismatches {int((dn > 0.011).sum())}, changed-flag mismatches {int(dc.sum())}, changed share {100 * M[f"{b}_changed"].mean():.1f}%')
    fails += int((dn > 0.011).sum()) + int(dc.sum())
print('PARITY FAILURES:', fails); sys.exit(1 if fails else 0)
