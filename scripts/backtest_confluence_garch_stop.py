"""
Canonical GARCH(1,1) walk-forward volatility-scaled stop backtest for the
TRIPLE+/QUAD_PLUS confluence-zone edge (server/routes/keyLevels.js
/api/confluence/today-zones, rendered in src/App.jsx's Confluence Zones card).

Consolidated 2026-07-18 from what had drifted into inconsistent behavior across
repeated ad-hoc parameter edits during the original 2026-07-15/16 mining session
(a `--last-150` mode that truncated the GARCH fit to only 100 warmup days before
evaluating, and a hardcoded absolute `recent_start`/`recent_end` date pair that
went stale within days of being written). Both fixed here:

  - GARCH is now ALWAYS fit on the full expanding-window history (min 100 days
    warmup, refit daily through the most recent available day) -- the
    short-window `--last-150` mode was already diagnosed in
    docs/OPEN_THREADS.md as noisier/less reliable (a GARCH model fit on only
    ~100 days is a worse forecast than one fit on years of data), so there is
    no longer a "canonical" reason to keep it as an option.
  - "Recent" evaluation windows are now computed dynamically as the trailing
    22 and 50 TRADING days from whatever the latest available date is, not a
    hardcoded calendar date pair -- matches this codebase's existing
    "last 22 sessions" convention (already used in App.jsx's confluence card
    copy) instead of introducing a new one.

Touch-detection parameters (PROXIMITY=15, LOOK_FORWARD=30, FADE_TARGET=30,
FIXED_STOP=120) are unchanged and were re-verified against
scripts/backtest_confluence.js and keyLevels.js's live zone-clustering logic
before this consolidation -- all three agree on PROXIMITY=15 and LOOK_FORWARD=30
directly; FIXED_STOP=120 matches keyLevels.js's own comment ("the only stop
distance where SINGLE/DOUBLE/TRIPLE/QUAD_PLUS all passed computeRigor's
clean:true check simultaneously").

Run: scratch/.venv/bin/python scripts/backtest_confluence_garch_stop.py
Output: scratch/confluence_garch_stop_findings.json
This is a backtest script (per this codebase's convention) -- it is not
imported by the running app and does not write to any live table. The GARCH-
scaled stop is a real, validated finding (see docs/OPEN_THREADS.md) but is NOT
wired into acd.js's live sizeMultiplier -- that would be a separate,
deliberate promotion step, not done here.
"""
import psycopg2
import pandas as pd
import numpy as np
from arch import arch_model
import json
from collections import defaultdict

PNL_PER_POINT = 2
COMMISSION = 1
PROXIMITY = 15
LOOK_FORWARD = 30
FADE_TARGET = 30
FIXED_STOP = 120
GARCH_WARMUP_DAYS = 100


def load_env():
    env_vars = {}
    with open('/home/mmoniz/trading-journal/.env', 'r') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#'):
                key, val = line.split('=', 1)
                env_vars[key] = val
    return env_vars


def compute_rigor(events, pnl_fn):
    if not events:
        return {'distinctDates': 0, 'top5DayPct': None, 'stable': None, 'thirds': None, 'clustered': False, 'clean': None}
    per_day = defaultdict(int)
    for e in events:
        per_day[e['date']] += 1
    counts = sorted(per_day.values(), reverse=True)
    top5 = sum(counts[:5])
    top5_pct = round(100 * top5 / len(events), 1)
    clustered = top5_pct > 50
    third = len(events) // 3
    stable = None
    thirds = None
    if third >= 5:
        g1, g2, g3 = events[:third], events[third:2 * third], events[2 * third:]
        ev1 = sum(pnl_fn(e) for e in g1) / len(g1)
        ev2 = sum(pnl_fn(e) for e in g2) / len(g2)
        ev3 = sum(pnl_fn(e) for e in g3) / len(g3)
        overall = sum(pnl_fn(e) for e in events)
        overall_sign = 1 if overall > 0 else (-1 if overall < 0 else 0)
        s1 = 1 if ev1 > 0 else (-1 if ev1 < 0 else 0)
        s2 = 1 if ev2 > 0 else (-1 if ev2 < 0 else 0)
        s3 = 1 if ev3 > 0 else (-1 if ev3 < 0 else 0)
        stable = (s1 == overall_sign) and (s2 == overall_sign) and (s3 == overall_sign)
        thirds = {'ev1': round(ev1, 2), 'ev2': round(ev2, 2), 'ev3': round(ev3, 2)}
    clean = (stable is True) and not clustered
    return {'distinctDates': len(per_day), 'top5DayPct': top5_pct, 'clustered': clustered,
            'stable': stable, 'thirds': thirds, 'clean': clean}


