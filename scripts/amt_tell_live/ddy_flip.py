"""DDY delta flip, APPROXIMATE reading (docs/DIRECTION_FEATURE_DICTIONARY_20261101.md Cue A1): 10-bar weighted moving average of per-bar delta (ask minus bid volume), state = its sign,
a flip at bar t = the state changes at t after the previous state lasted at least `streak` bars, direction = the new sign. Reproduces 566 of 786 real flips on the trader's own 2026-10-11..11-01
export (precision 0.71, recall 0.72). ALWAYS call this 'DDY flip (approximate)'. Pure function; the research scripts run_flip_guide.py / run_wait_for_flip.py / run_cue_confluence.py carry the same
logic inline (copied before this module existed); keep them in step if this changes."""
import numpy as np
WMA, STREAK = 10, 10

def ddy_flip_approx(bid, ask, wma=WMA, streak=STREAK):
    """bid, ask: per-bar volume arrays. Returns (flip, prior_run): flip[t] in {-1,0,+1}, prior_run[t] = length of the state that just ended (0 where no flip)."""
    dl = np.asarray(ask, float) - np.asarray(bid, float); n = len(dl); w = np.arange(1, wma + 1, dtype=float); sm = np.full(n, np.nan)
    for i in range(wma - 1, n): sm[i] = dl[i - wma + 1:i + 1] @ w / w.sum()
    flip = np.zeros(n, int); prior = np.zeros(n, int); run = 0; prev = 0
    for i in range(n):
        if np.isnan(sm[i]): continue
        s = 1 if sm[i] > 0 else -1 if sm[i] < 0 else prev
        if prev != 0 and s != prev:
            if run >= streak: flip[i] = s; prior[i] = run
            run = 1
        else: run += 1
        prev = s
    return flip, prior
