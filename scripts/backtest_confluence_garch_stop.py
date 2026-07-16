import os
import sys
import psycopg2
import pandas as pd
import numpy as np
from arch import arch_model
import json
from collections import defaultdict
import datetime
import math

PNL_PER_POINT = 2
COMMISSION = 1
PROXIMITY = 15
LOOK_FORWARD = 30
FADE_TARGET = 30
FIXED_STOP = 120

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
        g1 = events[:third]
        g2 = events[third:2*third]
        g3 = events[2*third:]
        
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
    return {
        'distinctDates': len(per_day),
        'top5DayPct': top5_pct,
        'clustered': clustered,
        'stable': stable,
        'thirds': thirds,
        'clean': clean
    }

def main():
    print("Loading DB...")
    env_vars = load_env()
    conn = psycopg2.connect(
        host=env_vars.get('DB_HOST', 'localhost'),
        port=env_vars.get('DB_PORT', '5432'),
        dbname=env_vars.get('DB_NAME', 'trading_journal'),
        user=env_vars.get('DB_USER', 'trader'),
        password=env_vars.get('DB_PASSWORD', 'trader123')
    )
    
    # Load daily RTH stats for GARCH
    print("Loading daily bars for GARCH...")
    query = """
        SELECT ts::date as date, open, high, low, close
        FROM price_bars_primary
        WHERE EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
        ORDER BY ts ASC
    """
    df_bars = pd.read_sql_query(query, conn)
    
    # We need daily OHLC of the RTH session
    daily = df_bars.groupby('date').agg({
        'open': 'first',
        'high': 'max',
        'low': 'min',
        'close': 'last'
    }).reset_index()
    daily['date'] = pd.to_datetime(daily['date']).dt.date
    daily.set_index('date', inplace=True)
    daily['log_ret'] = np.log(daily['close'] / daily['close'].shift(1)) * 100
    daily.dropna(inplace=True)
    
    is_150_mode = len(sys.argv) > 1 and sys.argv[1] == '--last-150'
    if is_150_mode:
        daily = daily.iloc[-150:]
        min_date = daily.index.min()
        df_bars = df_bars[pd.to_datetime(df_bars['date']).dt.date >= min_date]
        
    print(f"Loaded {len(daily)} trading days. Fitting GARCH models walk-forward...")
    # Walk-forward GARCH
    garch_vol = {}
    returns = daily['log_ret']
    
    # Fit initial model on first 100 days
    min_days = 100
    dates = daily.index.tolist()
    
    # Fit periodically to save time, e.g. refit every 5 days, forecast 1-step ahead
    # The prompt allows walk-forward/expanding window refit.
    # To strictly avoid lookahead, we only use data up to day d-1 to forecast day d.
    # For performance, we can refit every 5 days and use the parameters to forecast the intermediate days,
    # or just fit daily. I will fit daily for maximum rigor.
    baseline_vol = None
    
    for i in range(min_days, len(dates)):
        d = dates[i]
        hist_ret = returns.iloc[:i]
        
        # Fit GARCH(1,1)
        # Suppress warnings
        am = arch_model(hist_ret, vol='Garch', p=1, q=1, dist='Normal', rescale=False)
        try:
            res = am.fit(disp='off')
            # One step ahead forecast (for day i)
            fcast = res.forecast(horizon=1, align='origin')
            # variance is in fcast.variance
            pred_var = fcast.variance.iloc[-1, 0]
            pred_vol = np.sqrt(pred_var)
            
            # Unconditional variance = omega / (1 - alpha - beta)
            omega = res.params.get('omega', 0)
            alpha = res.params.get('alpha[1]', 0)
            beta = res.params.get('beta[1]', 0)
            if (1 - alpha - beta) > 0:
                unc_var = omega / (1 - alpha - beta)
                unc_vol = np.sqrt(unc_var)
            else:
                unc_vol = pred_vol # fallback
            
            if baseline_vol is None:
                baseline_vol = unc_vol
                
            garch_vol[d] = {
                'forecast_vol': pred_vol,
                'baseline_vol': unc_vol, # Can use a rolling long-term average as well
                'scale': pred_vol / baseline_vol
            }
        except Exception as e:
            # If fit fails, default to scale=1.0
            garch_vol[d] = {
                'forecast_vol': baseline_vol if baseline_vol else 1.0,
                'baseline_vol': baseline_vol if baseline_vol else 1.0,
                'scale': 1.0
            }
        
        if i % 100 == 0:
            print(f"GARCH progress: {i}/{len(dates)}")
            
    print("GARCH complete. Loading exact touch events...")
    
    # Load level prices
    query_lp = """
        SELECT trade_date, level_name, price::float as price
        FROM level_prices
        WHERE trade_date <= CURRENT_DATE
    """
    df_lp = pd.read_sql_query(query_lp, conn)
    lp_dict = defaultdict(dict)
    for _, row in df_lp.iterrows():
        lp_dict[row['trade_date']][row['level_name']] = row['price']
        
    df_bars['date'] = pd.to_datetime(df_bars['date']).dt.date
    
    all_touches = []
    
    # Group by date for intraday processing
    grouped_bars = df_bars.groupby('date')
    
    processed_days = 0
    for date, group in grouped_bars:
        processed_days += 1
        if processed_days % 100 == 0:
            print(f"Processing day {processed_days}/{len(grouped_bars)}: {date}")
            
        levels = lp_dict.get(date, {})
        if len(levels) < 5:
            continue
            
        # Get garch info
        g_info = garch_vol.get(date)
        if not g_info:
            continue
            
        scale = g_info['scale']
        scaled_stop = FIXED_STOP * scale
        
        bars = group.to_dict('records')
        touched_levels = set()
        recent_touches = {}
        
        for i, bar in enumerate(bars):
            nearby_high = []
            nearby_low = []
            
            for name, level in levels.items():
                # exclude RTH_VWAP as in JS
                if name == 'RTH_VWAP': continue
                
                dist_high = abs(bar['high'] - level)
                dist_low = abs(bar['low'] - level)
                
                if dist_high <= PROXIMITY and bar['high'] >= level:
                    nearby_high.append((name, level, dist_high))
                if dist_low <= PROXIMITY and bar['low'] <= level:
                    nearby_low.append((name, level, dist_low))
                    
            # High touches (SHORT)
            if nearby_high and i + LOOK_FORWARD < len(bars):
                conf = len(nearby_high)
                if conf >= 3:
                    primary = sorted(nearby_high, key=lambda x: x[2])[0]
                    entry = bar['close']
                    
                    mfe = 0
                    mae = 0
                    for j in range(i+1, min(i+LOOK_FORWARD+1, len(bars))):
                        mfe = max(mfe, entry - bars[j]['low'])
                        mae = min(mae, entry - bars[j]['high'])
                    mae = abs(mae)
                    
                    names = "+".join(sorted([x[0] for x in nearby_high]))
                    key = f"{date}_SHORT_{names}"
                    
                    if key not in recent_touches or i - recent_touches[key] >= 5:
                        recent_touches[key] = i
                        all_touches.append({
                            'date': date,
                            'direction': 'SHORT',
                            'conf': conf,
                            'mae': mae,
                            'mfe': mfe,
                            'fixed_stop': FIXED_STOP,
                            'scaled_stop': scaled_stop,
                            'scale': scale
                        })
                        
            # Low touches (LONG)
            if nearby_low and i + LOOK_FORWARD < len(bars):
                conf = len(nearby_low)
                if conf >= 3:
                    primary = sorted(nearby_low, key=lambda x: x[2])[0]
                    entry = bar['close']
                    
                    mfe = 0
                    mae = 0
                    for j in range(i+1, min(i+LOOK_FORWARD+1, len(bars))):
                        mfe = max(mfe, bars[j]['high'] - entry)
                        mae = min(mae, bars[j]['low'] - entry)
                    mae = abs(mae)
                    
                    names = "+".join(sorted([x[0] for x in nearby_low]))
                    key = f"{date}_LONG_{names}"
                    
                    if key not in recent_touches or i - recent_touches[key] >= 5:
                        recent_touches[key] = i
                        all_touches.append({
                            'date': date,
                            'direction': 'LONG',
                            'conf': conf,
                            'mae': mae,
                            'mfe': mfe,
                            'fixed_stop': FIXED_STOP,
                            'scaled_stop': scaled_stop,
                            'scale': scale
                        })
                        
    print(f"Collected {len(all_touches)} TRIPLE+ touches.")
    
    # Define recent window
    if is_150_mode:
        recent_start = daily.index[-50]
        recent_end = daily.index[-1]
    else:
        recent_start = datetime.date(2026, 6, 12)
        recent_end = datetime.date(2026, 7, 13)
    
    eval_window_touches = [t for t in all_touches if recent_start <= t['date'] <= recent_end]
    
    # GARCH scale stats for the last 50 days
    eval_dates = daily.index[-50:]
    eval_scales = [garch_vol[d]['scale'] for d in eval_dates if d in garch_vol]
    if eval_scales:
        scale_stats = {
            'min': round(float(np.min(eval_scales)), 3),
            'max': round(float(np.max(eval_scales)), 3),
            'median': round(float(np.median(eval_scales)), 3),
            'daily': {str(d): round(float(garch_vol[d]['scale']), 3) for d in eval_dates if d in garch_vol}
        }
    else:
        scale_stats = {}
    
    def calc_ev(events, stop_type='fixed'):
        w = 0
        l = 0
        pnl = 0
        for e in events:
            stop = e['fixed_stop'] if stop_type == 'fixed' else e['scaled_stop']
            if e['mae'] >= stop:
                # Stopped out
                l += 1
                pnl -= (stop * PNL_PER_POINT + COMMISSION)
            elif e['mfe'] >= FADE_TARGET:
                # Target hit
                w += 1
                pnl += (FADE_TARGET * PNL_PER_POINT - COMMISSION)
            else:
                # No trigger
                pass
        return pnl / len(events) if events else 0, w, l, pnl

    def pnl_fn(e, stop_type='fixed'):
        stop = e['fixed_stop'] if stop_type == 'fixed' else e['scaled_stop']
        if e['mae'] >= stop:
            return -(stop * PNL_PER_POINT + COMMISSION)
        elif e['mfe'] >= FADE_TARGET:
            return (FADE_TARGET * PNL_PER_POINT - COMMISSION)
        return 0
        
    triple_all = [t for t in all_touches if t['conf'] == 3]
    quad_all = [t for t in all_touches if t['conf'] >= 4]
    
    triple_recent = [t for t in triple_all if recent_start <= t['date'] <= recent_end]
    quad_recent = [t for t in quad_all if recent_start <= t['date'] <= recent_end]
    
    res = {
        'all_time': {},
        'recent': {}
    }
    
    for name, events in [('TRIPLE', triple_all), ('QUAD_PLUS', quad_all)]:
        if not events: continue
        ev_fixed, w_f, l_f, pnl_f = calc_ev(events, 'fixed')
        ev_scaled, w_s, l_s, pnl_s = calc_ev(events, 'scaled')
        
        rigor_fixed = compute_rigor(events, lambda e: pnl_fn(e, 'fixed'))
        rigor_scaled = compute_rigor(events, lambda e: pnl_fn(e, 'scaled'))
        
        res['all_time'][name] = {
            'N': len(events),
            'fixed': {'ev': round(ev_fixed, 2), 'wins': w_f, 'losses': l_f, 'pnl': pnl_f, 'rigor': rigor_fixed},
            'scaled': {'ev': round(ev_scaled, 2), 'wins': w_s, 'losses': l_s, 'pnl': pnl_s, 'rigor': rigor_scaled}
        }
        
    for name, events in [('TRIPLE', triple_recent), ('QUAD_PLUS', quad_recent)]:
        if not events: continue
        ev_fixed, w_f, l_f, pnl_f = calc_ev(events, 'fixed')
        ev_scaled, w_s, l_s, pnl_s = calc_ev(events, 'scaled')
        
        res['recent'][name] = {
            'N': len(events),
            'fixed': {'ev': round(ev_fixed, 2), 'wins': w_f, 'losses': l_f, 'pnl': pnl_f},
            'scaled': {'ev': round(ev_scaled, 2), 'wins': w_s, 'losses': l_s, 'pnl': pnl_s}
        }
        
    if is_150_mode:
        res['scale_stats_last_50'] = scale_stats
        out_file = '/home/mmoniz/trading-journal/scratch/confluence_garch_100_50_window.json'
    else:
        out_file = '/home/mmoniz/trading-journal/scratch/confluence_garch_stop_findings.json'
        
    with open(out_file, 'w') as f:
        json.dump(res, f, indent=2)
        
    print(f"Results saved to {os.path.basename(out_file)}")

if __name__ == "__main__":
    main()
