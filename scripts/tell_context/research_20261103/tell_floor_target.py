"""Floor target on the tell: docs/TELL_FLOOR_TARGET_PREREG_20261105.md (look 179, 3 counted tests). Same 1,760 explore entries, V1 management, each arm only ADDS a limit target.
Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/tell_floor_target.py   (look logged first by log_look_floor_target_20261105.mjs, hr-023)"""
import os, sys, json
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tell_replay_lib import replay_rows, F, REPO, SH, T, V
from watcher_stop_lib import run_dyn
from structure_lib import RAW, day_structure, levels_at

RTH0 = 55800.0; MULTS = (0.75, 1.0, 1.5); MIN_WIN = 100; MIN_ACTED = 150; H10, H11 = 57600.0, 61200.0
rng = np.random.default_rng(20261105)
P = pd.read_csv(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'tell_structure_exit_rows.csv'), usecols=['date', 'v1_net', 'v1_mfe'])   # the V1 outcomes of the same 1,760 entries (parity checked below)
FD = {}
for d in sorted(P.date.unique()):
    w = P[(P.date < d) & (P.v1_net > 0)]; FD[d] = float(w.v1_mfe.median()) if len(w) >= MIN_WIN else np.nan
CACHE = {}
def extra(S, allb, sig, t, ctxf):
    ctx = S['_ctx']; d = int(t['dir']); ei = int(t['ei']); risk = float(t['risk']); end_i = S['end'][sig]; date = t['date']
    Fv = FD.get(date, np.nan); out = dict(F=Fv, ehr=float(S['start'][ei]), has=(date in RAW))
    v1 = run_dyn(ctx, T.Prof(ctx), ei, d, risk, end_i)[0]; out.update(v1_net=v1['net'], v1_pts=v1['pts'], v1_mfe=v1['mfe'], v1_why=v1['reason'], risk_pts=risk)
    for m in MULTS: out.update({f's{m}_net': v1['net'], f's{m}_acted': False, f's{m}_dist': np.nan, f's{m}_why': v1['reason'], f's{m}_pts': v1['pts']})
    out.update(d1_net=v1['net'], d1_acted=False, d1_why=v1['reason'], d1_pts=v1['pts'])
    if np.isnan(Fv) or not out['has']: return out
    if date not in CACHE: CACHE.clear(); CACHE[date] = day_structure(date)
    S2 = CACHE[date]; entry = float(S['o'][ei]) + d * T.SLIP; e_min = int((S['start'][ei] - RTH0) // 60)
    if e_min < 0 or e_min >= S2['n'] - 1: return out
    cands = [float(zh if d == -1 else zl) for zl, zh in S2['zones']] + [float(L) for L in levels_at(S2, e_min)]
    ahead = sorted(c for c in cands if (c < entry if d == -1 else c > entry))
    if d == -1: ahead = ahead[::-1]
    def run(tg): return run_dyn(ctx, T.Prof(ctx), ei, d, risk, end_i, target=tg)[0]
    for m in MULTS:
        far = [c for c in ahead if abs(c - entry) >= m * Fv]
        if far:
            tr = run(far[0]); out.update({f's{m}_net': tr['net'], f's{m}_acted': tr['reason'] == 'TARGET', f's{m}_dist': abs(far[0] - entry), f's{m}_why': tr['reason'], f's{m}_pts': tr['pts'], f's{m}_has': True})
            if m == 1.0:
                tg = entry + d * Fv; tr2 = run(tg); out.update(d1_net=tr2['net'], d1_acted=tr2['reason'] == 'TARGET', d1_why=tr2['reason'], d1_pts=tr2['pts'])
    return out

def boot(x, days, q, B=4000):
    x = np.asarray(x, float); s = pd.Series(x).groupby(days).agg(['sum', 'count']); sm, ct = s['sum'].values, s['count'].values; m = np.empty(B)
    for b in range(B): p = rng.integers(0, len(sm), len(sm)); m[b] = sm[p].sum() / ct[p].sum()
    return np.percentile(m, q), float(np.std(m))

R, bad = replay_rows(extra)
R.to_csv(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'tell_floor_target_rows.csv'), index=False)
print(f'{len(R)} entries ({bad} without an entry bar); PARITY v1 vs the file: max |diff| {np.abs(R["v1_net"] - R.csv_net).max():.4f}, trades differing by more than 0.01: {int((np.abs(R["v1_net"] - R.csv_net) > 0.01).sum())}')
S = R[~R.F.isna() & R.has].copy(); print(f'seed / no-structure-data entries dropped: {len(R) - len(S)}; scored {len(S)} entries on {S.date.nunique()} dates; F (points): min {S.F.min():.1f}, median {S.F.median():.1f}, max {S.F.max():.1f}')
dates = sorted(S.date.unique()); half2 = S.date.isin(set(dates[len(dates) // 2:])).values; lo, hi = 0.833, 99.167
dn1 = (S['s1.0_net'] - S.v1_net).values; dn2 = (S['s1.0_net'] - S.d1_net).values; sm = (S.risk_pts <= 100).values; dn3 = np.where(sm, dn1, 0.0)
sd1 = boot(dn1, S.date.values, (lo, hi))[1]; sd2 = boot(dn2, S.date.values, (lo, hi))[1]; sd3 = boot(dn3, S.date.values, (lo, hi))[1]
print(f'\nDETECTABLE EFFECT (2.8 x SE), dollars per scored entry: T1 {2.8 * sd1:.2f}, T2 {2.8 * sd2:.2f}, T3 {2.8 * sd3:.2f} (printed before results)')
acted = S['s1.0_acted'].values; has = S['s1.0_dist'].notna().values
print(f'FUNNEL: structure at or beyond F exists for {has.sum()} of {len(S)} entries ({100 * has.mean():.1f}%); target REACHED on {acted.sum()} ({100 * acted.mean():.1f}%); median target distance {S["s1.0_dist"].median():.1f} pts vs median F {S.F.median():.1f}; DIST arm reached on {int(S.d1_acted.sum())}')
print('\nCOUNTED TESTS (mean paired net dollars per scored entry, CI 98.33% day-block):')
for lab, dn in (('T1 STRUCT minus V1', dn1), ('T2 STRUCT minus DIST', dn2), ('T3 STRUCT minus V1, stop <= 100 pts', dn3)):
    c, s = boot(dn, S.date.values, (lo, hi)); hs = (dn[~half2].mean(), dn[half2].mean())
    print(f'  {lab}: {dn.mean():+7.3f} [{c[0]:+.3f}, {c[1]:+.3f}] SE {s:.3f}  halves {hs[0]:+.3f} / {hs[1]:+.3f}')
c1 = boot(dn1, S.date.values, (lo, hi))[0]; lead = c1[0] > 0 and dn1[~half2].mean() > 0 and dn1[half2].mean() > 0
print(f'\nVERDICT (prereg section 4): ' + ('LEAD' if lead else 'NOT SHOWN') + f'; acted {acted.sum()} {"(>= " if acted.sum() >= MIN_ACTED else "(< "}{MIN_ACTED}{" , adequately powered by count)" if acted.sum() >= MIN_ACTED else " , UNDERPOWERED by count)"}')
print('\n--- REPORTED, NOT COUNTED ---')
for m in MULTS:
    d = (S[f's{m}_net'] - S.v1_net); a = S[f's{m}_acted']; print(f'floor x{m}: mean diff vs V1 {d.mean():+.3f}, structure exists {S[f"s{m}_dist"].notna().sum()}, reached {int(a.sum())}')
g = S[S['s1.0_dist'].notna()]; x = g['s1.0_net']; print(f'on entries WITH a far structure (N {len(g)}): V1 mean {g.v1_net.mean():+.2f} / STRUCT {x.mean():+.2f} / DIST {g.d1_net.mean():+.2f}; STRUCT WR {100 * (x > 0).mean():.0f}% avg win {x[x > 0].mean():+.1f} avg loss {x[x <= 0].mean():+.1f}; V1 WR {100 * (g.v1_net > 0).mean():.0f}% avg win {g.v1_net[g.v1_net > 0].mean():+.1f} avg loss {g.v1_net[g.v1_net <= 0].mean():+.1f}')
print('STRUCT exit mix on those:', g['s1.0_why'].value_counts().to_dict())
for lab, mk in (('stop <= 100', sm), ('stop > 100', ~sm)):
    z = S[mk]; print(f'  {lab}: N {len(z)}, STRUCT minus V1 {(z["s1.0_net"] - z.v1_net).mean():+.3f}, reached {int(z["s1.0_acted"].sum())}, V1 mean {z.v1_net.mean():+.2f}')
fh = ((S.ehr >= H10) & (S.ehr < H11)).values
for lab, mk in (('10:00-10:59', fh), ('11:00 on', ~fh)): z = S[mk]; print(f'  entry {lab}: N {len(z)}, STRUCT minus V1 {(z["s1.0_net"] - z.v1_net).mean():+.3f}')
