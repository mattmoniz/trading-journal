"""ONE implementation of the RTH volume-profile shape measures, shared by the live context label (`context.shape_letter`) and the research scripts (`research_20261103/*.py`), so the letter in the live system and in every
study is the same function (docs/OVERNIGHT_TO_RTH_SHAPE_PREREG_20261103.md section 9 item 1; cv-079). 40 equal bins across the session's own range (scale-free across years), the profile smoothed with a centred 3-bin mean for the
POC and the peaks, the 70 percent value area grown from the POC bin over the UNSMOOTHED bins (single-bin steps, the larger neighbour first). Letter D / P / b from the value-area midpoint in thirds of the range (the user's tails
and POC method); MULTI_HUMP = bimodality at or above a cut supplied by the caller. Conventions, NOT VALIDATED. Pure, no I/O."""
import numpy as np

NB = 40
MIN_SEP = 5          # the two humps must be at least this many bins apart


def features(px, vol):
    """px, vol: price and volume per traded price (any resolution). Returns None for a degenerate profile, else a dict with the 40-bin profile and the shape measures."""
    px = np.asarray(px, float); vol = np.asarray(vol, float)
    if len(px) == 0: return None
    lo, hi = float(px.min()), float(px.max())
    if hi - lo < 1e-9: return None
    edges = np.linspace(lo, hi + 1e-9, NB + 1); P, _ = np.histogram(px, bins=edges, weights=vol); sm = P.copy()
    for j in range(1, NB - 1): sm[j] = P[j - 1:j + 2].mean()
    poc = int(sm.argmax()); poc_pos = (poc + 0.5) / NB
    mu = np.average(px, weights=vol); sd = np.sqrt(np.average((px - mu) ** 2, weights=vol)); skew = float(np.average(((px - mu) / sd) ** 3, weights=vol)) if sd > 0 else 0.0
    pk = sorted([j for j in range(1, NB - 1) if sm[j] >= sm[j - 1] and sm[j] > sm[j + 1]], key=lambda j: -sm[j]); sel = []
    for j in pk:
        if all(abs(j - k) >= MIN_SEP for k in sel): sel.append(j)
    bimod = 0.0; trough = None
    if len(sel) >= 2:
        a, b = sorted(sel[:2]); small, big = min(sm[a], sm[b]), max(sm[a], sm[b]); bimod = float(max(0.0, 1 - sm[a:b + 1].min() / small) * small / big); trough = int(a + sm[a:b + 1].argmin())
    humps = int(sum(1 for j in sel if sm[j] >= 0.5 * sm[sel[0]])) if sel else 0
    lo_i = hi_i = poc; got = P[poc]; tot = P.sum()
    while got < 0.7 * tot:
        up = P[hi_i + 1] if hi_i + 1 < NB else -1; dn = P[lo_i - 1] if lo_i - 1 >= 0 else -1
        if up >= dn and hi_i + 1 < NB: hi_i += 1; got += P[hi_i]
        elif lo_i - 1 >= 0: lo_i -= 1; got += P[lo_i]
        else: break
    val, vah = lo_i / NB, (hi_i + 1) / NB
    return dict(lo=lo, hi=hi, P=[float(x) for x in P], poc_pos=poc_pos, skew=float(skew), bimod=bimod, humps=humps, val=val, vah=vah, va_mid=(val + vah) / 2, peaks=[int(j) for j in sel], trough=trough)


def letter(va_mid):
    """D / P / b from the value-area midpoint position (0 = low end of the range, 1 = high end): lower third b, middle D, upper third P."""
    return 'b' if va_mid < 1 / 3 else ('P' if va_mid > 2 / 3 else 'D')
