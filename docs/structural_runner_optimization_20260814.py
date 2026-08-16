import psycopg2
import pandas as pd
import numpy as np
from scipy.optimize import differential_evolution
from typing import List, Dict

def fetch_trade_bars_from_db(
    conn_string: str,
    trade_ids: List[int],
    max_bars_post_entry: int = 200
) -> Dict[int, pd.DataFrame]:
    """
    Fetches 1-min OHLCV bars for each trade_id from PostgreSQL.
    Note: Requires schema adaptation to extract entry_price and r0 from custom_fields JSONB.
    """
    conn = psycopg2.connect(conn_string)
    
    placeholders = ','.join(['%s'] * len(trade_ids))
    meta_query = f"""
        SELECT 
            trade_id, 
            entry_time, 
            entry_price, 
            r0
        FROM trades 
        WHERE trade_id IN ({placeholders})
        ORDER BY trade_id;
    """
    trades_df = pd.read_sql(meta_query, conn, params=trade_ids)
    
    trade_dfs = {}
    with conn.cursor() as cur:
        for _, row in trades_df.iterrows():
            trade_id = row['trade_id']
            entry_time = row['entry_time']
            entry_price = float(row['entry_price'])
            r0 = float(row['r0'])
            
            bars_query = """
                SELECT 
                    bar_time,
                    open, 
                    high, 
                    low, 
                    close
                FROM price_bars_primary
                WHERE symbol = %s 
                  AND bar_time >= %s
                ORDER BY bar_time ASC
                LIMIT %s;
            """
            bars_df = pd.read_sql(bars_query, conn, params=(row['symbol'], entry_time, max_bars_post_entry))
            
            if bars_df.empty:
                continue
                
            bars_df['entry_price'] = entry_price
            bars_df['r0'] = r0
            trade_dfs[trade_id] = bars_df
            
    conn.close()
    return trade_dfs


def compute_structural_stop_anchors(
    highs: np.ndarray, 
    lows: np.ndarray, 
    pivot_threshold: float
) -> np.ndarray:
    """
    Returns an array `stop_anchors` of shape (n_bars,).
    stop_anchors[t] = the structural swing low level confirmed as of bar t.
    """
    n = len(highs)
    stop_anchors = np.full(n, np.nan, dtype=np.float64)
    
    if n < 3:
        return stop_anchors
    
    current_anchor = lows[0]
    current_trend = 'downtrend'
    last_peak = highs[0]
    last_trough = lows[0]
    
    for t in range(1, n):
        current_high = highs[t]
        current_low = lows[t]
        
        if current_trend == 'downtrend':
            if current_low < last_trough:
                last_trough = current_low
                current_anchor = last_trough
            elif current_high > last_peak * (1 + pivot_threshold):
                current_trend = 'uptrend'
                last_peak = current_high
        else:
            if current_high > last_peak:
                last_peak = current_high
            elif current_low < last_trough * (1 - pivot_threshold):
                current_trend = 'downtrend'
                last_trough = current_low
                current_anchor = last_trough
                
        stop_anchors[t] = current_anchor
        
    stop_anchors[0] = stop_anchors[1] if n > 1 else lows[0]
    return pd.Series(stop_anchors).ffill().to_numpy()


class TradePathStructural:
    __slots__ = ('opens', 'highs', 'lows', 'closes', 'entry', 'r0', 'n_bars', 'mfe_full', 'stop_anchors')
    
    def __init__(self, df: pd.DataFrame, pivot_threshold: float):
        self.opens = df['open'].to_numpy(dtype=np.float64)
        self.highs = df['high'].to_numpy(dtype=np.float64)
        self.lows = df['low'].to_numpy(dtype=np.float64)
        self.closes = df['close'].to_numpy(dtype=np.float64)
        self.entry = float(df['entry_price'].iloc[0])
        self.r0 = float(df['r0'].iloc[0])
        self.n_bars = len(self.opens)
        self.mfe_full = (np.max(self.highs) - self.entry) / self.r0
        
        self.stop_anchors = compute_structural_stop_anchors(
            self.highs, self.lows, pivot_threshold
        )


def simulate_structural_trade(
    trade: TradePathStructural, 
    tick_offset: float,
    activation_r: float
) -> float:
    entry = trade.entry
    r0 = trade.r0
    n = trade.n_bars
    
    initial_stop = entry - r0
    current_stop = initial_stop
    trailing_active = False
    cum_high = entry
    
    for t in range(n):
        if trade.lows[t] <= current_stop:
            exit_price = trade.opens[t] if trade.opens[t] < current_stop else current_stop
            return (exit_price - entry) / r0

        cum_high = max(cum_high, trade.highs[t])
        current_mfe = (cum_high - entry) / r0
        
        if not trailing_active and current_mfe >= activation_r:
            trailing_active = True
            
        if trailing_active:
            anchor_idx = max(0, t - 1)
            structural_low = trade.stop_anchors[anchor_idx]
            
            if not np.isnan(structural_low):
                candidate_stop = structural_low - tick_offset
                current_stop = max(current_stop, candidate_stop)
            
    return (trade.closes[-1] - entry) / r0


class StructuralObjectiveWrapper:
    """Callable class wrapper to enable multiprocessing pickling during DE."""
    def __init__(self, trade_dataframes):
        self.trade_dataframes = trade_dataframes
        
    def __call__(self, params):
        pivot_threshold = params[0]
        tick_offset = params[1]  
        activation_r = params[2]
        
        compiled = [TradePathStructural(df, pivot_threshold) for df in self.trade_dataframes]
        
        r_all = np.array([
            simulate_structural_trade(t, tick_offset * t.r0, activation_r) 
            for t in compiled
        ])
        
        mean_all = np.mean(r_all)
        runner_mask = np.array([t.mfe_full >= 3.0 for t in compiled])
        mean_runner = np.mean(r_all[runner_mask]) if np.any(runner_mask) else 0.0

        excess_losses = r_all[r_all < -0.5] - (-0.5)
        downside_dev = np.sqrt(np.mean(excess_losses**2)) if len(excess_losses) > 0 else 0.0

        p5_threshold = np.percentile(r_all, 5.0)
        worst_tail = r_all[r_all <= p5_threshold]
        tail_cvar = abs(np.mean(worst_tail)) if len(worst_tail) > 0 else 0.0

        utility = (mean_all + (0.35 * mean_runner)) - (1.5 * (downside_dev + (0.30 * tail_cvar)))
        return -utility


def optimize_structural_system(
    trade_dataframes: List[pd.DataFrame],
    max_activation_cap: float = 3.0
) -> Dict[str, float]:
    bounds = [
        (0.003, 0.06),  
        (0.005, 0.25),  
        (1.2, max_activation_cap)
    ]
    
    wrapper = StructuralObjectiveWrapper(trade_dataframes)
        
    result = differential_evolution(
        func=wrapper,
        bounds=bounds,
        strategy='best1bin',
        maxiter=30,
        popsize=10,
        seed=42,
        workers=-1
    )
    
    return {
        "best_pivot_threshold": round(result.x[0], 4),
        "best_tick_offset_pct_r": round(result.x[1] * 100, 2),  
        "best_activation_r": round(result.x[2], 2),
        "optimized_score": round(-result.fun, 4)
    }
