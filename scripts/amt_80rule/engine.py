"""AMT 80%-rule mechanical strategy engine (PREREG.md frozen). Pure functions; no DB writes."""
import sys
import numpy as np
import pandas as pd
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/macro_regime')
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/ml_meta_labeling')
from loader import compute_va_fn  # noqa: E402
from db import get_connection  # noqa: E402

TICK = SLIP = 0.25; DPP = 2.0; COMM_RT = 2.0; COMM_RT_SPEC = 4.5
ENTRY_LAST_OFF, FLAT_OFF, FIRST_SIGNAL_I = 345, 385, 5      # entry bar open <= 15:15; flatten at the 15:55 open; first trigger bar 09:35
MIN_VA, ROOM, RISK_CAP, BUF, SETUP_BUF, INVALID = 40.0, 15.0, 15.0, 7.5, 2.0, 2.0
BAIL_BARS, BAIL_MFE, BAIL_PNL, BE_PTS, TRAIL_BUF = 15, 8.0, 2.0, 1.0, 3.0
BASE = dict(A='A1', B='B1', C='C1', N=2)


def load_sessions(start='2023-03-01', end='2026-10-27'):
    conn = get_connection(); cur = conn.cursor(); cur.execute("SET statement_timeout='120s'")
    s = pd.Timestamp(start).replace(day=1); e = pd.Timestamp(end); frames = []
    while s < e:
        nxt = s + pd.offsets.MonthBegin(1)
        cur.execute("""SELECT ts, open::float, high::float, low::float, close::float, volume::float, bid_volume::float, ask_volume::float
                       FROM price_bars_primary WHERE symbol='NQ' AND ts >= %s AND ts < %s AND ts::time >= '09:30' AND ts::time < '16:00' ORDER BY ts""",
                    (max(s, pd.Timestamp(start)).to_pydatetime(), min(nxt, e).to_pydatetime()))
        r = cur.fetchall()
        if r: frames.append(pd.DataFrame(r, columns=['ts', 'o', 'h', 'l', 'c', 'v', 'bid', 'ask']))
        s = nxt
    conn.close(); df = pd.concat(frames); df['ts'] = pd.to_datetime(df['ts']); df['d'] = df.ts.dt.strftime('%Y-%m-%d')
    out = {}
    for d, g in df.groupby('d', sort=True):
        off = (g.ts.dt.hour * 60 + g.ts.dt.minute - 570).to_numpy(); a = {k: np.full(390, np.nan) for k in ('o', 'h', 'l', 'c', 'v', 'dl')}
        for k in ('o', 'h', 'l', 'c', 'v'): a[k][off] = g[k].to_numpy()
        a['dl'][off] = (g.ask - g.bid).to_numpy(); a['n'] = len(g); a['first_ok'] = off.min() == 0; a['last_ok'] = off.max() == 389
        out[d] = a
    return out


def profile(a):
    """Port of computeProfile() returning (vah, val, poc). Volume spread across each bar's high-low tick range."""
    vm = {}
    for h, l, v in zip(a['h'], a['l'], a['v']):
        if np.isnan(h) or np.isnan(l) or np.isnan(v) or not h >= l: continue
        lo, hi = int(round(l / TICK)), int(round(h / TICK)); vpl = v / max(1, int(round((h - l) / TICK)) + 1)
        for t in range(lo, hi + 1): vm[t] = vm.get(t, 0.0) + vpl
    keys = sorted(vm); vols = [vm[k] for k in keys]
    if len(keys) < 3: return None
    tot = 0.0
    for v in vols: tot += v
    poc = vols.index(max(vols)); va = vols[poc]; up, dn = poc + 1, poc - 1; n = len(vols)
    while va < tot * 0.70 and (up < n or dn >= 0):
        ua = vols[up] if up < n else 0; da = vols[dn] if dn >= 0 else 0
        if ua >= da and up < n: va += ua; up += 1
        elif dn >= 0: va += da; dn -= 1
        else: va += ua; up += 1
    return keys[up - 1] * TICK, keys[dn + 1] * TICK, keys[poc] * TICK


