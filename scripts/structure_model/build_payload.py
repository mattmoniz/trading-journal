"""Builds public/structure_model.json for the Monitor page: the shadow next-hour RANGE model's history (docs/STRUCTURE_SHADOW_MODEL_DESIGN_20261105.md). Two sources, one daily series:
  (1) the EXPLORE-era walk-forward rows (scratch/structure_model_20261105/rows_walkforward.csv, written by research_20261103/structure_model_stepA.py --dump-rows): each row was predicted by a ridge fitted only on EARLIER days, so it is out-of-sample by construction, but the model's design was chosen on this same era (stated on the card);
  (2) the FORWARD rows (table structure_model_rows, once the nightly job exists): predictions frozen before the hour, labels attached after it. Forward days are flagged fwd=1.
Usage: venv/bin/python scripts/structure_model/build_payload.py   (called nightly after the labelling step; read-only against everything but its own output file)"""
import os, json, datetime
import numpy as np, pandas as pd
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')); OUT = os.path.join(REPO, 'public', 'structure_model.json')
H = pd.read_csv(os.path.join(REPO, 'scratch', 'structure_model_20261105', 'rows_walkforward.csv')); H = H[H.scored == 1].copy(); H['fwd'] = 0
rows = [H]
try:                                                                                   # forward rows: only if the nightly job's table exists and has labelled rows
    from sqlalchemy import create_engine  # noqa
except Exception: pass
F = None
fp = os.path.join(REPO, 'scratch', 'structure_model_20261105', 'forward_rows.csv')     # written by the nightly job (date, T, y, p0, p2, adr) for LABELLED forward rows
if os.path.exists(fp):
    F = pd.read_csv(fp)
    if len(F): F['scored'] = 1; F['fwd'] = 1; rows.append(F.astype({'y': float, 'p0': float, 'p2': float, 'adr': float}))
D = pd.concat(rows, ignore_index=True)
D['l0'] = (D.y - D.p0) ** 2; D['l2'] = (D.y - D.p2) ** 2; D['l3'] = (D.y - D.p3) ** 2; D['hard_pts'] = D.adr * np.exp(D.p3); D['real_pts'] = D.adr * np.exp(D.y); D['mod_pts'] = D.adr * np.exp(D.p2); D['base_pts'] = D.adr * np.exp(D.p0)
g = D.groupby('date').agg(n=('y', 'size'), l0=('l0', 'mean'), l2=('l2', 'mean'), l3=('l3', 'mean'), hp=('hard_pts', 'mean'), rp=('real_pts', 'mean'), mp=('mod_pts', 'mean'), bp=('base_pts', 'mean'), fwd=('fwd', 'max')).reset_index().sort_values('date')
daily = [dict(d=r.date, n=int(r.n), l0=round(float(r.l0), 5), l2=round(float(r.l2), 5), l3=round(float(r.l3), 5), hp=round(float(r.hp), 1), rp=round(float(r.rp), 1), mp=round(float(r.mp), 1), bp=round(float(r.bp), 1), fwd=int(r.fwd)) for r in g.itertuples()]
imp = lambda x: 100 * (x.l0.sum() - x.l2.sum()) / x.l0.sum(); impH = lambda x: 100 * (x.l3.sum() - x.l2.sum()) / x.l3.sum()
FIRST_LOOK_DAYS = 60                                                                   # pre-registered: forward skill is NOT published before the first look at 60 complete forward days (cv-006, DeepSeek round Z)
fwd = g[g.fwd == 1]; exp_ = g[g.fwd == 0]
import glob
arts = sorted(glob.glob(os.path.join(REPO, 'scratch', 'structure_model_20261105', 'models', 'model_*.json'))); art = json.load(open(arts[-1])) if arts else None
payload = dict(state='OK', generatedAt=datetime.datetime.now().isoformat(timespec='seconds'),
    model=dict(name='Next-hour range model (shadow): ridge on clock + HAR-X + price-movement state + now-versus-lately', baseline='HAR-X + clock', hardBaseline='HAR-X + clock + last-30-minute range + range so far', decisionTimes=['10:30', '11:30', '13:00', '14:30'], label='ln(next-hour high-low / ADR); shown here in points'),
    frozen=(dict(version=art['version'], trainedAt=art['trained_at'], rows=art['n_rows'], forwardRows=art['n_forward_rows']) if art else None),
    era=dict(exploreFrom=exp_.date.min(), exploreTo=exp_.date.max(), forwardFrom=(fwd.date.min() if len(fwd) else None), forwardDays=int(len(fwd)), exploreDays=int(len(exp_))),
    totals=dict(exploreImprovementHardPct=round(float(impH(exp_)), 2), forwardImprovementHardPct=(round(float(impH(fwd)), 2) if len(fwd) >= FIRST_LOOK_DAYS else None), exploreImprovementPct=round(float(imp(exp_)), 2), exploreRows=int(exp_.n.sum()), forwardImprovementPct=(round(float(imp(fwd)), 2) if len(fwd) >= FIRST_LOOK_DAYS else None), forwardRows=int(fwd.n.sum()) if len(fwd) else 0,
                corrModelExplore=round(float(np.corrcoef(D[D.fwd == 0].p2, D[D.fwd == 0].y)[0, 1]), 3), corrBaselineExplore=round(float(np.corrcoef(D[D.fwd == 0].p0, D[D.fwd == 0].y)[0, 1]), 3)),
    daily=daily,
    next=dict(review='Counts only until the FIRST LOOK at 60 complete forward days (240 rows), the SECOND at 120, then one non-overlapping look per 60: improvement over the HARD baseline (HAR-X + clock + the last-30-minute range + the range so far: two plain persistence terms that already capture 79 percent of the gain over HAR-X + clock) with a week-block 95 percent CI, both halves and a circular-shift placebo (docs/STRUCTURE_SHADOW_MODEL_DESIGN_20261105.md).',
              ifConfirmed='CI lower bound above 0 and both halves positive: keep it as the next-hour range display; no consumer is wired without the user\'s word.',
              ifFailed='At the SECOND look the CI includes 0 or the estimate is negative: retire to the HAR-X + clock baseline and write the autopsy (which decision time and which group lost skill).'),
    notes=['HONESTY CHECK (2026-11-05): two plain persistence terms (the last-30-minute range and the range so far) added to HAR-X + clock already capture 79 percent of the model\'s gain over HAR-X + clock; the replay edge over that HARD baseline is about +6.5 percent, not tested with an interval. The forward looks are judged against the hard baseline.','The explore-era series is a WALK-FORWARD replay: every row was predicted by a model fitted only on earlier days (out-of-sample by construction), but the features were chosen on this same era, so it is a lead (pre-registered test: claim structure_model_stepA_20261104), not forward evidence.',
           'It forecasts a RANGE (volatility), not a direction, and nothing trades or gates on it.',
           'Forward rows start with the first nightly run after the build; until then the card shows the explore replay only.'])
with open(OUT + '.tmp', 'w') as f: json.dump(payload, f)
os.replace(OUT + '.tmp', OUT); print(f'wrote public/structure_model.json: {len(daily)} days ({payload["era"]["exploreDays"]} explore, {payload["era"]["forwardDays"]} forward), explore improvement {payload["totals"]["exploreImprovementPct"]}%, correlation model {payload["totals"]["corrModelExplore"]} vs baseline {payload["totals"]["corrBaselineExplore"]}')
