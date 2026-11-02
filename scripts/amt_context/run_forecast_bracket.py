"""PREREG_FORECAST_BRACKET.md (option 3): a no-direction bracket after the tell, distances k = c x forecast E_30 (points), two structures (S-STOP breakout via run_bracket.bracket, S-LIMIT fade via bracket_limit.limit_bracket), c in {0.25, 0.5}.
EXPLORE only (<= 2025-05-16), SIMULATED dollars, nothing live. READS OUTCOMES -> the look is logged first by log_look_forecast_bracket.mjs.
Usage: /home/mmoniz/trading-journal/venv/bin/python /home/mmoniz/trading-journal/scripts/amt_context/run_forecast_bracket.py"""
import sys; sys.argv = sys.argv[:1]
import os
import numpy as np, pandas as pd
import tell_state as TS, vbars as V, trade as T, forecast_features as FF
import run_bracket as RB
import run_break_entry as B
import walkforward_forecast as WF
import bracket_limit as BL
SEED, SEED_PTS, CS, W, TICK = 20261102, 100, (0.25, 0.5), 1800.0, 0.25
B.BOOT = 3000
FULL30 = 1740.0

def harness_check(sess):
    """the research S-STOP simulation must reproduce through the function this script uses (run_bracket.bracket): TELL, k = 1 x median bar range, windows 5 and 30 minutes (run_bracket_output.txt: 2591 points on 442 dates, mean -2.43 / -1.52 per point)."""
    df0 = pd.read_csv(os.path.join(TS.HERE, '..', 'amt_vbars', 'decision_points_explore.csv')); tell = df0.groupby(['date', 'i']).ncomp.max().reset_index(); tell = tell[tell.ncomp == 5]; ok = True
    for Wm, want in ((5, -2.43), (30, -1.52)):
        nets = []; dts = set()
        for r in tell.itertuples():
            S = sess[r.date]; i = int(r.i)
            if i < 20: continue
            k = float(np.median(S['h'][i - 19:i + 1] - S['l'][i - 19:i + 1])); net, _ = RB.bracket(S, i, k, Wm * 60.0); nets.append(0.0 if net is None else net); dts.add(r.date)
        got = float(np.mean(nets)); good = len(nets) == 2591 and len(dts) == 442 and round(got, 2) == want; ok &= good
        print(f'HARNESS CHECK S-STOP window {Wm} min: {len(nets)} points on {len(dts)} dates, mean per point ${got:+.2f} (research ${want:+.2f}) -> {"reproduced" if good else "MISMATCH"}')
    return ok

def tell_rows(d, ctx, pos, dow, drop):
    S = ctx['S']; end, comp = S['end'], S['comp']; out = []
    for t in T.simulate(ctx, 'V1', dict(fires=0, skip=0, trades=0, fallback=0)):
        drop['tell_trades'] += 1; sig = int(t['sig']); ts = float(end[sig]); row = FF.activity_row(ctx, ts, dow)
        if row is None: drop['tell_no_row'] += 1; continue
        if end[comp].max() < ts + FULL30: drop['tell_window'] += 1; continue
        r = {k: row[k] for k in FF.CONT + ['bucket', 'dow']}; r.update(arm='TELL', date=d, i=sig, ts=ts, atr=ctx['atr'], blk=WF.block_of(pos)); out.append(r)
    return out

def control_rows(d, ctx, pos, dow, drop):
    """decision-grid bars (every 10th bar index, 10:00-14:30, complete) with NO tell in either direction (ncomp < 5, not gated by the range, as the earlier bracket's nmax < 5) and price moving in at least one direction."""
    S = ctx['S']; end, comp = S['end'], S['comp']; prof = T.Prof(ctx); out = []
    for i in range(ctx['n'] - 1):
        if i % 10 or not (V.DEC_FIRST <= end[i] <= V.DEC_LAST) or not comp[i]: continue
        if not (ctx['moving1'][i] or ctx['moving-1'][i]): continue
        if any(T.ncomp_at(ctx, prof, i, dd, need_nodes=False)[1] for dd in (1, -1)): continue
        drop['ctl_points'] += 1; ts = float(end[i]); row = FF.activity_row(ctx, ts, dow)
        if row is None: drop['ctl_no_row'] += 1; continue
        if end[comp].max() < ts + FULL30: drop['ctl_window'] += 1; continue
        r = {k: row[k] for k in FF.CONT + ['bucket', 'dow']}; r.update(arm='CONTROL', date=d, i=i, ts=ts, atr=ctx['atr'], blk=WF.block_of(pos)); out.append(r)
    return out

def cell_rows(R, sess, structure, c):
    rows = {'TELL': [], 'CONTROL': []}
    for r in R.itertuples():
        S = sess[r.date]; k = max(TICK, round(c * r.e30pts / TICK) * TICK)
        if structure == 'STOP': net, amb = RB.bracket(S, r.i, k, W); alt = net
        else: net, amb, alt = BL.limit_bracket(S, r.i, k, W)
        rows[r.arm].append(dict(date=r.date, net=0.0 if net is None else net, alt=0.0 if alt is None else alt, bin=B.tbin(S, r.i), fill=net is not None, amb=amb, k=k, third=r.third))
    return rows

