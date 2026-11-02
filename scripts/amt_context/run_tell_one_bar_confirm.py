"""docs/TELL_ONE_BAR_CONFIRM_PREREG_20261102.md. EXPLORE only, SIMULATED dollars. READS OUTCOMES -> look logged first (log_look_tell_one_bar_confirm.mjs). Usage: nice python run_tell_one_bar_confirm.py"""
import sys; sys.argv = sys.argv[:1]
import numpy as np, pandas as pd
import tell_state as TS, vbars as V, trade as T
SEED, BOOT, SLIP = 20261102, 3000, T.SLIP

def main():
    rng = np.random.default_rng(SEED + 151); _, ctxs, _ = TS.sessions_and_contexts(); rows = []; skipped = 0
    for d in sorted(ctxs):
        ctx = ctxs[d]; S = ctx['S']; end = S['end']; o, c = S['o'], S['c']
        for t in T.simulate(ctx, 'V1', dict(fires=0, skip=0, trades=0, fallback=0)):
            i, dr = int(t['sig']); i = int(t['sig']); dr = int(t['dir']); conf = dr * (c[i + 1] - c[i]) > 0 if i + 1 < ctx['n'] else False; row = dict(date=d, net0=float(t['net']), conf=bool(conf), netd=np.nan, shift=np.nan, reason0=t['reason'])
            if conf and i + 3 < ctx['n']:
                stop = float(t['stop']); entry_d = o[i + 2] + dr * SLIP
                if dr * (entry_d - stop) <= 0: skipped += 1
                else:
                    tr = T.run_position(ctx, T.Prof(ctx), i + 2, dr, stop, 'V1', end[i]); row['netd'] = float(tr['net']); row['shift'] = dr * (entry_d - float(t['entry'])); row['reasond'] = tr['reason']
            rows.append(row)
    R = pd.DataFrame(rows); n = len(R); nc = int(R.conf.sum()); print(f'V1 trades {n}; CONFIRMED (next bar closes in the tell direction) {nc} ({100 * nc / n:.0f}%); delayed trades {int(R.netd.notna().sum())}; skipped (delayed entry not on the profit side of the stop) {skipped}')
    ud = np.array(sorted(R.date.unique())); idx = {u: np.where(R.date.values == u)[0] for u in ud}
    def pt(mask, col): v = R[col].values; return np.array([np.nansum(v[idx[u]][mask[idx[u]]]) for u in ud]), np.array([int(np.sum(mask[idx[u]] & np.isfinite(v[idx[u]]))) for u in ud])
    masks = dict(CONF=R.conf.values, AGAINST=~R.conf.values, ALL=np.ones(n, bool), DELAYED=R.netd.notna().values)
    S_ = {'CONF_orig': pt(masks['CONF'], 'net0'), 'AGAINST_orig': pt(masks['AGAINST'], 'net0'), 'ALL_orig': pt(masks['ALL'], 'net0'), 'DELAYED': pt(masks['DELAYED'], 'netd')}
    mm = lambda w, a: (w @ a[0]) / max(1.0, w @ a[1]); w1 = np.ones(len(ud)); half = (np.arange(len(ud)) < len(ud) // 2) * 1.0; hb = 1 - half
    def test(a, b):
        bd = [mm(w, S_[a]) - mm(w, S_[b]) for w in (np.bincount(rng.integers(0, len(ud), len(ud)), minlength=len(ud)).astype(float) for _ in range(BOOT))]; diff = mm(w1, S_[a]) - mm(w1, S_[b]); p = float(min(1.0, 2 * min((np.sum(np.array(bd) <= 0) + 1) / (BOOT + 1), (np.sum(np.array(bd) >= 0) + 1) / (BOOT + 1))))
        return dict(diff=diff, lo=np.percentile(bd, 2.5), hi=np.percentile(bd, 97.5), p=p, h1=mm(half, S_[a]) - mm(half, S_[b]), h2=mm(hb, S_[a]) - mm(hb, S_[b]))
    t1 = test('CONF_orig', 'AGAINST_orig'); t2 = test('DELAYED', 'ALL_orig'); bdd = [mm(w, S_['DELAYED']) for w in (np.bincount(rng.integers(0, len(ud), len(ud)), minlength=len(ud)).astype(float) for _ in range(BOOT))]; dl, dh = np.percentile(bdd, [2.5, 97.5])
    order = sorted([('T1', t1), ('T2', t2)], key=lambda x: x[1]['p']); keep = -1
    for rk, (k, r) in enumerate(order): keep = rk if r['p'] <= (rk + 1) / 2 * 0.10 else keep
    print(f'\nRESOLUTION: delayed-trade mean CI [{dl:+.1f}, {dh:+.1f}] dollars (half-width {(dh - dl) / 2:.1f})')
    print(f'means (per trade, $): ORIGINAL all {mm(w1, S_["ALL_orig"]):+.2f}; ORIGINAL confirmed (N {nc}) {mm(w1, S_["CONF_orig"]):+.2f}; ORIGINAL against (N {n - nc}) {mm(w1, S_["AGAINST_orig"]):+.2f}; DELAYED confirmed (N {int(R.netd.notna().sum())}) {mm(w1, S_["DELAYED"]):+.2f}; mean entry price shift of the delay {np.nanmean(R.shift):+.2f} points')
    for rk, (k, r) in enumerate(order):
        ok = k == 'T2' and rk <= keep and (r['lo'] > 0 or r['hi'] < 0) and dl > 0 and int(R.netd.notna().sum()) >= 200 and len(np.unique(R.date[R.netd.notna()])) >= 100 and np.sign(r['h1']) == np.sign(r['h2']) == np.sign(r['diff'])
        print(f'  {k} {"original confirmed minus against" if k == "T1" else "delayed minus all original"}: {r["diff"]:+.2f} CI [{r["lo"]:+.2f}, {r["hi"]:+.2f}] p {r["p"]:.3f} halves {r["h1"]:+.2f} / {r["h2"]:+.2f} BH {"survives" if rk <= keep else "no"}{"  <== CANDIDATE" if ok else ""}')
    dd = R[R.netd.notna()]; print(f'UNCOUNTED: stop-out share original all {100 * np.mean([x in ("STOP", "STOP_GAP") for x in R.reason0]):.0f}%, delayed {100 * np.mean([x in ("STOP", "STOP_GAP") for x in dd.reasond]):.0f}%; by year (delayed mean $): ' + ', '.join(f'{y} {dd[dd.date.str[:4] == y].netd.mean():+.1f} (N {int((dd.date.str[:4] == y).sum())})' for y in sorted(set(dd.date.str[:4]))))

if __name__ == '__main__': main()