def build_eligible(raw):
    ks = sorted(raw); full = {k: raw[k]['n'] >= 385 and raw[k]['first_ok'] and raw[k]['last_ok'] for k in ks}; out = []
    for i, d in enumerate(ks):
        if i == 0 or not full[d] or not full[ks[i - 1]] or (pd.Timestamp(d) - pd.Timestamp(ks[i - 1])).days > 5: continue
        p = profile(raw[ks[i - 1]])
        if p is None: continue
        pa = raw[ks[i - 1]]; ok = ~np.isnan(pa['h'])
        ref = compute_va_fn(pd.DataFrame({'High': pa['h'][ok], 'Low': pa['l'][ok], 'Volume': pa['v'][ok]}), pct=0.70)
        assert abs(ref['vah'] - p[0]) < 1e-9 and abs(ref['val'] - p[1]) < 1e-9, f'VA mismatch vs loader on {d}'
        out.append(dict(d=d, a=raw[d], vah=p[0], val=p[1], poc=p[2], width=p[0] - p[1], open=float(raw[d]['o'][0])))
    return out


def atr14(a):
    h, l, c = a['h'], a['l'], a['c']; pc = np.concatenate([[np.nan], c[:-1]])
    tr = np.fmax(h - l, np.fmax(np.abs(h - pc), np.abs(l - pc))); out = np.full(390, np.nan)
    for i in range(13, 390): out[i] = np.nanmean(tr[i - 13:i + 1])
    return out


def _extreme(a, d, lvl, start, key_cmp):
    """B3: extreme of the contiguous run of bars closing outside value immediately before `start` (None if there is none)."""
    c = a['c']; k = start - 1
    while k >= 0 and not (key_cmp(c[k], lvl)): k -= 1
    if k < 0: return None
    vals = []; j = k
    while j >= 0 and key_cmp(c[j], lvl): vals.append(a['l'][j] if d == 1 else a['h'][j]); j -= 1
    return min(vals) if d == 1 else max(vals)