def main():
    print("Loading DB...")
    env_vars = load_env()
    conn = psycopg2.connect(
        host=env_vars.get('DB_HOST', 'localhost'), port=env_vars.get('DB_PORT', '5432'),
        dbname=env_vars.get('DB_NAME', 'trading_journal'), user=env_vars.get('DB_USER', 'trader'),
        password=env_vars.get('DB_PASSWORD', 'trader123'))

    print("Loading daily RTH bars for GARCH...")
    query = """
        SELECT ts::date as date, open, high, low, close
        FROM price_bars_primary
        WHERE EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
        ORDER BY ts ASC
    """
    df_bars = pd.read_sql_query(query, conn)
    daily = df_bars.groupby('date').agg({'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last'}).reset_index()
    daily['date'] = pd.to_datetime(daily['date']).dt.date
    daily.set_index('date', inplace=True)
    daily['log_ret'] = np.log(daily['close'] / daily['close'].shift(1)) * 100
    daily.dropna(inplace=True)

    print(f"Loaded {len(daily)} trading days. Fitting GARCH walk-forward (full expanding window, {GARCH_WARMUP_DAYS}-day warmup)...")
    garch_vol = {}
    returns = daily['log_ret']
    dates = daily.index.tolist()
    baseline_vol = None

    for i in range(GARCH_WARMUP_DAYS, len(dates)):
        d = dates[i]
        hist_ret = returns.iloc[:i]  # strictly < day i, no lookahead
        am = arch_model(hist_ret, vol='Garch', p=1, q=1, dist='Normal', rescale=False)
        try:
            res = am.fit(disp='off')
            fcast = res.forecast(horizon=1, align='origin')
            pred_vol = np.sqrt(fcast.variance.iloc[-1, 0])
            omega = res.params.get('omega', 0)
            alpha = res.params.get('alpha[1]', 0)
            beta = res.params.get('beta[1]', 0)
            if (1 - alpha - beta) > 0:
                unc_vol = np.sqrt(omega / (1 - alpha - beta))
            else:
                unc_vol = pred_vol
            if baseline_vol is None:
                baseline_vol = unc_vol
            garch_vol[d] = {'forecast_vol': pred_vol, 'baseline_vol': unc_vol, 'scale': pred_vol / baseline_vol}
        except Exception:
            garch_vol[d] = {'forecast_vol': baseline_vol if baseline_vol else 1.0,
                             'baseline_vol': baseline_vol if baseline_vol else 1.0, 'scale': 1.0}
        if i % 100 == 0:
            print(f"GARCH progress: {i}/{len(dates)}")

    print("GARCH complete. Loading level touches...")
    query_lp = "SELECT trade_date, level_name, price::float as price FROM level_prices WHERE trade_date <= CURRENT_DATE"
    df_lp = pd.read_sql_query(query_lp, conn)
    lp_dict = defaultdict(dict)
    for _, row in df_lp.iterrows():
        lp_dict[row['trade_date']][row['level_name']] = row['price']

    df_bars['date'] = pd.to_datetime(df_bars['date']).dt.date
    all_touches = []
    grouped_bars = df_bars.groupby('date')
    processed_days = 0

    for date, group in grouped_bars:
        processed_days += 1
        if processed_days % 100 == 0:
            print(f"Processing day {processed_days}/{len(grouped_bars)}: {date}")
        levels = lp_dict.get(date, {})
        if len(levels) < 5:
            continue
        g_info = garch_vol.get(date)
        if not g_info:
            continue
        scale = g_info['scale']
        scaled_stop = FIXED_STOP * scale
        bars = group.to_dict('records')
        recent_touches = {}

        for i, bar in enumerate(bars):
            nearby_high, nearby_low = [], []
            for name, level in levels.items():
                if name == 'RTH_VWAP':
                    continue
                dist_high = abs(bar['high'] - level)
                dist_low = abs(bar['low'] - level)
                if dist_high <= PROXIMITY and bar['high'] >= level:
                    nearby_high.append((name, level, dist_high))
                if dist_low <= PROXIMITY and bar['low'] <= level:
                    nearby_low.append((name, level, dist_low))

            for nearby, direction in [(nearby_high, 'SHORT'), (nearby_low, 'LONG')]:
                if not nearby or i + LOOK_FORWARD >= len(bars):
                    continue
                conf = len(nearby)
                if conf < 3:
                    continue
                entry = bar['close']
                mfe = mae = 0
                for j in range(i + 1, min(i + LOOK_FORWARD + 1, len(bars))):
                    if direction == 'SHORT':
                        mfe = max(mfe, entry - bars[j]['low'])
                        mae = min(mae, entry - bars[j]['high'])
                    else:
                        mfe = max(mfe, bars[j]['high'] - entry)
                        mae = min(mae, bars[j]['low'] - entry)
                mae = abs(mae)
                names = "+".join(sorted([x[0] for x in nearby]))
                key = f"{date}_{direction}_{names}"
                if key not in recent_touches or i - recent_touches[key] >= 5:
                    recent_touches[key] = i
                    all_touches.append({'date': date, 'direction': direction, 'conf': conf, 'mae': mae,
                                         'mfe': mfe, 'fixed_stop': FIXED_STOP, 'scaled_stop': scaled_stop, 'scale': scale})

    print(f"Collected {len(all_touches)} TRIPLE+ touches.")

    def calc_ev(events, stop_type):
        w = l = 0
        pnl = 0
        for e in events:
            stop = e['fixed_stop'] if stop_type == 'fixed' else e['scaled_stop']
            if e['mae'] >= stop:
                l += 1
                pnl -= (stop * PNL_PER_POINT + COMMISSION)
            elif e['mfe'] >= FADE_TARGET:
                w += 1
                pnl += (FADE_TARGET * PNL_PER_POINT - COMMISSION)
        return (pnl / len(events) if events else 0), w, l, pnl

    def pnl_fn(e, stop_type):
        stop = e['fixed_stop'] if stop_type == 'fixed' else e['scaled_stop']
        if e['mae'] >= stop:
            return -(stop * PNL_PER_POINT + COMMISSION)
        elif e['mfe'] >= FADE_TARGET:
            return (FADE_TARGET * PNL_PER_POINT - COMMISSION)
        return 0

    # Dynamic trailing windows -- last 22 and last 50 TRADING days from whatever
    # the latest available date is, never a hardcoded absolute date.
    trading_dates_sorted = sorted(dates)
    window_defs = {
        'last_22': set(trading_dates_sorted[-22:]),
        'last_50': set(trading_dates_sorted[-50:]),
    }

    triple_all = [t for t in all_touches if t['conf'] == 3]
    quad_all = [t for t in all_touches if t['conf'] >= 4]

    def tier_report(events):
        ev_fixed, w_f, l_f, pnl_f = calc_ev(events, 'fixed')
        ev_scaled, w_s, l_s, pnl_s = calc_ev(events, 'scaled')
        return {
            'N': len(events),
            'fixed': {'ev': round(ev_fixed, 2), 'wins': w_f, 'losses': l_f, 'pnl': round(pnl_f, 2),
                      'rigor': compute_rigor(events, lambda e: pnl_fn(e, 'fixed'))},
            'scaled': {'ev': round(ev_scaled, 2), 'wins': w_s, 'losses': l_s, 'pnl': round(pnl_s, 2),
                       'rigor': compute_rigor(events, lambda e: pnl_fn(e, 'scaled'))},
        }

    res = {'all_time': {}, 'last_22': {}, 'last_50': {}}
    for name, events in [('TRIPLE', triple_all), ('QUAD_PLUS', quad_all)]:
        if not events:
            continue
        res['all_time'][name] = tier_report(events)
        for wkey, wdates in window_defs.items():
            res[wkey][name] = tier_report([t for t in events if t['date'] in wdates])

    for wkey, wdates in window_defs.items():
        wdates_sorted = sorted(wdates)
        scales = [garch_vol[d]['scale'] for d in wdates_sorted if d in garch_vol]
        res[f'{wkey}_scale_stats'] = {
            'min': round(float(np.min(scales)), 3) if scales else None,
            'max': round(float(np.max(scales)), 3) if scales else None,
            'median': round(float(np.median(scales)), 3) if scales else None,
            'date_range': [str(wdates_sorted[0]), str(wdates_sorted[-1])] if wdates_sorted else None,
        }

    out_file = '/home/mmoniz/trading-journal/scratch/confluence_garch_stop_findings.json'
    with open(out_file, 'w') as f:
        json.dump(res, f, indent=2)
    print(f"Results saved to confluence_garch_stop_findings.json")
    print(json.dumps({k: v for k, v in res.items() if k in ('all_time', 'last_22', 'last_50')}, indent=2, default=str))


if __name__ == "__main__":
    main()
