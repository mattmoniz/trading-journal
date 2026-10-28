"""Initiative Ignition & Retest (PREREG.md frozen). Pure simulation, EXPLORE only."""
import sys
import numpy as np
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_80rule'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_s1')
import engine as E

TICK = SLIP = 0.25; DPP = 2.0; COMM = 2.0
CONF, MIN_RNG, CLEAR, CLOSE_FRAC, VOL_MULT, VOL_N = 20.0, 15.0, 5.0, 0.75, 1.5, 20
ORDER_BARS, HARD, STRUCT, TGT = 5, 12.0, 4.0, 24.0
WIN_LO, WIN_HI, FLAT, IB_DONE = 5, 330, 385, 60     # ignition bar index 09:35..15:00; flatten 15:55; IB complete at the 10:30 bar


def lines(S, i):
    """(long_line, short_line) usable by an ignition bar at index i (None where no cluster)."""
    a = S['a']; out = []
    ibh = float(np.nanmax(a['h'][:IB_DONE])) if i >= IB_DONE else None
    ibl = float(np.nanmin(a['l'][:IB_DONE])) if i >= IB_DONE else None
    onh, onl = S.get('onh'), S.get('onl')
    for va, others, fn in ((S['vah'], (ibh, onh), max), (S['val'], (ibl, onl), min)):
        cl = [x for x in others if x is not None and abs(x - va) <= CONF]
        out.append(fn([va] + cl) if cl else None)
    return out[0], out[1]


def ignition_parts(a, i, line, d):
    """Dict of booleans for the initiative conditions plus the crossing/clearance gate. d=+1 long."""
    h, l, c, v, dl = a['h'][i], a['l'][i], a['c'][i], a['v'][i], a['dl'][i]
    if np.isnan(h) or np.isnan(v) or np.isnan(dl) or i < VOL_N: return None
    prior = a['v'][i - VOL_N:i]
    if np.isnan(prior).any(): return None
    rng = h - l
    cross = (l <= line) if d == 1 else (h >= line)
    clear = (c >= line + CLEAR) if d == 1 else (c <= line - CLEAR)
    disp = rng >= MIN_RNG
    rej = rng > 0 and ((c - l) / rng >= CLOSE_FRAC if d == 1 else (c - l) / rng <= 1 - CLOSE_FRAC)
    vol = v >= VOL_MULT * prior.mean()
    dlt = dl > 0 if d == 1 else dl < 0
    return dict(cross=cross, clear=clear, disp=disp, rej=rej, vol=vol, dlt=dlt)


def is_ignition(p): return p is not None and p['cross'] and p['clear'] and p['disp'] and p['rej'] and p['vol'] and p['dlt']
def is_plain(p): return p is not None and p['cross'] and p['clear'] and not (p['disp'] and p['rej'] and p['vol'] and p['dlt'])


