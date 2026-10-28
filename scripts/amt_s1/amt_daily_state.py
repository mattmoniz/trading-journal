"""Nightly passive tracker for AMT S1/S2/S3 daily states (PASSIVE_TRACKER_PREREG.md, frozen 2026-10-28).
Idempotent: inserts only sessions not already in amt_daily_state (rows are never rewritten, so definitions stay frozen).
Prints state COUNTS only and 'NO DATA YET' until the pre-registered thresholds; never prints an outcome statistic.
Usage: ../../venv/bin/python amt_daily_state.py"""
import sys, datetime
import numpy as np
import pandas as pd
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/macro_regime')
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/ml_meta_labeling')
from loader import load_raw_sessions, build_prior_va_dict, compute_va_fn  # noqa: E402
from amt_s1 import overnight_ranges  # noqa: E402
from db import get_connection  # noqa: E402

FORWARD_START = '2026-10-27'
INTERIM_N, DECISION_N = 60, 150


def build_rows(end):
    S = load_raw_sessions(end=end); prior, _ = build_prior_va_dict(S)
    ks = sorted(S)
    full = {k: (len(S[k]) >= 385 and S[k].index[0].strftime('%H:%M') == '09:30' and S[k].index[-1].strftime('%H:%M') == '15:59') for k in ks}
    on = overnight_ranges(end=end); rows = []; hist = []
    for i, d in enumerate(ks):
        if not full[d]:
            continue
        df = S[d]; rng = float(df.High.max() - df.Low.min())
        ok = (i > 0 and full[ks[i - 1]] and (pd.Timestamp(d) - pd.Timestamp(ks[i - 1])).days <= 5
              and not np.isnan(prior[d]['vah']) and len(hist) >= 20)
        if ok:
            atr = float(np.mean(hist[-20:])); p = S[ks[i - 1]]; va = prior[d]
            ib = df.between_time('09:30', '10:29')
            if len(ib) == 60 and '10:30' in df.index.strftime('%H:%M'):
                O = float(df.Open.iloc[0]); o1030 = float(df.loc[df.index.strftime('%H:%M') == '10:30', 'Open'].iloc[0])
                ibh, ibl = float(ib.High.max()), float(ib.Low.min())
                iva = compute_va_fn(ib, pct=0.70)
                s1 = 'ABOVE' if O > va['vah'] else ('BELOW' if O < va['val'] else 'INSIDE')
                s2 = None if np.isnan(iva['vah']) else ('MIGRATE_UP' if iva['val'] > va['vah'] else ('MIGRATE_DN' if iva['vah'] < va['val'] else 'OVERLAP'))
                s3 = 'MIGRATE_UP' if ibl > va['vah'] else ('MIGRATE_DN' if ibh < va['val'] else 'OVERLAP')
                o = on.loc[d] if d in on.index else None
                close = float(df.Close.iloc[-1])
                rows.append(dict(trade_date=d, is_forward=d >= FORWARD_START, atr20=atr, prior_vah=va['vah'], prior_val=va['val'],
                                 prior_close=float(p.Close.iloc[-1]), open_0930=O, ib_high=ibh, ib_low=ibl,
                                 ib_va_high=None if np.isnan(iva['vah']) else iva['vah'], ib_va_low=None if np.isnan(iva['val']) else iva['val'],
                                 open_1030=o1030, s1_state=s1, s2_state=s2, s3_state=s3,
                                 gap_atr=(O - float(p.Close.iloc[-1])) / atr,
                                 onr_atr=(float(o.hi - o.lo) / atr) if (o is not None and o.n >= 500) else None,
                                 prng_atr=float(p.High.max() - p.Low.min()) / atr, ibr_atr=(ibh - ibl) / atr, ib_ret_atr=(o1030 - O) / atr,
                                 y_oc=(close - O) / atr, y_1030=(close - o1030) / atr))
        hist.append(rng)
    return rows


def main():
    conn = get_connection(); cur = conn.cursor()
    end = (datetime.date.today() + datetime.timedelta(days=1)).isoformat()
    rows = build_rows(end)
    cur.execute("SELECT trade_date::text FROM amt_daily_state"); have = {r[0] for r in cur.fetchall()}
    new = [r for r in rows if r['trade_date'] not in have]
    cols = list(new[0].keys()) if new else []
    for r in new:
        cur.execute(f"INSERT INTO amt_daily_state ({','.join(cols)}) VALUES ({','.join(['%s'] * len(cols))}) ON CONFLICT DO NOTHING",
                    [None if (isinstance(v, float) and np.isnan(v)) else v for v in r.values()])
    conn.commit()
    print(f"amt_daily_state: {len(rows)} eligible sessions, {len(new)} inserted ({len(have)} already present)")
    cur.execute("""SELECT is_forward, count(*), count(*) FILTER (WHERE s2_state='MIGRATE_UP'), count(*) FILTER (WHERE s2_state='MIGRATE_DN'),
                   count(*) FILTER (WHERE s3_state='MIGRATE_UP'), count(*) FILTER (WHERE s3_state='MIGRATE_DN') FROM amt_daily_state GROUP BY 1 ORDER BY 1""")
    for fwd, n, a, b, c, d in cur.fetchall():
        print(f"  {'FORWARD' if fwd else 'HISTORY'} sessions={n} | S2 up={a} dn={b} | S3 up={c} dn={d}")
        if fwd:
            for name, k in (('S2-UP', a), ('S2-DN', b), ('S3-UP', c), ('S3-DN', d)):
                st = 'NO DATA YET' if k < INTERIM_N else ('interim read allowed (descriptive only)' if k < DECISION_N else 'DECISION LOOK DUE')
                print(f"    {name}: forward state days {k} -> {st}")
    conn.close()


if __name__ == '__main__':
    main()
