"""Stage-0 gate 2 parity harness: replay one historical session's REAL ticks through the live code path (ScidTailer -> LiveSession -> core.replay on the session so far, at every new forming bar) and compare with the
research result (trade.simulate on the stored .bars.tsv/.vap.tsv files, the numbers behind trades_V1_explore.csv). Three checks (DeepSeek review item 2):
  A. FINAL: the live path's last evaluation equals the research trade list for V1 and V3 (every field).
  B. FIRST-SEEN: each trade, as first seen in a mid-session (prefix) evaluation, has the same direction, signal bar, entry price and stop as the final research trade (no look-ahead into the decision).
  C. PREFIX STABILITY: every trade CLOSED in a prefix evaluation is identical in the final result; every OPEN trade in a prefix evaluation is a prefix of its final trade.
Bars are also compared with the stored research bar files (layer 1).
Usage: parity_day.py DATE [--stride N] [--rule split|whole] [--json out.json]   (explore dates only; the hold-out is not extracted)"""
import os, sys, json, time, datetime, glob, argparse
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, '..', 'tick_microstructure'))
import core, tailer, session
import vbars as V, trade as T
import extract_cells_20261020 as X

ROOTS = {'split': '/home/mmoniz/trading-journal/scratch/volbars500_full_20261028', 'whole': '/home/mmoniz/trading-journal/scratch/volbars500_whole_20261028'}
FIELDS = ('sig', 'ei', 'xj', 'dir', 'entry', 'stop', 'risk', 'reason', 'broke', 'pts', 'net', 'fb')


def research_priors(root, d):
    """prior 20 sessions' stats exactly as run_trade.py picks them: the 20 sessions before d in the sorted list of extracted explore sessions."""
    V.ROOT = root; ks = sorted(os.path.basename(p)[:10] for p in glob.glob(root + '/*.bars.tsv')); ks = [k for k in ks if k <= '2025-05-16']
    i = ks.index(d); prior = ks[max(0, i - 20):i]; stats = []
    for p in prior:
        S = V.load_session(p); stats.append(V.session_stats(S))
    return prior, stats


def research_result(root, d, prior_stats):
    V.ROOT = root; S = V.load_session(d); inp = core.baseline_inputs(prior_stats)
    if inp is None: return None, S
    ctx = T.prep(S, inp[0], inp[1])
    if ctx is None: return None, S
    out = {}
    for b, variant, w in (('V1', 'V1', (V.DEC_FIRST, V.DEC_LAST)), ('V3', 'V3', (V.DEC_FIRST, V.DEC_LAST)), ('V1P', 'V1', (V.RTH_OPEN, V.DEC_FIRST))):      # reference side written out independently of core.BOOK_SPEC
        saved = (T.ENTRY_FROM, T.ENTRY_TO); T.ENTRY_FROM, T.ENTRY_TO = w
        try: out[b] = T.simulate(ctx, variant)
        finally: T.ENTRY_FROM, T.ENTRY_TO = saved
    return out, S


def tick_source(d, Sref, rule='split'):
    """(path, exact) -- the tick file for date d, chosen like the batch extractor chose it: of the standard-layout candidates, the first whose opening bar reproduces research bar 0 (prices and volume exact).
    exact=True when the bar start time also matches to the millisecond (same recording as the research); exact=False when only prices/volume match -- the same market recorded by the other Sierra instance,
    whose tick timestamps differ by fractions of a second (then timestamps are compared with a 2 s tolerance and flagged)."""
    dd = datetime.date.fromisoformat(d); prev = dd - datetime.timedelta(days=1); alt = None
    for code in X.candidate_codes(X.CAL[d]):
        for p in X.scid_paths(code):
            if X._sniff_layout(p, dd) != 'std': continue
            tl = tailer.ScidTailer(p, from_date=prev); ls = session.LiveSession(d, rule, [])
            polled = 0
            while not ls.sb.done and polled < 8_000_000:          # read on until the session's first bar completes (a Tue-Fri session starts ~18 hours after the binary-search landing point)
                chunk = tl.poll(max_records=200000)
                if not chunk and tl.backlog_bytes() == 0: break
                polled += 200000
                for t in chunk: ls.feed_trade(t)
            ls.finish_scale_detection(); b = ls.sb.done[0] if ls.sb.done else None
            if b is None or (b['o'], b['h'], b['l'], b['c'], b['v']) != (float(Sref['o'][0]), float(Sref['h'][0]), float(Sref['l'][0]), float(Sref['c'][0]), int(Sref['vol'][0])): continue
            if abs(b['start'] - float(Sref['start'][0])) < 1e-3: return p, True
            alt = alt or p
    return alt, False


