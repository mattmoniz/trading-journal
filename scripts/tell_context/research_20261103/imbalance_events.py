"""Breakout events and their window features for docs/IMBALANCE_BREAKOUT_PREREG_20261104.md (sections 1-4). Writes scratch/watcher_marks_20261104/imbalance_events.csv; no statistics here (those are in imbalance_breakout.py)."""
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from imbalance_lib import explore_dates, load, agg, imbalances, stacks, stack_runs, REPO, TICK, RTH0, IB1, RTH1, WIN
DECIDE_AFTER, HORIZON, LAST_DECISION, COLLAPSE_SEC, MIN_EARLIER = 5, 3600.0, RTH0 + 18000.0, 600.0, 5


def levels(S, P):
    """(name, price, side, usable-from-end-time): ON high/low, IB high/low (usable after 10:30), prior-day RTH high/low."""
    on = S['end'] <= RTH0; ib = (S['end'] > RTH0) & (S['end'] <= IB1); out = []
    if on.sum() > 5: out += [('ONH', float(S['h'][on].max()), 1, RTH0), ('ONL', float(S['l'][on].min()), -1, RTH0)]
    if ib.sum() > 5: out += [('IBH', float(S['h'][ib].max()), 1, IB1), ('IBL', float(S['l'][ib].min()), -1, IB1)]
    if P is not None:
        pr = (P['end'] > RTH0) & (P['end'] <= RTH1)
        if pr.sum() > 50: out += [('PDH', float(P['h'][pr].max()), 1, RTH0), ('PDL', float(P['l'][pr].min()), -1, RTH0)]
    return out


def breakouts(S, P):
    ev = []
    for name, lvl, d, t0 in levels(S, P):
        for j in range(1, S['n']):
            if S['end'][j] <= t0: continue
            if S['end'][j] > LAST_DECISION: break
            beyond = (S['c'][j] >= lvl + TICK) if d == 1 else (S['c'][j] <= lvl - TICK); inside_before = (S['c'][j - 1] <= lvl) if d == 1 else (S['c'][j - 1] >= lvl)
            if beyond and inside_before: ev.append(dict(ltype=name[:2], level=name, lvl=lvl, d=d, j=j, t=float(S['end'][j]))); break
    ev.sort(key=lambda e: e['t']); keep = []
    for e in ev:                                                                         # siblings: same direction within 10 minutes of an earlier event the same day
        if any(k['d'] == e['d'] and e['t'] - k['t'] <= COLLAPSE_SEC for k in keep): continue
        keep.append(e)
    return keep


def window_stats(S, i0, i1, d, lvl, mins):
    lo, ask, bid = agg(S, i0, i1); out = {}; occ = int(((ask + bid) > 0).sum()); prices = (lo + np.arange(len(ask))) * TICK
    for R in (3, 4):
        buy, sell = imbalances(ask, bid, R, mins['buy'], mins['sell']); al, op = (buy, sell) if d == 1 else (sell, buy); sa, so = stacks(al), stacks(op)
        beyond = (prices > lvl) if d == 1 else (prices < lvl); na = int(al.sum()); no = int(op.sum())
        out.update({f'sa{R}': sa, 'so{R}'.replace('{R}', str(R)): so, f'net{R}': sa - so, f'nal{R}': na, f'nop{R}': no, f'loc{R}': (float((al & beyond).sum()) / na if na else np.nan), f'rate{R}': (na - no) / max(occ, 1)})
    return out, float(ask.sum() + bid.sum())


