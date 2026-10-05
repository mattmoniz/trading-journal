"""Weekly forward check of the hourly volume-build magnitude effect.

Claim under test (RESEARCH_CLAIM hourly_volume_build_next60m_excursion_descriptive_20261004):
an hour's volume build, measured against the same hour-of-day over the prior 20 sessions,
predicts a larger max excursion over the next 60 minutes than that hour's own trailing
same-hour baseline. Non-directional: this is a magnitude effect, not a trade signal.

Design, fixed on 2026-10-04 and deliberately NOT tuned on the forward data:
- Every baseline and tercile cut uses only data strictly before the hour being scored.
- Hours are scored only if on or after FORWARD_START. Earlier hours are history, used
  only to build the baselines, never reported as forward results.
- Single-contract hours only (a multi-contract hour is a roll-week proxy and is dropped).
- Inference: day-blocked bootstrap CI (one resample unit = trading day).

Persists one performance_audit row per session per run (signal_type='HOURLY_VOLBUILD_FORWARD',
signal_name=RTH|GLOBEX, window_days=0), so each week's result is queryable. Run weekly from
scripts/run_weekly_backtests.sh. Prints N=0 until FORWARD_START has bars.
"""
import sys
import os
import json
from datetime import date

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'ml_meta_labeling'))
from db import get_connection

FORWARD_START = pd.Timestamp('2026-10-05')
HISTORY_START = '2025-08-31'
TERCILE_LOOKBACK_SESSIONS = 20
BOOT_ITERS = 2000
MNQ_USD_PER_POINT = 2.0  # excursion in dollars for 1 MNQ; NOT realized P&L (no direction rule exists)


def load_hours(conn):
    b = pd.read_sql(
        "SELECT ts, contract, high::float h, low::float l, close::float c, volume::float v "
        "FROM price_bars_primary WHERE symbol='NQ' AND ts >= %(s)s ORDER BY ts",
        conn, params={'s': HISTORY_START})
    b['ts'] = pd.to_datetime(b['ts'])
    b = b.drop_duplicates('ts').set_index('ts').sort_index()
    b['hour'] = b.index.floor('h')
    g = b.groupby('hour')
    H = pd.DataFrame({
        'vol': g['v'].sum(), 'hi': g['h'].max(), 'lo': g['l'].min(), 'close': g['c'].last(),
        'nctr': g['contract'].nunique(), 'nbars': g['c'].size(),
    })
    H['hod'] = H.index.hour
    H['date'] = H.index.date
    H['range'] = H['hi'] - H['lo']
    fwd = []
    for t in H.index:
        w = b.loc[t + pd.Timedelta(hours=1): t + pd.Timedelta(hours=2) - pd.Timedelta(minutes=1)]
        if len(w) < 50:
            fwd.append(np.nan)
            continue
        c0 = H.at[t, 'close']
        fwd.append(max(w['h'].max() - c0, c0 - w['l'].min()))
    H['fwd_max_exc'] = fwd
    H = H.dropna(subset=['fwd_max_exc'])
    H = H[(H['nctr'] == 1) & (H['nbars'] >= 50)].sort_index()
    H['session'] = np.where((H['hod'] >= 18) | (H['hod'] < 9), 'GLOBEX', 'RTH')
    return H


def add_trailing_baselines(H):
    vol_z, vol_base_ok, fwd_base = [], [], []
    for idx, row in H.iterrows():
        prior = H[(H['hod'] == row['hod']) & (H.index < idx)].tail(TERCILE_LOOKBACK_SESSIONS)
        if len(prior) < 10:
            vol_z.append(np.nan)
            fwd_base.append(np.nan)
            continue
        s = prior['vol'].std()
        vol_z.append((row['vol'] - prior['vol'].mean()) / s if s and s > 0 else np.nan)
        fwd_base.append(prior['fwd_max_exc'].mean())
    H = H.assign(vol_z=vol_z, fwd_base=fwd_base)
    H = H.dropna(subset=['vol_z', 'fwd_base'])
    H['resid'] = H['fwd_max_exc'] - H['fwd_base']
    return H


def day_block_ci(d, col, rng):
    days = d['date'].unique()
    grp = {k: v[col].values for k, v in d.groupby('date')}
    means = [np.concatenate([grp[x] for x in rng.choice(days, len(days))]).mean() for _ in range(BOOT_ITERS)]
    return np.percentile(means, [2.5, 97.5])


def score_forward(H):
    fwd = H[H.index >= FORWARD_START]
    rng = np.random.default_rng(0)
    out = {}
    for s in ['RTH', 'GLOBEX']:
        d = fwd[fwd['session'] == s]
        if len(d) < 20:
            out[s] = {'n': len(d), 'days': int(d['date'].nunique()), 'high_resid': None,
                      'ci': None, 'low_resid': None}
            continue
        # terciles cut on the forward hours' own vol_z distribution is a forward-data fit,
        # so use the fixed 1/3 and 2/3 cutoffs estimated on the full pre-forward history
        hist = H[(H.index < FORWARD_START) & (H['session'] == s)]
        q = hist['vol_z'].quantile([1/3, 2/3]).values
        hi = d[d['vol_z'] >= q[1]]
        lo = d[d['vol_z'] <= q[0]]
        ci = day_block_ci(hi, 'resid', rng) if len(hi) else [np.nan, np.nan]
        out[s] = {'n': len(d), 'days': int(d['date'].nunique()),
                  'high_resid': float(hi['resid'].mean()) if len(hi) else None,
                  'ci': [float(ci[0]), float(ci[1])],
                  'low_resid': float(lo['resid'].mean()) if len(lo) else None,
                  'high_n': int(len(hi))}
    return out


def persist(conn, results):
    cur = conn.cursor()
    for s, r in results.items():
        ev = r['high_resid']
        cur.execute("""
            INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, ev_per_trade, notes)
            VALUES (%s, 0, 'HOURLY_VOLBUILD_FORWARD', %s, %s, %s, %s)
            ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
              SET sample_size = EXCLUDED.sample_size, ev_per_trade = EXCLUDED.ev_per_trade, notes = EXCLUDED.notes
        """, (date.today(), s, r['n'], ev, json.dumps({
            'forward_start': str(FORWARD_START.date()), **r,
            'high_resid_usd_per_mnq': (r['high_resid'] * MNQ_USD_PER_POINT) if r['high_resid'] is not None else None,
            'excursion_not_pnl': True,
            'method': 'same_hour_trailing_baseline_day_blocked_ci_fixed_terciles',
        })))
    conn.commit()


def main():
    conn = get_connection()
    H = add_trailing_baselines(load_hours(conn))
    results = score_forward(H)
    for s, r in results.items():
        print(f"{s}: forward hours={r['n']} days={r['days']} high-build residual={r['high_resid']} "
              f"CI={r['ci']} low-build residual={r['low_resid']}")
    persist(conn, results)
    conn.close()


if __name__ == '__main__':
    main()
