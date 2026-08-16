import numpy as np
import pandas as pd
from structural_runner_optimization import optimize_structural_system

print("Generating synthetic trades...")
np.random.seed(42)

def generate_synthetic_trade(is_runner=False):
    n_bars = 100
    if is_runner:
        steps = np.random.normal(0.4, 0.8, n_bars) # Upward drift
    else:
        steps = np.random.normal(-0.1, 1.2, n_bars) # Chop / downward
        
    prices = 100 + np.cumsum(steps)
    
    highs = prices + np.abs(np.random.normal(0, 0.5, n_bars))
    lows = prices - np.abs(np.random.normal(0, 0.5, n_bars))
    
    # Ensure high >= open/close and low <= open/close
    opens = prices
    closes = prices + np.random.normal(0, 0.2, n_bars)
    highs = np.maximum(highs, np.maximum(opens, closes))
    lows = np.minimum(lows, np.minimum(opens, closes))
    
    df = pd.DataFrame({
        'open': opens,
        'high': highs,
        'low': lows,
        'close': closes,
    })
    
    df['entry_price'] = prices[0]
    df['r0'] = 2.0  # $2 initial risk
    return df

trades = []
# 20 runners, 80 chops
for _ in range(20):
    trades.append(generate_synthetic_trade(is_runner=True))
for _ in range(80):
    trades.append(generate_synthetic_trade(is_runner=False))

print(f"Prepared {len(trades)} synthetic trades.")
print("Starting structural optimizer...")
try:
    result = optimize_structural_system(trades)
    print("\n✅ OPTIMIZATION COMPLETE")
    for k, v in result.items():
        print(f"  {k}: {v}")
except Exception as e:
    import traceback
    print(f"\n❌ ERROR:")
    traceback.print_exc()
