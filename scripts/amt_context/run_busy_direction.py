"""PREREG_BUSY_DIRECTION.md (option 2): when the forecast says busy, are the first break and the move more often toward the NEARER range boundary than when it says quiet? Market behaviour only, EXPLORE only (<= 2025-05-16), no trade rule.
READS OUTCOMES (first-break side, forward closes) -> the look is logged first by log_look_busy_direction.mjs.  Usage: /home/mmoniz/trading-journal/venv/bin/python /home/mmoniz/trading-journal/scripts/amt_context/run_busy_direction.py"""
import sys; sys.argv = sys.argv[:1]
import numpy as np, pandas as pd
import tell_state as TS, vbars as V, trade as T, forecast_features as FF
import run_first_break as FB
import walkforward_forecast as WF
SEED, BOOT, DRAWS, SEED_PTS = 20261102, 3000, 1000, 2000
FULL = {1800.0: 1740.0, 3600.0: 3540.0}      # a window counts as complete when the last complete bar ends within a minute of it (as the other scripts' full30)
COLS = ['isT', 'isBrk', 'S30', 'one', 'S60', 'has60']

def points_for_date(d, ctx, pos, dow, control_counts):
    """grid points (every 10th bar index, 10:00-14:30, complete bar) of one session. Always adds to the first-break CONTROL counts (the harness check, all dates); returns evaluation rows for dates past the first-train stretch."""
    S = ctx['S']; end, comp, c = S['end'], S['comp'], S['c']; rows = []; atr = ctx['atr']
    for i in range(ctx['n'] - 1):
        if i % 10 or not (V.DEC_FIRST <= end[i] <= V.DEC_LAST) or not comp[i]: continue
        ins = T.inside_range(ctx, i, 1) and T.inside_range(ctx, i, -1)
        if ins:
            for dd in (1, -1):
                if ctx[f'moving{dd}'][i]: control_counts[FB.first_break(ctx, i, dd)] += 1
            control_counts['points'] += sum(bool(ctx[f'moving{dd}'][i]) for dd in (1, -1)); control_counts['dates'].add(d)
        if WF.block_of(pos) is None: continue
        ts = float(end[i]); row = FF.activity_row(ctx, ts, dow)
        if row is None: continue
        r = {k: row[k] for k in FF.CONT + ['bucket', 'dow']}; r.update(date=d, i=i, ts=ts, inside=ins, blk=WF.block_of(pos), full30=bool(end[comp].max() >= ts + FULL[1800.0]), full60=bool(end[comp].max() >= ts + FULL[3600.0]))
        if ins:
            bu, bl = T.boundary(ctx, i, 1), T.boundary(ctx, i, -1); du, dl = bu - c[i], c[i] - bl; r['dstar'] = 0 if du == dl else (1 if du < dl else -1); r['ratio'] = min(du, dl) / max(du, dl) if max(du, dl) > 0 else np.nan
            if r['dstar'] != 0:
                r['res'] = FB.first_break(ctx, i, r['dstar'])
                for hz, nm in ((1800.0, 'S30'), (3600.0, 'S60')):
                    w = np.where(comp & (end > ts) & (end <= ts + hz))[0]; r[nm] = float(r['dstar'] * (c[w[-1]] - c[i]) / atr) if len(w) else np.nan
        rows.append(r)
    return rows

def per_date(E, lab, dates):
    """per-date 6-vectors (COLS summed) for the HIGH and LOW labelled points; labels are an array aligned with E."""
    A = {}
    for nm in ('H', 'L'): A[nm] = np.array([E[k][(lab[k] == nm)].sum(0) if len(E[k]) else np.zeros(6) for k in range(len(dates))])
    return A

def stat_b(w, A):
    """B1 (share of first breaks on d*, HIGH minus LOW), B2 (S30 mean, HIGH minus LOW), S60 mean difference; weights w over dates."""
    s = lambda a, j: w @ a[:, j]
    with np.errstate(divide='ignore', invalid='ignore'):
        return np.array([s(A['H'], 0) / s(A['H'], 1) - s(A['L'], 0) / s(A['L'], 1), s(A['H'], 2) / s(A['H'], 3) - s(A['L'], 2) / s(A['L'], 3), s(A['H'], 4) / s(A['H'], 5) - s(A['L'], 4) / s(A['L'], 5)])

