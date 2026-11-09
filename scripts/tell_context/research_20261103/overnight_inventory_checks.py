"""Corrected analysis and committed diagnostics for docs/OVERNIGHT_INVENTORY_PREREG_20261104.md section 8 (A1, after DeepSeek round V). Reads the per-session rows written by overnight_inventory.py plus the per-minute files for the completeness check.
Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/overnight_inventory_checks.py   (the A1 look is logged first, hr-023)"""
import os, sys, csv
import numpy as np, pandas as pd
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..')); rng = np.random.default_rng(20261104); B, NSHIFT = 4000, 1000; CIQ = (1.25, 98.75)
R = pd.read_csv(os.path.join(REPO, 'scratch', 'watcher_marks_20261104', 'overnight_inventory_rows.csv')); R['m'] = -R.R * R.s                       # signed first-hour move in ADR units
R['wk'] = pd.to_datetime(R.date).dt.strftime('%G-%V'); R['sD'] = R.s * R.D; R = R.sort_values('date').reset_index(drop=True)

# 1. completeness: overnight minutes per session (18:00 previous calendar day to 09:29 = 930 minutes when complete)
nmin = []
for d in R.date:
    n = 0
    for r in csv.DictReader(open(os.path.join(REPO, 'scratch', 'updown_1m_20261104', d + '.csv'))):
        if r['ts'][:10] == d and r['ts'][11:16] >= '09:30': break
        n += 1
    nmin.append(n)
R['nmin'] = nmin; full = R.nmin.quantile(.5)
print(f'overnight minutes per session: median {full:.0f}, min {R.nmin.min()}, sessions below 90 percent of the median: {int((R.nmin < 0.9 * full).sum())} of {len(R)}')
print(f'explore-era median ADR {R.adr.median():.1f} points (p10 {R.adr.quantile(.1):.0f}, p90 {R.adr.quantile(.9):.0f}); 0.131 ADR = {0.131 * R.adr.median():.0f} points at the median')

# 2. the numbers disclosed inline before (now committed)
toward = np.sign(R.D) * R.m
print(f'\nmean first-hour move toward the overnight VWAP {toward.mean():+.4f} ADR (sd {toward.std():.3f}, N {len(R)})')
R['it'] = pd.qcut(R.I.abs().rank(method='first'), 3, labels=['low', 'mid', 'high'])
print('share of sessions that open underwater (S>0) by |I| tercile: ' + ' '.join(f'{k} {v:.3f}' for k, v in R.groupby('it', observed=True).apply(lambda x: (x.S > 0).mean()).items()))
g = R[(np.sign(R.gap) == R.s) & (R.gap != 0)].copy(); g['tert'] = pd.qcut(g.gap.abs().rank(method='first'), 3, labels=['small', 'mid', 'large'])
print('aligned-gap fill rate by gap-size tertile and S>0 / S<0 (rate, N): ' + '; '.join(f'{t} {"S>0" if u else "S<0"} {x.filled.mean():.2f} N={len(x)}' for (t, u), x in g.groupby(['tert', g.S > 0], observed=True)))


# 3. T3: m = b0 + b1 D + b2 s + b3 (s D); week-block bootstrap of b3; circular-shift placebo on m
def fit(df, m=None):
    y = df.m.values if m is None else m; X = np.column_stack([np.ones(len(df)), df.D.values, df.s.values, df.sD.values]); return np.linalg.lstsq(X, y, rcond=None)[0]


def week_boot(df):
    idx = list(df.groupby('wk').indices.values()); out = np.empty((B, 4))
    for k in range(B): out[k] = fit(df.iloc[np.concatenate([idx[j] for j in rng.integers(0, len(idx), len(idx))])])
    return out


def analyse(df, label):
    b = fit(df); bs = week_boot(df); ci = np.percentile(bs[:, 3], CIQ); se = bs[:, 3].std(); half = df.date.iloc[len(df) // 2]
    h1, h2 = fit(df[df.date < half])[3], fit(df[df.date >= half])[3]
    sh = np.array([fit(df, np.roll(df.m.values, int(rng.integers(10, len(df) - 10))))[3] for _ in range(NSHIFT)]); p97 = np.percentile(np.abs(sh), 97.5)
    lead = (ci[0] > 0 or ci[1] < 0) and np.sign(h1) == np.sign(h2) == np.sign(b[3]) and abs(b[3]) > p97
    print(f'\n{label} (N={len(df)}): detectable |b(s x D)| {2.8 * se:.3f}\n  b(s x D) {b[3]:+.3f} CI [{ci[0]:+.3f}, {ci[1]:+.3f}] | halves {h1:+.3f} / {h2:+.3f} | circular-shift placebo 97.5th pct of |b| {p97:.3f} => ' + ('LEAD' if lead else 'NOT SHOWN')
          + f'\n  reported, not counted: b(D) pull toward the basis {b[1]:+.3f} [{np.percentile(bs[:, 1], (2.5, 97.5))[0]:+.3f}, {np.percentile(bs[:, 1], (2.5, 97.5))[1]:+.3f}]; b(s) inventory sign alone {b[2]:+.3f} [{np.percentile(bs[:, 2], (2.5, 97.5))[0]:+.3f}, {np.percentile(bs[:, 2], (2.5, 97.5))[1]:+.3f}]')


analyse(R, 'T3 all sessions')
analyse(R[R.nmin >= 0.9 * full].reset_index(drop=True), 'T3 sensitivity: sessions with a complete overnight only')
