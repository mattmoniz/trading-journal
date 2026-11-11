"""Row 39 (docs/GLOBEX_BAR_SIZE_PREREG_20261110.md): GLOBEX-ONLY volume bars of several sizes (default 100, 125, 500 contracts) from the NQ .scid ticks in ONE pass per trade date, Explore dates only (<= 2025-05-16). Reuses extract_volbars_20261028
(contract matching, layout sniffing, DB-volume validation, the shared SessionBars bar rule with its new vb parameter). Globex = seconds since the 18:00 ET open < 55800 (09:30 ET); ticks after that still count toward the RTH validation volume but are not fed to the builders.
Output scratch/volbars<SIZE>_globex_20261110/YYYY-MM-DD.bars.tsv (same columns as the 500V files, no .vap). The 500 arm is the within-pass control and must reproduce the existing 500V Globex bars.
Usage: extract_globex_vbars_20261110.py [--only DATE ...]   env VB_SIZES=100,125,500  VB_POOL=2"""
import sys, os, datetime
from multiprocessing import Pool
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract_volbars_20261028 as E
X, sr = E.X, E.sr
from barbuilder import SessionBars, session_sec
SIZES = [int(s) for s in os.environ.get('VB_SIZES', '100,125,500').split(',')]; GBX_END_SEC = 55800.0; LAST_EXPLORE = E.LAST_EXPLORE
OUTS = {s: os.path.join(X.ROOT, 'scratch', f'volbars{s}_globex_20261110') for s in SIZES}
for o_ in OUTS.values(): os.makedirs(o_, exist_ok=True)

def multi_for_path(p, d):
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
    prev = dd - datetime.timedelta(days=1); tot = 0; sbs = {s: SessionBars(E.OVERFLOW, vb=s) for s in SIZES}
    for t in (sr.read_ticks(p, start_date=prev, end_date=dd) if lay == 'std' else E._legacy_range(p, prev, dd)):
        m = t.ts_et.hour * 60 + t.ts_et.minute
        if sc != 1.0: t.price = t.price * sc
        sec = session_sec(t.ts_et, dd)
        if sec is None: continue
        if t.ts_et.date() == dd and 570 <= m < 960: tot += int(t.size)
        if sec < GBX_END_SEC:
            for sb in sbs.values(): sb.feed(sec, t.price, t.size, t.aggressor)
    return {s: sb.all_bars() for s, sb in sbs.items()}, tot

def work(d):
    if all(os.path.exists(os.path.join(OUTS[s], d + '.bars.tsv')) for s in SIZES): return d, 'exists'
    best = None
    for code in X.candidate_codes(X.CAL[d]):
        for p in X.scid_paths(code):
            try: res, tot = multi_for_path(p, d)
            except ValueError: return d, 'nontick'
            if res is None: continue
            if d in X.DBVOL and abs(tot - X.DBVOL[d]) <= 0.03 * X.DBVOL[d]: best = res; break
        if best is not None: break
    if best is None: return d, 'nomatch'
    for s, bars in best.items():
        fp = os.path.join(OUTS[s], d + '.bars.tsv')
        with open(fp + '.tmp', 'w') as f:
            for i, (b, comp) in enumerate(bars): f.write(f"{i}\t{b['start']:.3f}\t{b['end']:.3f}\t{b['o']}\t{b['h']}\t{b['l']}\t{b['c']}\t{b['v']}\t{b['bid']:.1f}\t{b['ask']:.1f}\t{b['n']}\t{int(comp)}\n")
        os.replace(fp + '.tmp', fp)
    return d, ' '.join(f'{s}:{len(b)}' for s, b in best.items())

if __name__ == '__main__':
    dates = [d for d in sorted(X.CAL) if '2023-03-06' <= d <= LAST_EXPLORE]
    if len(sys.argv) > 2 and sys.argv[1] == '--only': dates = sys.argv[2:]
    with Pool(int(os.environ.get('VB_POOL', 2))) as pool:
        n = 0
        for d, s in pool.imap_unordered(work, dates):
            n += 1
            if n % 25 == 0 or s in ('nomatch', 'nontick') or len(dates) < 10: print(n, d, s, flush=True)
    print('done', n)
