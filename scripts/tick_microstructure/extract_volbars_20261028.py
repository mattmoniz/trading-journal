"""500-contract volume bars (+ volume-at-price per bar) from NQ .scid ticks for the FULL trading day (Globex 18:00 the previous calendar day through 17:00 ET, user: the 1-day profile on the 500-volume chart includes Globex), per trade date. EXPLORE dates only (<= 2025-05-16): the hold-out is not extracted.
Reuses extract_cells_20261020's contract map, layout sniffing, price scaling and DB-volume validation (a date is kept only if the tick total matches price_bars_primary RTH volume within 3 percent).
Bar rule (ASSUMPTION, Sierra docs say a volume bar is 'equal to or greater than' the setting and recommend Split Data Records, which they do not describe): bars close at EXACTLY 500 contracts, a trade that overflows is SPLIT and the remainder opens the next bar (bid/ask volume allocated pro rata); the first bar starts at 18:00 (new session) and bars run continuously through 17:00; the last bar is partial and flagged. start/end are seconds since the 18:00 open (RTH open = 55800).
Output scratch/volbars500_20261028/YYYY-MM-DD.bars.tsv: idx start_sec end_sec open high low close vol bid ask ntrades complete ; .vap.tsv: idx price vol bid ask.
Usage: extract_volbars_20261028.py [--validate DATE] (default: all explore dates)"""
import sys, os, json, collections, datetime
from multiprocessing import Pool
sys.path.insert(0, os.path.dirname(__file__))
import extract_cells_20261020 as X
sr = X.sr
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'amt_tell_live'))
from barbuilder import SessionBars, session_sec, VB
OVERFLOW = os.environ.get('VB_OVERFLOW', 'split')       # 'split' (research default: a trade that overflows 500 is split, remainder opens the next bar) or 'whole' (Stage-0 sensitivity: the whole trade stays in the bar, which closes at >= 500)
OUT = os.environ.get('VB_OUT') or os.path.join(X.ROOT, 'scratch', 'volbars500_full_20261028'); os.makedirs(OUT, exist_ok=True)
LAST_EXPLORE = '2025-05-16'

def _legacy_range(p, d0, d1):
    for dt, o, h, l, c, nt, tv, bv, av in sr._raw_records(p, start_date=d0):
        et = dt.astimezone(sr.ET)
        if et.date() < d0: continue
        if et.date() > d1: break
        if not (o == h == l == c) or (bv > 0) == (av > 0): raise ValueError('legacy layout violated')
        t = X._T(); t.ts_utc = dt; t.ts_et = et; t.price = c / sr.SCID_PRICE_SCALE; t.size = tv; t.aggressor = 'SELL' if bv > 0 else 'BUY'; yield t

def bars_for_path(p, d):
    dd = datetime.date.fromisoformat(d); lay = X._sniff_layout(p, dd)
    if lay == 'empty': return None, 0
    if lay == 'other': raise ValueError('unknown record layout')
    sc = 1.0
    if lay == 'std':
        import statistics
        pr = []
        for k, t0 in enumerate(sr.read_ticks(p, start_date=dd, end_date=dd)):
            pr.append(t0.price)
            if k >= 300: break
        if pr and statistics.median(pr) < 1000: sc = 100.0
    prev = dd - datetime.timedelta(days=1); tot = 0
    sb = SessionBars(OVERFLOW)                      # the bar rule lives in scripts/amt_tell_live/barbuilder.py, shared with the live tell detector
    for t in (sr.read_ticks(p, start_date=prev, end_date=dd) if lay == 'std' else _legacy_range(p, prev, dd)):
        m = t.ts_et.hour * 60 + t.ts_et.minute
        if sc != 1.0: t.price = t.price * sc
        sec = session_sec(t.ts_et, dd)
        if sec is None: continue
        if t.ts_et.date() == dd and 570 <= m < 960: tot += int(t.size)
        sb.feed(sec, t.price, t.size, t.aggressor)
    return sb.all_bars(), tot

def bars_for(d):
    best = None
    for code in X.candidate_codes(X.CAL[d]):
        for p in X.scid_paths(code):
            try: bars, tot = bars_for_path(p, d)
            except ValueError: return 'nontick'
            if bars is None: continue
            if d in X.DBVOL and abs(tot - X.DBVOL[d]) <= 0.03 * X.DBVOL[d]: return bars
            if best is None or abs(tot - X.DBVOL.get(d, 0)) < abs(best[1] - X.DBVOL.get(d, 0)): best = (bars, tot)
    return None

def work(d):
    fp = os.path.join(OUT, d + '.bars.tsv'); fp2 = os.path.join(OUT, d + '.vap.tsv')
    if os.path.exists(fp) and os.path.exists(fp2): return d, 'exists'
    r = bars_for(d)
    if r == 'nontick': return d, 'nontick'
    if r is None: return d, 'nomatch'
    with open(fp + '.tmp', 'w') as f, open(fp2 + '.tmp', 'w') as g:
        for i, (b, comp) in enumerate(r):
            f.write(f"{i}\t{b['start']:.3f}\t{b['end']:.3f}\t{b['o']}\t{b['h']}\t{b['l']}\t{b['c']}\t{b['v']}\t{b['bid']:.1f}\t{b['ask']:.1f}\t{b['n']}\t{int(comp)}\n")
            for px, v in sorted(b['vap'].items()): g.write(f"{i}\t{px}\t{v[0]}\t{v[1]:.1f}\t{v[2]:.1f}\n")
    os.replace(fp + '.tmp', fp); os.replace(fp2 + '.tmp', fp2); return d, f'{len(r)} bars'

if __name__ == '__main__':
    dates = [d for d in sorted(X.CAL) if '2023-03-06' <= d <= LAST_EXPLORE]
    if len(sys.argv) > 2 and sys.argv[1] == '--only':
        dates = sys.argv[2:]
    with Pool(int(os.environ.get('VB_POOL', 8))) as pool:
        n = 0
        for d, s in pool.imap_unordered(work, dates):
            n += 1
            if n % 50 == 0 or s in ('nomatch', 'nontick'): print(n, d, s, flush=True)
    print('done', n)
