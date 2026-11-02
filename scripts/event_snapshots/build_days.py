"""Stage 1 of the event-snapshot study (docs/EVENT_SNAPSHOT_STUDY_20261102.md): rebuild every depth-era NQ session from the tick files with the sidecar's validated builder (bootstrap.build_sessions), chain the 20-session baselines IN MEMORY
(no write to any live table), find the V1 tell events with the research simulation (trade.simulate) and save per-day arrays for the snapshot analysis. Price/volume data only; no P&L or outcome column is read.
Usage: /home/mmoniz/trading-journal/venv/bin/python build_days.py [FIRST_DATE] [LAST_DATE]"""
import os, sys, json, datetime
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(HERE, '..', 'amt_tell_live')); sys.path.insert(0, os.path.join(HERE, '..', 'amt_vbars'))
import persist, bootstrap, core
import vbars as V, trade as T
OUT = '/home/mmoniz/trading-journal/scratch/event_snapshots_20261102'; RULE = 'split'

def day_record(d, s, ctx, prior_ok):
    bars = s.finished_bars(); S = ctx['S']; n = ctx['n']
    vi, px, tot, bv, av = [], [], [], [], []
    for i, (b, cm) in enumerate(bars):
        for p, v in b['vap'].items(): vi.append(i); px.append(p); tot.append(v[1] + v[2]); bv.append(v[1]); av.append(v[2])
    prof = T.Prof(ctx); end, comp = S['end'], S['comp']; grid = []
    for i in range(n - 1):
        if i % 10 or not (V.DEC_FIRST <= end[i] <= V.DEC_LAST) or not comp[i]: continue
        r = {dd: T.ncomp_at(ctx, prof, i, dd, need_nodes=True) for dd in (1, -1)}; c4 = {dd: int(ctx['fast'][i]) + int(ctx['flip'][i]) + int(ctx['osc'][i]) + int(ctx[f'strides{dd}'][i]) for dd in (1, -1)}
        grid.append((i, bool(r[1][1] or r[-1][1]), bool(ctx['moving1'][i] or ctx['moving-1'][i]), c4[1], int(r[1][0]) - c4[1], c4[-1], int(r[-1][0]) - c4[-1]))   # (bar, tell, moving, c4 up, ladder up, c4 down, ladder down)
    tells = []; prof2 = T.Prof(ctx)
    for t in T.simulate(ctx, 'V1', dict(fires=0, skip=0, trades=0, fallback=0)):
        sg = int(t['sig']); dd = int(t['dir']); n5, _ = T.ncomp_at(ctx, prof2, sg, dd, need_nodes=True); c4 = int(ctx['fast'][sg]) + int(ctx['flip'][sg]) + int(ctx['osc'][sg]) + int(ctx[f'strides{dd}'][sg])
        tells.append(dict(sig=sg, ei=int(t['ei']), xj=int(t['xj']), dir=dd, entry=float(t['entry']), stop=float(t['stop']), c4=c4, ladder=int(n5) - c4))
    np.savez_compressed(f'{OUT}/day_{d}.npz', start=S['start'], end=S['end'], o=S['o'], h=S['h'], l=S['l'], c=S['c'], vol=S['vol'], bid=S['bid'], ask=S['ask'], comp=S['comp'], ntr=np.array([b['n'] for b, _ in bars]),
                        vap_i=np.array(vi), vap_px=np.array(px), vap_tot=np.array(tot), vap_bid=np.array(bv), vap_ask=np.array(av))
    json.dump(dict(date=d, n=int(n), atr=float(ctx['atr']), onh=float(ctx['onh']), onl=float(ctx['onl']), tells=tells, grid=grid, validated=True), open(f'{OUT}/day_{d}.json', 'w'))
    return len(tells), len(grid)

def main():
    first = sys.argv[1] if len(sys.argv) > 1 else '2026-05-01'; last = sys.argv[2] if len(sys.argv) > 2 else '2026-10-30'; conn = persist.connect(); os.makedirs(OUT, exist_ok=True)
    dates = [str(x) for x in bootstrap.completed_session_dates(conn, str(datetime.date.fromisoformat(last) + datetime.timedelta(days=1)), 400) if first <= str(x) <= last]
    print(f'{len(dates)} candidate session dates {dates[0]}..{dates[-1]}', flush=True); prior = []; nt = nd = skipped = 0
    for d in dates:
        sess, ok, info = bootstrap.build_sessions(conn, d, [RULE])
        if sess is None or not ok: print(f'{d}: skipped ({"not validated" if sess is not None else info})', flush=True); skipped += 1; continue
        s = sess[RULE]; bars = s.finished_bars(); stats = core.stats_of_session(bars, d); ctx = core.build_ctx(bars, d, prior)
        if ctx is not None:
            a, b = day_record(d, s, ctx, len(prior)); nt += a; nd += 1; print(f'{d}: bars {ctx["n"]}, tells {a}, grid points {b}', flush=True)
        else: print(f'{d}: no baseline yet ({len(prior)} prior sessions)', flush=True)
        prior.append(stats)
    print(f'DONE: {nd} days with events, {nt} V1 tell events, {skipped} skipped dates')

if __name__ == '__main__': main()
