"""Watcher-managed stop test (docs/WATCHER_STOP_PREREG_20261104.md). Explore, same 1,760 tell entries; V1 management identical except that the stop is re-set by the watcher state. Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/watcher_stop_test.py"""
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tell_replay_lib import replay_rows, F, REPO, T
import watcher as W
from block_stats import bootmean, bootdiff
rng = np.random.default_rng(113); KP = 8; SHOWN = {}; ENDS = {}
ADV = {1: ('DRIVE_DOWN', 'DRIVE_DOWN_BUILDING'), -1: ('DRIVE_UP', 'DRIVE_UP_BUILDING')}
def run_dyn(ctx, prof, ei, d, stop0, entry_time, state_at, widen=True, tighten=True):
    """T.run_position (V1) with a stop re-set by `state_at(j)` after each completed bar j (effective from bar j+1). Returns (trade dict, n_widen, n_tighten)."""
    S = ctx['S']; o, h, l, c, end, start = S['o'], S['h'], S['l'], S['c'], S['end'], S['start']; n = ctx['n']
    entry = o[ei] + d * T.SLIP; s = abs(entry - stop0); stop = stop0; broke = False; pend = None; mfe = 0.0; widened = tightened = False
    for j in range(ei, n):
        px = why = None
        if pend is not None: px, why = o[j] - d * T.SLIP, pend; pend = None
        elif start[j] >= T.FLAT_S: px, why = o[j] - d * T.SLIP, 'EOD'
        elif j > ei and d * (o[j] - stop) <= 0: px, why = o[j] - d * T.SLIP, 'STOP_GAP'
        elif (d == 1 and l[j] <= stop) or (d == -1 and h[j] >= stop): px, why = stop - d * T.SLIP, 'STOP'
        if px is not None: return T._trade(ctx, ei, j, d, entry, px, why, stop, broke, mfe), widened, tightened
        mfe = max(mfe, d * ((h[j] if d == 1 else l[j]) - entry))
        bd = T.boundary(ctx, j, d)
        if not broke and ((c[j] > bd) if d == 1 else (c[j] < bd)): broke = True
        if not broke and end[j] - entry_time >= T.TIMEOUT_S: pend = 'TIMEOUT'
        elif broke:
            nc, _ = T.ncomp_at(ctx, prof, j, d, need_nodes=True)
            if nc <= 2: pend = 'FADE'
        st = state_at(j)                                                       # the watcher state of the completed bar j re-sets the stop for bar j+1
        if tighten and not tightened and st in ADV[d]: stop = entry - d * 0.5 * s; tightened = True
        elif widen and not widened and not tightened and st == 'BALANCE_CONFIRMED': stop = entry - d * 2.0 * s; widened = True
    j = n - 1; return T._trade(ctx, ei, j, d, entry, c[j], 'EOS', stop, broke, mfe), widened, tightened
def shown_of(S):
    d = S['d']
    if d not in SHOWN: SHOWN[d] = W.run(S['end'], S['h'], S['l'], S['c'])['shown']; ENDS[d] = S['end']
    return SHOWN[d]
_sessions = {}
def extra(S, allb, sig, t, ctxf):
    ctx = S['_ctx']; d = int(t['dir']); ei = int(t['ei']); s = float(t['risk']); entry = float(S['o'][ei]) + d * T.SLIP; stop0 = entry - d * s; end_i = S['end'][sig]; sh = shown_of(S); out = {}
    real = lambda j: sh[j]
    for nm, (wd, ti) in (('A0', (False, False)), ('A1', (True, False)), ('A2', (False, True)), ('A3', (True, True))):
        tr, w, k = run_dyn(ctx, T.Prof(ctx), ei, d, stop0, end_i, real, wd, ti); out[nm] = tr['net']; out[nm + '_w'] = w; out[nm + '_t'] = k; out[nm + '_r'] = tr['reason']
    pl = []; keys = [k for k in ENDS if k != S['d']]
    for _ in range(KP):
        dd = keys[int(rng.integers(0, len(keys)))]; e2, s2 = ENDS[dd], SHOWN[dd]; plc = lambda j, e2=e2, s2=s2: s2[min(len(s2) - 1, int(np.searchsorted(e2, S['end'][j], 'left')))]
        pl.append(run_dyn(ctx, T.Prof(ctx), ei, d, stop0, end_i, plc, True, True)[0]['net'])
    out['A3p'] = float(np.mean(pl)) if pl else np.nan
    return out
