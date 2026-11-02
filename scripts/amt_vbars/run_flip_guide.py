"""DDY flip (approximate) as a side guide for tell fires (PREREG_FLIP_GUIDE.md frozen 2026-11-01). EXPLORE ONLY. Usage: ../../venv/bin/python run_flip_guide.py"""
import numpy as np
import vbars as V, trade as T
import run_direction as D
import run_break_entry as B
import run_expansion_horizons as H
from run_first_break import first_break
SEED, BOOT, TRIALS, M, P, S_MIN = 20261101, 2000, 200, 10, 10, 10

def flips(S):
    dl = S['ask'] - S['bid']; n = len(dl); w = np.arange(1, P + 1, dtype=float); sm = np.full(n, np.nan)
    for i in range(P - 1, n): sm[i] = dl[i - P + 1:i + 1] @ w / w.sum()
    out = np.zeros(n, int); run = 0; prev = 0
    for i in range(n):
        if np.isnan(sm[i]): continue
        s = 1 if sm[i] > 0 else -1 if sm[i] < 0 else prev
        if prev != 0 and s != prev:
            if run >= S_MIN: out[i] = s
            run = 1
        else: run += 1
        prev = s
    return out

def dci(ev, vals, rng):
    return D.dayci(ev, list(vals), rng)

