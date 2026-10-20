"""Per-second aggressor volume per RTH session for docs/LOCATION_REGIME_PACE_PREREG_20261020.md.
Output scratch/persec_20261020/DATE.tsv lines: second_of_day(ET, int)  buy_aggr_volume  sell_aggr_volume (only seconds with volume). Same file/validation logic as extract_stuffed_20261020.py (session RTH volume must match the database within 3 percent).
Usage: extract_persec_20261020.py [DATE ...]  (default: every date with a stuffed file)"""
import sys, os, glob
from multiprocessing import Pool
sys.path.insert(0, os.path.dirname(__file__))
import extract_cells_20261020 as E
import extract_stuffed_20261020 as X
ROOT = X.ROOT; OUT = os.path.join(ROOT, 'scratch', 'persec_20261020'); os.makedirs(OUT, exist_ok=True)
def process(d):
    fp = os.path.join(OUT, d + '.tsv')
    if os.path.exists(fp): return d, 'exists'
    best = None
    for code in E.candidate_codes(E.CAL[d]):
        for p in E.scid_paths(code):
            try: tk = X.ticks_for(p, d)
            except ValueError: return d, 'nontick'
            tot = sum(x[2] for x in tk)
            if d in E.DBVOL and abs(tot - E.DBVOL[d]) <= 0.03 * E.DBVOL[d]: best = tk; break
        if best is not None: break
    if best is None: return d, 'nomatch'
    agg = {}
    for s, px, sz, ag, u in best:
        i = int(s); c = agg.get(i) or agg.setdefault(i, [0, 0])
        if ag == 'BUY': c[0] += sz
        elif ag == 'SELL': c[1] += sz
    with open(fp + '.tmp', 'w') as f:
        for i in sorted(agg): f.write(f'{i}\t{agg[i][0]}\t{agg[i][1]}\n')
    os.replace(fp + '.tmp', fp); return d, f'{len(agg)} seconds'
if __name__ == '__main__':
    dates = sys.argv[1:] or sorted(os.path.basename(x)[:10] for x in glob.glob(os.path.join(ROOT, 'scratch', 'stuffed_20261020', '*.tsv')))
    with Pool(12) as pool:
        n = 0
        for d, s in pool.imap_unordered(process, dates):
            n += 1
            if n % 100 == 0 or s in ('nomatch', 'nontick'): print(n, d, s, flush=True)
    print('done', n)
