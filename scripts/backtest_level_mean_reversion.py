import os
import sys
import psycopg2
import pandas as pd
import numpy as np
from statsmodels.tsa.stattools import adfuller
import json
from collections import defaultdict
import datetime
import random

LOOK_FORWARD = 30
PROXIMITY = 15

def load_env():
    env_vars = {}
    with open('/home/mmoniz/trading-journal/.env', 'r') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#'):
                key, val = line.split('=', 1)
                env_vars[key] = val
    return env_vars

def calc_hurst_rs(ts):
    ts = np.array(ts)
    N = len(ts)
    if N < 10: return np.nan
    
    lags = []
    rs_vals = []
    
    for lag in [5, 6, 10, 15, 30]:
        if lag > N: continue
        
        rs_sub = []
        for i in range(0, N, lag):
            sub = ts[i:i+lag]
            if len(sub) == lag:
                s = np.std(sub)
                if s > 1e-6:
                    y = sub - np.mean(sub)
                    z = np.cumsum(y)
                    r = np.max(z) - np.min(z)
                    rs_sub.append(r / s)
        
        if rs_sub:
            rs_vals.append(np.mean(rs_sub))
            lags.append(lag)
            
    if len(lags) > 1:
        slope, _ = np.polyfit(np.log(lags), np.log(rs_vals), 1)
        return slope
    return np.nan

def calc_adf(ts):
    if len(ts) < 15:
        return np.nan, np.nan
    try:
        res = adfuller(ts, maxlag=5, autolag='AIC')
        return res[0], res[1] # stat, p-value
    except:
        return np.nan, np.nan

