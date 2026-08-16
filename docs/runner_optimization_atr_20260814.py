import numpy as np
import pandas as pd
from scipy.optimize import differential_evolution
from typing import List, Dict

class TradePath:
    """
    High-throughput memory container with an O(1) rolling high lookback cache.
    """
    __slots__ = (
        'opens', 'highs', 'lows', 'closes', 'atrs', 
        'entry', 'r0', 'mfe_full', 'n_bars', 'rolling_highs'
    )
    
    def __init__(self, df: pd.DataFrame, max_lookback: int = 25):
        self.opens = df['open'].to_numpy(dtype=np.float64)
        self.highs = df['high'].to_numpy(dtype=np.float64)
        self.lows = df['low'].to_numpy(dtype=np.float64)
        self.closes = df['close'].to_numpy(dtype=np.float64)
        self.atrs = df['atr'].to_numpy(dtype=np.float64)
        self.entry = float(df['entry_price'].iloc[0])
        self.r0 = float(df['r0'].iloc[0])
        self.n_bars = len(self.opens)
        self.mfe_full = (np.max(self.highs) - self.entry) / self.r0
        
        # Precomputed rolling lookback matrix: Shape (max_lookback + 1, n_bars)
        self.rolling_highs = np.empty((max_lookback + 1, self.n_bars), dtype=np.float64)
        highs_series = pd.Series(self.highs)
        for lb in range(1, max_lookback + 1):
            self.rolling_highs[lb, :] = highs_series.rolling(lb, min_periods=1).max().to_numpy()


def simulate_trade_fast(
    trade: TradePath, 
    atr_mult: float, 
    lookback: int, 
    activation_r: float
) -> float:
    """
    Strictly non-leaky execution:
    - Decouples bar t execution from bar t ratchet.
    - O(1) rolling high anchor lookups.
    """
    entry = trade.entry
    r0 = trade.r0
    n = trade.n_bars
    
    initial_stop = entry - r0
    current_stop = initial_stop
    trailing_active = False
    cum_high = entry
    
    for t in range(n):
        # 1. Execution Check on Open / Low
        if trade.lows[t] <= current_stop:
            exit_price = trade.opens[t] if trade.opens[t] < current_stop else current_stop
            return (exit_price - entry) / r0

        # 2. State & Anchor Updates for next bar
        cum_high = max(cum_high, trade.highs[t])
        current_mfe = (cum_high - entry) / r0
        
        if not trailing_active and current_mfe >= activation_r:
            trailing_active = True
            
        if trailing_active:
            anchor_high = trade.rolling_highs[lookback, t]
            candidate_stop = anchor_high - (atr_mult * trade.atrs[t])
            current_stop = max(current_stop, candidate_stop)
            
    return (trade.closes[-1] - entry) / r0


def utility_fitness_objective(
    params: np.ndarray, 
    trades: List[TradePath], 
    alpha: float = 0.35, 
    gamma: float = 1.5,
    beta: float = 0.30,
    hurdle: float = -0.5
) -> float:
    """
    Smooth, coherent optimization objective:
    - Hurdled semi-deviation ignores friction noise above hurdle (-0.5R).
    - CVaR (Expected Shortfall) averages the entire worst 5% tail.
    """
    atr_mult, lookback_f, activation_r = params
    lookback = int(round(lookback_f))
    
    n_trades = len(trades)
    r_all = np.empty(n_trades, dtype=np.float64)
    runner_indices = []
    
    for i in range(n_trades):
        t = trades[i]
        r_val = simulate_trade_fast(t, atr_mult, lookback, activation_r)
        r_all[i] = r_val
        if t.mfe_full >= 3.0:
            runner_indices.append(i)
            
    mean_all = np.mean(r_all)
    mean_runner = np.mean(r_all[runner_indices]) if runner_indices else 0.0
    
    # 1. Hurdled Downside Semi-Deviation
    excess_losses = r_all[r_all < hurdle] - hurdle
    downside_dev = np.sqrt(np.mean(excess_losses**2)) if len(excess_losses) > 0 else 0.0
    
    # 2. 5% Expected Shortfall (CVaR)
    p5_threshold = np.percentile(r_all, 5.0)
    worst_tail = r_all[r_all <= p5_threshold]
    tail_cvar = abs(np.mean(worst_tail)) if len(worst_tail) > 0 else 0.0
    
    # Additive Utility
    utility = (mean_all + (alpha * mean_runner)) - (gamma * (downside_dev + (beta * tail_cvar)))
    
    return -utility


def optimize_runner_system(
    trade_dataframes: List[pd.DataFrame], 
    max_lookback_cap: int = 20
) -> Dict[str, float]:
    """
    Runs Differential Evolution over the dynamically bounded parameter space.
    """
    compiled_trades = [TradePath(df, max_lookback=max_lookback_cap) for df in trade_dataframes]
    
    # Bound activation threshold dynamically by empirical 70th percentile MFE
    mfe_dist = [t.mfe_full for t in compiled_trades]
    p70_mfe = float(np.percentile(mfe_dist, 70.0))
    max_act_bound = max(1.5, min(p70_mfe, 3.5))
    
    bounds = [
        (1.5, 4.5),                  # ATR Multiplier
        (2.0, float(max_lookback_cap)), # Lookback Window
        (1.2, max_act_bound)         # Activation Threshold (R)
    ]
    
    result = differential_evolution(
        func=utility_fitness_objective,
        bounds=bounds,
        args=(compiled_trades, 0.35, 1.5, 0.30, -0.5),
        strategy='best1bin',
        maxiter=35,
        popsize=12,
        mutation=(0.5, 1.0),
        recombination=0.7,
        seed=42,
        workers=-1
    )
    
    best_atr, best_lb, best_act = result.x
    
    return {
        "best_atr_multiplier": round(best_atr, 2),
        "best_lookback_bars": int(round(best_lb)),
        "best_activation_threshold_r": round(best_act, 2),
        "empirical_p70_activation_cap": round(max_act_bound, 2),
        "optimized_utility_score": round(-result.fun, 4)
    }