# warm the state cache for every explore session first (placebo draws other days' states)
import glob, vbars as V
for p in sorted(glob.glob(V.ROOT + '/*.bars.tsv')):
    dd = os.path.basename(p)[:10]
    if dd <= '2025-05-16':
        try: shown_of(V.load_session(dd))
        except Exception: pass
print(len(SHOWN), 'sessions with a watcher state series')
R, bad = replay_rows(extra)
print(f'{len(R)} entries ({bad} without an entry bar); PARITY A0 vs the file: max |diff| {np.abs(R.A0 - R.csv_net).max():.4f}; placebo available for {int(R.A3p.notna().sum())}')
bim = np.array([F[d]['final']['bimod'] for d in F]); q90, q25 = float(np.quantile(bim, .9)), float(np.quantile(bim, .25)); R['sB'] = R.bim >= q90; R['sD'] = (R.bim <= q25) & (R.letter == 'D'); R.to_csv(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'watcher_stop_rows.csv'), index=False)
def stat(x, days): c = bootmean(np.asarray(x), days, rng, B=2000); return c
print('\nARMS (mean dollars per trade, win rate, average winner / loser, largest loss; stops re-set: widened / tightened)')
for nm in ('A0', 'A1', 'A2', 'A3', 'A3p'):
    x = R[nm].dropna(); c = stat(x.values, R.loc[x.index, 'date'].values); w = x[x > 0]; l = x[x <= 0]
    extra_s = '' if nm in ('A0', 'A3p') else f'  widened {int(R[nm + "_w"].sum())} tightened {int(R[nm + "_t"].sum())}'
    print(f'  {nm:4s} mean {x.mean():+7.2f} CI [{c[0]:+.1f}, {c[1]:+.1f}]  WR {100*(x>0).mean():3.0f}%  avgW {w.mean():+7.1f} avgL {l.mean():+7.1f}  worst {x.min():+8.1f}{extra_s}')
print('\nCOUNTED TESTS (paired, per entry, day-block CI)')
tests = {}
for nm, a, b in (('T1 A1 - A0', 'A1', 'A0'), ('T2 A2 - A0', 'A2', 'A0'), ('T3 A3 - A0', 'A3', 'A0')): d = R[a] - R[b]; c = stat(d.values, R.date.values); tests[nm] = c; print(f'  {nm}: {d.mean():+.2f}  CI [{c[0]:+.1f}, {c[1]:+.1f}]')
Rp = R[R.A3p.notna()]; d = Rp.A3 - Rp.A3p; c4 = stat(d.values, Rp.date.values); print(f'  T4 A3 (real state) - A3p (another day\'s state): {d.mean():+.2f}  CI [{c4[0]:+.1f}, {c4[1]:+.1f}]  N={len(Rp)}')
print('  => ' + ('LEAD (T3 and T4 CI lower bounds above 0): the hold-out may be spent once' if tests['T3 A3 - A0'][0] > 0 and c4[0] > 0 else 'NOT SHOWN: the lead rule needs T3 and T4 lower bounds above 0'))
print('\nBY DAY SHAPE (hindsight): mean dollars per trade A0 / A1 / A2 / A3 / placebo A3p')
for lab, m in (('ALL', R.bim.notna()), ('strong D', R.sD), ('strong B', R.sB), ('letter D', R.letter == 'D'), ('letter P', R.letter == 'P'), ('letter b', R.letter == 'b'), ('multi-hump', R.final_multi == True), ('not multi-hump', R.final_multi == False)):
    g = R[m]; print(f'  {lab:14s} N={len(g):4d}  ' + '  '.join(f'{nm} {g[nm].mean():+7.1f}' for nm in ('A0', 'A1', 'A2', 'A3', 'A3p')))
print('\nBY ENTRY TIME (A3 minus A0): before 10:30 (state UNKNOWN) / 10:30-12:00 / from 12:00')
for lab, m in (('<10:30', R.end_sec < 55800 + 3600), ('10:30-12:00', (R.end_sec >= 55800 + 3600) & (R.end_sec < 55800 + 9000)), ('>=12:00', R.end_sec >= 55800 + 9000)): g = R[m]; print(f'  {lab:12s} N={len(g):4d}  A3-A0 {(g.A3 - g.A0).mean():+.2f}  widened {int(g.A3_w.sum())} tightened {int(g.A3_t.sum())}')
