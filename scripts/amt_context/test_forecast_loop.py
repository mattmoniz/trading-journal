"""Tests of the forecast learning loop (forecast_train.py, forecast_loop.py): the train/evaluate guard, the non-overlapping calendar, the promotion rule on synthetic cases, forward-data cutoffs against the real table, and a reproduction of the registered champion from explore data alone; plus one mutation.
Usage: nice ../../venv/bin/python test_forecast_loop.py"""
import sys, json, inspect
import numpy as np, pandas as pd
import forecast_train as FT, forecast_loop as FL, forecast_features as FF
from db import get_connection
ok_all = True
def check(name, cond):
    global ok_all; ok_all &= bool(cond); print(('ok   ' if cond else 'FAIL ') + name)
# 1. the guard: points on or before trained_through are never evaluated
df = pd.DataFrame(dict(date=['2026-11-02', '2026-11-03', '2026-11-04'], x=[1, 2, 3])); out = FL.evaluable(df, '2026-11-03')
check('guard: a point ON the trained_through date is excluded, later ones kept', list(out.date) == ['2026-11-04'])
# 2. the calendar is contiguous and non-overlapping
sp = [FL.span_for(i) for i in range(4)]; check('calendar: spans (20,40), (40,60), (60,80), (80,100)', sp == [(20, 40), (40, 60), (60, 80), (80, 100)])
check('calendar: every span starts where the previous ended (no shared days)', all(sp[k][1] == sp[k + 1][0] for k in range(3)))
# 3. day-blocked comparison and the promotion arithmetic on synthetic data (a truly better model is detected, an identical one is not)
rng = np.random.default_rng(1); nd, per = 40, 12; dates = np.repeat([f'2026-12-{d:02d}' for d in range(1, 29)] + [f'2027-01-{d:02d}' for d in range(1, 13)], per)[:nd * per]; truth = rng.normal(0, 1, nd * per); y = truth + rng.normal(0, 0.8, nd * per)
d = pd.DataFrame(dict(date=dates)); good = truth + rng.normal(0, 0.3, nd * per); bad = rng.normal(0, 1, nd * per)
r1 = FL.day_blocked(d, good, bad, y, 5); check(f'synthetic: a better model beats a noise model (diff {r1["diff"]:+.2f}, CI lower {r1["lo"]:+.2f}, p {r1["p"]:.3f})', r1['diff'] > 0.3 and r1['lo'] > 0 and r1['p'] < 0.05)
r2 = FL.day_blocked(d, good, good.copy(), y, 6); check(f'synthetic: an identical model is not promoted (diff {r2["diff"]:+.4f}, p {r2["p"]:.3f})', abs(r2['diff']) < 1e-12 and not (r2['lo'] > 0 and r2['p'] < 0.05))
# 4. forward cutoffs against the real tables
conn = get_connection(); a = FT.forward_frame(conn, 30, '2026-10-29'); b = FT.forward_frame(conn, 30, '2026-10-30')
check(f'forward frame: no point after the cutoff ({len(a)} rows through 10-29, {len(b)} through 10-30)', len(a) > 0 and a.date.max() <= '2026-10-29' and len(b) > len(a) and b.date.max() <= '2026-10-30')
# 5. the training frame
ex = FT.explore_frame(30); t0, i0 = FT.training_frame(conn, 30, None); t1, i1 = FT.training_frame(conn, 30, '2026-10-30')
check(f'training frame: no cutoff = explore only ({len(t0)} rows); with a cutoff the forward rows are appended ({len(t1)} rows, {i1["forward_n"]} forward)', len(t0) == len(ex) and len(t1) == len(ex) + i1['forward_n'] and i1['forward_n'] > 0 and t0.date.max() <= '2025-05-16')
# 6. retraining on explore data alone reproduces the registered champion
cur = conn.cursor(); cur.execute("SELECT version, params FROM forecast_models WHERE role='CHAMPION' AND horizon_min=30"); ver, params = cur.fetchone(); params = params if isinstance(params, dict) else json.loads(params); fit = FT.fit(t0, 30)
same = fit['alpha'] == params['alpha'] and np.allclose(fit['coef'], params['coef'], atol=1e-9) and np.allclose(fit['mu'], params['mu'], atol=1e-9) and abs(fit['ym'] - params['ym']) < 1e-9
check(f'reproduction: retraining on the explore frame reproduces the registered champion {ver} exactly', same)
# 7. predict() on stored params equals the training-time forecast on explore rows (the subset PERSIST model too is consistent)
r = ex.iloc[1000].to_dict(); z = (FF.vector(r) - np.array(params['mu'])) / np.array(params['sd']); check('predict(): stored params reproduce the hand computation', abs(FT.predict(params, r) - float(params['ym'] + z @ np.array(params['coef']))) < 1e-12)
pers = FT.fit(ex.iloc[::10].reset_index(drop=True), 30, FL.PERSIST_NAMES); check('PERSIST model uses only the trailing ranges and the clock', pers['names'] == FL.PERSIST_NAMES and len(pers['coef']) == len(FL.PERSIST_NAMES))
conn.close()
# 8. mutation: an evaluator that keeps points ON the trained_through date must be caught by test 1
src = inspect.getsource(FL.evaluable).replace("df.date > str(trained_through)", "df.date >= str(trained_through)"); ns = dict(vars(FL)); exec(src, ns); m = ns['evaluable'](df, '2026-11-03')
check('mutation: an evaluator using >= would include the trained_through date, and test 1 catches it', list(m.date) != ['2026-11-04'])
print('all forecast loop tests passed' if ok_all else 'SOME TESTS FAILED'); sys.exit(0 if ok_all else 1)
