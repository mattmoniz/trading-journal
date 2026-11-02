"""PREREG_PATH_STRUCTURE.md: the path-structure (hit probability) test. Market behaviour only, EXPLORE only, no fills/costs/orders; the cost break-evens are printed next to the probabilities.
READS OUTCOMES -> look logged first by log_look_path_structure.mjs.  Usage: /home/mmoniz/trading-journal/venv/bin/python /home/mmoniz/trading-journal/scripts/amt_context/run_path_structure.py"""
import sys; sys.argv = sys.argv[:1]
import numpy as np, pandas as pd
import tell_state as TS, vbars as V, trade as T, forecast_features as FF
import run_break_entry as B
import walkforward_forecast as WF
import path_tree as PT
SEED, BOOT, SEED_ALL, SEED_TELL = 20261102, 3000, 2000, 100
CS, ATRC, TICK = (0.25, 0.5, 0.75, 1.0), (0.1, 0.2, 0.3), 0.25
C0 = T.COMM / T.DPP; SL = T.SLIP; GRID = [(t, s) for t in (0.5, 1.0, 2.0) for s in (0.5, 1.0, 2.0)]
REV, EXT, TMO, AMB = 0, 1, 2, 3

def base_row(d, ctx, i, pos, dow, **kw):
    S = ctx['S']; ts = float(S['end'][i]); row = FF.activity_row(ctx, ts, dow); mx = S['end'][ctx['n'] - 1]
    r = dict(date=d, i=i, ts=ts, atr=ctx['atr'], pos=pos, bin=B.tbin(S, i), floor=2 * float(np.median(S['h'][max(0, i - 19):i + 1] - S['l'][max(0, i - 19):i + 1])), full30=bool(S['end'][S['comp']].max() >= ts + 1740.0), full60=bool(S['end'][S['comp']].max() >= ts + 3540.0), ok=row is not None, **kw)
    if row is not None: r.update({k: row[k] for k in FF.CONT + ['bucket', 'dow']}); r['blk'] = WF.block_of(pos)
    return r

def grid_rows(d, ctx, pos, dow):
    S = ctx['S']; end, comp = S['end'], S['comp']; prof = T.Prof(ctx); out = []
    for i in range(ctx['n'] - 1):
        if i % 10 or not (V.DEC_FIRST <= end[i] <= V.DEC_LAST) or not comp[i]: continue
        tell = any(T.ncomp_at(ctx, prof, i, dd, need_nodes=False)[1] for dd in (1, -1)); mv = bool(ctx['moving1'][i] or ctx['moving-1'][i])
        out.append(base_row(d, ctx, i, pos, dow, kind='GRID', tell=tell, moving=mv, tdir=0))
    return out

def v1_rows(d, ctx, pos, dow):
    return [base_row(d, ctx, int(t['sig']), pos, dow, kind='V1', tell=True, moving=True, tdir=int(t['dir'])) for t in T.simulate(ctx, 'V1', dict(fires=0, skip=0, trades=0, fallback=0))]

def outcome(S, i, k):
    side, j = PT.touch(S, i, k)
    if side is None: return dict(touch=0, side=0, res=-1, M=np.nan, sbr=False, sbe=False, asym='')
    if side == 'AMBIG': return dict(touch=2, side=0, res=-1, M=np.nan, sbr=False, sbe=False, asym='')
    rs = PT.resolve(S, i, j, side, k); code = {'REVERT': REV, 'EXTEND': EXT, 'TIMEOUT': TMO, 'AMBIG': AMB}[rs]; P = S['c'][i]; L = P + side * k; sbr, sbe = PT.same_bar_flags(S, i, j, side, k)
    a = ''.join({'TARGET': 'T', 'STOP': 'S', 'TIMEOUT': 'o', 'AMBIG': 'a'}[PT.first_hit(S, j, L - side * t * k, L + side * s * k, side)] for t, s in GRID)
    return dict(touch=1, side=side, res=code, M=PT.run_length(S, i, j, side, k) if code != AMB else np.nan, sbr=sbr, sbe=sbe, asym=a)