def main():
    rng = np.random.default_rng(SEED); ctxs = B.load_ctxs(); atr = H.sessions()[1]
    tr = []; rep = dict(fires=0, skip=0, trades=0, fallback=0)
    for d, c in ctxs.items(): tr += T.simulate(c, 'V1', rep)
    print(f'Sessions usable {len(ctxs)}; V1 tell fires {len(tr)} (expected 1760); hold-out NOT touched')
    cache = {}; ev = []
    for t in tr:
        c = ctxs[t['date']]; S = c['S']; i0 = t['sig']; ei = t['ei']
        if t['date'] not in cache: cache[t['date']] = flips(S)
        fl = cache[t['date']]; win = fl[max(0, i0 - M + 1):i0 + 1]; nz = win[win != 0]; vote = int(nz[-1]) if len(nz) else 0
        same = T.stripped(c, ei, t['dir'], t['risk']); opp = T.stripped(c, ei, -t['dir'], t['risk'])
        a = atr.get(t['date']); ex = H.excursions(S, a, i0, 1, 3600) if a else None
        fwd_long = None if ex is None else ex[2]; fbs = first_break(c, i0, t['dir'])
        ev.append(dict(date=t['date'], dir=t['dir'], vote=vote, same=same, opp=opp, fwd_long=fwd_long, fb=fbs))
    N = len(ev); withv = [e for e in ev if e['vote'] != 0]
    agree = [e for e in withv if e['vote'] == e['dir']]; dis = [e for e in withv if e['vote'] != e['dir']]; nof = [e for e in ev if e['vote'] == 0]
    print(f"fires {N} on {len({e['date'] for e in ev})} dates; with a flip vote {len(withv)} ({100 * len(withv) / N:.0f}%): AGREE {len(agree)}, DISAGREE {len(dis)}; no flip {len(nof)}")
    med = sorted(e['date'] for e in ev)[N // 2]
    same = np.array([e['same'] for e in ev]); opp = np.array([e['opp'] for e in ev])
    pl = [np.mean(np.where(rng.integers(0, 2, N) == 1, same, opp)) for _ in range(TRIALS)]; p95 = float(np.percentile(pl, 95))
    print(f"\nR0 tell ${same.mean():+.2f} CI {tuple(round(x, 2) for x in dci(ev, same, rng))} | R1 opposite ${opp.mean():+.2f} | PLACEBO mean ${np.mean(pl):+.2f} p95 ${p95:+.2f}")
    f1 = np.array([(e['same'] if (e['vote'] == 0 or e['vote'] == e['dir']) else e['opp']) for e in ev]); d1 = f1 - same
    lo, hi = dci(ev, d1, rng); h1 = d1[[e['date'] < med for e in ev]].mean(); h2 = d1[[e['date'] >= med for e in ev]].mean(); a_lo, a_hi = dci(ev, f1, rng)
    ok1 = lo > 0 and a_lo > 0 and f1.mean() > p95 and h1 > 0 and h2 > 0
    print(f"=== F1 flip-guided (flip side when a vote exists, else the tell): N={N}, mean ${f1.mean():+.2f} absolute CI [{a_lo:+.2f}, {a_hi:+.2f}]; paired minus R0 {d1.mean():+.2f} CI [{lo:+.2f}, {hi:+.2f}]; halves {h1:+.2f}/{h2:+.2f}; placebo p95 ${p95:+.2f} -> {'PASS' if ok1 else 'not shown'}")
    print('=== F2 agree filter (tell outcome by group)')
    for lab, g in (('AGREE', agree), ('DISAGREE', dis), ('NO-FLIP', nof)):
        v = np.array([e['same'] for e in g]); l, h_ = dci(g, v, rng) if len(g) > 5 else (np.nan, np.nan); print(f"  {lab:9s} N={len(g):4d}, tell-direction mean ${v.mean():+.2f} CI [{l:+.2f}, {h_:+.2f}]")
    rest = dis + nof; ci_s = D.splitci(ev, [1 if (e['vote'] == e['dir']) else 0 for e in ev], [e['same'] for e in ev], rng)
    ag = np.array([e['same'] for e in agree]); hA1 = np.mean([e['same'] for e in agree if e['date'] < med]) - np.mean([e['same'] for e in rest if e['date'] < med]); hA2 = np.mean([e['same'] for e in agree if e['date'] >= med]) - np.mean([e['same'] for e in rest if e['date'] >= med])
    a2lo, _ = dci(agree, ag, rng); ok2 = len(agree) >= 200 and a2lo > 0 and ci_s[0] > 0 and hA1 > 0 and hA2 > 0
    print(f"  AGREE minus rest {ag.mean() - np.mean([e['same'] for e in rest]):+.2f} CI [{ci_s[0]:+.2f}, {ci_s[1]:+.2f}]; halves {hA1:+.2f}/{hA2:+.2f}; AGREE absolute CI lower {a2lo:+.2f} -> {'PASS' if ok2 else 'not shown'}")
    print('=== F3 disagree-follow (flip side vs tell side on DISAGREE fires, paired)')
    d3 = np.array([e['opp'] - e['same'] for e in dis]); l3, h3 = dci(dis, d3, rng); print(f"  N={len(dis)}: flip side minus tell side {d3.mean():+.2f} CI [{l3:+.2f}, {h3:+.2f}] (flip-side mean ${np.mean([e['opp'] for e in dis]):+.2f})")
    print('=== secondary market behaviour (signed 60-minute move, ATR20 units; first-break side)')
    def sm(g, key):
        x = [(e['vote'] if key == 'flip' else e['dir']) * e['fwd_long'] for e in g if e['fwd_long'] is not None]; return (np.mean(x), len(x)) if x else (np.nan, 0)
    for lab, g in (('flip-vote fires, flip side', withv), ('flip-vote fires, tell side', withv)):
        k = 'flip' if 'flip side' in lab else 'tell'; m_, n_ = sm(g, k); print(f"  {lab:30s} mean {m_:+.4f} (n={n_})")
    m_, n_ = sm(dis, 'flip'); m2, _ = sm(dis, 'tell'); print(f"  DISAGREE fires: flip side {m_:+.4f} vs tell side {m2:+.4f} (n={n_})")
    for lab, g in (('flip-vote', withv), ('no-flip', nof)):
        b = [e for e in g if e['fb'] != 'N' and e['fb'] is not None]; fbT = [e for e in b if e['fb'] == 'T'] if False else None
    print('\nsummary', {'F1': ok1, 'F2': ok2})

if __name__ == '__main__': main()