def process_paths(paths):
    h_vals = []
    adf_stats = []
    adf_pvals = []
    
    for p in paths:
        ts = p['path']
        h = calc_hurst_rs(ts)
        if not np.isnan(h):
            h_vals.append(h)
            
        stat, pval = calc_adf(ts)
        if not np.isnan(pval):
            adf_stats.append(stat)
            adf_pvals.append(pval)
            
    return {
        'N': len(paths),
        'hurst_mean': round(float(np.mean(h_vals)), 4) if h_vals else None,
        'hurst_median': round(float(np.median(h_vals)), 4) if h_vals else None,
        'hurst_lt_0_5_pct': round(100 * sum(1 for h in h_vals if h < 0.5) / len(h_vals), 1) if h_vals else None,
        'adf_pval_mean': round(float(np.mean(adf_pvals)), 4) if adf_pvals else None,
        'adf_reject_pct': round(100 * sum(1 for p in adf_pvals if p < 0.05) / len(adf_pvals), 1) if adf_pvals else None
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
    
    print("Loading EV data...")
    # Get EV for SETUP_STATUS signal types. Sort by run_date DESC to pick the most recent
    query_ev = """
        SELECT signal_name, ev_per_trade 
        FROM (
            SELECT signal_name, ev_per_trade,
                   ROW_NUMBER() OVER(PARTITION BY signal_name ORDER BY run_date DESC) as rn
            FROM performance_audit 
            WHERE signal_type = 'SETUP_STATUS'
        ) t
        WHERE rn = 1
    """
    df_ev = pd.read_sql_query(query_ev, conn)
    ev_dict = dict(zip(df_ev['signal_name'], df_ev['ev_per_trade']))
    
    print("Loading RTH bars...")
    query = """
        SELECT ts::date as date, open, high, low, close
        FROM price_bars_primary
        WHERE EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
        ORDER BY ts ASC
    """
    df_bars = pd.read_sql_query(query, conn)
    df_bars['date'] = pd.to_datetime(df_bars['date']).dt.date
    
    print("Loading level prices...")
    query_lp = """
        SELECT trade_date, level_name, price::float as price
        FROM level_prices
        WHERE trade_date <= CURRENT_DATE
    """
    df_lp = pd.read_sql_query(query_lp, conn)
    lp_dict = defaultdict(dict)
    for _, row in df_lp.iterrows():
        lp_dict[row['trade_date']][row['level_name']] = row['price']
        
    grouped_bars = df_bars.groupby('date')
    
    all_touches = []
    baseline_paths = []
    processed_days = 0
    np.random.seed(42)
    random.seed(42)
    
    for date, group in grouped_bars:
        processed_days += 1
        if processed_days % 100 == 0:
            print(f"Processing day {processed_days}/{len(grouped_bars)}")
            
        levels = lp_dict.get(date, {})
        bars = group.to_dict('records')
        
        # Sample a few random paths for baseline
        if len(bars) > LOOK_FORWARD + 10:
            for _ in range(3):
                idx = random.randint(0, len(bars) - LOOK_FORWARD - 1)
                path = [bars[j]['close'] for j in range(idx+1, idx+LOOK_FORWARD+1)]
                baseline_paths.append({
                    'date': date,
                    'type': 'RANDOM',
                    'path': path
                })
        
        if len(levels) < 1:
            continue
            
        recent_touches = {}
        
        for i, bar in enumerate(bars):
            for name, level in levels.items():
                if name == 'RTH_VWAP': continue
                
                dist_high = abs(bar['high'] - level)
                dist_low = abs(bar['low'] - level)
                
                # High touch -> SHORT fade
                if dist_high <= PROXIMITY and bar['high'] >= level and i + LOOK_FORWARD < len(bars):
                    key = f"{date}_SHORT_{name}"
                    if key not in recent_touches or i - recent_touches[key] >= 5:
                        recent_touches[key] = i
                        path = [bars[j]['close'] for j in range(i+1, i+LOOK_FORWARD+1)]
                        all_touches.append({
                            'date': date,
                            'level_name': name,
                            'direction': 'SHORT',
                            'path': path
                        })
                        
                # Low touch -> LONG fade
                if dist_low <= PROXIMITY and bar['low'] <= level and i + LOOK_FORWARD < len(bars):
                    key = f"{date}_LONG_{name}"
                    if key not in recent_touches or i - recent_touches[key] >= 5:
                        recent_touches[key] = i
                        path = [bars[j]['close'] for j in range(i+1, i+LOOK_FORWARD+1)]
                        all_touches.append({
                            'date': date,
                            'level_name': name,
                            'direction': 'LONG',
                            'path': path
                        })
                        
    print(f"Total individual touches evaluated: {len(all_touches)}")
    
    # Process paths per level
    recent_start = datetime.date(2026, 6, 12)
    recent_end = datetime.date(2026, 7, 13)
    
    def process_groups(touches_list):
        grouped = defaultdict(list)
        for t in touches_list:
            grouped[(t['level_name'], t['direction'])].append(t)
            
        results = []
        for (level_name, direction), paths in grouped.items():
            if len(paths) < 20: continue
            stats = process_paths(paths)
            
            # lookup EV
            setup_name = f"{level_name}_FADE_{direction}"
            ev = ev_dict.get(setup_name, None)
            
            stats['level_name'] = level_name
            stats['direction'] = direction
            stats['setup_name'] = setup_name
            stats['ev_per_trade'] = float(ev) if ev is not None else None
            
            results.append(stats)
            
        return results

    all_time_results = process_groups(all_touches)
    recent_touches = [t for t in all_touches if recent_start <= t['date'] <= recent_end]
    recent_results = process_groups(recent_touches)
    
    # Sort and rank all-time
    all_time_sorted = sorted(all_time_results, key=lambda x: (x['hurst_mean'] is None, x['hurst_mean']))
    lowest_hurst_all = all_time_sorted[:10]
    highest_hurst_all = sorted(all_time_results, key=lambda x: (x['hurst_mean'] is None, -x['hurst_mean'] if x['hurst_mean'] is not None else 0))[:10]
    
    # Sort and rank recent
    recent_sorted = sorted(recent_results, key=lambda x: (x['hurst_mean'] is None, x['hurst_mean']))
    lowest_hurst_recent = recent_sorted[:10]
    highest_hurst_recent = sorted(recent_results, key=lambda x: (x['hurst_mean'] is None, -x['hurst_mean'] if x['hurst_mean'] is not None else 0))[:10]

    baseline_all = process_paths(baseline_paths)
    baseline_recent = process_paths([p for p in baseline_paths if recent_start <= p['date'] <= recent_end])

    res = {
        'all_time': {
            'BASELINE_RANDOM': baseline_all,
            'lowest_hurst_10': lowest_hurst_all,
            'highest_hurst_10': highest_hurst_all,
            'full_results': all_time_results
        },
        'recent_window': {
            'BASELINE_RANDOM': baseline_recent,
            'lowest_hurst_10': lowest_hurst_recent,
            'highest_hurst_10': highest_hurst_recent,
            'full_results': recent_results
        }
    }
    
    out_file = '/home/mmoniz/trading-journal/scratch/level_mean_reversion_findings.json'
    with open(out_file, 'w') as f:
        json.dump(res, f, indent=2)
        
    print(f"Results saved to {out_file}")

if __name__ == "__main__":
    main()
