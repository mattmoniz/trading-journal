"""TPO (time-at-price) profile and value area for one RTH session's 1-minute arrays. PREREG_TPO.md frozen."""
import numpy as np
TICK = 0.25

def tpo_profile(a, row=1.0, pct=0.70):
    h, l = a['h'], a['l']; spans = []
    for b in range(13):
        hh, ll = h[b * 30:b * 30 + 30], l[b * 30:b * 30 + 30]
        if np.all(np.isnan(hh)) or np.all(np.isnan(ll)): continue
        spans.append((int(np.floor(np.nanmin(ll) / row + 1e-9)), int(np.floor(np.nanmax(hh) / row + 1e-9))))
    if not spans: return None
    base = min(s[0] for s in spans); n = max(s[1] for s in spans) - base + 1; cnt = np.zeros(n)
    for lo, hi in spans: cnt[lo - base:hi - base + 1] += 1
    total = cnt.sum(); mid = (n - 1) / 2.0; best = cnt.max()
    cand = [r for r in range(n) if cnt[r] == best]; poc = min(cand, key=lambda r: (abs(r - mid), r))
    lo_i = hi_i = poc; acc = cnt[poc]
    while acc < pct * total and (hi_i < n - 1 or lo_i > 0):
        up = cnt[hi_i + 1:hi_i + 3].sum() if hi_i < n - 1 else -1.0
        dn = cnt[max(lo_i - 2, 0):lo_i].sum() if lo_i > 0 else -1.0
        if up >= dn and hi_i < n - 1: acc += cnt[hi_i + 1:hi_i + 3].sum(); hi_i = min(hi_i + 2, n - 1)
        else: acc += cnt[max(lo_i - 2, 0):lo_i].sum(); lo_i = max(lo_i - 2, 0)
    return dict(vah=(base + hi_i + 1) * row - TICK, val=(base + lo_i) * row, poc=(base + poc) * row, total=total)
