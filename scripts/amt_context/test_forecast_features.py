"""Train/serve equivalence: activity_row (serving) == run_p3.row_features (what the study trained and tested with), and stored-params prediction == the in-memory ridge prediction, on sampled explore rows.
Usage: ../../venv/bin/python test_forecast_features.py"""
import sys; sys.argv = sys.argv[:1]
import numpy as np
import tell_state as TS, forecast_features as FF, forecast_train as FT, run_p3 as P3, vbars as V, run_p2b as P
_, ctxs, _ = TS.sessions_and_contexts(); ks = sorted(ctxs)[::40]; rng = np.random.default_rng(7); n = bad = 0
for d in ks:
    c = ctxs[d]; fl = TS.bar_flags(c)
    for ts in rng.uniform(V.DEC_FIRST, V.DEC_LAST, 8):
        ts = float(int(ts // 60) * 60); a = FF.activity_row(c, ts, 2); b = P3.row_features(c, fl, ts, 2); n += 1
        if (a is None) != (b is None): bad += 1; print('presence mismatch', d, ts); continue
        if a is None: continue
        for k in ('A_now', 'rth_range_so_far_atr', 'overnight_range_atr', 'minutes_since_rth_open', 'rr15', 'rr30', 'rr60', 'dow', 'bucket'):
            if not np.isclose(a[k], b[k], rtol=1e-9, atol=1e-9): bad += 1; print('value mismatch', d, ts, k, a[k], b[k])
print(f'feature equivalence: {n} sampled points on {len(ks)} dates, mismatches {bad}')
df = FT.explore_frame(30).iloc[::20].reset_index(drop=True); p = FT.fit(df, 30); X = FT.X_of(df); Z = (X - np.array(p['mu'])) / np.array(p['sd']); mem = p['ym'] + Z @ np.array(p['coef']); sv = np.array([FF.predict(p, r)[0] for r in df.to_dict('records')])
print('stored-params prediction vs in-memory: max abs difference', float(np.max(np.abs(mem - sv))))
ok = bad == 0 and np.max(np.abs(mem - sv)) < 1e-9; print('TEST OK' if ok else 'TEST FAILED'); sys.exit(0 if ok else 1)
