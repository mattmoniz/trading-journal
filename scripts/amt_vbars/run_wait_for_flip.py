"""Wait for the DDY flip (approximate) after the tell, then trade the flip side (PREREG_WAIT_FOR_FLIP.md frozen 2026-11-01). EXPLORE ONLY. Usage: ../../venv/bin/python run_wait_for_flip.py"""
import numpy as np, pandas as pd
import vbars as V, trade as T
import run_break_entry as B
from run_profit_exits import sim
SEED, BOOT, TRIALS, P, S_MIN, HORIZON, TICK = 20261101, 2000, 40, 10, 10, 7200.0, 0.25

def flips(S):
    dl = S['ask'] - S['bid']; n = len(dl); w = np.arange(1, P + 1, dtype=float); sm = np.full(n, np.nan)
    for i in range(P - 1, n): sm[i] = dl[i - P + 1:i + 1] @ w / w.sum()
    out = np.zeros(n, int); run = 0; prev = 0
    for i in range(n):
        if np.isnan(sm[i]): continue
        s = 1 if sm[i] > 0 else -1 if sm[i] < 0 else prev
        if prev != 0 and s != prev:
            if run >= S_MIN: out[i] = s
            run = 1
        else: run += 1
        prev = s
    return out

def first_flip(S, fl, i0):
    end, start = S['end'], S['start']; t0 = end[i0]
    for j in range(i0 + 1, len(fl) - 1):
        if start[j] >= T.FLAT_S or end[j] - t0 > HORIZON: return None
        if fl[j] != 0: return j, int(fl[j])
    return None

def make_event(S, i0, j, d):
    ei = j + 1; entry = S['o'][ei] + d * T.SLIP
    stop = (S['l'][i0:j + 1].min() - TICK) if d == 1 else (S['h'][i0:j + 1].max() + TICK)
    sd = d * (entry - stop)
    return None if sd <= 2 * TICK else dict(ei=ei, d=d, sd=sd)

def main():
    rng = np.random.default_rng(SEED); ctxs = B.load_ctxs(); fl = {d: flips(c['S']) for d, c in ctxs.items()}
    rep = dict(fires=0, skip=0, trades=0, fallback=0); fires = []
    for dte, c in ctxs.items():
        for t in T.simulate(c, 'V1', rep): fires.append((dte, t['sig'], t['dir']))
    print(f'Sessions usable {len(ctxs)}; V1 fires {len(fires)} (expected 1760); hold-out NOT touched')
    ev = {}; noflip = skipped = 0
    for dte, i0, tdir in fires:
        c = ctxs[dte]; S = c['S']; ff = first_flip(S, fl[dte], i0)
        if ff is None: noflip += 1; continue
        j, d = ff; e = make_event(S, i0, j, d)
        if e is None: skipped += 1; continue
        e.update(date=dte, arm='armed', agree=(d == tdir)); ev[(dte, e['ei'], d)] = e
    df = pd.read_csv('decision_points_explore.csv'); df['moving'] = df.moving.astype(str).str.lower().eq('true')
    g = df.groupby(['date', 'i']).agg(nmax=('ncomp', 'max'), mov=('moving', 'any')).reset_index(); ctrl = g[(g.nmax < 5) & g.mov]
    for r in ctrl.itertuples():
        if r.date not in ctxs: continue
        S = ctxs[r.date]['S']; ff = first_flip(S, fl[r.date], int(r.i))
        if ff is None: continue
        j, d = ff; key = (r.date, j + 1, d)
        if key in ev: continue
        e = make_event(S, int(r.i), j, d)
        if e is not None: e.update(date=r.date, arm='control', agree=None); ev[key] = e
    A = [e for e in ev.values() if e['arm'] == 'armed']; C = [e for e in ev.values() if e['arm'] == 'control']
    print(f"tell fires with no flip in the window {noflip}, skipped (stop invalid) {skipped}; ARM events {len(A)} on {len({e['date'] for e in A})} dates (agree with the tell {sum(e['agree'] for e in A)}, disagree {sum(not e['agree'] for e in A)}); CONTROL events {len(C)}")
    for e in A + C:
        S = ctxs[e['date']]['S']; e['net'], e['why'] = sim(S, e['ei'], e['d'], e['sd'], None, None); e['bin'] = B.tbin(S, e['ei'] - 1)
    for lab, rr in (('ARM', A), ('CONTROL', C)):
        v = np.array([e['net'] for e in rr]); print(f"  {lab:8s} N={len(rr)} mean ${v.mean():+.2f} WR {100 * np.mean(v > 0):.0f}% exits stop {100 * np.mean([e['why'] == 'stop' for e in rr]):.0f}% time {100 * np.mean([e['why'] == 'time' for e in rr]):.0f}% median stop {np.median([e['sd'] for e in rr]):.1f} pts")
    pl = []
    for _ in range(TRIALS):
        pl.append(np.mean([sim(ctxs[e['date']]['S'], e['ei'], int(rng.choice([-1, 1])), e['sd'], None, None)[0] for e in A]))
    p95 = float(np.percentile(pl, 95)); m_, lo, hi = B.abs_ci(A, rng); pt, dlo, dhi = B.wdiff_ci(A, C, rng)
    mdate = sorted(e['date'] for e in A)[len(A) // 2]
    h1 = B.wdiff_ci([e for e in A if e['date'] < mdate], [e for e in C if e['date'] < mdate], rng)[0]; h2 = B.wdiff_ci([e for e in A if e['date'] >= mdate], [e for e in C if e['date'] >= mdate], rng)[0]
    ok = len(A) >= 200 and len({e['date'] for e in A}) >= 100 and lo > 0 and dlo > 0 and m_ > p95 and h1 > 0 and h2 > 0
    print(f"\nARM absolute ${m_:+.2f} day-blocked CI [{lo:+.2f}, {hi:+.2f}] | placebo mean ${np.mean(pl):+.2f} p95 ${p95:+.2f} | ARM minus CONTROL (entry-time-mix weighted) ${pt:+.2f} CI [{dlo:+.2f}, {dhi:+.2f}], halves {h1:+.2f}/{h2:+.2f} -> {'LEAD' if ok else 'not shown'}")
    print('=== descriptive: ARM split by agreement with the tell direction')
    for lab, sel in (('flip AGREES with the tell (confirmation)', [e for e in A if e['agree']]), ('flip DISAGREES (reversal)', [e for e in A if not e['agree']])):
        if len(sel) > 5: mm, l2, h2_ = B.abs_ci(sel, rng); print(f"  {lab:42s} N={len(sel)} mean ${mm:+.2f} CI [{l2:+.2f}, {h2_:+.2f}]")
    print('\nsummary', {'ARM': ok})

if __name__ == '__main__': main()
