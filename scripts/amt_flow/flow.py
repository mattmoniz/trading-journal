"""Order-flow branch (PREREG.md frozen): Setup A sweep + CVD absorption, Setup B build-and-go. EXPLORE only; pure simulation."""
import sys
import numpy as np
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_80rule'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_s1')
import engine as E

TICK = SLIP = 0.25; DPP = 2.0; COMM = 2.0
CONF, A_STOP, A_TGT, A_STRUCT, B_STOP, B_TGT, OUT_BARS, MICRO = 20.0, 6.0, 15.0, 5.0, 10.0, 20.0, 5, 15
A_RANGE, B_RANGE, FLAT = (60, 345), (60, 330), 385


def micro_vpoc(a):
    h, l, v = a['h'], a['l'], a['v']; out = np.full(390, np.nan); ok = ~np.isnan(h) & ~np.isnan(l) & ~np.isnan(v)
    base = int(round(np.nanmin(l) / TICK)); size = int(round(np.nanmax(h) / TICK)) - base + 2
    lo = np.where(ok, np.round(np.where(ok, l, 0) / TICK) - base, 0).astype(int); hi = np.where(ok, np.round(np.where(ok, h, 0) / TICK) - base, 0).astype(int)
    spread = np.where(ok, np.where(ok, v, 0) / np.maximum(1, hi - lo + 1), 0.0)
    for i in range(MICRO - 1, 390):
        arr = np.zeros(size)
        for j in range(i - MICRO + 1, i + 1):
            if ok[j]: arr[lo[j]:hi[j] + 1] += spread[j]
        out[i] = (int(np.argmax(arr)) + base) * TICK if arr.max() > 0 else np.nan
    return out


def build_zones(S):
    a = S['a']; lv = {}; ib = slice(0, 60)
    lv['IBH'] = float(np.nanmax(a['h'][ib])); lv['IBL'] = float(np.nanmin(a['l'][ib]))
    if S.get('onh') is not None: lv['ONH'], lv['ONL'] = S['onh'], S['onl']
    zones = []
    for vn, vp in (('pdVAH', S['vah']), ('pdVAL', S['val'])):
        for xn, xp in lv.items():
            if abs(vp - xp) <= CONF:
                z = (round(min(vp, xp), 2), round(max(vp, xp), 2), vn + '+' + xn)
                if all(abs(z[0] - q[0]) > 1e-9 or abs(z[1] - q[1]) > 1e-9 for q in zones): zones.append(z)
    return zones


def simulate(S, kind, control=False, mv=None, zones=None, stop_mode='base'):
    a = S['a']; o, h, l, c, dl = a['o'], a['h'], a['l'], a['c'], a['dl']
    zones = build_zones(S) if zones is None else zones
    if not zones: return []
    mv = micro_vpoc(a) if (kind == 'B' and mv is None) else mv
    rng_lo, rng_hi = A_RANGE if kind == 'A' else B_RANGE
    atr = E.atr14(a) if stop_mode != 'base' else None
    trades, pos, pend, pend_exit, fired = [], None, None, None, set()
    for i in range(390):
        if np.isnan(o[i]): continue
        if pend is not None and pos is None:
            d, info = pend; pend = None
            if rng_lo <= i <= rng_hi:
                entry = o[i] + d * SLIP
                if stop_mode == 'atr2' and not np.isnan(info.get('atr', np.nan)): stop = entry - d * 2.0 * info['atr']
                elif stop_mode == 'atr2ext' and kind == 'A' and not np.isnan(info.get('atr', np.nan)): stop = info['ext'] - d * 2.0 * info['atr']
                elif stop_mode != 'base': stop = None
                else: stop = info['ext'] - d * A_STOP if kind == 'A' else entry - d * B_STOP
                tgt = entry + d * (A_TGT if kind == 'A' else B_TGT)
                if stop is not None and ((d == 1 and stop < entry) or (d == -1 and stop > entry)): pos = dict(d=d, ei=i, entry=entry, stop=stop, tgt=tgt, mfe=0.0, mae=0.0, zone=info.get('zone'))
        if pos is not None:
            d = pos['d']; done = False; open_exit = False; stop_exit = False; why = None; px = None
            if pend_exit is not None and i > pos['ei']: px, why, done, open_exit = o[i] - d * SLIP, pend_exit, True, True; pend_exit = None
            elif i >= FLAT: px, why, done, open_exit = o[i] - d * SLIP, 'EOD', True, True
            elif i > pos['ei'] and d * (o[i] - pos['stop']) <= 0: px, why, done, open_exit = o[i] - d * SLIP, 'STOP_GAP', True, True
            elif (d == 1 and l[i] <= pos['stop']) or (d == -1 and h[i] >= pos['stop']): px, why, done, stop_exit = pos['stop'] - d * SLIP, 'STOP', True, True
            elif (d == 1 and h[i] >= pos['tgt'] + TICK) or (d == -1 and l[i] <= pos['tgt'] - TICK): px, why, done = pos['tgt'], 'TGT', True
            if open_exit: pass
            elif stop_exit: pos['mae'] = max(pos['mae'], d * (pos['entry'] - pos['stop']))
            else:
                pos['mfe'] = max(pos['mfe'], d * ((h[i] if d == 1 else l[i]) - pos['entry'])); pos['mae'] = max(pos['mae'], d * (pos['entry'] - (l[i] if d == 1 else h[i])))
            if done:
                pts = (px - pos['entry']) * d
                trades.append(dict(date=S['d'], kind=kind, dir=d, ei=pos['ei'], xi=i, entry=pos['entry'], stop0=pos['stop'], risk=abs(pos['entry'] - pos['stop']), reason=why, pts=pts,
                                   net=pts * DPP - COMM, mfe=pos['mfe'], mae=pos['mae'])); pos = None; pend_exit = None
            elif kind == 'A' and pos['zone'] is not None:
                zl, zh = pos['zone'][0], pos['zone'][1]
                if (d == 1 and c[i] < zl - A_STRUCT) or (d == -1 and c[i] > zh + A_STRUCT): pend_exit = 'STRUCT'
        if kind == 'B':
            for zi, (zl, zh, _) in enumerate(zones):
                if c[i] <= zh: fired.discard((zi, 1))
                if c[i] >= zl: fired.discard((zi, -1))
        if pos is None and pend is None and i >= 1 and not np.isnan(c[i]):
            sig = detect_a(a, zones, i, control) if kind == 'A' else detect_b(a, zones, mv, i, control, fired)
            if sig and rng_lo <= i + 1 <= rng_hi: pend = (sig[0], dict(sig[1], atr=(atr[i] if atr is not None else np.nan)))
    return trades


