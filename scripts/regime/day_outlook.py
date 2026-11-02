"""DAY outlook at 09:25 ET (docs/REGIME_GAUGE_20261102.md): expected RTH range and bucket from information known before 09:25. Stores one row per date in regime_outlook (the first run of a date wins; features never use anything after 09:24).
Usage: ../../venv/bin/python day_outlook.py [YYYY-MM-DD] [--no-store]"""
import sys, json
import numpy as np
import regime_lib as RL
def main():
    conn = RL.connect(); cur = conn.cursor(); args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if args: d = args[0]
    else: cur.execute("SELECT CURRENT_DATE::text"); d = cur.fetchone()[0]      # trading dates come from SQL CURRENT_DATE (the DB is America/New_York), never a JS or UTC date
    p, cut, rows, done, preds = RL.live_model(conn, upto=d); tr = [r for r in rows if r['date'] == d]
    if not tr: print(f'{d}: cannot build the outlook (no pre-open bars or no baseline)'); return 2
    r = tr[0]; pl = RL.predict(p, r); ratio = float(np.exp(pl)); pts = ratio * r['atr']; b = RL.bucket(pl, cut); typical = float(np.median([x['rng'] for x in done[-60:]]))
    feat = dict(pdr_atr=r['pdr'] / r['atr'], overnight_range_atr=(r['raw']['h'] - r['raw']['l']) / r['atr'], overnight_vol_log_ratio=r['onv'], gap_pre_atr=abs(r['raw']['pre'] - r['raw']['pc']) / r['atr'], dow=r['dow'])
    print(f'DAY OUTLOOK {d} (known at 09:25 ET): expected RTH range {pts:.0f} points ({ratio:.2f} x ATR20 {r["atr"]:.0f}); typical recent day {typical:.0f} points (median of the last 60); bucket {b} (cutoffs {cut["q33"]:+.3f} / {cut["q67"]:+.3f} on the log scale)')
    print(f'  features: overnight range {feat["overnight_range_atr"]:.2f} ATR, overnight volume {np.exp(feat["overnight_vol_log_ratio"]):.2f}x its 20-day average, prior-day range {feat["pdr_atr"]:.2f} ATR, pre-open gap {feat["gap_pre_atr"]:.2f} ATR')
    print(f'  meaning: an average day in this bucket moves about ${pts * 2:,.0f} per MNQ contract from the day low to the high; the model is a small ridge on the overnight range plus volume and calendar (out-of-sample rank correlation about 0.42); it says HOW BIG, not which way; it does not place or change any order.')
    if '--no-store' not in sys.argv:
        cur.execute("""INSERT INTO regime_outlook (trade_date, model_version, features, pred_log, atr20_pts, expected_range_pts, ratio_to_atr20, bucket, cutoffs) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (trade_date) DO NOTHING""", (d, p['version'], json.dumps(feat), pl, r['atr'], pts, ratio, b, json.dumps(cut))); conn.commit(); print(f'  stored in regime_outlook ({"new row" if cur.rowcount else "already stored earlier, not overwritten"})')
    conn.close(); return 0
if __name__ == '__main__': sys.exit(main())