def simulate(S, mode='ignition', market=False, report=None):
    """mode 'ignition' (the spec) or 'plain' (same-selection control). market=True: diagnostic market entry at the next open (stop/target from that entry)."""
    a = S['a']; o, h, l, c = a['o'], a['h'], a['l'], a['c']
    trades, pos, order, pend_exit, armed = [], None, None, None, {1: True, -1: True}
    for i in range(390):
        if np.isnan(o[i]): continue
        # 1. a resting order: try to fill on this bar
        if order is not None and pos is None and i >= order['t'] + 1:
            d, ln = order['d'], order['line']
            if market and i == order['t'] + 1:
                entry = o[i] + d * SLIP; pos = dict(d=d, ei=i, entry=entry, line=ln, stop=entry - d * HARD, tgt=entry + d * TGT, mfe=0.0, mae=0.0, sig=order['t']); order = None
            elif not market:
                thru = (l[i] <= ln - TICK) if d == 1 else (h[i] >= ln + TICK)
                if thru:
                    pos = dict(d=d, ei=i, entry=ln, line=ln, stop=ln - d * HARD, tgt=ln + d * TGT, mfe=0.0, mae=0.0, sig=order['t']); order = None
                    if report is not None: report['filled'] += 1
                elif i >= order['t'] + ORDER_BARS:
                    if report is not None: report['unfilled'].append((S['d'], order['t'], d, ln)); 
                    order = None
        # 2. manage the position (stop before target, on the fill bar too)
        if pos is not None:
            d = pos['d']; done = False; why = px = None
            if pend_exit is not None and i > pos['ei']: px, why, done = o[i] - d * SLIP, pend_exit, True; pend_exit = None
            elif i >= FLAT: px, why, done = o[i] - d * SLIP, 'EOD', True
            elif i > pos['ei'] and d * (o[i] - pos['stop']) <= 0: px, why, done = o[i] - d * SLIP, 'STOP_GAP', True
            elif (d == 1 and l[i] <= pos['stop']) or (d == -1 and h[i] >= pos['stop']): px, why, done = pos['stop'] - d * SLIP, 'STOP', True
            elif (d == 1 and h[i] >= pos['tgt'] + TICK) or (d == -1 and l[i] <= pos['tgt'] - TICK): px, why, done = pos['tgt'], 'TGT', True
            if not done or why in ('STOP', 'TGT'):
                pos['mfe'] = max(pos['mfe'], d * ((h[i] if d == 1 else l[i]) - pos['entry'])); pos['mae'] = max(pos['mae'], d * (pos['entry'] - (l[i] if d == 1 else h[i])))
            if done:
                pts = (px - pos['entry']) * d
                trades.append(dict(date=S['d'], dir=d, sig=pos['sig'], ei=pos['ei'], xi=i, entry=pos['entry'], line=pos['line'], risk=HARD, reason=why, pts=pts, net=pts * DPP - COMM, mfe=pos['mfe'], mae=pos['mae'])); pos = None; pend_exit = None
            elif not market and ((d == 1 and c[i] < pos['line'] - STRUCT) or (d == -1 and c[i] > pos['line'] + STRUCT)): pend_exit = 'STRUCT'
            elif market and ((d == 1 and c[i] < pos['line'] - STRUCT) or (d == -1 and c[i] > pos['line'] + STRUCT)): pend_exit = 'STRUCT'
        # 3. re-arm directions when price closes back through the line
        if not np.isnan(c[i]):
            ll, sl = lines(S, i)
            if ll is not None and c[i] <= ll: armed[1] = True
            if sl is not None and c[i] >= sl: armed[-1] = True
        # 4. detect a new signal on this bar
        if pos is None and order is None and WIN_LO <= i <= WIN_HI and i + 1 < 390 and not np.isnan(c[i]):
            ll, sl = lines(S, i)
            for d, ln in ((1, ll), (-1, sl)):
                if ln is None or not armed[d]: continue
                p = ignition_parts(a, i, ln, d)
                ok = is_ignition(p) if mode == 'ignition' else is_plain(p)
                if ok:
                    armed[d] = False; order = dict(t=i, d=d, line=ln)
                    if report is not None: report['signals'] += 1
                    break
    return trades


def stripped(a, ei, d, S_pts, T_pts):
    """Placebo geometry: enter at the bar open (NO slippage), stop S, target T, flatten at the 15:55 open; exits pay slippage like the real ones."""
    o, h, l = a['o'], a['h'], a['l']; entry = o[ei]; stop = entry - d * S_pts; tgt = entry + d * T_pts
    for i in range(ei, 390):
        if np.isnan(o[i]): continue
        if i >= FLAT: return ((o[i] - d * SLIP - entry) * d) * DPP - COMM
        if i > ei and d * (o[i] - stop) <= 0: return ((o[i] - d * SLIP - entry) * d) * DPP - COMM
        if (d == 1 and l[i] <= stop) or (d == -1 and h[i] >= stop): return ((stop - d * SLIP - entry) * d) * DPP - COMM
        if (d == 1 and h[i] >= tgt + TICK) or (d == -1 and l[i] <= tgt - TICK): return T_pts * DPP - COMM
    return 0.0 - COMM
