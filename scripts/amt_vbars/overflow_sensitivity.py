"""Stage-0 gate 1 of the live tell project (docs/AMT_TELL_LIVE_PROJECT_SPEC_20261028.md section 8, item 1): how much does the overflow rule matter?
The research bars SPLIT a trade that overflows 500 (remainder opens the next bar). Sierra's docs only say a volume bar is 'equal to or greater than' the setting. This script compares
the two readings on the explore sessions: (1) bar sequences (count, per-bar identity), (2) the tell/trade results of trade.simulate (V1, V3) built on each.
Usage: ../../venv/bin/python overflow_sensitivity.py [split_root] [whole_root]. Pure comparison, EXPLORE only (hold-out not extracted)."""
import glob, os, sys
import numpy as np
import vbars as V, trade as T

SPLIT = V.ROOT
WHOLE = '/home/mmoniz/trading-journal/scratch/volbars500_whole_20261028'


def load_all(root):
    V.ROOT = root; out = {}; stats = {}
    for p in sorted(glob.glob(root + '/*.bars.tsv')):
        d = os.path.basename(p)[:10]
        if d > '2025-05-16': continue
        try: S = V.load_session(d)
        except Exception: continue
        out[d] = S; stats[d] = V.session_stats(S)
    return out, stats


def contexts(sess, stats):
    ks = sorted(sess); ctxs = {}
    for i, d in enumerate(ks):
        if i < 20: continue
        prior = ks[i - 20:i]; rngs = [stats[p][0] for p in prior if not np.isnan(stats[p][0])]
        if len(rngs) < 15: continue
        base = {h: float(np.mean([stats[p][1][h] for p in prior if h in stats[p][1]])) for h in range(24) if sum(h in stats[p][1] for p in prior) >= 15}
        c = T.prep(sess[d], float(np.mean(rngs)), base)
        if c is not None: ctxs[d] = c
    return ctxs


def compare_bars(a, b):
    """Per-session bar-sequence comparison; a=split, b=whole. Returns summary dict."""
    rows = []
    for d in sorted(set(a) & set(b)):
        A, B = a[d], b[d]; na, nb = len(A['c']), len(B['c']); m = min(na, nb)
        same_prefix = 0
        for k in range(m):
            if (A['start'][k], A['end'][k], A['o'][k], A['h'][k], A['l'][k], A['c'][k], A['vol'][k]) == (B['start'][k], B['end'][k], B['o'][k], B['h'][k], B['l'][k], B['c'][k], B['vol'][k]): same_prefix += 1
            else: break
        over = int(np.sum(B['vol'][B['comp']] > 500))     # whole-mode bars that hold more than 500
        rows.append((d, na, nb, same_prefix, over))
    return rows


def trades_of(ctxs, var):
    tr = []
    for d, c in ctxs.items(): tr += [dict(t, date=d) for t in T.simulate(c, var)]
    return tr


def key(t): return (t['date'], t['dir'])


def main():
    split_root = sys.argv[1] if len(sys.argv) > 1 else SPLIT; whole_root = sys.argv[2] if len(sys.argv) > 2 else WHOLE
    sa, sta = load_all(split_root); sb, stb = load_all(whole_root)
    rows = compare_bars(sa, sb); n = len(rows)
    nbars_a = sum(r[1] for r in rows); nbars_b = sum(r[2] for r in rows)
    ident = sum(1 for r in rows if r[1] == r[2] and r[3] == r[1]); same_count = sum(1 for r in rows if r[1] == r[2])
    overs = sum(r[4] for r in rows)
    print(f"Sessions in both: {n} (split-only {len(set(sa) - set(sb))}, whole-only {len(set(sb) - set(sa))})")
    print(f"Bars: split {nbars_a}, whole {nbars_b} ({100 * (nbars_b - nbars_a) / nbars_a:+.2f}%). Whole-mode bars holding > 500 contracts: {overs} ({100 * overs / nbars_b:.2f}% of bars)")
    print(f"Sessions with an IDENTICAL bar sequence: {ident}; same bar count: {same_count}")
    fd = [r[3] / max(1, min(r[1], r[2])) for r in rows]
    print(f"Share of a session's bars before the first difference (median over sessions): {np.median(fd):.3f}; sessions whose first difference is before bar 50: {sum(1 for r in rows if r[3] < 50)}")
    ca, cb = contexts(sa, sta), contexts(sb, stb)
    print(f"Usable sessions with a 20-session baseline: split {len(ca)}, whole {len(cb)}")
    for var in ('V1', 'V3'):
        ta, tb = trades_of(ca, var), trades_of(cb, var)
        ma = {(t['date'], t['dir'], round(t['entry'], 2)): t for t in ta}; mb = {(t['date'], t['dir'], round(t['entry'], 2)): t for t in tb}
        # a trade 'matches' when the same date, direction and same entry price occur in both (the signal bar index differs when bar counts differ)
        both = set(ma) & set(mb)
        da = {}; db = {}
        for t in ta: da.setdefault(key(t), []).append(t)
        for t in tb: db.setdefault(key(t), []).append(t)
        dates_a = {t['date'] for t in ta}; dates_b = {t['date'] for t in tb}
        na_, nb_ = len(ta), len(tb); pa = np.mean([t['net'] for t in ta]); pb = np.mean([t['net'] for t in tb])
        print(f"\n[{var}] split: N={na_} mean {pa:+.2f}/trade total {sum(t['net'] for t in ta):+.0f} on {len(dates_a)} dates | whole: N={nb_} mean {pb:+.2f}/trade total {sum(t['net'] for t in tb):+.0f} on {len(dates_b)} dates")
        print(f"   same date+direction+entry price in both: {len(both)} ({100 * len(both) / max(1, na_):.0f}% of split trades, {100 * len(both) / max(1, nb_):.0f}% of whole trades)")
        print(f"   dates traded in both {len(dates_a & dates_b)}; only split {len(dates_a - dates_b)}; only whole {len(dates_b - dates_a)}")
        if both:
            dn = [mb[k]['net'] - ma[k]['net'] for k in both]; print(f"   on the {len(both)} matched trades the net differs by mean {np.mean(dn):+.2f}, median {np.median(dn):+.2f}, share exactly equal {100 * np.mean([x == 0 for x in dn]):.0f}%")
    print("\nReading: if the whole-mode bar count, tell count and V1/V3 means are close to the split-mode figures, the overflow rule is immaterial for the project; if not, the user's exported Sierra bars decide (spec section 8, item 1).")


if __name__ == '__main__':
    main()