def cell_frame(R, sess, kfun):
    recs = []
    for r in R.itertuples():
        k = kfun(r); o = outcome(sess[r.date], r.i, k); o.update(k=k, pf=(k + SL + C0) / (2 * k + SL), pb=(k + 2 * SL + C0) / (2 * k + SL)); recs.append(o)
    return pd.concat([R.reset_index(drop=True), pd.DataFrame(recs)], axis=1)

# ---- statistics -------------------------------------------------------------------------------------------------
def dbc(sub, dix, D):
    """per (date, entry-time bin) counts of reverts and resolved points."""
    Rv = np.zeros((D, 3)); Nn = np.zeros((D, 3)); m = sub.res.isin([REV, EXT]).values; ix = np.array([dix[x] for x in sub.date.values[m]], dtype=int); b = sub['bin'].values[m]; np.add.at(Rv, (ix, b), (sub.res.values[m] == REV)); np.add.at(Nn, (ix, b), 1.0); return Rv, Nn

def q_stats(sub, rng, dates):
    dix = {d: k for k, d in enumerate(dates)}; D = len(dates); Rv, Nn = dbc(sub, dix, D); r1, n1 = Rv.sum(1), Nn.sum(1)
    if n1.sum() == 0: return None
    draws = []
    for _ in range(BOOT): w = np.bincount(rng.integers(0, D, D), minlength=D).astype(float); draws.append((w @ r1) / (w @ n1) if (w @ n1) > 0 else np.nan)
    draws = np.array(draws); med = np.sort(np.unique(sub.date.values))[len(np.unique(sub.date.values)) // 2]
    half = lambda m: (lambda s: (s.res == REV).sum() / max(1, s.res.isin([REV, EXT]).sum()))(sub[m])
    return dict(q=r1.sum() / n1.sum(), n=int(n1.sum()), lo=float(np.nanpercentile(draws, 2.5)), hi=float(np.nanpercentile(draws, 97.5)), draws=draws, h1=half(sub.date <= med), h2=half(sub.date > med))

def diff_stats(t, c, rng, dates):
    dix = {d: k for k, d in enumerate(dates)}; D = len(dates); Rt, Nt = dbc(t, dix, D); Rc, Nc = dbc(c, dix, D)
    def one(w):
        nt, nc = w @ Nt, w @ Nc
        if (nt == 0).any() or (nc == 0).any(): return None
        return float(np.sum(nt / nt.sum() * ((w @ Rt) / nt - (w @ Rc) / nc)))
    pt = one(np.ones(D)); dr = [v for v in (one(np.bincount(rng.integers(0, D, D), minlength=D).astype(float)) for _ in range(BOOT)) if v is not None]
    return pt, np.array(dr)

def half_diff(t, c, rng, dates):
    med = np.sort(np.unique(t.date.values))[len(np.unique(t.date.values)) // 2]; out = []
    for sel_t, sel_c in (((t.date <= med).values, (c.date <= med).values), ((t.date > med).values, (c.date > med).values)): v = diff_stats(t[sel_t], c[sel_c], rng, dates)[0]; out.append(np.nan if v is None else v)
    return out

def bh(ps, q=0.10):
    order = sorted(range(len(ps)), key=lambda x: ps[x]); keep = -1
    for rank, ix in enumerate(order): keep = rank if ps[ix] <= (rank + 1) / len(ps) * q else keep
    return {ix: (rank <= keep) for rank, ix in enumerate(order)}

def share_tree(g):
    tc = g[g.touch >= 1]; n = max(1, len(tc)); return f'touch {100 * (g.touch >= 1).mean():.0f}% (ambig {100 * (g.touch == 2).mean():.1f}%); of {len(tc)} touches: revert {100 * (tc.res == REV).sum() / n:.1f}% extend {100 * (tc.res == EXT).sum() / n:.1f}% timeout {100 * (tc.res == TMO).sum() / n:.1f}% ambig {100 * (tc.res == AMB).sum() / n:.1f}%; same-bar revert possible {100 * tc.sbr.mean():.1f}%, same-bar extend {100 * tc.sbe.mean():.1f}%'

def qline(g):
    m = g.res.isin([REV, EXT]); return f'Q {100 * (g.res[m] == REV).mean():.1f}% (N {int(m.sum())})' if m.sum() else 'Q n/a (N 0)'

# ---- main -------------------------------------------------------------------------------------------------------
def main():
    rng = np.random.default_rng(SEED + 29); sess, ctxs, _ = TS.sessions_and_contexts(); df, dates = WF.training_points(ctxs); pos = {d: k for k, d in enumerate(dates)}; gr, vr = [], []
    for d in dates:
        dow = pd.Timestamp(d).dayofweek; gr += grid_rows(d, ctxs[d], pos[d], dow)
        if WF.block_of(pos[d]) is not None: vr += v1_rows(d, ctxs[d], pos[d], dow)
    G, Vr = pd.DataFrame(gr), pd.DataFrame(vr)
    for X in (G, Vr): X['usable'] = X.ok & X.blk.notna() if 'blk' in X else False
    Gm = G[G.usable].copy(); Vm = Vr[Vr.usable].copy(); Gm['blk'] = Gm.blk.astype(int); Vm['blk'] = Vm.blk.astype(int)
    for X in (Gm, Vm): X['lf'] = WF.block_forecasts(df, dates, X); X['e30pts'] = np.exp(X.lf) * X.atr
    Gm = Gm.sort_values(['pos', 'ts', 'i']).reset_index(drop=True); lo3, hi3 = WF.expanding_cutoffs(Gm.lf.values, SEED_ALL)
    Gm['third'] = np.where(np.isnan(lo3), '', np.where(Gm.lf > hi3, 'H', np.where(Gm.lf < lo3, 'L', 'M'))); keys = Gm.pos.values * 1e5 + Gm.ts.values
    p = np.minimum(np.searchsorted(keys, Vm.pos.values * 1e5 + Vm.ts.values, side='left'), len(Gm) - 1); Vm['third'] = np.where(np.isnan(lo3[p]), '', np.where(Vm.lf.values > hi3[p], 'H', np.where(Vm.lf.values < lo3[p], 'L', 'M')))
    print(f'COUNTS: V1 signal bars after the first {WF.FIRST_TRAIN} dates {len(Vr)}; usable (forecast available) {len(Vm)}; grid bars (all dates) {len(G)}, usable after the first {WF.FIRST_TRAIN} dates {len(Gm)}')
    TELLe = Vm[Vm.full60].reset_index(drop=True); ALLe = Gm[Gm.full60].reset_index(drop=True); print(f'with a complete 60-minute window: TELL {len(TELLe)} on {TELLe.date.nunique()} dates; ALL {len(ALLe)} on {ALLe.date.nunique()} dates; CONTROL (moving, no tell) {int((ALLe.moving & ~ALLe.tell).sum())}; ALL points that are tell grid bars {int(ALLe.tell.sum())}')
    # harness: touch rate of the bracket-test population must match the recorded bracket fill rates (99% / 83%): a touch needs no one-tick-through, so it may be a little higher
    H = Vm[Vm.full30].reset_index(drop=True); ok = len(H) == 1379
    for c, want in ((0.25, 0.99), (0.5, 0.83)):
        tr = np.mean([PT.touch(sess[r.date], r.i, max(TICK, round(c * r.e30pts / TICK) * TICK))[0] is not None for r in H.itertuples()]); good = (want - 0.005) <= tr <= (want + 0.02); ok &= good
        print(f'HARNESS CHECK c={c}: touch rate {100 * tr:.1f}% vs recorded bracket fill rate {100 * want:.0f}% -> {"consistent" if good else "MISMATCH"}')
    print(f'HARNESS CHECK TELL population before the 60-minute window requirement: {len(H)} (bracket run: 1,379) -> {"reproduced" if len(H) == 1379 else "MISMATCH"}')
    if not ok: print('STOPPED: the harness does not reproduce the bracket run'); return
    Mp, Tp, store = [], [], {}
    for c in CS:
        kf = lambda r, c=c: max(r.floor, round(c * r.e30pts / TICK) * TICK); FA = cell_frame(ALLe, sess, kf); FT = cell_frame(TELLe, sess, kf); FC = FA[FA.moving & ~FA.tell].reset_index(drop=True); store[c] = (FT, FC, FA)
        print(f'\n=================== distance c = {c} x forecast E_30 (mean k: TELL {FT.k.mean():.1f}, ALL {FA.k.mean():.1f} pts; floor binding for {100 * (FA.k <= FA.floor + 1e-9).mean():.1f}% of ALL points) ===================')
        for nm, g in (('TELL', FT), ('CONTROL', FC), ('ALL', FA)): print(f'  {nm:8s} {share_tree(g)}')
        qs = {nm: q_stats(g, rng, sorted(g.date.unique())) for nm, g in (('TELL', FT), ('CONTROL', FC), ('ALL', FA))}
        print('  RESOLUTION and Q = P(revert | resolved), 95% day-blocked CI (cost break-even floors next to ALL):')
        for nm, q in qs.items(): print(f'    {nm:8s} Q {100 * q["q"]:.1f}%  CI [{100 * q["lo"]:.1f}, {100 * q["hi"]:.1f}] (half-width {50 * (q["hi"] - q["lo"]):.1f} pts)  N resolved {q["n"]}  halves {100 * q["h1"]:.1f} / {100 * q["h2"]:.1f}')
        ra = FA[FA.res.isin([REV, EXT])]; pf, pb = float(ra.pf.mean()), float(ra.pb.mean()); q = qs['ALL']; fade_ok = q['lo'] > pf and q['h1'] > pf and q['h2'] > pf; brk_ok = q['hi'] < 1 - pb and q['h1'] < 1 - pb and q['h2'] < 1 - pb
        pfp = float((np.nansum(q['draws'] <= pf) + 1) / (len(q['draws']) + 1)); pbp = float((np.nansum(q['draws'] >= 1 - pb) + 1) / (len(q['draws']) + 1)); Mp += [(c, 'fade', pfp, fade_ok), (c, 'brk', pbp, brk_ok)]
        print(f'  M tests (ALL): fade needs Q > p*_fade {100 * pf:.1f}% -> {"PASS" if fade_ok else "not passed"} (one-sided p {pfp:.4f}); breakout needs Q < {100 * (1 - pb):.1f}% -> {"PASS" if brk_ok else "not passed"} (one-sided p {pbp:.4f})')
        dts = sorted(set(FT.date) | set(FC.date)); pt, dr = diff_stats(FT, FC, rng, dts); lo, hi = np.percentile(dr, [2.5, 97.5]); h1, h2 = half_diff(FT, FC, rng, dts); pv = float(min(1.0, 2 * min((np.sum(dr <= 0) + 1) / (len(dr) + 1), (np.sum(dr >= 0) + 1) / (len(dr) + 1))))
        Tp.append((c, pt, lo, hi, h1, h2, pv)); print(f'  T test: TELL minus CONTROL in Q (entry-time-mix weighted) {100 * pt:+.1f} pts, CI [{100 * lo:+.1f}, {100 * hi:+.1f}], halves {100 * h1:+.1f} / {100 * h2:+.1f}, two-sided p {pv:.4f}')
        print('  uncounted splits (Q, N resolved):')
        for lab, g in (('TELL', FT), ('ALL', FA)):
            print(f'    {lab} by touch side: up {qline(g[g.side == 1])} | down {qline(g[g.side == -1])}; by forecast third: ' + ' | '.join(f'{t} {qline(g[g.third == t])}' for t in ('L', 'M', 'H')) + '; by entry bin: ' + ' | '.join(f'{b} {qline(g[g["bin"] == b])}' for b in (0, 1, 2)))
            qd = np.array_split(np.sort(g.date.unique()), 4); print(f'    {lab} by quarter: ' + ' | '.join(qline(g[g.date.isin(x)]) for x in qd))
        print(f'    TELL touch WITH the tell direction: {qline(FT[(FT.side == FT.tdir) & (FT.side != 0)])} | AGAINST: {qline(FT[(FT.side == -FT.tdir) & (FT.side != 0)])}')
        print('  uncounted asymmetry grid: P(target toward P before stop), target t x k / stop s x k beyond the touch level, vs driftless reference s/(s+t):')
        for nm, g in (('TELL', FT), ('CONTROL', FC), ('ALL', FA)):
            ga = g[g.asym != '']; cells = []
            for ix, (t, s) in enumerate(GRID):
                ch = ga.asym.str[ix]; m = ch.isin(['T', 'S']); cells.append(f'{t}/{s}: {(ch[m] == "T").mean():.3f} (ref {s / (s + t):.3f}, N {int(m.sum())})')
            print(f'    {nm:8s} ' + '; '.join(cells))
        print('  uncounted run length M (max excursion beyond the touch level before the revert, in k): ' + '; '.join(f'{nm} mean {g.M.mean():.2f} p50 {g.M.quantile(.5):.2f} p90 {g.M.quantile(.9):.2f} p99 {g.M.quantile(.99):.2f}' for nm, g in (('TELL', FT), ('CONTROL', FC), ('ALL', FA)) if g.M.notna().any()))
    kb = bh([x[2] for x in Mp]); kt = bh([x[6] for x in Tp]); sg = [np.sign(x[1]) for x in Tp]
    print('\n=================== SUMMARY OF COUNTED TESTS ===================')
    for ix, (c, side, p_, ok_) in enumerate(Mp): print(f'  M c={c} {side}: rule {"PASS" if ok_ else "not passed"}, p {p_:.4f}, BH q=0.10 {"rejects" if kb[ix] else "does not reject"}')
    curve = max(sg.count(1.0), sg.count(-1.0)) >= 3
    for ix, (c, pt, lo, hi, h1, h2, pv) in enumerate(Tp): ok_ = (lo > 0 or hi < 0) and np.sign(h1) == np.sign(h2) == np.sign(pt) and curve; print(f'  T c={c}: diff {100 * pt:+.1f} pts, CI [{100 * lo:+.1f}, {100 * hi:+.1f}], p {pv:.4f}, rule {"PASS" if ok_ else "not passed"} (same sign in >= 3 of 4 cells: {curve}), BH q=0.10 {"rejects" if kt[ix] else "does not reject"}')
    print('\n=================== SENSITIVITY (uncounted): k in ATR20 fractions, all 516 dates, tell grid bars vs control, no model ===================')
    Gs = G[G.full60].reset_index(drop=True)
    for c in ATRC:
        kf = lambda r, c=c: max(r.floor, round(c * r.atr / TICK) * TICK); FS = cell_frame(Gs, sess, kf); ft, fc = FS[FS.tell].reset_index(drop=True), FS[FS.moving & ~FS.tell].reset_index(drop=True)
        dts = sorted(set(ft.date) | set(fc.date)); pt, dr = diff_stats(ft, fc, rng, dts); qt, qc = q_stats(ft, rng, sorted(ft.date.unique())), q_stats(fc, rng, sorted(fc.date.unique()))
        print(f'  c_ATR={c}: mean k {FS.k.mean():.1f} pts; tell Q {100 * qt["q"]:.1f}% [{100 * qt["lo"]:.1f}, {100 * qt["hi"]:.1f}] N {qt["n"]}; control Q {100 * qc["q"]:.1f}% [{100 * qc["lo"]:.1f}, {100 * qc["hi"]:.1f}] N {qc["n"]}; tell minus control {100 * pt:+.1f} pts CI [{100 * np.percentile(dr, 2.5):+.1f}, {100 * np.percentile(dr, 97.5):+.1f}]')

if __name__ == '__main__': main()
