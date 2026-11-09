"""Structure-based exit arms A1-A4 (docs/TELL_STRUCTURE_EXIT_ARMS_PREREG_20261104.md). Same 1,760 explore entries, V1 management, each arm only ADDS an exit (target limit or event market exit); an arm with no structure / no event follows V1.
Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/tell_structure_exit.py   (look is logged first by log_look_structure_exit_20261104.mjs, hr-023)"""
import os, sys, json
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tell_replay_lib import replay_rows, F, REPO, SH, T, V
from watcher_stop_lib import run_dyn

RTH0 = 55800.0; H10, H11 = 57600.0, 61200.0; MIN_ACTED = 150
STATE = json.load(open(os.path.join(REPO, 'scratch', 'rotation_vwap_20261104', 'state.json')))
rng = np.random.default_rng(20261104)


from structure_lib import RAW, value_area, thin_zones, day_structure, levels_at, near_zone, pick_zone


CACHE = {}
def extra(S, allb, sig, t, ctxf):
    ctx = S['_ctx']; d = int(t['dir']); ei = int(t['ei']); risk = float(t['risk']); end_i = S['end'][sig]; date = t['date']; h, l = S['h'], S['l']
    a = max(0, sig - 19); scale = max(float(np.median(h[a:sig + 1] - l[a:sig + 1])), T.TICK); prox = 2 * scale
    out = dict(scale=scale, ehr=float(S['start'][ei]), has=(date in RAW and date in STATE))
    v1 = run_dyn(ctx, T.Prof(ctx), ei, d, risk, end_i)[0]; out.update(v1_net=v1['net'], v1_pts=v1['pts'], v1_mfe=v1['mfe'], v1_why=v1['reason'])
    for k in ('a1', 'a2', 'a3', 'a4'): out.update({f'{k}_net': v1['net'], f'{k}_pts': v1['pts'], f'{k}_why': v1['reason'], f'{k}_acted': False, f'{k}_dist': np.nan})
    if not out['has']: return out
    if date not in CACHE: CACHE.clear(); CACHE[date] = day_structure(date)
    S2 = CACHE[date]; entry = float(S['o'][ei]) + d * T.SLIP; e_min = int((S['start'][ei] - RTH0) // 60)
    if e_min < 0 or e_min >= S2['n'] - 1: return out
    lev = levels_at(S2, e_min); dirs = STATE[date]['dir']
    def run(**kw):
        tr = run_dyn(ctx, T.Prof(ctx), ei, d, risk, end_i, **kw)[0]; return tr
    for arm, need in (('a1', False), ('a2', True)):
        tg = pick_zone(S2['zones'], entry, d, lev, prox, need)
        if tg is not None:
            tr = run(target=tg); out.update({f'{arm}_net': tr['net'], f'{arm}_pts': tr['pts'], f'{arm}_why': tr['reason'], f'{arm}_acted': tr['reason'] == 'TARGET', f'{arm}_dist': abs(tg - entry)})
    n = S2['n']; ex3 = None                                                                                                    # A3: first flip against the position that happens at structure
    for i in range(e_min + 1, min(n, len(dirs))):
        if dirs[i] == -d and dirs[i - 1] != -d:
            px = S2['c'][i]; lv = levels_at(S2, i)
            if near_zone(px, S2['zones'], prox) or any(abs(px - L) <= prox for L in lv): ex3 = RTH0 + (i + 1) * 60; break
    if ex3 is not None:
        tr = run(exit_at_sec=ex3); out.update(a3_net=tr['net'], a3_pts=tr['pts'], a3_why=tr['reason'], a3_acted=tr['reason'] == 'EVENT')
    ex4 = None; i1 = None                                                                                                      # A4: out of the developing value area, a flip against the position since, then a close back inside
    for i in range(e_min + 1, min(n, len(dirs))):
        dv = S2['dev'][i - 1]
        if dv is None: continue
        if i1 is None and ((d == -1 and S2['l'][i] < dv[0]) or (d == 1 and S2['h'][i] > dv[2])): i1 = i
        if i1 is not None and i >= i1:
            flipped = any(dirs[j] == -d and dirs[j - 1] != -d for j in range(i1, i + 1))
            cur = S2['dev'][i]
            if flipped and cur and cur[0] <= S2['c'][i] <= cur[2]: ex4 = RTH0 + (i + 1) * 60; out['a4_dwell'] = i - i1; break
    if ex4 is not None:
        tr = run(exit_at_sec=ex4); out.update(a4_net=tr['net'], a4_pts=tr['pts'], a4_why=tr['reason'], a4_acted=tr['reason'] == 'EVENT')
    return out


def boot(x, days, q, B=4000):
    x = np.asarray(x, float); s = pd.Series(x).groupby(days).agg(['sum', 'count']); sm, ct = s['sum'].values, s['count'].values; m = np.empty(B)
    for b in range(B): p = rng.integers(0, len(sm), len(sm)); m[b] = sm[p].sum() / ct[p].sum()
    return np.percentile(m, q), float(np.std(m))


R, bad = replay_rows(extra)
R.to_csv(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'tell_structure_exit_rows.csv'), index=False)
print(f'{len(R)} entries ({bad} without an entry bar); structure data for {int(R.has.sum())}; PARITY v1 vs the file: max |diff| {np.abs(R["v1_net"] - R.csv_net).max():.4f}, trades differing by more than 0.01: {int((np.abs(R["v1_net"] - R.csv_net) > 0.01).sum())}')
dates = sorted(R.date.unique()); half = set(dates[len(dates) // 2:]); R['den'] = np.maximum(R.v1_mfe, R.scale); R['cap_v1'] = R.v1_pts / R.den; h2 = R.date.isin(half).values
print('\nCOVERAGE and COUNTED TESTS (arm minus V1, paired over ALL entries; capture = exit points / max(V1 MFE, s); CI 98.75% day-block)')
for arm, lab in (('a1', 'A1 zone target'), ('a2', 'A2 zone target + coinciding level'), ('a3', 'A3 flip at structure'), ('a4', 'A4 value-area cue')):
    R[f'cap_{arm}'] = R[f'{arm}_pts'] / R.den; acted = R[f'{arm}_acted'].values; na = int(acted.sum())
    dc = (R[f'cap_{arm}'] - R.cap_v1).values; dn = (R[f'{arm}_net'] - R.v1_net).values
    if na < MIN_ACTED: print(f'  {lab}: acted on {na} of {len(R)} entries ({100 * na / len(R):.1f}%) -> UNDERPOWERED, not scored'); continue
    cc, sc = boot(dc, R.date.values, (0.625, 99.375)); cn, sn = boot(dn, R.date.values, (0.625, 99.375)); hs = (dc[~h2].mean() > 0, dc[h2].mean() > 0)
    keeps = cc[0] > 0 and cn[0] > -2.8 * sn and all(hs); costs = cc[0] > 0 and cn[1] < 0 and all(hs)
    print(f'  {lab}: acted {na} ({100 * na / len(R):.1f}%)  capture diff {dc.mean():+.3f} CI98.75 [{cc[0]:+.3f}, {cc[1]:+.3f}] SE {sc:.3f} | net diff {dn.mean():+7.2f} CI [{cn[0]:+.1f}, {cn[1]:+.1f}] SE {sn:.2f} detectable {2.8 * sn:.1f} | halves {hs}  => '
          + ('KEEPS MORE, COSTS RUNNERS' if costs else ('KEEPS MORE' if keeps else ('LEAD (capture up, CI includes 0)' if dc.mean() > 0 and cc[0] <= 0 else 'NOT SHOWN'))))
print('\nON THE ENTRIES WHERE THE ARM ACTED (descriptive): N, V1 mean net / arm mean net, mean capture V1 / arm, win rate, average winner / loser, mean distance to the target, exit mix')
for arm, lab in (('a1', 'A1'), ('a2', 'A2'), ('a3', 'A3'), ('a4', 'A4')):
    g = R[R[f'{arm}_acted']]
    if len(g) == 0: print(f'  {lab}: never acted'); continue
    x = g[f'{arm}_net']; extra_s = f'  mean distance {g[f"{arm}_dist"].mean():.1f} pts ({(g[f"{arm}_dist"] / g.scale).median():.1f} s median)' if arm in ('a1', 'a2') else (f'  dwell outside value {g["a4_dwell"].median():.0f} min median' if arm == 'a4' and 'a4_dwell' in g else '')
    print(f'  {lab}: N={len(g):4d}  net V1 {g.v1_net.mean():+7.2f} / arm {x.mean():+7.2f}  capture {g.cap_v1.mean():+.2f} / {g[f"cap_{arm}"].mean():+.2f}  WR {100 * (x > 0).mean():3.0f}%  avg win {x[x > 0].mean():+7.1f}  avg loss {x[x <= 0].mean():+7.1f}{extra_s}')
fh = (R.ehr >= H10) & (R.ehr < H11); print('\nBY ENTRY HOUR (descriptive): mean paired capture diff / net diff vs V1 over all entries')
for lab, m in (('10:00-10:59', fh), ('11:00 on', ~fh)):
    g = R[m]; print(f'  {lab:12s} N={len(g):4d}' + ''.join(f'   {a.upper()}: cap {(g[f"cap_{a}"] - g.cap_v1).mean():+.3f} net {(g[f"{a}_net"] - g.v1_net).mean():+6.2f}' for a in ('a1', 'a2', 'a3', 'a4')))
