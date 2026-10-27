"""Daily FULL-SESSION volume-at-price for ES (E-mini S&P) from the raw .scid tick files, 0.25-point resolution, trade-date session 18:00 ET prior day to 17:00 ET. The ES twin of build_vap_daily_20261026.py (NQ), for the
ES replication (docs/ES_REPLICATION_TOPS_LVN_PREREG_20261027.md). Contract per trade date from es_front_calendar; each date reconciled to the database ES session volume (price_bars_es_front) within 3 percent, else
skipped and reported. Output scratch/vap_daily_es/YYYY-MM-DD.tsv  lines: price volume. Needs scratch/es_meta_20261027.json (scratch/dump_es_meta.mjs).
Usage: build_vap_daily_es_20261027.py START END"""
import sys, os, json, datetime, collections, statistics
from multiprocessing import Pool
sys.path.insert(0, os.path.dirname(__file__))
import scid_reader as sr
import extract_cells_20261020 as ec
ROOT = ec.ROOT
META = json.load(open(os.path.join(ROOT, 'scratch', 'es_meta_20261027.json')))
OUT = os.path.join(ROOT, 'scratch', 'vap_daily_es'); os.makedirs(OUT, exist_ok=True)
DIRS = ('/mnt/c/SierraChart/Data', '/mnt/c/SierraChart-DTC/Data')
def paths(contract):                                   # ESM3 -> ESM3.CME.scid / ESM23-CME.scid / ESM23.scid in either folder
    q, y = contract[2], contract[3]; yy = '2' + y if int(y) >= 3 else '2' + y
    names = [f'ES{q}{y}.CME.scid', f'ES{q}{yy}-CME.scid', f'ES{q}{yy}.scid']
    return [os.path.join(d, n) for d in DIRS for n in names if os.path.exists(os.path.join(d, n))]
def session(p, d):
    dd = datetime.date.fromisoformat(d); prev = dd - datetime.timedelta(days=1)
    lay = ec._sniff_layout(p, dd)
    if lay == 'empty': lay = ec._sniff_layout(p, prev)
    if lay == 'other': raise ValueError('unknown record layout')
    sc = 1.0; cs = []
    for k, (dt, o, h, l, c, nt, tv, b, a) in enumerate(sr._raw_records(p, start_date=dd)):
        cs.append(c / sr.SCID_PRICE_SCALE)
        if k >= 300: break
    if cs and statistics.median(cs) < 1000: sc = 100.0     # plain-price copies of the file
    for dt, o, h, l, c, nt, tv, b, a in sr._raw_records(p, start_date=prev):
        et = sr._to_et(dt); day = et.date()
        if day < prev: continue
        if day > dd: break
        m = et.hour * 60 + et.minute
        if day == prev and m < 1080: continue
        if day == dd and m >= 1020: continue
        if lay == 'std' and not (o == 0.0 or o < -1e30): continue
        if lay == 'legacy' and not (o == h == l == c): continue
        px = round(c / sr.SCID_PRICE_SCALE * sc * 4) / 4
        if not (1000 < px < 20000): continue
        yield px, tv
def work(d):
    fp = os.path.join(OUT, d + '.tsv')
    if os.path.exists(fp): return d, 'exists'
    con = META['contract'].get(d); want = META['vol'].get(d, {}).get('v', 0)
    if not con or want <= 0: return d, 'no-calendar-or-volume'
    best = None
    for p in paths(con):
        try:
            acc = collections.defaultdict(int); tot = 0
            for px, tv in session(p, d): acc[px] += tv; tot += tv
        except ValueError: return d, 'nontick'
        if tot and abs(tot - want) <= 0.03 * want:
            with open(fp + '.tmp', 'w') as f:
                for px in sorted(acc): f.write(f'{px:.2f}\t{acc[px]}\n')
            os.replace(fp + '.tmp', fp); return d, f'ok {tot} db {int(want)} {con} {os.path.basename(p)}'
        if best is None or abs(tot - want) < abs(best - want): best = tot
    return d, f'NO-RECONCILE {con} best {best} vs db {int(want)} files {len(paths(con))}'
if __name__ == '__main__':
    a = datetime.date.fromisoformat(sys.argv[1]); b = datetime.date.fromisoformat(sys.argv[2])
    days = [(a + datetime.timedelta(days=i)).isoformat() for i in range((b - a).days + 1)]
    days = [d for d in days if d in META['vol']]
    with Pool(int(os.environ.get('NPROC', '3'))) as pool:
        for d, msg in pool.imap(work, days): print(d, msg, flush=True)