def main():
    rng = np.random.default_rng(SEED + 17); sess, ctxs, _ = TS.sessions_and_contexts()
    if not harness_check(sess): print('STOPPED: the S-STOP harness does not reproduce the research bracket'); return
    df, dates = WF.training_points(ctxs); pos = {d: k for k, d in enumerate(dates)}; drop = dict(tell_trades=0, tell_no_row=0, tell_window=0, ctl_points=0, ctl_no_row=0, ctl_window=0); recs = []
    for d in dates:
        p = pos[d]
        if WF.block_of(p) is None: continue
        dow = pd.Timestamp(d).dayofweek; recs += tell_rows(d, ctxs[d], p, dow, drop) + control_rows(d, ctxs[d], p, dow, drop)
    R = pd.DataFrame(recs); R['lf'] = WF.block_forecasts(df, dates, R); R['e30pts'] = np.exp(R.lf) * R.atr; R = R.sort_values(['arm', 'date', 'i']).reset_index(drop=True)
    print(f'funnel (after the first {WF.FIRST_TRAIN} dates): {drop}')
    A = R[R.arm == 'TELL']; C = R[R.arm == 'CONTROL']; print(f'TELL points {len(A)} on {A.date.nunique()} dates; CONTROL_MOVING points {len(C)} on {C.date.nunique()} dates; mean forecast E_30 (points): TELL {A.e30pts.mean():.1f}, CONTROL {C.e30pts.mean():.1f}')
    third = np.full(len(R), '', dtype=object); ia = np.where(R.arm.values == 'TELL')[0]; lo3, hi3 = WF.expanding_cutoffs(R.lf.values[ia], SEED_PTS); fa = R.lf.values[ia]
    third[ia] = np.where(np.isnan(lo3), '', np.where(fa > hi3, 'H', np.where(fa < lo3, 'L', 'M'))); R['third'] = third
    cells = {}
    for structure in ('STOP', 'LIMIT'):
        for c in CS:
            rows = cell_rows(R, sess, structure, c); Ar, Cr = rows['TELL'], rows['CONTROL']; mdate = sorted(r['date'] for r in Ar)[len(Ar) // 2]
            nA = len(Ar); fills = sum(r['fill'] for r in Ar); amb = sum(r['amb'] for r in Ar); pa = np.array([r['net'] for r in Ar]); pc = np.array([r['net'] for r in Cr]); fl = np.array([r['net'] for r in Ar if r['fill']])
            m_, lo_, hi_ = B.abs_ci(Ar, rng); pt, draws = B.wdiff_draws(Ar, Cr, rng); lo, hi = float(np.percentile(draws, 2.5)), float(np.percentile(draws, 97.5)); p1 = float((np.sum(np.array(draws) <= 0) + 1) / (len(draws) + 1))
            h1 = B.wdiff_ci([r for r in Ar if r['date'] < mdate], [r for r in Cr if r['date'] < mdate], rng)[0]; h2 = B.wdiff_ci([r for r in Ar if r['date'] >= mdate], [r for r in Cr if r['date'] >= mdate], rng)[0]
            ash = amb / max(fills, 1); ndates = len({r['date'] for r in Ar})
            ok = nA >= 200 and ndates >= 100 and lo_ > 0 and lo > 0 and h1 > 0 and h2 > 0 and ash < 0.25; cells[(structure, c)] = (ok, p1)
            print(f'\n=== S-{structure}, k = {c} x forecast E_30 (mean k TELL {np.mean([r["k"] for r in Ar]):.1f} pts) ===')
            print(f'  TELL    points {nA} on {ndates} dates | fill rate {100 * fills / nA:.0f}% ambiguous {100 * ash:.1f}% of fills{"  [DOMINATED BY BAR RESOLUTION]" if ash > 0.25 else ""} | mean per point ${pa.mean():+.2f} | per fill ${fl.mean() if len(fl) else float("nan"):+.2f}')
            print(f'  CONTROL points {len(Cr)} | fill rate {100 * sum(r["fill"] for r in Cr) / len(Cr):.0f}% ambiguous {100 * sum(r["amb"] for r in Cr) / max(1, sum(r["fill"] for r in Cr)):.1f}% | mean per point ${pc.mean():+.2f}')
            print(f'  TELL absolute per point ${m_:+.2f} day-blocked CI [{lo_:+.2f}, {hi_:+.2f}]')
            print(f'  TELL minus CONTROL (entry-time-mix weighted) ${pt:+.2f} CI [{lo:+.2f}, {hi:+.2f}] one-sided bootstrap p {p1:.4f} halves {h1:+.2f} / {h2:+.2f}')
            print(f'  READING: {"LEAD (all conditions met)" if ok else "not shown"}')
            if structure == 'LIMIT':
                Aalt = [dict(r, net=r['alt']) for r in Ar]; print(f'  uncounted: ambiguous bars scored as the first-filled side reaching its target (best case) -> TELL absolute ${B.abs_ci(Aalt, rng)[0]:+.2f} per point (worst-case rule above is the registered one)')
            hl = {t: np.array([r['net'] for r in Ar if r['third'] == t]) for t in ('H', 'M', 'L')}
            print('  uncounted: TELL mean per point by causal forecast third (first 100 tell points seed the cutoffs): ' + ', '.join(f'{t} N={len(v)} ${v.mean():+.2f}' for t, v in hl.items() if len(v)))
    ps = sorted((v[1], k) for k, v in cells.items()); keep = max([i for i, (p, _) in enumerate(ps) if p <= (i + 1) / len(ps) * 0.10] + [-1])
    print('\nBH q=0.10 over the four cells (one-sided p of TELL minus CONTROL):', {f'S-{k[0]} c={k[1]}': ('rejects' if i <= keep else 'does not reject') for i, (p, k) in enumerate(ps)})
    print('summary (all conditions met):', {f'S-{k[0]} c={k[1]}': v[0] for k, v in cells.items()})

if __name__ == '__main__': main()
