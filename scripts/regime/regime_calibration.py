"""Nightly: fill the realized RTH range into regime_outlook for completed dates and print COUNTS until 30 realized outlooks exist, then the calibration (mean realized range by bucket) as a monitor. Never changes the model; fail-soft (always exit 0). docs/REGIME_GAUGE_20261102.md"""
import sys, numpy as np
import regime_lib as RL
def main():
    conn = RL.connect(); cur = conn.cursor()
    cur.execute("""UPDATE regime_outlook o SET realized_range_pts = s.rth_range, realized_ratio = s.rth_range / o.atr20_pts FROM daily_rth_stats s WHERE s.trade_date = o.trade_date AND s.n_bars >= 371 AND o.realized_range_pts IS NULL"""); n_upd = cur.rowcount; conn.commit()
    cur.execute("SELECT count(*), count(realized_range_pts) FROM regime_outlook"); tot, real = cur.fetchone(); print(f'regime gauge: {tot} outlooks stored, {real} with the realized range (filled {n_upd} tonight); calibration is printed from 30 realized outlooks.')
    if real >= 30:
        cur.execute("SELECT bucket, count(*), avg(realized_range_pts), avg(realized_ratio) FROM regime_outlook WHERE realized_range_pts IS NOT NULL GROUP BY bucket ORDER BY 1"); print('calibration (mean realized range by bucket): ' + '; '.join(f'{b} N {n} mean {m:.0f} pts ({r:.2f} ATR)' for b, n, m, r in cur.fetchall()))
    conn.close()
if __name__ == '__main__':
    try: main()
    except Exception as e: print('regime_calibration: FAILED', repr(e)[:200])
    sys.exit(0)
