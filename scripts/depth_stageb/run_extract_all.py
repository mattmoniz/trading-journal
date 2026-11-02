"""Extract the Stage B heatmap for every stage-1 session that has a depth file. Usage: python run_extract_all.py"""
import sys, glob, os, json, time
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_tell_live'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/depth_stageb')
import numpy as np, persist, extract_heatmap as X
conn = persist.connect(); dates = sorted(os.path.basename(f)[4:14] for f in glob.glob('/home/mmoniz/trading-journal/scratch/event_snapshots_20261102/day_*.json')); ok = fail = 0; t0 = time.time()
for d in dates:
    out_path = f'{X.OUT}/{d}.npz'
    if os.path.exists(out_path): ok += 1; continue
    try:
        contract = persist.contract_for(conn, d); out, info = X.extract(d, contract)
        if out is None: print(d, 'SKIP', info, flush=True); fail += 1; continue
        np.savez_compressed(out_path, **out); ok += 1; print(d, contract, info, f'{time.time() - t0:.0f}s', flush=True)
    except Exception as e: print(d, 'ERROR', repr(e)[:150], flush=True); fail += 1
print(f'DONE extracted {ok}, skipped/failed {fail}')
