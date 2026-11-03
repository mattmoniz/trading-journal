"""Feasibility counts only: touch episodes, dwell-gate survival, level staleness, coverage. NO outcome labels are read. Usage: nice python feasibility.py"""
import sys; sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/tape_companion'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_tell_live')
import numpy as np, pandas as pd, collections, lib, persist, pickle
EXPLORE_END = '2025-05-16'
conn = persist.connect()
with conn.cursor() as c:
    c.execute("SELECT trade_date::text, level_name, price::float FROM level_prices WHERE trade_date BETWEEN '2023-04-01' AND %s AND price IS NOT NULL", (EXPLORE_END,)); rows = c.fetchall()
LV = {}
for d, n, p in rows: LV.setdefault(d, {})[n] = p
pd_dates = lib.persec_dates(); B = lib.Baselines(pd_dates)
dates = [d for d in pd_dates if d in LV and d <= EXPLORE_END]
print(f'persec dates {len(pd_dates)}; explore dates with stored levels and a persec file {len(dates)}')
stale = []; ok_dates = []; cnt = collections.Counter(); fam_cnt = collections.Counter(); out = []; per_day = []
for d in dates:
    bl = B.for_date(d)
    if bl is None: cnt['no_baseline'] += 1; continue
    scale, vr = bl; i = pd_dates.index(d); P = lib.load_day(pd_dates[i - 1]); A = lib.load_day(d)
    L = LV[d]
    # staleness: stored prior-day high/low vs the previous session's RTH extremes in the per-second file
    bad = False
    if 'PD_HIGH' in L and 'PD_LOW' in L and (abs(L['PD_HIGH'] - P['high'].max()) > 3.0 or abs(L['PD_LOW'] - P['low'].min()) > 3.0): bad = True
    if bad: stale.append(d); cnt['stale_dates'] += 1; continue
    ev = lib.find_touches(A, L, scale, vr); n_ok = 0
    for e in ev:
        st, f = lib.gate_and_features(A, e, scale, vr); cnt['touch'] += 1; cnt[st] += 1
        if st == 'OK':
            n_ok += 1; fm = sorted(set(lib.NAME2FAM[m] for m in e['members'])); [fam_cnt.update([x]) for x in fm]
            out.append(dict(date=d, i=e['i'], center=e['center'], lo=e['lo'], hi=e['hi'], members='|'.join(e['members']), scale=scale, **f))
    per_day.append(n_ok); ok_dates.append(d)
print('counts:', dict(cnt)); print(f'dates used {len(ok_dates)}, stale-level dates skipped {len(stale)} ({100*len(stale)/max(1,len(dates)):.1f}%)')
tot = cnt['touch']; print(f'touch episodes {tot}; gate OK {cnt["OK"]} ({100*cnt["OK"]/tot:.1f}%), THROUGH before decision {cnt["THROUGH"]} ({100*cnt["THROUGH"]/tot:.1f}%), ALREADY_HELD {cnt["ALREADY_HELD"]} ({100*cnt["ALREADY_HELD"]/tot:.1f}%), EDGE {cnt["EDGE"]}')
print('evaluable events per date: mean %.1f median %d p10 %d p90 %d; dates with >=1 event %d' % (np.mean(per_day), np.median(per_day), np.percentile(per_day, 10), np.percentile(per_day, 90), sum(1 for x in per_day if x > 0)))
print('family presence in OK events:', dict(fam_cnt))
df = pd.DataFrame(out); print('hour of decision:', df.hour.value_counts().sort_index().to_dict()); print('side:', df.side.value_counts().to_dict(), '| touch_no>1 share %.2f' % (df.touch_no > 1).mean(), '| members per event mean %.2f' % df.members.str.count(r'\|').add(1).mean())
print('tussle NaN share %.3f' % df.tussle.isna().mean())
df.to_csv(f'/home/mmoniz/trading-journal/scratch/tape_hold_slice_events_20261103_s{lib.SCALE_MIN}.csv', index=False); open('/home/mmoniz/trading-journal/scratch/tape_hold_slice_stale_dates_20261103.txt', 'w').write('\n'.join(stale))
