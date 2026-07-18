import psycopg2
import pandas as pd
import numpy as np
from arch import arch_model
import json
import datetime

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

def main():
    print("Loading DB...")
    env_vars = load_env()
    conn = psycopg2.connect(
        host=env_vars.get('DB_HOST', 'localhost'), port=env_vars.get('DB_PORT', '5432'),
        dbname=env_vars.get('DB_NAME', 'trading_journal'), user=env_vars.get('DB_USER', 'trader'),
        password=env_vars.get('DB_PASSWORD', 'trader123'))
    conn.autocommit = True
    cursor = conn.cursor()

    print("Loading daily RTH bars for GARCH...")
    # symbol='NQ' is required -- price_bars_primary has documented ES contamination
    # 2023-11-16 to 2023-12-14 (docs/OPEN_THREADS.md data-sanity audit). Without this
    # filter, that month's daily OHLC mixes ES (~4000-5000) and NQ (~15000-20000+)
    # bars together, producing nonsense ranges right inside the GARCH walk-forward
    # warmup window -- and since the fit uses an expanding window, that corrupted
    # month stays in every subsequent day's training history forever. Found 2026-07-18
    # while investigating why every fitted alpha[1] came back ~0.
    query = """
        SELECT ts::date as date, open, high, low, close
        FROM price_bars_primary
        WHERE symbol = 'NQ'
          AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
        ORDER BY ts ASC
    """
    df_bars = pd.read_sql_query(query, conn)
    daily = df_bars.groupby('date').agg({'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last'}).reset_index()
    daily['date'] = pd.to_datetime(daily['date']).dt.date
    daily.set_index('date', inplace=True)
    daily['log_ret'] = np.log(daily['close'] / daily['close'].shift(1)) * 100
    daily.dropna(inplace=True)

    print(f"Loaded {len(daily)} trading days. Fitting GARCH walk-forward...")
    returns = daily['log_ret']
    dates = daily.index.tolist()
    
    garch_records = []
    scales = []
    # Numerical safeguard: when 1-alpha-beta is near zero (near-unit-root/IGARCH fit),
    # unc_vol = sqrt(omega/(1-alpha-beta)) blows up or collapses -- not a real signal,
    # a known degeneracy of this formula. Found 2026-07-18: real data shows a clean
    # bimodal split (44/317 days with 1-alpha-beta ~0, the rest sitting at 0.07-0.13
    # with a real gap between the two clusters) rather than a continuum, so this
    # threshold sits in that gap, not picked by feel. On a degenerate day, carry
    # forward the most recent VALID day's unc_vol instead of trusting that day's own
    # blown-up value.
    PERSISTENCE_FLOOR = 0.02
    last_valid_unc_vol = None

    for i in range(GARCH_WARMUP_DAYS, len(dates)):
        d = dates[i]
        hist_ret = returns.iloc[:i]
        am = arch_model(hist_ret, vol='Garch', p=1, q=1, dist='Normal', rescale=False)
        degenerate = False
        try:
            res = am.fit(disp='off')
            fcast = res.forecast(horizon=1, align='origin')
            pred_vol = np.sqrt(fcast.variance.iloc[-1, 0])
            omega = res.params.get('omega', 0)
            alpha = res.params.get('alpha[1]', 0)
            beta = res.params.get('beta[1]', 0)
            persistence_gap = 1 - alpha - beta
            if persistence_gap > PERSISTENCE_FLOOR:
                unc_vol = np.sqrt(omega / persistence_gap)
                last_valid_unc_vol = unc_vol
            elif last_valid_unc_vol is not None:
                unc_vol = last_valid_unc_vol
                degenerate = True
            else:
                unc_vol = pred_vol  # no valid history yet (very early days only)
                degenerate = True
            scale = pred_vol / unc_vol
        except Exception:
            pred_vol = 1.0
            unc_vol = last_valid_unc_vol if last_valid_unc_vol is not None else 1.0
            scale = pred_vol / unc_vol
            alpha = None
            beta = None
            degenerate = True

        scales.append(scale)
        garch_records.append((d, pred_vol, unc_vol, scale, alpha, beta, degenerate))
        if i % 100 == 0:
            print(f"GARCH progress: {i}/{len(dates)}  alpha={alpha}  beta={beta}  degenerate={degenerate}")

    p01 = np.percentile(scales, 1)
    p99 = np.percentile(scales, 99)
    print(f"1st percentile scale: {p01:.4f}")
    print(f"99th percentile scale: {p99:.4f}")

    today_str = datetime.date.today().isoformat()

    print("Upserting into performance_audit...")
    for d, pred_vol, unc_vol, scale, alpha, beta, degenerate in garch_records:
        notes_json = json.dumps({
            'trade_date': str(d),
            'forecast_vol': float(pred_vol),
            'unc_vol': float(unc_vol),
            'scale': float(scale),
            'alpha': float(alpha) if alpha is not None else None,
            'beta': float(beta) if beta is not None else None,
            'degenerate_fallback': bool(degenerate),
        })
        cursor.execute("""
            INSERT INTO performance_audit (
                run_date, window_days, signal_type, signal_name, sample_size, notes
            ) VALUES (%s, 0, 'GARCH_VOL_SCALE', %s, 1, %s)
            ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
                notes = EXCLUDED.notes
        """, (today_str, str(d), notes_json))
    
    print("Backfill complete.")

if __name__ == "__main__":
    main()
