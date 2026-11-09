"""Context of one tell fire (read-only, causal): where the fire sits in the developing RTH value area, the range-gate state, the nearest relative LVN and a day-shape letter.
Pure functions over completed 500-contract bars (the same bar dicts `scripts/amt_tell_live/barbuilder.py` builds). No orders, no database, no outcome labels.
Spec: docs/TELL_CONTEXT_OVERLAY_SCOPE_20261103.md and docs/TELL_GLOBEX_RTH_PROFILE_STATE_PREREG_20261103.md (draft). Every label here is NOT VALIDATED."""
import json, os, collections
import numpy as np
import profile_shape as PS

RTH_OPEN, IB_END = 55800.0, 59400.0                 # seconds since the 18:00 ET open: 09:30 and 10:30
HERE = os.path.dirname(os.path.abspath(__file__))
CUTS = json.load(open(os.path.join(HERE, 'shape_cuts.json')))
NEAR_RANGES = 2.0                                    # "near" = within 2 median 20-bar ranges (TELL_PULLBACK convention)


def _profile(bars, rth_only):
    P = collections.defaultdict(float)
    for b in bars:
        if rth_only and b['end'] < RTH_OPEN: continue
        for px, v in b['vap'].items(): P[round(px)] += v[0]
    return P


def value_area(P, frac=0.70):
    ks = sorted(P); a = np.array([P[k] for k in ks]); poc = int(a.argmax()); tot = a.sum(); lo = hi = poc; got = a[poc]
    while got < frac * tot:
        up = a[hi + 1] + (a[hi + 2] if hi + 2 < len(a) else 0) if hi + 1 < len(a) else -1
        dn = a[lo - 1] + (a[lo - 2] if lo - 2 >= 0 else 0) if lo - 1 >= 0 else -1
        if up >= dn and hi + 1 < len(a): hi += 1; got += a[hi]
        elif lo - 1 >= 0: lo -= 1; got += a[lo]
        else: break
    return ks[poc], ks[lo], ks[hi]


def range_gate(bars, d):
    """The tell's own range gate (trade.py boundary/inside_range): which sides have closed beyond the overnight/IB boundary."""
    on = [b for b in bars if b['end'] < RTH_OPEN]; ib = [b for b in bars if RTH_OPEN <= b['end'] < IB_END]; rth = [b for b in bars if b['end'] >= RTH_OPEN]
    if not on or not rth: return dict(up_broken=False, down_broken=False, opposite_broken=False)
    onh, onl = max(b['h'] for b in on), min(b['l'] for b in on); ibdone = bars[-1]['end'] >= IB_END and ib
    up = max(onh, max(b['h'] for b in ib)) if ibdone else onh; dn = min(onl, min(b['l'] for b in ib)) if ibdone else onl
    ub = any(b['c'] > up for b in rth); db = any(b['c'] < dn for b in rth)
    return dict(up_broken=ub, down_broken=db, opposite_broken=(ub if d == -1 else db), upper=up, lower=dn)


def relative_lvns(bars, entry, d, r20):
    """Troughs of the whole-session profile (bin = median 500-bar range / 5, centred 3-bin smoothing) with a peak on each side; depth = trough / smaller peak (lower = deeper)."""
    w = float(np.median([b['h'] - b['l'] for b in bars])) / 5.0
    P = collections.defaultdict(float)
    for b in bars:
        for px, v in b['vap'].items(): P[int(np.floor(px / w))] += v[0]
    ks = np.arange(min(P), max(P) + 1); V = np.array([P.get(k, 0.0) for k in ks]); sm = V.copy()
    for j in range(1, len(V) - 1): sm[j] = V[j - 1:j + 2].mean()
    med = float(np.median(V[V > 0])); pk = [j for j in range(1, len(sm) - 1) if sm[j] >= sm[j - 1] and sm[j] > sm[j + 1]]
    out = []
    for j in range(1, len(sm) - 1):
        if not (sm[j] <= sm[j - 1] and sm[j] < sm[j + 1]): continue
        L = [p for p in pk if p < j]; R = [p for p in pk if p > j]
        if not L or not R: continue
        pl, pr = L[-1], R[0]
        if min(sm[pl], sm[pr]) < med: continue                                        # trough must sit inside value, both walls at least the median bin
        price = (ks[j] + 0.5) * w; dist = (price - entry)
        out.append(dict(price=round(price, 2), depth=round(float(sm[j] / min(sm[pl], sm[pr])), 2), side='AHEAD' if dist * d > 0 else 'BEHIND', dist_ranges=round(dist / r20, 1)))
    return sorted(out, key=lambda x: abs(x['dist_ranges']))


