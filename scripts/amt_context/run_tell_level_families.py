"""docs/TELL_PULLBACK_AND_LEVEL_DIRECTION_PREREG_20261102.md Part D: the stored level set as families. EXPLORE only, RTH, points. READS OUTCOMES -> look logged first. Usage: nice python run_tell_level_families.py"""
import sys; sys.argv = sys.argv[:1]
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_tell_live')
import numpy as np, pandas as pd
import tell_state as TS, vbars as V, trade as T, persist
from run_tell_at_level import outcomes
SEED, BOOT = 20261102, 3000; HZ = (15, 30, 60)
FAM = {'OR_HL': [f'OR{n}_{s}' for n in (5, 10, 15, 30) for s in ('HIGH', 'LOW')], 'MIDS': ['OR5_MID', 'OR10_MID', 'OR15_MID', 'OR30_MID', 'IB_MID', 'PD_OR_MID', 'PD_IB_MID', 'PW_MID'], 'IB_HL': ['IB_HIGH', 'IB_LOW'], 'OVN': ['ONH', 'ONL'],
       'PRIOR_DAY': ['PD_HIGH', 'PD_LOW', 'PD_CLOSE', 'PD_POC', 'PD_IB_HIGH', 'PD_IB_LOW'], 'VALUE_AREA': [f'{p}_{s}' for p in ('PD', 'PW', 'PM', 'PY', '3M') for s in ('VAH', 'VAL')],
       'CAMARILLA': [f'CAM_{x}{i}' for x in 'RS' for i in range(1, 5)], 'FLOOR': ['FLOOR_PIVOT'] + [f'FLOOR_{x}{i}' for x in 'RS' for i in range(1, 4)], 'WM_PIVOTS': ['WPP', 'WR1', 'WR2', 'WS1', 'WS2', 'MPP', 'MR1', 'MR2', 'MS1', 'MS2'],
       'OPENS_VWAP': ['DAILY_OPEN', 'WEEKLY_OPEN', 'MONTHLY_OPEN', 'WEEKLY_VWAP', 'MONTHLY_VWAP'], 'PERIOD_HLP': ['PW_HIGH', 'PW_LOW', 'PW_POC', 'PM_HIGH', 'PM_LOW', 'PM_POC', 'PY_POC', '3M_POC']}
MINS = {**{f'OR{n}_{s}': n for n in (5, 10, 15, 30) for s in ('HIGH', 'LOW', 'MID')}, 'IB_HIGH': 60, 'IB_LOW': 60, 'IB_MID': 60}

def load_levels(conn):
    with conn.cursor() as c: c.execute("SELECT trade_date::text, level_name, price::float FROM level_prices WHERE trade_date BETWEEN '2023-04-01' AND '2025-05-16' AND price IS NOT NULL"); rows = c.fetchall()
    L = {}
    for d, n, p in rows: L.setdefault(d, {})[n] = p
    return L

def nearest(S, i, levels, names, minutes_open):
    c = S['c'][i]; up, dn = [], []
    for nm in names:
        p = levels.get(nm)
        if p is None or not np.isfinite(p) or minutes_open < MINS.get(nm, 0): continue
        (up if p > c else dn).append((abs(p - c), nm)) if p != c else None
    if not up or not dn: return None
    du, ku = min(up); dl, kd = min(dn); scale = float(np.median(S['h'][i - 19:i + 1] - S['l'][i - 19:i + 1]))
    if min(du, dl) > 2 * scale: return None
    return (-1, ku) if du < dl else (1, kd)

