"""Tables from the fillchar CSVs (descriptive). Usage: python fillchar_report.py"""
import numpy as np, pandas as pd
T = pd.read_csv('/home/mmoniz/trading-journal/scratch/fillchar_triggers_20261103.csv'); L = pd.read_csv('/home/mmoniz/trading-journal/scratch/fillchar_limits_20261103.csv')
print(f"sessions: {T.date.nunique()} dates; trigger rows {len(T)}; limit rows {len(L)}")
# sanity checks that must hold by construction
tr = T[T.trig == 1]; assert (tr.slip >= -1e-9).all(), 'negative slip'; assert (tr.slip1s >= tr.slip - 1e-9).all(), 'worst-in-1s must be >= first print'
lt = L[L.touch == 1]; assert (lt.thru2 <= lt.thru1).all() and (lt.thru1 <= 1).all(); print('sanity checks pass (slip >= 0, worst-in-1s >= first print, through2 <= through1)')
q = lambda x, p: np.nanpercentile(x, p) if len(x) else np.nan
def tab(g):
    s = g[g.trig == 1]; return pd.Series(dict(n=len(g), trig_share=round(len(s) / len(g), 3), slip_med=q(s.slip, 50), p75=q(s.slip, 75), p90=q(s.slip, 90), p95=q(s.slip, 95), p99=q(s.slip, 99), mx=s.slip.max() if len(s) else np.nan,
        worst1s_p95=q(s.slip1s, 95), ge4t=round((s.slip >= 4).mean(), 3) if len(s) else np.nan, ge20t=round((s.slip >= 20).mean(), 3) if len(s) else np.nan, gap_gt1s=round((s.gap > 1).mean(), 3) if len(s) else np.nan))
pd.set_option('display.width', 250); pd.set_option('display.max_columns', 30)
print('\n== STOP/MARKET TRIGGERS: slippage past the trigger at the FIRST print beyond it, in ticks (0.25 pt); worst1s = worst print in the 1 s after; gap_gt1s = share where >1 s passed since the previous print')
print(T.groupby('seg', sort=False).apply(tab).round(2).to_string())
print('\nby session and trigger distance (x session 5-min-range scale)'); print(T.groupby(['sess', 'f']).apply(tab).round(2)[['n', 'trig_share', 'slip_med', 'p90', 'p95', 'p99', 'mx', 'ge4t']].to_string())
T['vol'] = T.groupby('sess').scale.transform(lambda s: pd.qcut(s, 3, labels=['low', 'mid', 'high'], duplicates='drop')) if T.date.nunique() >= 6 else 'all'
print('\nby session volatility tercile (session scale)'); print(T.groupby(['sess', 'vol']).apply(tab).round(2)[['n', 'trig_share', 'slip_med', 'p90', 'p95', 'p99', 'mx', 'ge4t']].to_string())
def ltab(g):
    t = g[g.touch == 1]; return pd.Series(dict(n=len(g), touch=round(len(t) / len(g), 3), thru1_given_touch=round(t.thru1.mean(), 3), thru2_given_touch=round(t.thru2.mean(), 3), vol_at_med=q(t.vol_at, 50), vol_at_p90=q(t.vol_at, 90), t_thru_med_s=q(t.t_thru, 50),
        fwd60_touch_only=round(t[t.thru1 == 0].fwd60.mean(), 3), fwd60_through=round(t[t.thru1 == 1].fwd60.mean(), 3), first_below_p90=q(t.first_below, 90)))
print('\n== RESTING BUY LIMITS below the market: touch = first print at or below; through = a print >= 1 tick (or 2) below within 5 min of the touch; vol_at = lots printed AT the limit before it traded through (queue-ahead proxy); fwd60 = drift 60 s after the touch in scale units (negative = adverse)')
print(L.groupby('seg', sort=False).apply(ltab).round(2).to_string()); print(); print(L.groupby(['sess', 'f']).apply(ltab).round(2).to_string())