def simulate_session(S, cfg=BASE, collect_exit_i=True):
    a = S['a']; o, h, l, c, dl = a['o'], a['h'], a['l'], a['c'], a['dl']; VAH, VAL, POC = S['vah'], S['val'], S['poc']
    if VAH - VAL < MIN_VA: return []
    atr = atr14(a); N = cfg['N']; trades = []; pos = None; pend = None; pend_exit = None; armed = {1: False, -1: False}
    st3 = {1: [None], -1: [None]}                      # A3: cross bar index per direction
    n_entered = 0
    for i in range(390):
        if np.isnan(o[i]): continue
        # ---- entry from the previous close's signal ----
        if pend is not None and pos is None:
            d, info = pend; pend = None
            if i <= ENTRY_LAST_OFF and n_entered < 2:
                entry = o[i] + d * SLIP
                if cfg['B'] == 'B1': raw = min(VAL - BUF, info['ext_setup'] - SETUP_BUF) if d == 1 else max(VAH + BUF, info['ext_setup'] + SETUP_BUF)
                elif cfg['B'] == 'B2':
                    buf = 1.5 * info['atr']; raw = min(VAL - buf, info['ext_setup'] - SETUP_BUF) if d == 1 else max(VAH + buf, info['ext_setup'] + SETUP_BUF)
                else: raw = info['ext_exc'] - 1.0 if d == 1 else info['ext_exc'] + 1.0
                stop = max(raw, entry - RISK_CAP) if d == 1 else min(raw, entry + RISK_CAP)
                risk = abs(entry - stop)
                if cfg['C'] == 'C1': t1, t2 = POC, (VAH if d == 1 else VAL)
                elif cfg['C'] == 'C2': t1, t2 = entry + d * risk, POC
                else: t1, t2 = entry + 0.5 * (POC - entry), POC
                geom = (entry < t1 < t2) if d == 1 else (t2 < t1 < entry)
                valid = geom and ((stop < entry) if d == 1 else (stop > entry))
                if valid:
                    n_entered += 1
                    pos = dict(d=d, ei=i, entry=entry, stop=stop, stop0=stop, t1=t1, t2=t2, A=True, B=True, pa=None, pb=None, ra=None, rb=None, mfe=0.0, mae=0.0,
                               bars=0, upd=[], t1i=None, pivot_ok=False, hit_i=None, trig_i=info['trig_i'])
        # ---- manage ----
        if pos is not None:
            d = pos['d']
            for u in list(pos['upd']):
                if u[0] <= i:
                    if (d == 1 and u[1] > pos['stop']) or (d == -1 and u[1] < pos['stop']): pos['stop'] = u[1]
                    pos['upd'].remove(u)
            def close_legs(px, why):
                for leg in ('A', 'B'):
                    if pos[leg]:
                        pos[leg] = False; pos['p' + leg.lower()] = (px - pos['entry']) * d; pos['r' + leg.lower()] = why
                pos['xi'] = i
            done = False; open_exit = False; stop_exit = False; stp = pos['stop']
            if pend_exit is not None and i > pos['ei']:
                close_legs(o[i] - d * SLIP, pend_exit); pend_exit = None; done = True; open_exit = True
            elif i >= FLAT_OFF:
                close_legs(o[i] - d * SLIP, 'EOD'); done = True; open_exit = True
            else:
                stp = pos['stop']
                if i > pos['ei'] and d * (o[i] - stp) <= 0: close_legs(o[i] - d * SLIP, 'STOP_GAP'); done = True; open_exit = True
                elif (d == 1 and l[i] <= stp) or (d == -1 and h[i] >= stp): close_legs(stp - d * SLIP, 'STOP'); done = True; stop_exit = True
                else:
                    if pos['A'] and ((d == 1 and h[i] >= pos['t1'] + TICK) or (d == -1 and l[i] <= pos['t1'] - TICK)):
                        pos['A'] = False; pos['pa'] = (pos['t1'] - pos['entry']) * d; pos['ra'] = 'T1'; pos['t1i'] = i
                        pos['upd'].append((i + 1, pos['entry'] + d * BE_PTS))
                    if pos['B'] and ((d == 1 and h[i] >= pos['t2'] + TICK) or (d == -1 and l[i] <= pos['t2'] - TICK)):
                        pos['B'] = False; pos['pb'] = (pos['t2'] - pos['entry']) * d; pos['rb'] = 'T2'
                        if pos['t1i'] is None and pos['A'] is False: pass
                    if not pos['A'] and not pos['B']: pos['xi'] = i; done = True
            if open_exit: pass                                   # closed at the open: nothing of this bar's range happened inside the trade
            elif stop_exit: pos['mae'] = max(pos['mae'], d * (pos['entry'] - stp))   # stop is hit before any later favorable extreme
            else:
                pos['mfe'] = max(pos['mfe'], d * ((h[i] if d == 1 else l[i]) - pos['entry'])); pos['mae'] = max(pos['mae'], d * (pos['entry'] - (l[i] if d == 1 else h[i])))
            if done:
                trades.append(finish(pos, S)); pos = None; pend_exit = None
            else:
                pos['bars'] += 1
                if (d == 1 and c[i] < VAL - INVALID) or (d == -1 and c[i] > VAH + INVALID): pend_exit = 'STRUCT'
                elif pos['bars'] == BAIL_BARS and pos['mfe'] < BAIL_MFE and d * (c[i] - pos['entry']) <= BAIL_PNL: pend_exit = 'BAIL'
                if pos['t1i'] is not None and i > pos['t1i'] and pend_exit is None:
                    p = i - 5
                    if p - 5 >= 0 and p >= pos['ei']:
                        if d == 1 and l[p] < np.nanmin(l[p - 5:p]) and l[p] <= np.nanmin(l[p + 1:p + 6]): pos['upd'].append((i + 1, l[p] - TRAIL_BUF))
                        if d == -1 and h[p] > np.nanmax(h[p - 5:p]) and h[p] >= np.nanmax(h[p + 1:p + 6]): pos['upd'].append((i + 1, h[p] + TRAIL_BUF))
        # ---- armed flags and signals at this bar's close ----
        if c[i] < VAL: armed[1] = True
        if c[i] > VAH: armed[-1] = True
        if pos is None and pend is None and n_entered < 2 and i >= 2:
            sig = detect(S, a, i, cfg, armed, st3, atr)
            if sig and FIRST_SIGNAL_I <= i <= ENTRY_LAST_OFF - 1: pend = sig; st3[1][0] = None; st3[-1][0] = None
    return trades


