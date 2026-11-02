"""S-LIMIT structure of PREREG_FORECAST_BRACKET.md: a two-sided LIMIT fade bracket on 500-volume bars. Mirror of scripts/amt_vbars/run_bracket.py `bracket` (same slip, window, flatten and order-of-checks conventions) with limits instead of stops.
Rules (all from the prereg): reference P = close of bar i; buy limit at P - k, sell limit at P + k; both live for W seconds after bar i's end; the first to FILL cancels the other. A limit fills only if price trades THROUGH it by one tick (no queue credit) and fills AT the limit price (no price improvement credited).
After a fill: target = back to P (needs a trade-through of one tick), stop = k beyond the fill (loss k plus one tick slip, a gap fills at the open), time exit W after the fill bar's end (close, one tick adverse), flatten at the 15:55 open (one tick adverse).
A bar that reaches BOTH limits is AMBIGUOUS and scored as the worst case, a stop-out (-(k + slip)). Within a post-fill bar the order of checks is flatten, stop, target, time (stop before target = worst case).
Returns (net dollars or None for no fill, ambiguous flag, best_case_net): best_case_net equals net except for ambiguous bars, where it scores the physically consistent best case (the first-filled side reaches its target P) for the uncounted sensitivity."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'amt_vbars'))
import trade as T
TICK, SLIP, DPP, COMM, FLAT = T.TICK, T.SLIP, T.DPP, T.COMM, T.FLAT_S


def limit_bracket(S, i, k, W):
    o, h, l, c, end, start = S['o'], S['h'], S['l'], S['c'], S['end'], S['start']; n = len(c); P = c[i]; Lb, Ls = P - k, P + k; t0 = end[i]
    for j in range(i + 1, n):
        if start[j] >= FLAT or end[j] - t0 > W: return None, False, None
        fb, fs = l[j] <= Lb - TICK, h[j] >= Ls + TICK
        if fb and fs: return -(k + SLIP) * DPP - COMM, True, k * DPP - COMM
        if not (fb or fs): continue
        d = 1 if fb else -1; ent = Lb if fb else Ls; stop = ent - d * k; target = P; tf = end[j]
        net = lambda px: (((px - d * SLIP) - ent) * d) * DPP - COMM          # market-style exit with one tick adverse
        if (d == 1 and l[j] <= stop) or (d == -1 and h[j] >= stop):           # stop traded in the fill bar itself (the fill came first on the way)
            px = min(stop, o[j]) if d == 1 else max(stop, o[j]); v = net(px); return v, False, v
        for m in range(j + 1, n):
            if start[m] >= FLAT: v = net(o[m]); return v, False, v
            if (d == 1 and l[m] <= stop) or (d == -1 and h[m] >= stop):
                px = min(stop, o[m]) if d == 1 else max(stop, o[m]); v = net(px); return v, False, v
            if (d == 1 and h[m] >= target + TICK) or (d == -1 and l[m] <= target - TICK):
                v = (target - ent) * d * DPP - COMM; return v, False, v         # a resting limit exit: at its price, no slip
            if end[m] - tf >= W: v = net(c[m]); return v, False, v
        v = net(c[n - 1]); return v, False, v
    return None, False, None