def detect_a(a, zones, i, control):
    h, l, c, dl = a['h'], a['l'], a['c'], a['dl']
    if np.isnan(h[i - 1]) or np.isnan(dl[i]): return None
    touched = [z for z in zones if l[i] <= z[1] and h[i] >= z[0] and l[i - 1] <= z[1] and h[i - 1] >= z[0]]
    if not touched: return None
    z = min(touched, key=lambda q: abs((q[0] + q[1]) / 2 - c[i])); ll = l[i] < l[i - 1]; hh = h[i] > h[i - 1]
    if control:
        if ll == hh: return None
        if ll and dl[i] <= 0: return (1, dict(ext=min(l[i - 1], l[i]), zone=z))
        if hh and dl[i] >= 0: return (-1, dict(ext=max(h[i - 1], h[i]), zone=z))
        return None
    if ll and dl[i] > 0: return (1, dict(ext=min(l[i - 1], l[i]), zone=z))
    if hh and dl[i] < 0: return (-1, dict(ext=max(h[i - 1], h[i]), zone=z))
    return None


def detect_b(a, zones, mv, i, control, fired):
    c = a['c']
    if i < OUT_BARS - 1 or np.isnan(mv[i]): return None
    for zi, (zl, zh, _) in enumerate(zones):
        if (zi, 1) not in fired and np.all(c[i - OUT_BARS + 1:i + 1] > zh) and ((mv[i] <= zh) if control else (mv[i] > zh)): fired.add((zi, 1)); return (1, dict(zone=(zl, zh)))
        if (zi, -1) not in fired and np.all(c[i - OUT_BARS + 1:i + 1] < zl) and ((mv[i] >= zl) if control else (mv[i] < zl)): fired.add((zi, -1)); return (-1, dict(zone=(zl, zh)))
    return None


def stripped(a, ei, d, S_pts, T_pts):
    """One simple geometry for the placebo: stop S, target T from the entry, flatten at the 15:55 open. Returns net dollars (1 contract)."""
    o, h, l = a['o'], a['h'], a['l']; entry = o[ei] + d * SLIP; stop = entry - d * S_pts; tgt = entry + d * T_pts
    for i in range(ei, 390):
        if np.isnan(o[i]): continue
        if i >= FLAT: return ((o[i] - d * SLIP - entry) * d) * DPP - COMM
        if i > ei and d * (o[i] - stop) <= 0: return ((o[i] - d * SLIP - entry) * d) * DPP - COMM
        if (d == 1 and l[i] <= stop) or (d == -1 and h[i] >= stop): return ((stop - d * SLIP - entry) * d) * DPP - COMM
        if (d == 1 and h[i] >= tgt + TICK) or (d == -1 and l[i] <= tgt - TICK): return T_pts * DPP - COMM
    return 0.0 - COMM
