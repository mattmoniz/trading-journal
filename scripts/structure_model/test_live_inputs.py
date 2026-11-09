"""End-to-end parity of the LIVE input path (run_nightly.day_rows: price_bars_primary bars, daily_rth_stats ranges, the overnight SQL, the tick extractor, the legs helper, the prior-session windows) against the research rows
(scratch/structure_model_20261105/explore_features.csv) on sampled explore days. test_parity.py only proves features.py arithmetic from the research inputs; this proves the live INPUTS (DeepSeek round Z, criticism 2).
Usage: ulimit -v 4000000; venv/bin/python scripts/structure_model/test_live_inputs.py [N_DAYS]"""
import os, sys
import numpy as np, pandas as pd
sys.argv = sys.argv[:1] + [a for a in sys.argv[1:] if not a.isdigit()] if False else sys.argv
N = int(next((a for a in sys.argv[1:] if a.isdigit()), 6)); sys.argv = sys.argv[:1]
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import run_nightly as R, features as F
REF = pd.read_csv(R.EXPLORE); conn = R.get_connection(); rng = np.random.default_rng(11)
days = sorted(d for d in REF.date.unique() if d >= '2025-03-01'); pick = sorted(rng.choice(days, N, replace=False)); cols = F.M2_COLS + ['adr']; tot = {c: 0.0 for c in cols}; skipped = 0
for d in pick:
    out, note = R.day_rows(conn, d)
    if out is None: print(f'{d}: live path returned None ({note})'); skipped += 1; continue
    rows, adr, b = out; ref = REF[REF.date == d].sort_values('T'); print(f'{d}: live adr {adr:.2f} vs research {ref.adr.iloc[0]:.2f}; note {note}')
    for r, (_, rr) in zip(rows, ref.iterrows()):
        for c in F.M2_COLS:
            dif = abs(float(r[c]) - float(rr[c])); tot[c] = max(tot[c], dif)
            if dif > 1e-6: print(f'   T={int(rr["T"])} {c}: live {float(r[c]):.6f} research {float(rr[c]):.6f}')
    tot['adr'] = max(tot['adr'], abs(adr - ref.adr.iloc[0]))
print('\nworst absolute difference per column over', len(pick) - skipped, 'days:', {c: f'{v:.2e}' for c, v in tot.items() if v > 0} or 'all zero')
print('LIVE INPUTS MATCH RESEARCH' if max(tot.values()) < 1e-6 else 'LIVE INPUTS DIFFER FROM RESEARCH (see lines above)')
