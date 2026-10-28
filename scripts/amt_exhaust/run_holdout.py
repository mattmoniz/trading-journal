"""ONE look at the sealed hold-out (PREREG_HOLDOUT.md frozen). Usage: ../../venv/bin/python run_holdout.py   (refuses a second run)"""
import os, sys, pathlib, datetime, importlib.util
os.environ.update(EXH_PART='holdout', EXH_QMV='80', EXH_QER='60', EXH_TAG='_holdout')
import numpy as np, pandas as pd
HERE = pathlib.Path(__file__).parent; lock = HERE / 'holdout_exhaust.lock'
if lock.exists(): raise SystemExit('HOLD-OUT ALREADY LOOKED AT ONCE (holdout_exhaust.lock). No second look.')
lock.write_text(datetime.datetime.now().isoformat())
sys.path.insert(0, str(HERE))
sp = importlib.util.spec_from_file_location('exrun', str(HERE / 'run.py')); R = importlib.util.module_from_spec(sp); sp.loader.exec_module(R)
import exhaust as X
rng = np.random.default_rng(R.SEED)
sess = R.prepare(); out, _ = R.events_for(sess); by = R.enrich(sess, out)
print(f"HOLD-OUT: {len(sess)} sessions ({sess[0]['d']}..{sess[-1]['d']}) | E1 {len(out['E1'])} E2 {len(out['E2'])} C2 {len(out['C2'])} NR {len(out['NR'])} | cuts: at-level {R.CUT_REAL}, sham {R.CUT_SHAM} ATR20")
def did(evs, idx):
    F = np.array([e['F15'] for e in evs]); nr = np.array([e['d_real'] <= R.CUT_REAL for e in evs]); ns = np.array([e['d_sham'] <= R.CUT_SHAM for e in evs]); i = np.asarray(idx)
    if not (nr[i].any() and (~nr[i]).any() and ns[i].any() and (~ns[i]).any()): return np.nan
    return (F[i][nr[i]].mean() - F[i][~nr[i]].mean()) - (F[i][ns[i]].mean() - F[i][~ns[i]].mean())
for g in ('E1', 'E2'):
    evs = [e for e in out[g] if not np.isnan(e['F15'])]; at = [e for e in evs if e['d_real'] <= R.CUT_REAL]; rest = [e for e in evs if e['d_real'] > R.CUT_REAL]; sh = [e for e in evs if e['d_sham'] <= R.CUT_SHAM]
    print(f"\n=== CELL {g}-AT-LEVEL ===")
    if len(at) < 30: print(f"  N={len(at)} < 30: NOT EVALUATED"); continue
    m, lo, hi = R.boot_mean([e['F15'] for e in at], [e['date'] for e in at], rng)
    mr, lor, hir = R.boot_mean([e['F15'] for e in rest], [e['date'] for e in rest], rng, 1500); ms, los, his = R.boot_mean([e['F15'] for e in sh], [e['date'] for e in sh], rng, 1500)
    print(f"  at-real-level: N={len(at)} days={len(set(e['date'] for e in at))} gross mean F15 {m:+.2f} (95% CI {lo:+.2f}..{hi:+.2f}; 97.5% one-sided lower bound = {lo:+.2f}) | net of 1.5 pts {m - 1.5:+.2f} | F15>0 {100 * np.mean([e['F15'] > 0 for e in at]):.0f}%")
    print(f"  not at level: N={len(rest)} {mr:+.2f} (CI {lor:+.2f}..{hir:+.2f}) | near SHAM level: N={len(sh)} {ms:+.2f} (CI {los:+.2f}..{his:+.2f})")
    days = [e['date'] for e in evs]; dd = {}
    for i, d in enumerate(days): dd.setdefault(d, []).append(i)
    keys = list(dd); base = did(evs, np.arange(len(evs))); bs = [did(evs, np.concatenate([dd[keys[j]] for j in rng.integers(0, len(keys), len(keys))]).astype(int)) for _ in range(2000)]; bs = [b for b in bs if not np.isnan(b)]
    dlo, dhi = np.percentile(bs, 2.5), np.percentile(bs, 97.5); print(f"  DIFFERENCE-IN-DIFFERENCES vs sham: {base:+.2f} (95% CI {dlo:+.2f}..{dhi:+.2f})")
    pl = []
    for _ in range(R.TRIALS):
        v = []
        for e in at:
            a = by[e['date']]['a']; lo_, hi_ = max(X.ENTRY_LO, e['e'] - 30), min(X.ENTRY_HI, e['e'] + 30)
            for _t in range(20):
                i = int(rng.integers(lo_, hi_ + 1)); dd_ = int(rng.choice([-1, 1]))
                if i + 14 < 390 and not np.isnan(a['o'][i]) and not np.isnan(a['c'][i + 14]): v.append(dd_ * (a['c'][i + 14] - (a['o'][i] + dd_ * X.SLIP))); break
        pl.append(np.mean(v))
    pl = np.array(pl); p95 = np.percentile(pl, 95); print(f"  RANDOM-ENTRY PLACEBO: p5 {np.percentile(pl, 5):+.2f} p50 {np.percentile(pl, 50):+.2f} p95 {p95:+.2f} | trials >= cell {100 * np.mean(pl >= m):.1f}%")
    lead = lo > 0 and m > p95 and dlo > 0
    print(f"  LEAD CRITERIA: lower bound > 0: {lo > 0} | beats placebo p95: {m > p95} | DiD lower bound > 0: {dlo > 0}  =>  {'LEAD CONFIRMED ON HOLD-OUT' if lead else 'NOT CONFIRMED'}")
    gs = [e['geo'] for e in at if e['geo']]
    if gs:
        net = np.array([x['net'] for x in gs]); w, l_ = net[net > 0], net[net <= 0]; gm, glo, ghi = R.boot_mean(list(net), [e['date'] for e in at if e['geo']], rng, 1500)
        print(f"  geometry (descriptive): N={len(gs)} WR {100 * np.mean(net > 0):.0f}% PF {(w.sum() / abs(l_.sum())) if l_.sum() != 0 else float('inf'):.2f} mean ${gm:.2f}/trade (CI {glo:.2f}..{ghi:.2f}) median risk {np.median([x['risk'] for x in gs]):.1f} target {np.median([x['tdist'] for x in gs]):.1f} pts")
print('\n--- context, not counted ---')
for g in ('E1', 'E2', 'C2', 'NR'):
    v = [e['F15'] for e in out[g]]; m, lo, hi = R.boot_mean(v, [e['date'] for e in out[g]], rng, 1500); print(f"  {g} overall: N={len(v)} gross mean F15 {m:+.2f} (CI {lo:+.2f}..{hi:+.2f})")
rows = [dict(grp=k, **{kk: vv for kk, vv in e.items() if kk != 'geo'}) for k in out for e in out[k]]; pd.DataFrame(rows).to_csv(HERE / 'events_holdout.csv', index=False)
print('\nHold-out consumed for this question (holdout_exhaust.lock).')
