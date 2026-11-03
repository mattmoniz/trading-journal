"""Per-second GLOBEX tape for the hold-or-slice study's overnight arm (docs/LEVEL_HOLD_SLICE_GLOBEX_PREREG_20261103.md). One file per trade date: scratch/persec_globex_20261103/DATE.tsv
lines: second_since_1800_ET(prev calendar day) buy_aggr sell_aggr low high last (only seconds with trades), covering 18:00 through 09:29:59 ET (0..55799). Same contract-file choice and layout handling as extract_volbars_20261028.py:
the file is accepted only if its RTH tick volume matches price_bars_primary RTH volume within 3 percent. Explore dates only. Usage: extract_persec_globex.py [--only DATE ...]   (env GX_POOL workers, default 3)"""
import sys, os, datetime, statistics
from multiprocessing import Pool
HERE = os.path.dirname(os.path.abspath(__file__)); TM = os.path.join(HERE, '..', 'tick_microstructure')
sys.path.insert(0, TM); sys.path.insert(0, os.path.join(HERE, '..', 'amt_tell_live'))
import extract_volbars_20261028 as V
X, sr = V.X, V.sr
from barbuilder import session_sec
ROOT = X.ROOT; OUT = os.path.join(ROOT, 'scratch', 'persec_globex_20261103'); os.makedirs(OUT, exist_ok=True)
G_END = 55800            # 09:30 ET = 15.5 h after 18:00

def for_path(p, d):
    dd = datetime.date.fromisoformat(d); lay = X._sniff_layout(p, dd)
    if lay == 'empty': return None, 0
    if lay == 'other': raise ValueError('unknown record layout')
    sc = 1.0
    if lay == 'std':
        pr = []
        for k, t0 in enumerate(sr.read_ticks(p, start_date=dd, end_date=dd)):
            pr.append(t0.price)
            if k >= 300: break
        if pr and statistics.median(pr) < 1000: sc = 100.0
    prev = dd - datetime.timedelta(days=1); tot = 0; agg = {}
    for t in (sr.read_ticks(p, start_date=prev, end_date=dd) if lay == 'std' else V._legacy_range(p, prev, dd)):
        m = t.ts_et.hour * 60 + t.ts_et.minute; px = t.price * sc if sc != 1.0 else t.price
        sec = session_sec(t.ts_et, dd)
        if sec is None: continue
        if t.ts_et.date() == dd and 570 <= m < 960: tot += int(t.size)
        if sec >= G_END: continue
        i = int(sec); c = agg.get(i)
        if c is None: c = agg[i] = [0, 0, px, px, px]
        if t.aggressor == 'BUY': c[0] += t.size
        elif t.aggressor == 'SELL': c[1] += t.size
        if px < c[2]: c[2] = px
        if px > c[3]: c[3] = px
        c[4] = px
    return agg, tot

def work(d):
    fp = os.path.join(OUT, d + '.tsv')
    if os.path.exists(fp): return d, 'exists'
    best = None
    for code in X.candidate_codes(X.CAL[d]):
        for p in X.scid_paths(code):
            try: agg, tot = for_path(p, d)
            except ValueError: return d, 'nontick'
            if agg is None: continue
            if d in X.DBVOL and abs(tot - X.DBVOL[d]) <= 0.03 * X.DBVOL[d]: best = agg; break
        if best is not None: break
    if best is None: return d, 'nomatch'
    with open(fp + '.tmp', 'w') as f:
        for i in sorted(best): c = best[i]; f.write(f'{i}\t{c[0]}\t{c[1]}\t{c[2]:.2f}\t{c[3]:.2f}\t{c[4]:.2f}\n')
    os.replace(fp + '.tmp', fp); return d, f'{len(best)} seconds'

if __name__ == '__main__':
    dates = sorted(os.path.basename(x)[:10] for x in os.listdir(V.OUT) if x.endswith('.bars.tsv'))     # the 536 explore dates that passed RTH volume validation
    if len(sys.argv) > 2 and sys.argv[1] == '--only': dates = sys.argv[2:]
    with Pool(int(os.environ.get('GX_POOL', 3))) as pool:
        n = 0
        for d, s in pool.imap_unordered(work, dates):
            n += 1
            if n % 25 == 0 or s in ('nomatch', 'nontick') or len(dates) < 5: print(n, d, s, flush=True)
    print('done', n)
