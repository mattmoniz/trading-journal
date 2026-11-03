"""acceptance: snapshot() tape features equal the study's features for the same event and second; plus the live-extraction path on a post-explore date. run: venv python -I test_snapshot.py"""
import sys; sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/tape_companion')
import numpy as np, pandas as pd, lib, snapshot_at as S, random
df = pd.read_csv('/home/mmoniz/trading-journal/scratch/tape_hold_slice_events_20261103_s5.csv'); random.seed(7); rows = df.iloc[random.sample(range(len(df)), 12)]
pdates = lib.persec_dates(); B = lib.Baselines(pdates); bad = 0; same_i = 0
for _, r in rows.iterrows():
    scale, vr = B.for_date(r.date); A = lib.load_day(r.date); t0 = int(r.t0)
    f = lib.snapshot(A, t0, r.center, 'LONG' if r.side == 1 else 'SHORT', scale, vr)
    for k in ('vol_ratio', 'delta30', 'delta120', 'cumdelta', 'tussle'):
        a, b = f[k], r[k]
        if not ((np.isnan(a) and np.isnan(b)) or abs(a - b) < 1e-9): bad += 1; print('MISMATCH', r.date, t0, k, a, b)
    same_i += int(f['secs_since_contact'] == 60)
print(f'tape-feature parity: {12*5 - bad}/{12*5} equal; contact second identical to the study in {same_i}/12 events')
assert bad == 0
# end-to-end through the JSON path for one explore event, ET naive timestamp
r = rows.iloc[0]; ts = f"{r.date}T{(34200+int(r.t0))//3600:02d}:{((34200+int(r.t0))%3600)//60:02d}:{(34200+int(r.t0))%60:02d}"
print(S.snap_calls([dict(id='t1', ts=ts, level=float(r.center), direction='LONG' if r.side == 1 else 'SHORT')])[0])
# outside RTH and the live-extraction path (post-explore date, extracted from the .scid)
print(S.snap_calls([dict(id='g', ts='2026-10-30T20:15:00', level=24000.0, direction='LONG')])[0]['status'])
print(S.ensure_day('2026-10-30'))
res = S.snap_calls([dict(id='live', ts='2026-10-30T10:42:13', level=0, direction='LONG')]); print({k: res[0].get(k) for k in ('status', 'price_now', 'vol_ratio', 'delta30', 'baseline_age_days')})