def main():
    rng = np.random.default_rng(SEED + 13); _, ctxs, _ = TS.sessions_and_contexts(); df, dates = WF.training_points(ctxs); pos = {d: k for k, d in enumerate(dates)}
    ctl = dict(T=0, O=0, N=0, points=0, dates=set()); recs = []
    for d in dates: recs += points_for_date(d, ctxs[d], pos[d], pd.Timestamp(d).dayofweek, ctl)
    print(f'HARNESS CHECK: first-break CONTROL (moving only, both sides inside) reproduced: {ctl["points"]} points on {len(ctl["dates"])} dates, T {ctl["T"]} O {ctl["O"]} N {ctl["N"]}  (research output: 10896 points on 470 dates, T 3225 O 2101 N 5570)')
    if not (ctl['points'] == 10896 and len(ctl['dates']) == 470 and (ctl['T'], ctl['O'], ctl['N']) == (3225, 2101, 5570)): print('STOPPED: the harness does not reproduce the research control'); return
    R = pd.DataFrame(recs); R['lf'] = WF.block_forecasts(df, dates, R); R = R.sort_values(['date', 'ts', 'i']).reset_index(drop=True)
    n = len(R); print(f'grid points with a usable forecast after the first {WF.FIRST_TRAIN} dates: {n} on {R.date.nunique()} dates; the first {SEED_PTS} only seed the cutoffs')
    lo3, hi3 = WF.expanding_cutoffs(R.lf.values, SEED_PTS); R['lab'] = np.where(R.lf > hi3, 'H', np.where(R.lf < lo3, 'L', 'M')); R.loc[R.index < SEED_PTS, 'lab'] = ''
    E = R[(R.index >= SEED_PTS) & R.inside & (R.dstar != 0) & R.full30].copy(); ties = int(((R.index >= SEED_PTS) & R.inside & (R.dstar == 0)).sum())
    print(f'evaluated points (both sides inside, nearer side defined, 30-minute window complete): {len(E)} on {E.date.nunique()} dates; ties dropped {ties}; labels H {int((E.lab == "H").sum())} M {int((E.lab == "M").sum())} L {int((E.lab == "L").sum())}')
    nw = int(E.S30.isna().sum()); E = E[E.S30.notna()].copy(); print(f'dropped for no complete bar inside the 30-minute window: {nw}')
    E['isBrk'] = (E.res != 'N').astype(float); E['isT'] = (E.res == 'T').astype(float); E['one'] = 1.0; E['has60'] = (E.full60 & E.S60.notna()).astype(float); E['S60'] = np.where(E.has60 > 0, E.S60, 0.0)
    ud = sorted(E.date.unique()); byd = {d: np.where(E.date.values == d)[0] for d in ud}; X = E[COLS].values.astype(float); Ed = [X[byd[d]] for d in ud]; labs = E.lab.values; Ld = [labs[byd[d]] for d in ud]; D = len(ud)
    A0 = per_date(Ed, Ld, ud); obs = stat_b(np.ones(D), A0)
    boots = np.array([stat_b(np.bincount(rng.integers(0, D, D), minlength=D).astype(float), A0) for _ in range(BOOT)]); ci = np.nanpercentile(boots, [2.5, 97.5], axis=0)
    nulls = []
    for _ in range(DRAWS):
        perm = rng.permutation(D); PL = [Ld[perm[k]][np.arange(len(Ld[k])) % len(Ld[perm[k]])] for k in range(D)]; nulls.append(stat_b(np.ones(D), per_date(Ed, PL, ud)))
    nulls = np.array(nulls); pv = (np.sum(nulls >= obs, axis=0) + 1) / (DRAWS + 1)
    med = ud[D // 2]; half = {}
    for nm, sel in (('first', [k for k, d in enumerate(ud) if d <= med]), ('second', [k for k, d in enumerate(ud) if d > med])): w = np.zeros(D); w[sel] = 1.0; half[nm] = stat_b(w, A0)
    unc_share = E.isT.sum() / E.isBrk.sum(); unc_S30 = E.S30.mean()
    print(f'\nunconditional (all evaluated): first break on d* {100 * unc_share:.1f}% of {int(E.isBrk.sum())} breaking points (break rate {100 * E.isBrk.mean():.1f}%); mean S30 {unc_S30:+.4f} ATR')
    for lb in ('H', 'M', 'L'):
        g = E[E.lab == lb]; print(f'  {lb}: N {len(g)} on {g.date.nunique()} dates; share on d* {100 * g.isT.sum() / max(1, g.isBrk.sum()):.1f}% of {int(g.isBrk.sum())}; break rate {100 * g.isBrk.mean():.1f}%; mean S30 {g.S30.mean():+.4f} (excess {g.S30.mean() - unc_S30:+.4f})')
    res = {}
    for j, (nm, lab) in enumerate((('B1 share of first breaks on d* (HIGH minus LOW)', 'B1'), ('B2 mean S30, i.e. excess HIGH minus LOW', 'B2'), ('S60 mean difference (uncounted)', 'S60'))):
        ok = ci[0, j] > 0 and half['first'][j] > 0 and half['second'][j] > 0 and pv[j] < 0.05; res[lab] = (ok, pv[j])
        print(f'\n{nm}: {obs[j]:+.4f}  day-blocked CI [{ci[0, j]:+.4f}, {ci[1, j]:+.4f}]  permutation p {pv[j]:.4f}  halves {half["first"][j]:+.4f} / {half["second"][j]:+.4f}' + (f'  -> {"PASS" if ok else "NOT PASSED"}' if lab != 'S60' else ''))
    ps = sorted((res[k][1], k) for k in ('B1', 'B2')); keep = max([i for i, (p, _) in enumerate(ps) if p <= (i + 1) / 2 * 0.10] + [-1]); print('BH q=0.10 over B1,B2:', {k: ('rejects' if i <= keep else 'does not reject') for i, (p, k) in enumerate(ps)})
    print('\nuncounted: chronological quarters (points HIGH / LOW, B1, B2)'); qpass = []
    for qd in np.array_split(np.array(ud), 4):
        w = np.isin(ud, qd).astype(float); s = stat_b(w, A0); nh = sum(int((Ld[k] == 'H').sum()) for k in range(D) if w[k]); nl = sum(int((Ld[k] == 'L').sum()) for k in range(D) if w[k])
        print(f'  {qd[0]}..{qd[-1]}  H {nh} / L {nl}  B1 {s[0]:+.4f}  B2 {s[1]:+.4f}'); qpass.append((nh >= 30 and nl >= 30, s[0] > 0 and s[1] > 0))
    print('\nuncounted: near-versus-far reading. d* is the NEARER side by construction, so the split is by how lopsided the range is (nearer/farther distance, below or above the median ratio); B1 in each:')
    mr = E.ratio.median()
    for nm, m in (('lopsided (ratio <= median)', (E.ratio <= mr).values), ('centered (ratio > median)', (E.ratio > mr).values)):
        Am = per_date([Ed[k] for k in range(D)], [np.where(m[byd[ud[k]]], Ld[k], '') for k in range(D)], ud); s = stat_b(np.ones(D), Am); g = E[m]
        print(f'  {nm}: N {len(g)}, share on d* {100 * g.isT.sum() / max(1, g.isBrk.sum()):.1f}%, B1 {s[0]:+.4f}, B2 {s[1]:+.4f}')
    b1, b2 = res['B1'][0], res['B2'][0]; allq = all(ok for q, ok in qpass if q) and any(q for q, _ in qpass)
    print('\nREADING (pre-registered):', 'both pass and hold in every quarter with >= 30 H and L points -> a pre-registered TRADE rule is the next step (not run here)' if (b1 and b2 and allq) else 'B1 passes, B2 fails -> the cue predicts which edge breaks, not that the move pays' if (b1 and not b2) else 'both fail -> direction cues do not sharpen with the forecast' if (not b1 and not b2) else 'B2 passes without B1, or a pass that fails the quarter rule -> read the quarters first; no trade rule')

if __name__ == '__main__': main()
