"""docs/TELL_STOP_AND_REVERSE_PREREG_20261102.md. EXPLORE only, SIMULATED dollars. READS OUTCOMES -> look logged first. Usage: nice python run_tell_stop_reverse.py"""
import sys; sys.argv = sys.argv[:1]
import numpy as np, pandas as pd
import tell_state as TS, vbars as V, trade as T
SEED, BOOT, SLIP, DPP, COMM, TMO, FLAT = 20261102, 3000, T.SLIP, T.DPP, T.COMM, T.TIMEOUT_S, T.FLAT_S

def leg(S, ei, d, s, t0):
    """one leg: returns (net dollars, exit bar index, reason). Same geometry as trade.stripped_full, with the reason returned."""
    o, h, l, c, end, start = S['o'], S['h'], S['l'], S['c'], S['end'], S['start']; n = len(c); entry = o[ei] + d * SLIP; stop = entry - d * s; pend = False
    net = lambda px: ((px - entry) * d) * DPP - COMM
    for j in range(ei, n):
        if pend or start[j] >= FLAT: return net(o[j] - d * SLIP), j, ('TIMEOUT' if pend else 'EOD')
        if j > ei and d * (o[j] - stop) <= 0: return net(o[j] - d * SLIP), j, 'STOP'
        if (d == 1 and l[j] <= stop) or (d == -1 and h[j] >= stop): return net(stop - d * SLIP), j, 'STOP'
        if end[j] - t0 >= TMO: pend = True
    return net(c[n - 1]), n - 1, 'EOS'

def sequence(S, i, d, s, reverse):
    legs = []; ei = i + 1; t0 = S['end'][i]; n = len(S['c'])
    for _ in range(3 if reverse else 1):
        if ei >= n - 2: break
        net, j, why = leg(S, ei, d, s, t0); legs.append((net, why))
        if why != 'STOP' or not reverse: break
        d = -d; ei = j + 1; t0 = S['end'][j]
    return legs

