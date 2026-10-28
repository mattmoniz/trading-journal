"""Placebo diagnostic (NOT a hypothesis test): the user's proposed first target (+65 points) on RANDOM entries, with several stop sizes,
realistic fills, to show what that exit geometry does when entries carry no edge. Entries: 20 per full RTH session at random minutes 10:00-14:00,
random direction (seed 20261028). Fill model: entry = next bar open + 1 tick adverse; stop gaps fill at the bar open, else at the stop; target fills at the level;
1 tick adverse slippage on every exit; flatten at the 15:58 bar open; MNQ $2/pt, $2 round trip. Usage: ../../venv/bin/python exit_placebo_diagnostic.py"""
import sys
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/macro_regime')
import numpy as np, pandas as pd
from loader import load_raw_sessions
TICK, TARGET, ENTRIES, COMM, DPP = 0.25, 65.0, 20, 2.0, 2.0
rng = np.random.default_rng(20261028)
S = load_raw_sessions(end='2026-10-27')
days = [d for d in sorted(S) if len(S[d]) >= 385 and S[d].index[0].strftime('%H:%M') == '09:30' and S[d].index[-1].strftime('%H:%M') == '15:59']
def arrays(df):
    off = (df.index.hour * 60 + df.index.minute - 570).to_numpy(); a = {k: np.full(390, np.nan) for k in 'ohlc'}
    for k, c in zip('ohlc', ('Open', 'High', 'Low', 'Close')): a[k][off] = df[c].to_numpy(float)
    return a
def sim(a, m, d, stop_pts):
    e = m + 1
    if np.isnan(a['o'][e]): return None
    entry = a['o'][e] + d * TICK; stop = entry - d * stop_pts; tgt = entry + d * TARGET
    for i in range(e, 389):
        if np.isnan(a['o'][i]): continue
        o, h, l = a['o'][i], a['h'][i], a['l'][i]
        if d == 1:
            if i > e and o <= stop: return (o - TICK - entry), 'stop'
            if l <= stop: return (stop - TICK - entry), 'stop'
            if i > e and o >= tgt: return (o - TICK - entry), 'target'
            if h >= tgt: return (tgt - TICK - entry), 'target'
        else:
            if i > e and o >= stop: return -(o + TICK - entry), 'stop'
            if h >= stop: return -(stop + TICK - entry), 'stop'
            if i > e and o <= tgt: return -(o + TICK - entry), 'target'
            if l <= tgt: return -(tgt + TICK - entry), 'target'
    o = a['o'][388] if not np.isnan(a['o'][388]) else a['c'][387]
    return d * (o - d * TICK - entry), 'flat'
print(f"sessions {len(days)}, entries per session {ENTRIES}, target +{TARGET:.0f} points, costs: 1 tick/side slippage + $2 round trip (= {COMM / DPP:.2f} pt commission)")
print(f"{'stop':>5} {'zero-drift win%':>16} {'win%':>6} {'target%':>8} {'stop%':>6} {'flat%':>6} {'mean pts net':>13} {'mean $/trade':>13} {'(session-clustered SE pts)':>27}")
A = {d: arrays(S[d]) for d in days}
starts = {d: rng.integers(30, 270, ENTRIES) for d in days}; dirs = {d: rng.choice([-1, 1], ENTRIES) for d in days}
for sp in (30, 40, 65, 100):
    pts, kinds, sm = [], [], []
    for d in days:
        sess = []
        for m, dr in zip(starts[d], dirs[d]):
            r = sim(A[d], int(m), int(dr), sp)
            if r: sess.append(r[0] - COMM / DPP); pts.append(r[0] - COMM / DPP); kinds.append(r[1])
        sm.append(np.mean(sess))
    k = pd.Series(kinds).value_counts(normalize=True) * 100
    win = np.mean(np.array(pts) > 0) * 100
    print(f"{sp:5d} {100 * sp / (sp + TARGET):15.1f}% {win:5.1f}% {k.get('target', 0):7.1f}% {k.get('stop', 0):5.1f}% {k.get('flat', 0):5.1f}% {np.mean(pts):13.2f} {np.mean(pts) * DPP:13.2f} {np.std(sm) / np.sqrt(len(sm)):27.2f}")
