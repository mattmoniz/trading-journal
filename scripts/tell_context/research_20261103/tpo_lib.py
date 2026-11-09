"""TPO profile levels by the TradingView TPO rules (shared by carried_levels.py and daytype_forecast.py, hr-022): `tpo` builds the row counts / POC / 70 percent value area from RTH 1-minute bars, `unfinished` returns the poor high / poor low and the single-print zones."""
import numpy as np
TICK = 0.25
def tpo(m, o, h, l):
    """TradingView TPO rules: 30-minute blocks; auto row size = round(((hi - lo) / tick / 80) / inc) * inc ticks with inc 5 (1..100), 50 (100..1000); a row counts one block per bracket in which price traversed it; POC = the row with most blocks (ties: nearest the middle);
    70 percent value area grown one row at a time from the POC adding the larger neighbouring row (ties: the row closer to the POC, then the higher). Returns dict(lo, rs, counts, poc, vah_row, val_row) or None."""
    hi_, lo_ = float(h.max()), float(l.min()); rt = (hi_ - lo_) / TICK / 80.0
    if rt <= 0: return None
    inc = 5 if rt <= 100 else 50; tpr = max(inc, int(round(rt / inc)) * inc) if rt >= 1 else 1; rs = tpr * TICK; nrow = int((hi_ - lo_) / rs) + 1; cnt = np.zeros(nrow)
    for br in np.unique(m // 30):
        k = (m // 30) == br; a = np.floor((l[k] - lo_) / rs).astype(int); z = np.floor((h[k] - lo_) / rs).astype(int); seen = np.zeros(nrow, bool)
        for x, y in zip(a, z): seen[max(0, x):min(nrow - 1, y) + 1] = True
        cnt += seen
    mid = (nrow - 1) / 2; pocs = np.where(cnt == cnt.max())[0]; poc = int(pocs[np.argmin(np.abs(pocs - mid))]); target = 0.7 * cnt.sum(); got = cnt[poc]; a_ = b_ = poc
    while got < target:
        up = cnt[b_ + 1] if b_ + 1 < nrow else -1; dn = cnt[a_ - 1] if a_ - 1 >= 0 else -1
        if up < 0 and dn < 0: break
        if up > dn: b_ += 1; got += up
        elif dn > up: a_ -= 1; got += dn
        else:
            if (b_ + 1 - poc) < (poc - (a_ - 1)): b_ += 1; got += up
            elif (b_ + 1 - poc) > (poc - (a_ - 1)): a_ -= 1; got += dn
            else: b_ += 1; got += up
    return dict(lo=lo_, hi=hi_, rs=rs, cnt=cnt, poc=poc, vah=b_, val=a_)

def unfinished(tp):
    """From a tpo() result: (poor_high_price or None, poor_low_price or None, [(zone_low_price, zone_high_price), ...] single-print zones = runs of >= 2 consecutive non-extreme rows with exactly one TPO block)."""
    if tp is None: return None, None, []
    rs, lo_ = tp['rs'], tp['lo']; ph = float(tp['hi']) if tp['cnt'][-1] >= 2 else None; pl = float(tp['lo']) if tp['cnt'][0] >= 2 else None
    sp = np.where(tp['cnt'][1:-1] == 1)[0] + 1; runs = []; s0 = None
    for r_ in sp:
        if s0 is None: s0 = pv = r_
        elif r_ == pv + 1: pv = r_
        else: runs.append((s0, pv)); s0 = pv = r_
    if s0 is not None: runs.append((s0, pv))
    return ph, pl, [(lo_ + a_ * rs, lo_ + (b_ + 1) * rs) for a_, b_ in runs if b_ - a_ >= 1]
