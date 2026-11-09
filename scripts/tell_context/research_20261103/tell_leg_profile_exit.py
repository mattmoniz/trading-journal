"""Leg-profile stop and distance-floor structure exits (docs/TELL_LEG_PROFILE_STOP_AND_FLOOR_EXITS_PREREG_20261104.md). Arms: R0 initial stop on the leg profile, R1 leg-profile ratchet with a pullback floor, T1 zone target beyond the normal run,
A3F flip at structure after the run, A4F value-area cue after the run. Floors are walk-forward (V1 winners of strictly earlier dates). Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/tell_leg_profile_exit.py
(the look is logged first by log_look_leg_profile_exit_20261104.mjs, hr-023)"""
import os, sys, json
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tell_replay_lib import replay_rows, F, REPO, SH, T, V
from watcher_stop_lib import run_dyn
from structure_lib import RAW, day_structure, flip_exit_at_structure, value_cue_exit

RTH0 = 55800.0; H10, H11 = 57600.0, 61200.0; MIN_ACTED = 150; MIN_WIN = 50; ARMS = ('r0', 'r1', 't1', 'a3', 'a4')
STATE = json.load(open(os.path.join(REPO, 'scratch', 'rotation_vwap_20261104', 'state.json'))); LEGS = json.load(open(os.path.join(REPO, 'scratch', 'legs_20261104', 'legs.json')))
rng = np.random.default_rng(20261104)

# walk-forward floors from step 1's per-trade rows: for a date, V1 winners of strictly EARLIER dates (at least MIN_WIN of them)
S1 = pd.read_csv(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'tell_hold_value_trail_rows.csv'), usecols=['date', 'v1_mfe', 'dd_pre', 'scale', 'csv_net']); S1 = S1[S1.csv_net > 0].sort_values('date')
FLOORS = {}; prior_m, prior_p = [], []
for dte, g in S1.groupby('date', sort=True):
    FLOORS[dte] = (float(np.median(prior_m)), float(np.percentile(prior_p, 90)), len(prior_m)) if len(prior_m) >= MIN_WIN else None
    prior_m += list(g.v1_mfe / g.scale); prior_p += list(g.dd_pre / g.scale)
def floors_for(date):
    if date in FLOORS: return FLOORS[date]
    earlier = [k for k in FLOORS if k < date]; return FLOORS[max(earlier)] if earlier else None            # a date with no winners of its own uses the latest earlier date's floors (still only earlier data)


