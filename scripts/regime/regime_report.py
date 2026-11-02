"""Historical walk-forward report of the DAY gauge (descriptive; docs/REGIME_GAUGE_20261102.md). READS OUTCOMES -> look logged first (log_look_regime_report.mjs). Usage: nice python regime_report.py"""
import numpy as np
from scipy.stats import rankdata
import regime_lib as RL
rho = lambda a, b: float(np.corrcoef(rankdata(a), rankdata(b))[0, 1])
conn = RL.connect(); p, cut, rows, done, preds = RL.live_model(conn); conn.close()
d = [r for r in done if r['date'] in preds]; y = np.array([RL.target(r) for r in d]); pr = np.array([preds[r['date']] for r in d]); dates = [r['date'] for r in d]
print(f'valid complete days {len(done)} (through {done[-1]["date"]}); out-of-sample predicted days {len(d)} ({dates[0]}..{dates[-1]}); live model {p["version"]}, alpha {p["alpha"]}; cutoffs from the last {cut["n"]} OOS predictions: q33 {cut["q33"]:+.3f}, q67 {cut["q67"]:+.3f}')
base = {'overnight range alone': np.array([(r['raw']['h'] - r['raw']['l']) / r['atr'] for r in d]), 'prior-day range alone': np.array([r['pdr'] / r['atr'] for r in d]), 'overnight volume alone': np.array([r['onv'] for r in d])}
print(f'\nOUT-OF-SAMPLE Spearman with the realized RTH range: model {rho(pr, y):+.3f}; ' + '; '.join(f'{k} {rho(v, y):+.3f}' for k, v in base.items()))
q = max(1, len(d) // 4); print('by chronological quarter (model / overnight range alone): ' + ' | '.join(f'{dates[i * q]}..: {rho(pr[i * q:(i + 1) * q if i < 3 else None], y[i * q:(i + 1) * q if i < 3 else None]):+.3f} / {rho(base["overnight range alone"][i * q:(i + 1) * q if i < 3 else None], y[i * q:(i + 1) * q if i < 3 else None]):+.3f}' for i in range(4)))
# buckets with expanding (strictly earlier) terciles of the OOS predictions, as the live gauge would have used them
lab = []
for k, r in enumerate(d):
    if k < 60: lab.append(None); continue
    v = pr[max(0, k - 250):k]; lab.append(RL.bucket(pr[k], dict(q33=float(np.quantile(v, 1 / 3)), q67=float(np.quantile(v, 2 / 3)))))
rng_pts = np.array([r['rng'] for r in d]); atr = np.array([r['atr'] for r in d]); print('\nrealized RTH range by the bucket the gauge would have shown (expanding terciles, first 60 OOS days skipped):')
for b in ('QUIET', 'NORMAL', 'BUSY'):
    m = np.array([l == b for l in lab]); print(f'  {b:6s} N {int(m.sum()):3d} days: mean range {rng_pts[m].mean():6.0f} pts (median {np.median(rng_pts[m]):6.0f}), mean range / ATR20 {np.mean(rng_pts[m] / atr[m]):.2f}, SD of the range {rng_pts[m].std():5.0f}; about ${rng_pts[m].mean() * 2:,.0f} per contract end to end on an average day')
m = np.array([l is not None for l in lab]); allm = rng_pts[m].mean(); print(f'  all   N {int(m.sum()):3d} days: mean range {allm:6.0f} pts; BUSY/QUIET ratio of mean ranges {rng_pts[np.array([l == "BUSY" for l in lab])].mean() / rng_pts[np.array([l == "QUIET" for l in lab])].mean():.2f}')
big = rng_pts >= np.quantile(rng_pts[m], 0.9); print(f'  share of the biggest 10% of days that were labelled BUSY: {100 * np.mean([lab[i] == "BUSY" for i in range(len(d)) if big[i] and lab[i]]):.0f}% (a random label would give 33%); share of the smallest 10% labelled QUIET: {100 * np.mean([lab[i] == "QUIET" for i in range(len(d)) if rng_pts[i] <= np.quantile(rng_pts[m], 0.1) and lab[i]]):.0f}%')