def main():
    rng = np.random.default_rng(SEED + 173); sess, ctxs, _ = TS.sessions_and_contexts(); conn = persist.connect(); LV = load_levels(conn); rows = []; allnames = [n for v in FAM.values() for n in v]; cov = 0
    for d in sorted(ctxs):
        if d not in LV: continue
        cov += 1; levels = LV[d]; ctx = ctxs[d]; S = ctx['S']; end, comp = S['end'], S['comp']; prof = T.Prof(ctx)
        tells = [(int(t['sig']), int(t['dir'])) for t in T.simulate(ctx, 'V1', dict(fires=0, skip=0, trades=0, fallback=0))]
        ctl = [(i, 0) for i in range(ctx['n'] - 1) if i % 10 == 0 and V.DEC_FIRST <= end[i] <= V.DEC_LAST and comp[i] and (ctx['moving1'][i] or ctx['moving-1'][i]) and not any(T.ncomp_at(ctx, prof, i, dd, need_nodes=False)[1] for dd in (1, -1))]
        for arm, pts in (('TELL', tells), ('CONTROL', ctl)):
            for i, tdir in pts:
                if i < 20 or i + 4 >= ctx['n']: continue
                mo = (S['start'][i] - V.RTH_OPEN) / 60.0; base = dict(date=d, arm=arm, tdir=tdir); ys = None
                for fam, names in list(FAM.items()) + [('ALL', allnames)]:
                    ch = nearest(S, i, levels, names, mo)
                    if ch is None: continue
                    if ys is None: ys = {}
                    dr, lvl = ch; key = (dr,)
                    if dr not in ys: ys[dr] = {H: outcomes(S, i + 1, dr, H) for H in HZ}
                    rows.append(dict(base, fam=fam, dr=dr, level=lvl, agree=(None if arm == 'CONTROL' else dr == tdir), **{f'y{H}': ys[dr][H] for H in HZ}))
    R = pd.DataFrame(rows); R.to_csv('/home/mmoniz/trading-journal/scratch/tell_level_families_rows_20261102.csv', index=False); print(f'dates with stored levels {cov}; events {len(R)}')
    def cell(df, H):
        g = lambda a: df[df.arm == a].dropna(subset=[f'y{H}']).groupby('date')[f'y{H}'].agg(['sum', 'count']); gT, gC = g('TELL'), g('CONTROL'); ud = np.array(sorted(set(gT.index) | set(gC.index)))
        if len(gT) == 0 or len(gC) == 0: return None
        AT = np.c_[gT.reindex(ud)['sum'].fillna(0).values, gT.reindex(ud)['count'].fillna(0).values]; AC = np.c_[gC.reindex(ud)['sum'].fillna(0).values, gC.reindex(ud)['count'].fillna(0).values]; m = lambda w, a: (w @ a[:, 0]) / max(1.0, w @ a[:, 1]); w1 = np.ones(len(ud)); bd, bt = [], []
        for _ in range(BOOT): w = np.bincount(rng.integers(0, len(ud), len(ud)), minlength=len(ud)).astype(float); bd.append(m(w, AT) - m(w, AC)); bt.append(m(w, AT))
        h = len(ud) // 2; ha = (np.arange(len(ud)) < h) * 1.0; hb = 1 - ha; p = float(min(1.0, 2 * min((np.sum(np.array(bd) <= 0) + 1) / (BOOT + 1), (np.sum(np.array(bd) >= 0) + 1) / (BOOT + 1))))
        return dict(diff=m(w1, AT) - m(w1, AC), lo=np.percentile(bd, 2.5), hi=np.percentile(bd, 97.5), tm=m(w1, AT), tl=np.percentile(bt, 2.5), th=np.percentile(bt, 97.5), cm=m(w1, AC), p=p, h1=m(ha, AT) - m(ha, AC), h2=m(hb, AT) - m(hb, AC), n=int(AT[:, 1].sum()), days=int((AT[:, 1] > 0).sum()), nc=int(AC[:, 1].sum()))
    fams = list(FAM); res = {f: cell(R[R.fam == f], 'y30') for f in fams}; live = [f for f in fams if res[f] is not None]; order = sorted(live, key=lambda f: res[f]['p']); keep = -1
    for rk, f in enumerate(order): keep = rk if res[f]['p'] <= (rk + 1) / len(live) * 0.10 else keep
    print('\nRESOLUTION: ' + ', '.join(f'{f} {(res[f]["th"] - res[f]["tl"]) / 2:.1f}' for f in live)); print('\nCOUNTED (11 families, y30 = points fading the nearest level of the family; TELL minus CONTROL):')
    for rk, f in enumerate(order):
        r = res[f]; sgn = np.sign(r['diff']); ok = rk <= keep and (r['lo'] > 0 or r['hi'] < 0) and ((r['tl'] > 1.5) if sgn > 0 else (-r['th'] > 1.5)) and r['n'] >= 200 and r['days'] >= 100 and np.sign(r['h1']) == np.sign(r['h2']) == sgn
        print(f'  {f:11s} TELL {r["tm"]:+6.2f} [{r["tl"]:+.1f}, {r["th"]:+.1f}] (N {r["n"]}, {r["days"]} dates) CONTROL {r["cm"]:+6.2f} (N {r["nc"]}) diff {r["diff"]:+6.2f} CI [{r["lo"]:+.2f}, {r["hi"]:+.2f}] p {r["p"]:.3f} halves {r["h1"]:+.1f}/{r["h2"]:+.1f} BH {"survives" if rk <= keep else "no"}{"  UNDERPOWERED" if r["n"] < 200 or r["days"] < 100 else ""}{"  <== CANDIDATE" if ok else ""}')
    a = cell(R[R.fam == 'ALL'], 'y30'); print(f'\nUNCOUNTED all stored levels pooled (nearest of all): TELL {a["tm"]:+.2f} (N {a["n"]}) CONTROL {a["cm"]:+.2f} diff {a["diff"]:+.2f} CI [{a["lo"]:+.2f}, {a["hi"]:+.2f}]')
    for H in (15, 60): print(f'UNCOUNTED y{H} by family (diff, N): ' + '; '.join(f'{f} {cell(R[R.fam == f], f"y{H}")["diff"]:+.1f} ({res[f]["n"]})' for f in live))

if __name__ == '__main__': main()
