"""TURN SIGNAL detector, SHARED by the research (turn_signal_phase1.py) and the live daemon (scripts/vacuum_live/shadow.py): one implementation (hr-022). Pure numpy, causal at each event's own bar: nothing after
the event's bar is read to decide the event (the HOOK field of a spike is filled when its bars exist; the link of a Stage-2 looks only BACKWARD).
The user's definition (2026-11-09 chat): the signal marks the END of the last move and the BEGINNING of a new one (entry / exit points, not a setup).
  S1_CLUSTER  : a drop in bar time sustained over a period: onset of >= 3 of the last 5 bars being 'fast' by the user's own pace rule (RTH <= 15 s; Globex <= 0.65 x SMA50(dt) and <= 120 s); direction = net move over those 5 bars.
  S1_SPIKE    : cluster present AND Ratio + ROC through their Bollinger bands (strict: Ratio z > 1.5 and |ROC z| > 2 same direction; loose: one through its band and the other within 0.5 sd, 'a poke in one and a close poke in the other').
  S2_IGNITION : a strict thrust onset (Ratio z > 1.5, |ROC z| > 2 same direction). Linked to the most recent OPPOSITE Stage-1 event within LINK_BARS bars; `held` = no bar after that Stage-1 breached its extreme by more than 0.5 x EMA10(TR).
  EXTENSION   : direction x (Close - Close 240 min earlier, current session only) / ADR20, in the Stage-1 direction (large and positive = a long move already made).
The z-thresholds equal features.Z_RATIO / features.Z_ROC (the user's widths); callers assert it."""
import numpy as np

Z_RATIO, Z_ROC = 1.5, 2.0
HOOK_Z, HOOK_SD = 1.8, 0.25            # the user's exit rule as coded in depth_tell2.trade_exit (ROC z back to <= 1.8 while the Ratio is 0.25 sd off its peak)
LOOK_S, LINK_BARS, KMAX = 14400.0, 30, 30

def onset(m): return m & ~np.r_[False, m[:-1]]
def hhmm(en):
    s = (18 * 3600 + float(en)) % 86400; return '%02d:%02d:%02d' % (int(s // 3600), int(s % 3600 // 60), int(s % 60))

def _ext(en, c, n0, a, da, adr20):
    i0 = n0 + int(np.searchsorted(en[n0:], en[a] - LOOK_S))
    return float(da * (c[a] - c[min(i0, a)]) / adr20) if adr20 else float('nan')

def turn_events(P, n0, F, close, adr20):
    """P: continuous session arrays (en, c, h, l, ...), n0: index where the current session starts, F: features (zroc, zr, ratio, rs, roc, user_fast, etr), close: session close seconds. Returns a list of dicts for the CURRENT session."""
    en, c, h, l = P['en'], P['c'], P['h'], P['l']; n = len(c); idx = np.arange(n)
    z, zr, ratio, rs, etr = F['zroc'], F['zr'], F['ratio'], F['rs'], F['etr']
    d = np.where(F['roc'] > 0, 1, np.where(F['roc'] < 0, -1, 0)); ok = ~np.isnan(z) & ~np.isnan(zr); same = np.sign(z) == d
    strict = ok & (np.abs(z) > Z_ROC) & same & (zr > Z_RATIO)
    loose = strict | (ok & same & (zr > Z_RATIO) & (np.abs(z) > Z_ROC - 0.5)) | (ok & same & (np.abs(z) > Z_ROC) & (zr > Z_RATIO - 0.5))
    uf = F['user_fast'].astype(int); nf = np.zeros(n, int)
    for j in range(5): nf += np.r_[np.zeros(j, int), uf[:n - j]]
    cluster = nf >= 3
    rth_w = (en >= 56100.0) & (en <= close - 600.0); gbx_w = en <= 55500.0; win = (rth_w | gbx_w) & (idx >= n0)
    track = lambda a: 'GBX' if gbx_w[a] else 'RTH'
    ev, s1 = [], []
    # --- Stage 1: cluster onsets and spikes
    for a in np.where(onset(cluster) & win & (idx >= 5))[0]:
        da = int(np.sign(c[a] - c[a - 4]))
        if da == 0: continue
        e = dict(kind='S1_CLUSTER', a=int(a), track=track(a), dir=da, ext=_ext(en, c, n0, a, da, adr20), nfast=int(nf[a]), zroc=float(z[a]) if not np.isnan(z[a]) else None, zr=float(zr[a]) if not np.isnan(zr[a]) else None,
                 strict=None, hook=None, linked=None, etr=float(etr[a]), prog=float(da * (c[a] - c[a - 4]) / etr[a]) if etr[a] > 0 else None)
        ev.append(e); s1.append(e)
    for a in np.where(onset(loose) & cluster & win)[0]:
        da = int(d[a]); hook = None; pk = ratio[a]
        for j in range(a + 1, min(a + KMAX, n - 1) + 1):
            pk = max(pk, ratio[j])
            if not np.isnan(z[j]) and da * z[j] <= HOOK_Z and (pk - ratio[j]) >= HOOK_SD * rs[a]: hook = int(j - a); break
        e = dict(kind='S1_SPIKE', a=int(a), track=track(a), dir=da, ext=_ext(en, c, n0, a, da, adr20), nfast=int(nf[a]), zroc=float(z[a]), zr=float(zr[a]), strict=bool(strict[a]), hook=hook, linked=None, etr=float(etr[a]), prog=None)
        ev.append(e); s1.append(e)
    # --- Stage 2: strict thrust onsets, linked backward to the latest opposite Stage 1
    for s in np.where(onset(strict) & win)[0]:
        ds = int(d[s]); link = None
        cand = [e for e in s1 if e['dir'] == -ds and s - LINK_BARS <= e['a'] < s and e['track'] == track(s)]
        if cand:
            e1 = max(cand, key=lambda e: e['a']); a1 = e1['a']
            if e1['dir'] > 0: x1 = float(h[max(n0, a1 - 4):a1 + 1].max()); held = bool(h[a1 + 1:s + 1].max() <= x1 + 0.5 * etr[a1]) if s > a1 else True
            else: x1 = float(l[max(n0, a1 - 4):a1 + 1].min()); held = bool(l[a1 + 1:s + 1].min() >= x1 - 0.5 * etr[a1]) if s > a1 else True
            link = dict(kind=e1['kind'], a=a1, delay=int(s - a1), held=held, ext1=e1['ext'], extreme=x1)
        ev.append(dict(kind='S2_IGNITION', a=int(s), track=track(s), dir=ds, ext=None, nfast=int(nf[s]), zroc=float(z[s]), zr=float(zr[s]), strict=True, hook=None, linked=link, etr=float(etr[s]), prog=None))
    return sorted(ev, key=lambda e: (e['a'], e['kind']))

def qualifies(e, ext_cut):
    """The ORDER rule (fixed in writing before any order, docs/TURN_SIGNAL_SIM_FORWARD_PREREG_20261109.md): a Stage-2 ignition whose linked Stage 1 is opposite, within LINK_BARS, HELD, and whose Stage-1 extension is >= ext_cut (the rolling top tercile of Stage-1 extensions of the same track)."""
    if e['kind'] != 'S2_IGNITION' or not e['linked']: return False
    k = e['linked']
    return bool(k['held'] and k['ext1'] is not None and not np.isnan(k['ext1']) and ext_cut is not None and k['ext1'] >= ext_cut)