def detect(S, a, i, cfg, armed, st3, atr):
    c, l, h, dl = a['c'], a['l'], a['h'], a['dl']; VAH, VAL, POC = S['vah'], S['val'], S['poc']; N = cfg['N']; mode = cfg['A']
    for d in (1, -1):
        if not armed[d]: continue
        inside = (lambda k: VAL < c[k] < POC) if d == 1 else (lambda k: POC < c[k] < VAH)
        room = (POC - c[i]) if d == 1 else (c[i] - POC); outside = (lambda x, lv: x < lv) if d == 1 else (lambda x, lv: x > lv)
        edge = VAL if d == 1 else VAH
        def delta_ok(lo, hi):
            s1 = np.nansum(dl[lo:hi + 1]); return (s1 > 0) if d == 1 else (s1 < 0)
        def trig(start, bars_from):
            ext = np.nanmin(l[bars_from:i + 1]) if d == 1 else np.nanmax(h[bars_from:i + 1])
            exc = _extreme(a, d, edge, start, outside)
            return dict(ext_setup=ext, ext_exc=exc, atr=atr[i], trig_i=i), exc
        if mode == 'A1':
            if i < N - 1 or not all(inside(k) for k in range(i - N + 1, i + 1)): continue
            if room < ROOM or not (delta_ok(i, i) or delta_ok(i - 2, i)): continue
            info, exc = trig(i - N + 1, i - N + 1)
        elif mode == 'A2':
            if (i + 1) % 5 != 0 or i < 14 or not inside(i) or room < ROOM: continue
            if not (delta_ok(i - 4, i) or delta_ok(i - 14, i)): continue
            info, exc = trig(i - 4, i - 4)
        else:                                            # A3: cross, then a held retest within 2 points of the edge
            cr = st3[d][0]
            if cr is not None and outside(c[i], edge): st3[d][0] = None; cr = None
            if cr is None:
                if inside(i): st3[d][0] = i
                continue
            touched = (l[i] <= VAL + 2.0) if d == 1 else (h[i] >= VAH - 2.0)
            if i > cr and touched and inside(i) and room >= ROOM and (delta_ok(i, i) or delta_ok(i - 2, i)):
                info, exc = trig(cr, cr)
            else: continue
        if info['ext_exc'] is None and cfg['B'] == 'B3': continue
        return (d, info)
    return None


def finish(pos, S):
    d = pos['d']; legs = []
    for k in ('pa', 'pb'): legs.append(pos[k])
    net = [p * DPP - COMM_RT for p in legs]
    return dict(date=S['d'], dir=d, ei=pos['ei'], xi=pos.get('xi', pos['ei']), entry=pos['entry'], stop0=pos['stop0'], t1=pos['t1'], t2=pos['t2'], pts_a=legs[0], pts_b=legs[1],
                ra=pos['ra'], rb=pos['rb'], net_a=net[0], net_b=net[1], net=net[0] + net[1], net_spec=legs[0] * DPP + legs[1] * DPP - 2 * COMM_RT_SPEC, mfe=pos['mfe'], mae=pos['mae'],
                t1_hit=pos['t1i'] is not None, regime_far=bool(S['open'] > S['vah'] + 30 or S['open'] < S['val'] - 30), poc=S['poc'], val=S['val'], vah=S['vah'])
