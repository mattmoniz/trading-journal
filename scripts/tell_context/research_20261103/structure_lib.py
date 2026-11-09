"""Structure helpers shared by the exit studies (docs/TELL_STRUCTURE_EXIT_ARMS_PREREG_20261104.md, docs/TELL_LEG_PROFILE_STOP_AND_FLOOR_EXITS_PREREG_20261104.md): value area, overnight thin zones, per-date structure (developing value area per minute),
market levels, zone picking. Raw bars: scratch/structure_20261104/raw.json (export_structure_20261104.mjs). One copy (cv-079); tell_structure_exit.py imports it."""
import os, json
import numpy as np
from tell_replay_lib import REPO, T

RTH0 = 55800.0; THIN_PCT = 25; MIN_RUN = 5
RAW = json.load(open(os.path.join(REPO, 'scratch', 'structure_20261104', 'raw.json')))


def value_area(lo, vols):
    """Standard 70 percent value area expanded from the POC (two bins at a time). Returns (VAL, POC, VAH) as prices (bin lower edges)."""
    v = np.asarray(vols, float); tot = v.sum()
    if tot <= 0: return None
    poc = int(np.argmax(v)); a = b = poc; acc = v[poc]; n = len(v)
    while acc < 0.7 * tot and (a > 0 or b < n - 1):
        up = v[b + 1:b + 3].sum() if b < n - 1 else -1.0; dn = v[max(0, a - 2):a].sum() if a > 0 else -1.0
        if up >= dn: acc += max(up, 0); b = min(n - 1, b + 2)
        else: acc += max(dn, 0); a = max(0, a - 2)
    return lo + a, lo + poc, lo + b


def thin_zones(prof):
    """Maximal runs of at least MIN_RUN 1-point bins, each below the THIN_PCT percentile of the night's occupied-bin volumes. Returns [(zone_low_price, zone_high_price)] (the zone covers [low, high])."""
    v = np.asarray(prof['vols'], float); occ = v[v > 0]
    if len(occ) < 20: return []
    cut = np.percentile(occ, THIN_PCT); below = v < cut; zones = []; i = 0
    while i < len(v):
        if below[i]:
            j = i
            while j + 1 < len(v) and below[j + 1]: j += 1
            if j - i + 1 >= MIN_RUN: zones.append((prof['lo'] + i, prof['lo'] + j + 1))
            i = j + 1
        else: i += 1
    return zones


def day_structure(d):
    """Everything known about a date from raw bars: overnight thin zones, static levels, per-minute developing value area and running opening-range / IB extremes."""
    r = RAW[d]; rth = r['rth']; pos = {m: k for k, m in enumerate(rth['m'])}; n = 390; h = np.zeros(n); l = np.zeros(n); c = np.zeros(n); v = np.zeros(n)
    for i in range(n):                                                                                                              # one slot per RTH minute: a missing minute carries the previous close with no volume (as the rotation export does)
        k = pos.get(i)
        if k is not None: h[i], l[i], c[i], v[i] = rth['h'][k], rth['l'][k], rth['c'][k], rth['v'][k]
        else: h[i] = l[i] = c[i] = c[i - 1]
    lo_px = int(np.floor(l.min())); hi_px = int(np.floor(h.max())); prof = np.zeros(hi_px - lo_px + 3); dev = []                  # developing profile, volume spread over each minute's range
    for i in range(n):
        a = int(np.floor(l[i])) - lo_px; z = int(np.floor(h[i])) - lo_px; prof[a:z + 1] += v[i] / (z - a + 1); dev.append(value_area(lo_px, prof))
    ov = value_area(r['on']['lo'], r['on']['vols']); pv = value_area(r['prev']['lo'], r['prev']['vols'])
    static = [x for x in (ov or ()) if x is not None] + [x for x in (pv or ()) if x is not None] + [r['on']['lowPx'], r['on']['highPx'], r['prev']['lowPx'], r['prev']['highPx']]
    return dict(n=n, h=h, l=l, c=c, dev=dev, static=static, zones=thin_zones(r['on']))


def levels_at(S, i):
    """Market levels known after completed RTH minute i (static ones plus the opening range, the IB once complete, the developing value area)."""
    out = list(S['static']); h, l = S['h'], S['l']
    if i >= 29: orh, orl = h[:30].max(), l[:30].min(); out += [orh, orl, (orh + orl) / 2]
    if i >= 59: ibh, ibl = h[:60].max(), l[:60].min(); out += [ibh, ibl]
    else: out += [h[:i + 1].max(), l[:i + 1].min()]
    if S['dev'][i]: out += [S['dev'][i][0], S['dev'][i][2]]
    return out


def near_zone(px, zones, prox): return any(zl - prox <= px <= zh + prox for zl, zh in zones)


def pick_zone(zones, entry, d, levels, prox, need_level):
    ahead = [(zl, zh) for zl, zh in zones if (zh < entry if d == -1 else zl > entry)]
    ahead.sort(key=lambda z: -z[1] if d == -1 else z[0])                                                                    # nearest first
    for zl, zh in ahead:
        edge = zh if d == -1 else zl
        if abs(edge - entry) < 2 * T.TICK: continue
        if not need_level or any((zl <= L <= zh) or abs(L - edge) <= prox for L in levels): return float(edge)
    return None




def flip_exit_at_structure(S2, dirs, e_min, d, prox, min_exit_sec=0.0):
    """A3 / A3F: the first rotation flip against the position (a newly confirmed opposite 65-point leg) after entry that happens AT structure (price within `prox` of an overnight thin zone or a market level at the confirming minute's close).
    Returns the exit time (seconds since 18:00: the end of the confirming minute), or None. A flip whose exit time is before `min_exit_sec` is ignored (the distance-floor gate)."""
    for i in range(e_min + 1, min(S2['n'], len(dirs))):
        if dirs[i] == -d and dirs[i - 1] != -d:
            ex = RTH0 + (i + 1) * 60
            if ex < min_exit_sec: continue
            px = S2['c'][i]
            if near_zone(px, S2['zones'], prox) or any(abs(px - L) <= prox for L in levels_at(S2, i)): return ex
    return None


def value_cue_exit(S2, dirs, e_min, d, min_exit_sec=0.0):
    """A4 / A4F: out of the developing value area, a flip against the position since that first excursion, then a completed minute closing back inside the developing value area. Returns (exit time, minutes outside value) or (None, None)."""
    i1 = None
    for i in range(e_min + 1, min(S2['n'], len(dirs))):
        dv = S2['dev'][i - 1]
        if dv is None: continue
        if i1 is None and ((d == -1 and S2['l'][i] < dv[0]) or (d == 1 and S2['h'][i] > dv[2])): i1 = i
        if i1 is not None and i >= i1:
            flipped = any(dirs[j] == -d and dirs[j - 1] != -d for j in range(i1, i + 1)); cur = S2['dev'][i]; ex = RTH0 + (i + 1) * 60
            if flipped and cur and cur[0] <= S2['c'][i] <= cur[2] and ex >= min_exit_sec: return ex, i - i1
    return None, None
