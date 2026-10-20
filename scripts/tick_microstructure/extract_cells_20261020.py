"""Per-session (minute, price) volume cells from NQ .scid tick data, RTH 09:30-16:00 ET.
Derived aggregate for docs/BUBBLE_ABSORPTION_PREREG_20261020.md (not ingested into Postgres). Reuses the canonical scid_reader (merged unbundled sub-trades).
Usage: extract_cells_20261020.py [--validate DATE ...]  (default: all dates in scratch/contract_by_date_20261020.json up to 2026-10-13)
Output: scratch/cells_20261020/YYYY-MM-DD.tsv  lines: minute_of_day price total bid_aggr ask_aggr   (cells with total >= 20)
"""
import sys, os, json, datetime, collections, glob
from multiprocessing import Pool
sys.path.insert(0, os.path.dirname(__file__))
import scid_reader as sr
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CAL = json.load(open(os.path.join(ROOT, 'scratch', 'contract_by_date_20261020.json')))
OUT = os.path.join(ROOT, 'scratch', 'cells_20261020'); os.makedirs(OUT, exist_ok=True)
OUT2 = os.path.join(ROOT, 'scratch', 'orders_20261020'); os.makedirs(OUT2, exist_ok=True)
AGG_GAP_US = 1000      # Delta Dynamics Big Trades: Input data Aggregate, Aggregate gap 1 ms: consecutive same-side prints at most 1 ms apart are one order
DBVOL = json.load(open(os.path.join(ROOT, 'scratch', 'db_rth_volume_20261020.json')))
QUARTERS = 'HMUZ'
def code_of(contract): return contract[:2] + contract[2] + contract[-1]       # NQM23 -> NQM3
def scid_paths(code):
    return [f'{b}/{code}.CME.scid' for b in ('/mnt/c/SierraChart/Data', '/mnt/c/SierraChart-DTC/Data') if os.path.exists(f'{b}/{code}.CME.scid')]
def candidate_codes(contract):                       # mapped contract first, then the neighbouring quarters
    q = contract[2]; y = int(contract[-1]); i = QUARTERS.index(q); prev = (QUARTERS[i - 1], y if i else (y - 1) % 10); nxt = (QUARTERS[(i + 1) % 4], y if i < 3 else (y + 1) % 10)
    return [code_of(contract), f'NQ{prev[0]}{prev[1]}', f'NQ{nxt[0]}{nxt[1]}']
def cells_for_path(p, d, keep_all=False):
    dd = datetime.date.fromisoformat(d); cell = collections.defaultdict(lambda: [0, 0, 0]); tot = 0
    orders = []; cur = None
    for t in sr.read_ticks(p, start_date=dd, end_date=dd):
        m = t.ts_et.hour * 60 + t.ts_et.minute
        if not (570 <= m < 960): continue
        if cur is not None and t.aggressor == cur[0] and t.aggressor in ('BUY', 'SELL') and (t.ts_utc - cur[5]).total_seconds() * 1e6 <= AGG_GAP_US:
            cur[2] += t.size; cur[3] += t.price * t.size; cur[4] += 1; cur[5] = t.ts_utc
        else:
            if cur is not None and cur[2] >= 20: orders.append(cur)
            cur = [t.aggressor, t.ts_et.hour * 3600 + t.ts_et.minute * 60 + t.ts_et.second + t.ts_et.microsecond / 1e6, t.size, t.price * t.size, 1, t.ts_utc]
        c = cell[(m, round(t.price, 2))]; c[0] += t.size; tot += t.size
        if t.aggressor == 'SELL': c[1] += t.size
        elif t.aggressor == 'BUY': c[2] += t.size
    if cur is not None and cur[2] >= 20: orders.append(cur)
    return ({k: v for k, v in cell.items() if keep_all or v[0] >= 20}, orders), tot
def cells_for(d, keep_all=False):
    best = None
    for code in candidate_codes(CAL[d]):
        for p in scid_paths(code):
            try: c, tot = cells_for_path(p, d, keep_all)
            except ValueError as e: return 'nontick'          # the reader refuses files whose records are not true ticks: skip the date, never guess
            if d in DBVOL and abs(tot - DBVOL[d]) <= 0.03 * DBVOL[d]: return c
            if best is None or abs(tot - DBVOL.get(d, 0)) < abs(best[1] - DBVOL.get(d, 0)): best = (c, tot)
    return None                                       # no file reproduces the database volume for that date: skip it, never guess
def work(d):
    fp = os.path.join(OUT, d + '.tsv'); fp2 = os.path.join(OUT2, d + '.tsv')
    if os.path.exists(fp) and os.path.exists(fp2): return d, 'exists'
    r = cells_for(d)
    if r == 'nontick': return d, 'nontick'
    if r is None: return d, 'nomatch'
    c, orders = r
    if not c: return d, 'empty'
    with open(fp + '.tmp', 'w') as f:
        for (m, p), v in sorted(c.items()): f.write(f'{m}\t{p}\t{v[0]}\t{v[1]}\t{v[2]}\n')
    os.replace(fp + '.tmp', fp)
    with open(fp2 + '.tmp', 'w') as f:                  # side, ET seconds of day (first print), volume, vwap, number of prints
        for o in orders: f.write(f'{o[0][0]}\t{o[1]:.3f}\t{o[2]}\t{o[3] / o[2]:.2f}\t{o[4]}\n')
    os.replace(fp2 + '.tmp', fp2); return d, f'{len(c)} cells {len(orders)} orders'
if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--validate':
        import subprocess
        for d in sys.argv[2:]:
            r = cells_for(d, keep_all=True)
            if r is None or r == 'nontick': print(d, 'NO MATCHING FILE', r); continue
            c = r[0]
            permin = collections.defaultdict(lambda: [0, 0, 0])
            for (m, p), v in c.items(): permin[m][0] += v[0]; permin[m][1] += v[1]; permin[m][2] += v[2]
            json.dump({str(m): v for m, v in permin.items()}, open(os.path.join(ROOT, 'scratch', f'cells_validate_{d}.json'), 'w')); print(d, 'minutes', len(permin), 'total vol', sum(v[0] for v in permin.values()))
        sys.exit(0)
    dates = [d for d in sorted(CAL) if '2023-03-06' <= d <= '2026-10-13']
    with Pool(12) as pool:
        n = 0
        for d, s in pool.imap_unordered(work, dates):
            n += 1
            if n % 50 == 0 or s in ('nomatch', 'empty', 'nontick'): print(n, d, s, flush=True)
    print('done', n)