def cmp_trade(a, b):
    """list of (field, a, b) differences between two trade dicts."""
    out = []
    for f in FIELDS:
        va, vb = a[f], b[f]
        if isinstance(va, float) or isinstance(vb, float):
            if abs(float(va) - float(vb)) > 1e-9: out.append((f, va, vb))
        elif va != vb: out.append((f, va, vb))
    return out


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('date'); ap.add_argument('--stride', type=int, default=1); ap.add_argument('--rule', default='split'); ap.add_argument('--json'); ap.add_argument('--chunk', type=int, default=50000)
    a = ap.parse_args(); d = a.date; dd = datetime.date.fromisoformat(d); root = ROOTS[a.rule]
    t0 = time.time(); prior, pstats = research_priors(root, d)
    ref, Sref = research_result(root, d, pstats)
    res = dict(date=d, rule=a.rule, ok=True, problems=[], prior_n=len(prior))
    if ref is None:
        res['skipped'] = 'no usable baseline'; print(json.dumps(res)); (json.dump(res, open(a.json, 'w')) if a.json else None); return
    p, exact = tick_source(d, Sref, a.rule)
    if p is None: res['skipped'] = 'no standard-layout tick file reproduces the research bars (legacy-layout file: the live path never reads that layout)'; print(json.dumps(res)); (json.dump(res, open(a.json, 'w')) if a.json else None); return
    tl = tailer.ScidTailer(p, from_date=dd - datetime.timedelta(days=1)); ls = session.LiveSession(d, a.rule, pstats)
    first_seen = {}; prefix_checks = 0; prefix_bad = []; evals = 0; done = False; ntrig = 0; eval_time = 0.0
    final_ref = {b: {t['sig']: t for t in ref[b]} for b in core.BOOKS}
    while not done:
        trades = tl.poll(max_records=a.chunk)
        if not trades and tl.backlog_bytes() == 0: break
        for t in trades:
            if t.ts_et.date() > dd or (t.ts_et.date() == dd and t.ts_et.hour >= 17): done = True; break
            if not ls.feed_trade(t): continue
            ntrig += 1
            if ntrig % a.stride: continue
            te = time.time(); r = ls.evaluate(); eval_time += time.time() - te
            if r is None: continue
            evals += 1; nd = r['n_done']
            for b in core.BOOKS:
                for tr in r['books'][b]:
                    key = (b, tr['sig'])
                    if key not in first_seen: first_seen[key] = dict(tr)
                    fr = final_ref[b].get(tr['sig'])
                    prefix_checks += 1
                    if fr is None: prefix_bad.append((b, tr['sig'], nd, 'trade seen in a prefix evaluation is not in the final research list')); continue
                    if not tr['open']:
                        diff = cmp_trade(tr, fr)
                        if diff: prefix_bad.append((b, tr['sig'], nd, 'closed trade differs from final', diff))
                    else:
                        for f in ('ei', 'dir', 'entry', 'stop', 'risk', 'fb'):
                            if (abs(float(tr[f]) - float(fr[f])) > 1e-9) if isinstance(fr[f], float) else tr[f] != fr[f]: prefix_bad.append((b, tr['sig'], nd, f'open trade field {f} differs', (tr[f], fr[f])))
                        if fr['xj'] < tr['ei']: prefix_bad.append((b, tr['sig'], nd, 'open trade but final exits before its entry'))
    ls.finish_scale_detection()
    # ---- layer 1: bars vs the stored research files ------------------------------------------------------------------
    bars = ls.finished_bars(); live = __import__('barbuilder').session_arrays(bars, d)
    bar_diff = []
    if len(live['c']) != len(Sref['c']): bar_diff.append(('n_bars', len(live['c']), len(Sref['c'])))
    m = min(len(live['c']), len(Sref['c']))
    ts_diff = 0.0
    for k in ('start', 'end', 'o', 'h', 'l', 'c', 'vol', 'bid', 'ask'):
        if k in ('start', 'end') and not exact:
            ts_diff = max(ts_diff, float(np.max(np.abs(live[k][:m] - Sref[k][:m])))) if m else 0.0
            ne = int(np.sum(np.abs(live[k][:m] - Sref[k][:m]) > 2.0))
        else: ne = int(np.sum(live[k][:m] != Sref[k][:m]))
        if ne: bar_diff.append((k, ne))
    if len(live['vi']) != len(Sref['vi']) or np.any(live['vp'][:len(Sref['vp'])] != Sref['vp'][:len(live['vp'])]) or np.any(live['vv'][:len(Sref['vv'])] != Sref['vv'][:len(live['vv'])]): bar_diff.append(('vap', len(live['vi']), len(Sref['vi'])))
    res['bars'] = dict(live=int(len(live['c'])), ref=int(len(Sref['c'])), diffs=bar_diff, exact_timestamps=exact, max_timestamp_diff_s=round(ts_diff, 3))
    if bar_diff: res['ok'] = False; res['problems'].append('bar layer differs')
    # ---- A. final evaluation ---------------------------------------------------------------------------------------------
    te = time.time(); fin = ls.evaluate(force=True); eval_time += time.time() - te
    if fin is None: res['ok'] = False; res['problems'].append('no final evaluation'); fin = dict(books={b: [] for b in core.BOOKS})
    for b in core.BOOKS:
        lv, rf = fin['books'][b], ref[b]
        if len(lv) != len(rf): res['ok'] = False; res['problems'].append(f'A {b}: trade count live {len(lv)} vs research {len(rf)}')
        for x, y in zip(lv, rf):
            diff = cmp_trade(x, y)
            if diff: res['ok'] = False; res['problems'].append(f'A {b} sig {y["sig"]}: {diff}')
        # ---- B. first-seen decisions -------------------------------------------------------------------------------------
        for y in rf:
            fs = first_seen.get((b, y['sig']))
            if fs is None:
                if a.stride == 1: res['ok'] = False; res['problems'].append(f'B {b} sig {y["sig"]}: research trade never seen in any prefix evaluation')
                continue
            diff = [(f, fs[f], y[f]) for f in ('sig', 'ei', 'dir', 'entry', 'stop', 'risk', 'fb') if (abs(float(fs[f]) - float(y[f])) > 1e-9 if isinstance(y[f], float) else fs[f] != y[f])]
            if diff: res['ok'] = False; res['problems'].append(f'B {b} sig {y["sig"]} first-seen differs: {diff}')
        extra = [k for k in first_seen if k[0] == b and k[1] not in final_ref[b]]
        if extra: res['ok'] = False; res['problems'].append(f'B {b}: prefix-only trades {extra[:5]}')
    if prefix_bad: res['ok'] = False; res['problems'].append(f'C prefix stability: {len(prefix_bad)} violations, first {prefix_bad[:3]}')
    res.update(trades={b: len(ref[b]) for b in core.BOOKS}, evals=evals, prefix_checks=prefix_checks, triggers=ntrig, seconds=round(time.time() - t0, 1), eval_seconds=round(eval_time, 1), ticks=ls.n_trades, tail_backwards=tl.backwards)
    print(json.dumps(res, default=str))
    if a.json: json.dump(res, open(a.json, 'w'), default=str)


if __name__ == '__main__':
    main()
