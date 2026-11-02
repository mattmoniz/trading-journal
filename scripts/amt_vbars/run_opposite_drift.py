"""Opposite-of-the-tell and with-day-drift policies (PREREG_OPPOSITE_DRIFT.md frozen 2026-11-01). EXPLORE ONLY. Usage: ../../venv/bin/python run_opposite_drift.py"""
import numpy as np
import vbars as V, trade as T
import run_break_entry as B
SEED, BOOT, TRIALS, RTH0 = 20261101, 2000, 200, 55800.0

def blocked(vals, dates, rng):
    g = {}
    for v, d in zip(vals, dates): g.setdefault(d, []).append(v)
    arr = [np.array(a) for a in g.values()]; m = len(arr)
    bs = np.array([np.concatenate([arr[j] for j in rng.integers(0, m, m)]).mean() for _ in range(BOOT)]); return float(np.mean(vals)), float(np.percentile(bs, 2.5)), float(np.percentile(bs, 97.5))

def main():
    rng = np.random.default_rng(SEED); ctxs = B.load_ctxs(); rep = dict(fires=0, skip=0, trades=0, fallback=0); ev = []
    for dte, c in ctxs.items():
        S = c['S']; n = len(S['end']); k0 = int(np.searchsorted(S['start'], RTH0))
        for t in T.simulate(c, 'V1', rep):
            i0, ei, d, risk = t['sig'], t['ei'], t['dir'], t['risk']; drift = int(np.sign(S['c'][i0] - S['o'][k0])) if k0 < n else 0
            ev.append(dict(date=dte, d=d, drift=drift, nl=T.stripped(c, ei, 1, risk), ns=T.stripped(c, ei, -1, risk)))
    N = len(ev); dates = [e['date'] for e in ev]; nl = np.array([e['nl'] for e in ev]); ns = np.array([e['ns'] for e in ev]); td = np.array([e['d'] for e in ev]); dr = np.array([e['drift'] for e in ev])
    side = lambda s: np.where(s == 1, nl, ns)
    tell, opp = side(td), side(-td); wd = np.where(dr == 0, tell, side(dr))
    print(f'Sessions usable {len(ctxs)}; V1 fires {N} (expected 1760); hold-out NOT touched')
    withd = dr == td; counter = dr == -td; nod = dr == 0
    print(f'WITH-DRIFT {int(withd.sum())}, COUNTER-DRIFT {int(counter.sum())}, NO-DRIFT {int(nod.sum())} (no-drift fires keep the tell side in WITHDRIFT)')
    pl = [np.mean(np.where(rng.integers(0, 2, N) == 1, nl, ns)) for _ in range(TRIALS)]; p95 = float(np.percentile(pl, 95)); med = sorted(dates)[N // 2]; first = np.array([d < med for d in dates])
    mt, lt, ht = blocked(tell, dates, rng); print(f'TELL ${mt:+.2f} CI [{lt:+.2f}, {ht:+.2f}] | random-side placebo ${np.mean(pl):+.2f} p95 ${p95:+.2f}')
    ok = {}
    for name, pay in (('OPP', opp), ('WITHDRIFT', wd)):
        m, lo, hi = blocked(pay, dates, rng); _, dlo, dhi = blocked(pay - tell, dates, rng); h1 = float(np.mean((pay - tell)[first])); h2 = float(np.mean((pay - tell)[~first]))
        ok[name] = lo > 0 and dlo > 0 and m > p95 and h1 > 0 and h2 > 0
        print(f"{name:9s} ${m:+.2f} CI [{lo:+.2f}, {hi:+.2f}] | minus TELL {np.mean(pay - tell):+.2f} CI [{dlo:+.2f}, {dhi:+.2f}] halves {h1:+.2f}/{h2:+.2f} | placebo p95 ${p95:+.2f} -> {'LEAD' if ok[name] else 'not shown'}")
    print('descriptive cells (tell side / opposite side):')
    for lab, mask in (('WITH-DRIFT fires', withd), ('COUNTER-DRIFT fires', counter)):
        dd = [d for d, m_ in zip(dates, mask) if m_]; a, al, ah = blocked(tell[mask], dd, rng); b, bl, bh = blocked(opp[mask], dd, rng)
        print(f"  {lab:20s} N={int(mask.sum()):4d}: tell side ${a:+.2f} [{al:+.2f}, {ah:+.2f}] | opposite ${b:+.2f} [{bl:+.2f}, {bh:+.2f}]")
    print('\nsummary', ok)

if __name__ == '__main__': main()