CACHE = {}
def extra(S, allb, sig, t, ctxf):
    ctx = S['_ctx']; d = int(t['dir']); ei = int(t['ei']); risk = float(t['risk']); end_i = S['end'][sig]; date = t['date']; h, l = S['h'], S['l']
    a = max(0, sig - 19); scale = max(float(np.median(h[a:sig + 1] - l[a:sig + 1])), T.TICK); fl = floors_for(date)
    out = dict(scale=scale, ehr=float(S['start'][ei]), nofloor=fl is None)
    v1 = run_dyn(ctx, T.Prof(ctx), ei, d, risk, end_i)[0]; out.update(v1_net=v1['net'], v1_pts=v1['pts'], v1_mfe=v1['mfe'], v1_why=v1['reason'])
    for k in ARMS: out.update({f'{k}_net': v1['net'], f'{k}_pts': v1['pts'], f'{k}_why': v1['reason'], f'{k}_acted': False, f'{k}_dist': np.nan})
    out['r0_stopdist'] = risk; out['v1_risk'] = risk; out['r1_final'] = np.nan
    if fl is None or not (date in RAW and date in STATE and date in LEGS): return out
    if date not in CACHE: CACHE.clear(); CACHE[date] = day_structure(date)
    S2 = CACHE[date]; entry = float(S['o'][ei]) + d * T.SLIP; e_min = int((S['start'][ei] - RTH0) // 60); F_move = fl[0] * scale; F_pb = fl[1] * scale; dirs = STATE[date]['dir']
    i_prev = int((float(S['end'][sig]) - RTH0) // 60) - 1                                                                       # last completed minute strictly before the signal bar's end
    legs = [L for L in LEGS[date] if L['d'] == d and L['c'] <= i_prev]
    if legs:
        b0 = int(np.searchsorted(S['end'], RTH0 + legs[-1]['a'] * 60, side='right'))                                          # first 500-contract bar that ends after the pivot minute
        prof = T.Prof(ctx); base = prof.upto(b0 - 1).copy() if b0 >= 1 else np.zeros_like(prof.P)
        Ps = prof.upto(sig) - base; r = T.stop_price(ctx, Ps, sig, d, 2)                                                       # R0: the tell's own rule on the LEG profile
        if r is not None and (entry - r[0]) * d > 0:
            tr = run_dyn(ctx, T.Prof(ctx), ei, d, abs(entry - r[0]), end_i)[0]; out.update(r0_net=tr['net'], r0_pts=tr['pts'], r0_why=tr['reason'], r0_acted=abs(abs(entry - r[0]) - risk) > 1e-9, r0_stopdist=abs(entry - r[0]))
        prof2 = T.Prof(ctx); base2 = prof2.upto(b0 - 1).copy() if b0 >= 1 else np.zeros_like(prof2.P); final = [np.nan]
        def stop_fn(j, best, stop):                                                                                               # R1: the leg-profile LVN behind the 2nd node, only if at least F_pb behind the best price
            rr = T.stop_price(ctx, prof2.upto(j) - base2, j, d, 2)
            if rr is None: return None
            cand = rr[0]
            if (d == 1 and best - cand < F_pb) or (d == -1 and cand - best < F_pb): return None
            final[0] = cand; return cand
        tr = run_dyn(ctx, T.Prof(ctx), ei, d, risk, end_i, stop_fn=stop_fn)[0]; moved = not np.isnan(final[0])
        out.update(r1_net=tr['net'], r1_pts=tr['pts'], r1_why=tr['reason'], r1_acted=moved, r1_final=(abs(entry - final[0]) * (1 if (entry - final[0]) * d > 0 else -1)) if moved else np.nan)
    ahead = sorted([(zl, zh) for zl, zh in S2['zones'] if (zh < entry if d == -1 else zl > entry)], key=lambda z: -z[1] if d == -1 else z[0]); tg = None             # T1: first thin zone ahead whose near edge is at least F_move away
    for zl, zh in ahead:
        edge = zh if d == -1 else zl
        if abs(edge - entry) >= F_move: tg = float(edge); break
    if tg is not None:
        tr = run_dyn(ctx, T.Prof(ctx), ei, d, risk, end_i, target=tg); tr = tr[0]; out.update(t1_net=tr['net'], t1_pts=tr['pts'], t1_why=tr['reason'], t1_acted=tr['reason'] == 'TARGET', t1_dist=abs(tg - entry))
    gate = None                                                                                                               # the first completed bar at which the favourable excursion reached F_move
    for j in range(ei, len(h)):
        if d * ((h[j] if d == 1 else l[j]) - entry) >= F_move: gate = float(S['end'][j]); break
    if gate is not None and e_min >= 0 and e_min < S2['n'] - 1:
        prox = 2 * scale; ex3 = flip_exit_at_structure(S2, dirs, e_min, d, prox, gate)
        if ex3 is not None: tr = run_dyn(ctx, T.Prof(ctx), ei, d, risk, end_i, exit_at_sec=ex3)[0]; out.update(a3_net=tr['net'], a3_pts=tr['pts'], a3_why=tr['reason'], a3_acted=tr['reason'] == 'EVENT')
        ex4, dw = value_cue_exit(S2, dirs, e_min, d, gate)
        if ex4 is not None: tr = run_dyn(ctx, T.Prof(ctx), ei, d, risk, end_i, exit_at_sec=ex4)[0]; out.update(a4_net=tr['net'], a4_pts=tr['pts'], a4_why=tr['reason'], a4_acted=tr['reason'] == 'EVENT', a4_dwell=dw)
    return out


def boot(x, days, q, B=4000):
    x = np.asarray(x, float); s = pd.Series(x).groupby(days).agg(['sum', 'count']); sm, ct = s['sum'].values, s['count'].values; m = np.empty(B)
    for b in range(B): p = rng.integers(0, len(sm), len(sm)); m[b] = sm[p].sum() / ct[p].sum()
    return np.percentile(m, q), float(np.std(m))


R, bad = replay_rows(extra)
R.to_csv(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'tell_leg_profile_exit_rows.csv'), index=False)
print(f'{len(R)} entries ({bad} without an entry bar); no floor yet for {int(R.nofloor.sum())}; PARITY v1 vs the file: max |diff| {np.abs(R["v1_net"] - R.csv_net).max():.4f}, trades differing by more than 0.01: {int((np.abs(R["v1_net"] - R.csv_net) > 0.01).sum())}')
dates = sorted(R.date.unique()); half = set(dates[len(dates) // 2:]); R['den'] = np.maximum(R.v1_mfe, R.scale); R['cap_v1'] = R.v1_pts / R.den; h2 = R.date.isin(half).values
LAB = dict(r0='R0 initial stop on the leg profile', r1='R1 leg-profile ratchet (floor = winners p90 pullback)', t1='T1 zone target beyond the normal run', a3='A3F flip at structure after the run', a4='A4F value-area cue after the run')
print('\nCOVERAGE and COUNTED TESTS (arm minus V1, paired over ALL entries; capture = exit points / max(V1 MFE, s); CI 99% day-block, 5 tests)')
for arm in ARMS:
    R[f'cap_{arm}'] = R[f'{arm}_pts'] / R.den; acted = R[f'{arm}_acted'].values; na = int(acted.sum()); dc = (R[f'cap_{arm}'] - R.cap_v1).values; dn = (R[f'{arm}_net'] - R.v1_net).values
    if na < MIN_ACTED: print(f'  {LAB[arm]}: acted on {na} of {len(R)} entries ({100 * na / len(R):.1f}%) -> UNDERPOWERED, not scored'); continue
    cc, sc = boot(dc, R.date.values, (0.5, 99.5)); cn, sn = boot(dn, R.date.values, (0.5, 99.5)); hs = (dc[~h2].mean() > 0, dc[h2].mean() > 0); keeps = cc[0] > 0 and cn[0] > -2.8 * sn and all(hs); costs = cc[0] > 0 and cn[1] < 0 and all(hs)
    print(f'  {LAB[arm]}: acted {na} ({100 * na / len(R):.1f}%)  capture diff {dc.mean():+.3f} CI99 [{cc[0]:+.3f}, {cc[1]:+.3f}] SE {sc:.3f} | net diff {dn.mean():+7.2f} CI [{cn[0]:+.1f}, {cn[1]:+.1f}] SE {sn:.2f} detectable {2.8 * sn:.1f} | halves {hs}  => '
          + ('KEEPS MORE, COSTS RUNNERS' if costs else ('KEEPS MORE' if keeps else ('LEAD (capture up, CI includes 0)' if dc.mean() > 0 and cc[0] <= 0 else 'NOT SHOWN'))))
print('\nON THE ENTRIES WHERE THE ARM ACTED (descriptive): N, V1 mean net / arm mean net, capture V1 / arm, win rate, average winner / loser, worst loss V1 / arm, extra')
for arm in ARMS:
    g = R[R[f'{arm}_acted']]
    if len(g) == 0: print(f'  {arm}: never acted'); continue
    x = g[f'{arm}_net']; ex = (f'  median initial stop {g.r0_stopdist.median():.0f} pts vs V1 {g.v1_risk.median():.0f} pts (about ${2 * g.r0_stopdist.median():.0f} vs ${2 * g.v1_risk.median():.0f} per contract)' if arm == 'r0' else (f'  median distance to target {g[f"{arm}_dist"].median():.0f} pts ({(g[f"{arm}_dist"] / g.scale).median():.1f} s)' if arm == 't1' else ''))
    print(f'  {arm}: N={len(g):4d}  net V1 {g.v1_net.mean():+7.2f} / arm {x.mean():+7.2f}  capture {g.cap_v1.mean():+.2f} / {g[f"cap_{arm}"].mean():+.2f}  WR {100 * (x > 0).mean():3.0f}%  avg win {x[x > 0].mean():+7.1f}  avg loss {x[x <= 0].mean():+7.1f}  worst {g.v1_net.min():+7.1f} / {x.min():+7.1f}{ex}')
g = R[R.r1_acted]; print(f'\nR1: the ratchet moved the stop on {len(g)} entries; median final stop distance from the entry {g.r1_final.median():+.0f} pts (positive = still a loss limit, negative = a locked profit); locked a profit on {int((g.r1_final < 0).sum())}')
fh = (R.ehr >= H10) & (R.ehr < H11); print('\nBY ENTRY HOUR (descriptive): mean paired capture diff / net diff vs V1 over all entries')
for lab, m in (('10:00-10:59', fh), ('11:00 on', ~fh)):
    gg = R[m]; print(f'  {lab:12s} N={len(gg):4d}' + ''.join(f'   {a.upper()}: cap {(gg[f"cap_{a}"] - gg.cap_v1).mean():+.3f} net {(gg[f"{a}_net"] - gg.v1_net).mean():+6.2f}' for a in ARMS))
