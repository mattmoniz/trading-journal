"""NOW reading (docs/REGIME_GAUGE_20261102.md Part 2): rebuilds today's 500-contract bars from the live tick file (the nightly tagger's builder, about 3 s), takes the CHAMPION 30-minute forecast at the last complete bar and prints expected travel, its bucket,
the RTH range so far against the day outlook, and the data age. Read-only, no order, no server restart. Usage: ../../venv/bin/python regime_now.py [YYYY-MM-DD]"""
import sys, os, json, datetime
_a = sys.argv[:]; sys.argv = sys.argv[:1]
import numpy as np
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_tell_live'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_context'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_vbars')
import persist, bootstrap, core, vbars as V, forecast_features as FF, forecast_train as FT
sys.argv = _a
CUT = '/home/mmoniz/trading-journal/scratch/regime_now_cutoffs.json'

def champion(conn):
    cur = conn.cursor(); cur.execute("SELECT version, params FROM forecast_models WHERE role='CHAMPION' AND horizon_min=30"); v, p = cur.fetchone(); return v, (p if isinstance(p, dict) else json.loads(p))

def now_cutoffs(version, params):
    """terciles of the champion's out-of-sample 30-minute forecasts over the explore period (walk-forward no-tell design), cached per champion version."""
    if os.path.exists(CUT):
        c = json.load(open(CUT))
        if c.get('version') == version: return c
    import walkforward_forecast as WF
    df = FT.explore_frame(30); dates = [str(x) for x in sorted(df.date.unique())]; pos = {d: k for k, d in enumerate(dates)}; R = df[df.date.map(lambda d: WF.block_of(pos[d]) is not None)].copy(); R['blk'] = R.date.map(lambda d: WF.block_of(pos[d])); lf = WF.block_forecasts(df, dates, R)
    c = dict(version=version, q33=float(np.quantile(lf, 1 / 3)), q67=float(np.quantile(lf, 2 / 3)), n=int(len(lf))); json.dump(c, open(CUT, 'w')); return c

def main():
    conn = persist.connect(); cur = conn.cursor(); args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if args: d = args[0]
    else: cur.execute("SELECT CURRENT_DATE::text"); d = cur.fetchone()[0]
    sess, ok, info = bootstrap.build_sessions(conn, d, ['split'])
    if sess is None: print(f'{d}: cannot rebuild today\'s bars ({info})'); return 2
    s = sess['split']; prior, _ = persist.load_prior_stats(conn, d, 'split'); bars = s.finished_bars(); ctx = core.build_ctx(bars, d, prior)
    if ctx is None: print(f'{d}: no baseline yet'); return 3
    S = ctx['S']; end, comp = S['end'], S['comp']; rth = comp & (end >= V.RTH_OPEN) & (end <= V.RTH_CLOSE)
    if not rth.any(): print(f'{d}: no complete RTH bar yet (the NOW reading starts after 09:30 ET)'); return 0
    ts = float(end[rth][-1]); dow = datetime.date.fromisoformat(d).weekday(); row = FF.activity_row(ctx, ts, dow)
    if row is None: print(f'{d}: not enough bars for a reading yet'); return 0
    rng = float((S['h'][rth].max() - S['l'][rth].min())); clock0 = (datetime.datetime.combine(datetime.date.fromisoformat(d) - datetime.timedelta(days=1), datetime.time(18, 0)) + datetime.timedelta(seconds=ts))
    if not (V.DEC_FIRST <= ts <= V.DEC_LAST):    # the champion was trained on 10:00-14:30 ET only: outside it the model would extrapolate (a 15:59 reading once printed a 364-point 30-minute move), so it stays silent
        print(f'NOW READING {d}: the last complete bar ended {clock0.strftime("%H:%M:%S")} ET, outside the model\'s trained window (10:00-14:30 ET), so no 30-minute reading is given. RTH range so far {rng:.0f} points.'); conn.close(); return 0
    ver, params = champion(conn); lf, val = FF.predict(params, row); cut = now_cutoffs(ver, params); b = 'QUIET' if lf <= cut['q33'] else ('BUSY' if lf >= cut['q67'] else 'NORMAL'); atr = ctx['atr']
    clock = (datetime.datetime.combine(datetime.date.fromisoformat(d) - datetime.timedelta(days=1), datetime.time(18, 0)) + datetime.timedelta(seconds=ts)); now = datetime.datetime.now(); age_min = (now - clock).total_seconds() / 60.0
    cur.execute("SELECT expected_range_pts, bucket FROM regime_outlook WHERE trade_date=%s", (d,)); o = cur.fetchone()
    print(f'NOW READING {d}: last complete 500-contract bar ended {clock.strftime("%H:%M:%S")} ET (data age {age_min:.0f} min; the session data {"validated against the database volume" if ok else "NOT validated (live partial day)"})')
    print(f'  next 30 minutes: expected travel {val * atr:.0f} points ({val:.2f} ATR20 {atr:.0f}), bucket {b} (champion {ver}; explore terciles {cut["q33"]:+.2f} / {cut["q67"]:+.2f} on the log scale)')
    print(f'  RTH range so far {rng:.0f} points' + (f' against the day outlook {o[0]:.0f} points ({o[1]}): {100 * rng / o[0]:.0f}% of the expected range used' if o else ' (no day outlook stored for today: run day_outlook.py before 09:30 to store one)'))
    print('  reads HOW BIG, never which way; no order is placed or changed.'); conn.close(); return 0
if __name__ == '__main__': sys.exit(main())
