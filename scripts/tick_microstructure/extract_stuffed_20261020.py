"""Per big order (merged same-side prints at most 1 ms apart, size >= 70, RTH) price path for docs/STUFFED_BIG_ORDER_PREREG_20261020.md.
Output scratch/stuffed_20261020/DATE.tsv, one line per order: side(B/S) t0 tend size nprints p_first p_last vwap | p at tend+{60,300,360,600,960,1200,1860,2100}s | extreme AGAINST the order within (tend,tend+300] | extreme WITH the order in the same window.
Times are ET seconds of day; prices are real index points (the DTC install's NQZ26.scid is stored at 1/100 and is corrected). Windows start at the next whole second after the order ends (per-second buckets); an empty field = beyond 16:00.
Usage: extract_stuffed_20261020.py [DATE ...]  (default: every date that has an orders file)"""
import sys, os, json, statistics, datetime, glob
from multiprocessing import Pool
sys.path.insert(0, os.path.dirname(__file__))
import scid_reader as sr
import extract_cells_20261020 as E
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'scratch', 'stuffed_20261020'); os.makedirs(OUT, exist_ok=True)
SIZE = 70; OFFS = (60, 300, 360, 600, 960, 1200, 1860, 2100); END = 16 * 3600
def ticks_for(p, d):
    dd = datetime.date.fromisoformat(d); lay = E._sniff_layout(p, dd)
    if lay in ('empty', 'other'): raise ValueError(lay)
    sc = 1.0
    if lay == 'std':
        pr = []
        for k, t0 in enumerate(sr.read_ticks(p, start_date=dd, end_date=dd)):
            pr.append(t0.price)
            if k >= 300: break
        if pr and statistics.median(pr) < 1000: sc = 100.0
    out = []
    for t in (sr.read_ticks(p, start_date=dd, end_date=dd) if lay == 'std' else E._legacy_ticks(p, dd)):
        s = t.ts_et.hour * 3600 + t.ts_et.minute * 60 + t.ts_et.second + t.ts_et.microsecond / 1e6
        if not (34200 <= s < END): continue
        out.append((s, t.price * sc, t.size, t.aggressor, t.ts_utc))
    return out
def stuffed_rows(tk):
    n = END + 1
    hi = [None] * n; lo = [None] * n; last = [None] * n
    for s, px, sz, ag, u in tk:
        i = int(s)
        if hi[i] is None or px > hi[i]: hi[i] = px
        if lo[i] is None or px < lo[i]: lo[i] = px
        last[i] = px
    prev = None
    for i in range(n):
        if last[i] is None: last[i] = prev
        else: prev = last[i]
    orders = []; cur = None
    for s, px, sz, ag, u in tk:
        if cur is not None and ag == cur[0] and ag in ('BUY', 'SELL') and (u - cur[7]).total_seconds() * 1e6 <= 1000:
            cur[3] += sz; cur[4] += px * sz; cur[5] += 1; cur[2] = s; cur[7] = u; cur[8] = px
        else:
            if cur is not None and cur[3] >= SIZE: orders.append(cur)
            cur = [ag, s, s, sz, px * sz, 1, px, u, px]          # side, t0, tend, size, sum(px*size), prints, p_first, utc_end, p_last
    if cur is not None and cur[3] >= SIZE: orders.append(cur)
    rows = []
    for o in orders:
        ag, t0, te, sz, pv, npr, pf, _, pl = o; i0 = int(te) + 1
        def at(off): j = int(te + off); return last[j] if j < END and last[j] is not None else ''
        if i0 + 300 < END:
            win_hi = max((hi[i] for i in range(i0, min(i0 + 300, END)) if hi[i] is not None), default='')
            win_lo = min((lo[i] for i in range(i0, min(i0 + 300, END)) if lo[i] is not None), default='')
        else:
            win_hi = max((hi[i] for i in range(i0, END) if hi[i] is not None), default=''); win_lo = min((lo[i] for i in range(i0, END) if lo[i] is not None), default='')
        against, withd = (win_hi, win_lo) if ag == 'SELL' else (win_lo, win_hi)
        rows.append([ag[0], f'{t0:.3f}', f'{te:.3f}', sz, npr, f'{pf:.2f}', f'{pl:.2f}', f'{pv / sz:.2f}'] + [('' if at(x) == '' else f'{at(x):.2f}') for x in OFFS] + [('' if against == '' else f'{against:.2f}'), ('' if withd == '' else f'{withd:.2f}')])
    return rows
def process(d):
    fp = os.path.join(OUT, d + '.tsv')
    if os.path.exists(fp): return d, 'exists'
    best = None
    for code in E.candidate_codes(E.CAL[d]):
        for p in E.scid_paths(code):
            try: tk = ticks_for(p, d)
            except ValueError: return d, 'nontick'
            tot = sum(x[2] for x in tk)
            if d in E.DBVOL and abs(tot - E.DBVOL[d]) <= 0.03 * E.DBVOL[d]: best = tk; break
        if best is not None: break
    if best is None: return d, 'nomatch'
    rows = stuffed_rows(best)
    with open(fp + '.tmp', 'w') as f:
        for r in rows: f.write('\t'.join(str(x) for x in r) + '\n')
    os.replace(fp + '.tmp', fp); return d, f'{len(rows)} orders'
if __name__ == '__main__':
    dates = sys.argv[1:] or sorted(os.path.basename(x)[:10] for x in glob.glob(os.path.join(ROOT, 'scratch', 'orders_20261020', '*.tsv')))
    with Pool(12) as pool:
        n = 0
        for d, s in pool.imap_unordered(process, dates):
            n += 1
            if n % 100 == 0 or s in ('nomatch', 'nontick'): print(n, d, s, flush=True)
    print('done', n)