def perbar_stats(S, ws, dj, d, lvl):
    """A2 (prereg section 11): diagonal imbalances and stacks PER BAR over the window bars ws..dj; MINVOL = the median nonzero own-side cell of ALL EARLIER bars of the session."""
    a, b = S['ask'][:S['ptr'][ws]], S['bid'][:S['ptr'][ws]]; minb, mins_ = float(np.median(a[a > 0])), float(np.median(b[b > 0])); out = {}
    for R in (3, 4):
        sa = so = bars = beyond = 0
        for i in range(ws, dj + 1):
            lo, ask, bid = agg(S, i, i); buy, sell = imbalances(ask, bid, R, minb, mins_); al, op = (buy, sell) if d == 1 else (sell, buy); ra = stack_runs(al); sa += len(ra); so += stacks(op); bars += int(len(ra) > 0)
            for st, en in ra: mid = (lo + (st + en) / 2.0) * TICK; beyond += int(mid > lvl if d == 1 else mid < lvl)
        out.update({f'bsa{R}': sa, f'bso{R}': so, f'bnet{R}': sa - so, f'bbars{R}': bars, f'bloc{R}': (beyond / sa if sa else np.nan)})
    out['bminvol'] = minb; return out


def session_events(S, P, a2=False):
    rows = []
    for e in breakouts(S, P):
        dj = e['j'] + DECIDE_AFTER
        if dj >= S['n'] or dj < WIN - 1: continue
        te = float(S['end'][dj]); ws = dj - WIN + 1
        if te > LAST_DECISION: continue
        n_win = ws // WIN
        if n_win < MIN_EARLIER: continue
        earlier = [agg(S, k * WIN, k * WIN + WIN - 1) for k in range(n_win)]; durs = [float(S['end'][k * WIN + WIN - 1] - S['start'][k * WIN]) for k in range(n_win)]
        nzb = np.concatenate([a[a > 0] for _, a, _ in earlier]); nzs = np.concatenate([b[b > 0] for _, _, b in earlier]); mins = dict(buy=float(np.median(nzb)), sell=float(np.median(nzs)))
        f, wv = window_stats(S, ws, dj, e['d'], e['lvl'], mins); s = max(float(np.median(S['h'][ws:dj + 1] - S['l'][ws:dj + 1])), TICK)
        fut = (S['end'] > te) & (S['end'] <= te + HORIZON)
        if fut.sum() < 10 or S['end'][-1] < te + HORIZON: continue
        c0 = float(S['c'][dj]); hi, lo = float(S['h'][fut].max()), float(S['l'][fut].min()); fav, adv = ((hi - c0), (c0 - lo)) if e['d'] == 1 else ((c0 - lo), (hi - c0))
        back = (S['c'][fut] <= e['lvl']) if e['d'] == 1 else (S['c'][fut] >= e['lvl'])
        extra = perbar_stats(S, ws, dj, e['d'], e['lvl']) if a2 else {}
        rows.append(dict(**extra, date=S['d'], ltype=e['ltype'], level=e['level'], d=e['d'], t=te, volr=float(np.median(durs)) / max(float(S['end'][dj] - S['start'][ws]), 1e-6), rng_s=float(S['h'][ws:dj + 1].max() - S['l'][ws:dj + 1].min()) / s, s=s, y=(fav - adv) / s, fail=bool(back.any()), minbuy=mins['buy'], **f))
    return rows


if __name__ == '__main__':
    import datetime
    a2 = '--a2' in sys.argv; dates = explore_dates(); rows = []; prev = None; stale = 0
    for d in dates:
        S = load(d); P = prev
        if a2 and prev is not None and (datetime.date.fromisoformat(d) - datetime.date.fromisoformat(prev['d'])).days > 5: P = None; stale += 1      # stale prior-day level: skip the PD events of this session
        rows += session_events(S, P, a2); prev = S
    if a2: print('sessions whose prior explore date is more than 5 calendar days back (PD events skipped):', stale)
    E = pd.DataFrame(rows); E.to_csv(os.path.join(REPO, 'scratch', 'watcher_marks_20261104', 'imbalance_events_a2.csv' if a2 else 'imbalance_events.csv'), index=False)
    print(len(dates), 'sessions,', len(E), 'events'); print(E.groupby(['ltype', 'd']).size().to_string())
