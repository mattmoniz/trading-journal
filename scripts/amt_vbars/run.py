"""500-contract node ladder + flow tell, EXPLORE ONLY (PREREG.md + Amendment 1 frozen). Hold-out not extracted.  Usage: ../../venv/bin/python run.py"""
import glob, os, pathlib
import numpy as np, pandas as pd
import vbars as V
SEED, BOOT = 20261028, 3000
HERE = pathlib.Path(__file__).parent

def sdiff(st, a, r, y):
    tot = 0.0; w = 0
    for k in range(3):
        m = st == k; ma, mr = m & a, m & r
        if ma.sum() == 0 or mr.sum() == 0: continue
        tot += ma.sum() * (np.nanmean(y[ma]) - np.nanmean(y[mr])); w += ma.sum()
    return tot / w if w else np.nan

def boot(d, a, r, y, rng):
    dates = d.date.to_numpy(); ud = np.unique(dates); idx = [np.where(dates == x)[0] for x in ud]; st = d.stratum.to_numpy(); res = []
    for _ in range(BOOT):
        pk = np.concatenate([idx[j] for j in rng.integers(0, len(ud), len(ud))]); res.append(sdiff(st[pk], a[pk], r[pk], y[pk]))
    res = np.array(res); return np.nanpercentile(res, [2.5, 97.5]), np.nanpercentile(res, 2.5)

def main():
    rng = np.random.default_rng(SEED)
    dates = sorted(os.path.basename(p)[:10] for p in glob.glob(V.ROOT + '/*.bars.tsv')); dates = [d for d in dates if d <= '2025-05-16']
    sess = {}; stats = {}
    for d in dates:
        try: S = V.load_session(d)
        except Exception as e: print('skip', d, e); continue
        sess[d] = S; stats[d] = V.session_stats(S)
    ks = sorted(sess); print(f"Sessions with bars {len(ks)} ({ks[0]}..{ks[-1]}); hold-out NOT extracted")
    rows = []
    for i, d in enumerate(ks):
        if i < 20: continue
        prior = ks[i - 20:i]; rngs = [stats[p][0] for p in prior if not np.isnan(stats[p][0])]
        if len(rngs) < 15: continue
        atr = float(np.mean(rngs)); base = {}
        for h in range(24):
            vals = [stats[p][1][h] for p in prior if h in stats[p][1]]
            if len(vals) >= 15: base[h] = float(np.mean(vals))
        rows += V.points(sess[d], atr, base)
    df = pd.DataFrame(rows).dropna(subset=['A', 'fwd']).reset_index(drop=True)
    qmed, rmed = float(df.Q.median()), float(df.R.median()); print(f"Decision points {len(df)} over {df.date.nunique()} sessions; median Q {qmed:.3f}, median R {rmed:.1f} (frozen cutoffs)")
    df['nodes'] = df.L >= 2; df['fast'] = df.A >= 1; df['flip'] = df.Q >= qmed; df['osc'] = df.R >= rmed
    comps = ['nodes', 'fast', 'flip', 'osc', 'strides']; df['ncomp'] = df[comps].sum(axis=1)
    q = df.dist.quantile([1 / 3, 2 / 3]).values; df['stratum'] = np.where(df.dist <= q[0], 0, np.where(df.dist <= q[1], 1, 2))
    print("L distribution:", df.L.value_counts().sort_index().to_dict(), "| moving share", f"{100 * df.moving.mean():.0f}%", "| strides share", f"{100 * df.strides.mean():.0f}%")
    arms = {'TELL5': df.ncomp == 5, 'TELL4': df.ncomp >= 4, 'TELL3': df.ncomp >= 3}
    orig = df.nodes & df.fast & df.flip & df.moving
    print("\nARM SIZES (events / dates):")
    for k, m in list(arms.items()) + [('TELL3-original (nodes+fast+flip+moving)', orig)]:
        print(f"  {k:40s} {int(m.sum()):5d} / {df[m].date.nunique():3d}  up {int((m & (df.dir == 1)).sum())} down {int((m & (df.dir == -1)).sum())}")
    print("  MOVING-ONLY control:", int(df.moving.sum()), "| single-component counts:", {c: int(((df.ncomp == 1) & df[c]).sum()) for c in comps})
    prim = next((k for k in ('TELL5', 'TELL4', 'TELL3') if arms[k].sum() >= 150 and df[arms[k]].date.nunique() >= 60), None)
    d_ = df; st = d_.stratum.to_numpy(); fwd = d_.fwd.to_numpy(); brk = d_.brk.astype(float).to_numpy(); mv = d_.moving.to_numpy()
    print(f"\nPRIMARY ARM by the counts rule: {prim or 'NONE (UNDERPOWERED)'}")
    for lab, m in [(k, v) for k, v in arms.items()] + [('moving-only', pd.Series(mv)), ('all points', pd.Series(np.ones(len(df), bool)))]:
        g = df[m.to_numpy()]; print(f"  {lab:12s} N={len(g):5d} break {100 * g.brk.mean():5.1f}%  signed 60-min move {g.fwd.mean():+.4f} ATR20")
    def rep(name, a_mask, ref_mask):
        a = a_mask.to_numpy() if hasattr(a_mask, 'to_numpy') else a_mask; r = ref_mask
        if a.sum() < 5: print(f"  {name}: N={int(a.sum())} too few"); return
        pt = sdiff(st, a, r, fwd); ci, lo = boot(d_, a, r, fwd, rng); pb = sdiff(st, a, r, brk); cb, _ = boot(d_, a, r, brk, rng)
        print(f"  {name:38s} N={int(a.sum()):5d} signed move {pt:+.4f} ATR20 CI [{ci[0]:+.4f}, {ci[1]:+.4f}] (1-sided 97.5% lb {lo:+.4f}) | break {100 * pb:+.1f} pts CI [{100 * cb[0]:+.1f}, {100 * cb[1]:+.1f}]")
    print("\nPRIMARY (signed 60-min move, arm minus MOVING-ONLY not in the arm):")
    if prim: rep(prim, arms[prim], mv & ~arms[prim].to_numpy())
    print("\nDESCRIPTIVE (not counted): every arm and single components vs moving-only")
    for k in arms:
        if k != prim: rep(k, arms[k], mv & ~arms[k].to_numpy())
    rep('TELL3-original', orig, mv & ~orig.to_numpy())
    for c in comps:
        rep(f'only {c}', (d_.ncomp == 1) & d_[c], mv & ~((d_.ncomp == 1) & d_[c]).to_numpy())
        rep(f'all but {c}', (d_.ncomp == 4) & ~d_[c], mv & ~((d_.ncomp == 4) & ~d_[c]).to_numpy())
    df.to_csv(HERE / 'decision_points_explore.csv', index=False)
    print("\nReading is pre-registered (PREREG.md + Amendment 1): lead = primary lower bound > 0 AND the primary arm beats its single components on the signed move. Under 150 events / 60 dates = underpowered.")

if __name__ == '__main__':
    main()