def shape_letter(P, bars):
    """Letter D / P / b from the value-area TAILS and POC (the user's method) plus a separate MULTI_HUMP flag and the hump count: the shared implementation in `profile_shape.py` (the same function the research uses; one
    label, docs/OVERNIGHT_TO_RTH_SHAPE_PREREG_20261103.md section 9). Convention, NOT VALIDATED (docs/TELL_CONTEXT_OVERLAY_SCOPE_20261103.md sections 8-15)."""
    px = np.array(sorted(P)); vol = np.array([P[k] for k in sorted(P)]); f = PS.features(px, vol)
    if f is None: return None
    return dict(letter=PS.letter(f['va_mid']), multi_hump=bool(f['bimod'] >= CUTS['bimod_top_tercile_cut']), humps=int(f['humps']), va_mid=round(float(f['va_mid']), 2), poc_pos=round(float(f['poc_pos']), 2), bimodality=round(float(f['bimod']), 2))


def context_at_fire(bars, entry, d, min_rth_minutes=60):
    """bars = completed bars through the signal bar; entry = the tell's entry price; d = +1 long / -1 short."""
    rth = [b for b in bars if b['end'] >= RTH_OPEN]
    r20 = float(np.median([b['h'] - b['l'] for b in bars[-20:]]))
    gate = range_gate(bars, d); out = dict(direction=d, entry=entry, range20=round(r20, 2), gate=gate)
    if not rth or (bars[-1]['end'] - RTH_OPEN) / 60.0 < min_rth_minutes:
        out.update(label='UNKNOWN', reason='RTH profile younger than %d minutes' % min_rth_minutes); return out
    P = _profile(bars, True); poc, val, vah = value_area(P); width = max(vah - val, 1e-9)
    loc = (entry - val) / width; tail = 'ABOVE_VAH' if entry > vah else ('BELOW_VAL' if entry < val else 'INSIDE')
    near = NEAR_RANGES * r20; near_top = tail == 'INSIDE' and (vah - entry) <= near; near_bot = tail == 'INSIDE' and (entry - val) <= near
    top = tail == 'ABOVE_VAH' or near_top; bot = tail == 'BELOW_VAL' or near_bot; reason = None
    if top and not bot: label = 'AGREES' if d == -1 else 'AGAINST'
    elif bot and not top: label = 'AGREES' if d == 1 else 'AGAINST'
    else:
        label = 'NEUTRAL'
        if top and bot: reason = 'value area narrower than twice the near distance: both edges are near'     # visible, not a silent NEUTRAL
    lv = relative_lvns(bars, entry, d, r20)
    out.update(label=label, rth_minutes=round((bars[-1]['end'] - RTH_OPEN) / 60.0), poc=poc, val=val, vah=vah, location=round(float(loc), 2), tail=tail, near_edge=('BOTH' if near_top and near_bot else 'TOP' if near_top else 'BOTTOM' if near_bot else None), reason=reason,
               shape=shape_letter(P, bars), nearest_lvn=(lv[0] if lv else None), lvns_within_near=[x for x in lv if abs(x['dist_ranges']) <= NEAR_RANGES])
    return out