def main():
    rng = np.random.default_rng(SEED + 191); _, ctxs, _ = TS.sessions_and_contexts(); rows = []; v1 = []
    for d in sorted(ctxs):
        ctx = ctxs[d]; S = ctx['S']; end, comp = S['end'], S['comp']; prof = T.Prof(ctx)
        tells = [(int(t['sig']), int(t['dir']), float(t['net'])) for t in T.simulate(ctx, 'V1', dict(fires=0, skip=0, trades=0, fallback=0))]
        ctl = [(i, int(np.sign(S['c'][i] - S['c'][i - 10])), 0.0) for i in range(max(10, 1), ctx['n'] - 1) if i % 10 == 0 and V.DEC_FIRST <= end[i] <= V.DEC_LAST and comp[i] and (ctx['moving1'][i] or ctx['moving-1'][i]) and S['c'][i] != S['c'][i - 10] and not any(T.ncomp_at(ctx, prof, i, dd, need_nodes=False)[1] for dd in (1, -1))]
        for arm, pts in (('TELL', tells), ('CONTROL', ctl)):
            for i, dr, net0 in pts:
                if i < 20 or i + 6 >= ctx['n']: continue
                med = float(np.median(S['h'][i - 19:i + 1] - S['l'][i - 19:i + 1]))
                for k in (1, 2):
                    for var, rev in (('A', False), ('B', True)):
                        legs = sequence(S, i, dr, k * med, rev); rows.append(dict(date=d, arm=arm, k=k, var=var, net=sum(x[0] for x in legs), legs=len(legs), stops=sum(1 for x in legs if x[1] == 'STOP'), first=legs[0][0] if legs else 0.0, later=sum(x[0] for x in legs[1:])))
                if arm == 'TELL': v1.append(net0)
    R = pd.DataFrame(rows); print(f'signals: TELL {int(((R.arm == "TELL") & (R.k == 1) & (R.var == "A")).sum())}, CONTROL {int(((R.arm == "CONTROL") & (R.k == 1) & (R.var == "A")).sum())}; reference original V1 mean per trade ${np.mean(v1):+.2f} (N {len(v1)})')
    res = {}
    for k in (1, 2):
        for var in ('A', 'B'):
            sub = R[(R.k == k) & (R['var'] == var)]; g = lambda a: sub[sub.arm == a].groupby('date')['net'].agg(['sum', 'count']); gT, gC = g('TELL'), g('CONTROL'); ud = np.array(sorted(set(gT.index) | set(gC.index)))
            AT = np.c_[gT.reindex(ud)['sum'].fillna(0).values, gT.reindex(ud)['count'].fillna(0).values]; AC = np.c_[gC.reindex(ud)['sum'].fillna(0).values, gC.reindex(ud)['count'].fillna(0).values]; m = lambda w, a: (w @ a[:, 0]) / max(1.0, w @ a[:, 1]); w1 = np.ones(len(ud)); bd, bt = [], []
            for _ in range(BOOT): w = np.bincount(rng.integers(0, len(ud), len(ud)), minlength=len(ud)).astype(float); bd.append(m(w, AT) - m(w, AC)); bt.append(m(w, AT))
            h = len(ud) // 2; ha = (np.arange(len(ud)) < h) * 1.0; hb = 1 - ha; p = float(min(1.0, 2 * min((np.sum(np.array(bd) <= 0) + 1) / (BOOT + 1), (np.sum(np.array(bd) >= 0) + 1) / (BOOT + 1))))
            st = sub[sub.arm == 'TELL']; res[(k, var)] = dict(diff=m(w1, AT) - m(w1, AC), lo=np.percentile(bd, 2.5), hi=np.percentile(bd, 97.5), tm=m(w1, AT), tl=np.percentile(bt, 2.5), th=np.percentile(bt, 97.5), cm=m(w1, AC), p=p, h1=m(ha, AT) - m(ha, AC), h2=m(hb, AT) - m(hb, AC), n=int(AT[:, 1].sum()), days=int((AT[:, 1] > 0).sum()), legs=st.legs.mean(), stops=st.stops.mean(), first=st['first'].mean(), later=st['later'].mean())
    keys = list(res); order = sorted(range(4), key=lambda i: res[keys[i]]['p']); keep = -1
    for rk, ix in enumerate(order): keep = rk if res[keys[ix]]['p'] <= (rk + 1) / 4 * 0.10 else keep
    sv = {keys[ix]: rk <= keep for rk, ix in enumerate(order)}; print('\nCOUNTED (net dollars per signal; CONTROL = the same procedure on no-tell moving bars):')
    for k in keys:
        r = res[k]; ok = sv[k] and (r['lo'] > 0 or r['hi'] < 0) and r['tl'] > 0 and r['n'] >= 1000 and r['days'] >= 300 and np.sign(r['h1']) == np.sign(r['h2']) == np.sign(r['diff'])
        print(f'  stop {k} x median bar range, variant {k and ("A no reversal" if k and False else "")}'.replace('variant ', '') + f'{"A (single leg)" if k[1] == "A" else "B (reverse, up to 3 legs)"}'.replace('B ', 'B ') if False else f'  k={k[0]} {"A single leg" if k[1] == "A" else "B stop-and-reverse"}: TELL {r["tm"]:+6.2f} [{r["tl"]:+.1f}, {r["th"]:+.1f}] (N {r["n"]}, {r["days"]} dates) CONTROL {r["cm"]:+6.2f} diff {r["diff"]:+.2f} CI [{r["lo"]:+.2f}, {r["hi"]:+.2f}] p {r["p"]:.3f} halves {r["h1"]:+.1f}/{r["h2"]:+.1f} BH {"survives" if sv[k] else "no"}{"  <== CANDIDATE" if ok else ""} | legs {r["legs"]:.2f}, stop-outs {r["stops"]:.2f}, first leg {r["first"]:+.2f}, reversal legs {r["later"]:+.2f}')
    tt = R[(R.arm == 'TELL') & (R['var'] == 'B')]; print('UNCOUNTED by year (TELL, variant B, k=1 net per signal): ' + ', '.join(f'{y} {tt[(tt.k == 1) & (tt.date.str[:4] == y)].net.mean():+.2f}' for y in sorted(set(tt.date.str[:4]))))

if __name__ == '__main__': main()
