"""Daily FULL-SESSION volume-at-price (18:00 ET prior day .. 17:00 ET, Globex + RTH) from NQ .scid tick data, at 0.25-point resolution.
Why: the stored period value areas (3M_/PM_/PW_/PY_...) are built from 1-minute bars with each bar's volume spread evenly over its high-low, which flips the POC on
two-peaked profiles (2026-10-26: block profile POC 31,237 by spread vs 29,780 by real volume-at-price; the user's Sierra line says 29,779.75). Reuses the layout
handling of extract_cells_20261020.py and reconciles every day against price_bars_primary session volume (within 3 percent) before writing; a day that does not reconcile
is skipped and reported, never guessed.
Usage: build_vap_daily_20261026.py START END   (trade dates, inclusive; output scratch/vap_daily/YYYY-MM-DD.tsv  lines: price volume_all_sessions volume_rth_0930_1600)
Run with venv/bin/python is not needed (stdlib only)."""
import sys, os, json, datetime, collections
from multiprocessing import Pool
sys.path.insert(0, os.path.dirname(__file__))
import scid_reader as sr
import extract_cells_20261020 as ec
ROOT = ec.ROOT
OUT = os.path.join(ROOT, 'scratch', 'vap_daily'); os.makedirs(OUT, exist_ok=True)
DBV = json.load(open(os.path.join(ROOT, 'scratch', 'db_session_volume_20261026.json')))
def session_ticks(p, d):
    """Yield (price, size) for trade date d: ET evening of the previous calendar day (>=18:00) plus d up to 17:00."""
    dd = datetime.date.fromisoformat(d); prev = dd - datetime.timedelta(days=1)
    lay = ec._sniff_layout(p, dd)
    if lay == 'empty':
        lay = ec._sniff_layout(p, prev)
    if lay == 'other': raise ValueError('unknown record layout')
    sc = 1.0
    if lay == 'std':
        import statistics
        pr = []
        for k, t0 in enumerate(sr.read_ticks(p, start_date=dd, end_date=dd)):
            pr.append(t0.price)
            if k >= 300: break
        if pr and statistics.median(pr) < 1000: sc = 100.0
    for day in (prev, dd):
        it = sr.read_ticks(p, start_date=day, end_date=day) if lay == 'std' else ec._legacy_ticks(p, day)
        for t in it:
            m = t.ts_et.hour * 60 + t.ts_et.minute
            if day == prev and m < 1080: continue
            if day == dd and m >= 1020: continue
            yield t.price * sc, t.size, (day == dd and 570 <= m < 960)
def vap_for_path(p, d):
    acc = collections.defaultdict(lambda: [0, 0]); tot = 0
    for px, sz, rth in session_ticks(p, d):
        c = acc[round(px * 4) / 4]; c[0] += sz; tot += sz
        if rth: c[1] += sz
    return acc, tot
LASTCAL = max(ec.CAL)
def contract_of(d):
    return ec.CAL.get(d) or (ec.CAL[LASTCAL] if d > LASTCAL else None)
def work(d):
    fp = os.path.join(OUT, d + '.tsv')
    if os.path.exists(fp): return d, 'exists'
    if d not in DBV or DBV[d]['v'] <= 0: return d, 'no-db-volume'
    con = contract_of(d)
    want = DBV[d]['v']; best = None
    for code in ec.candidate_codes(con):
        for p in ec.scid_paths(code):
            try: acc, tot = vap_for_path(p, d)
            except ValueError as e: return d, 'nontick'
            if tot and abs(tot - want) <= 0.03 * want:
                with open(fp + '.tmp', 'w') as f:
                    for px in sorted(acc): f.write(f'{px:.2f}\t{acc[px][0]}\t{acc[px][1]}\n')
                os.replace(fp + '.tmp', fp); return d, f'ok vol {tot} db {int(want)} ({len(acc)} prices) {os.path.basename(p)}'
            if best is None or abs(tot - want) < abs(best - want): best = tot
    return d, f'NO-RECONCILE best tick vol {best} vs db {int(want)}'
if __name__ == '__main__':
    a = datetime.date.fromisoformat(sys.argv[1]); b = datetime.date.fromisoformat(sys.argv[2])
    days = [(a + datetime.timedelta(days=i)).isoformat() for i in range((b - a).days + 1)]
    days = [d for d in days if datetime.date.fromisoformat(d).weekday() < 5 or d in DBV]   # Sunday-evening sessions belong to the Monday trade date
    days = [d for d in days if contract_of(d)]
    with Pool(int(os.environ.get('NPROC', '4'))) as pool:
        for d, msg in pool.imap(work, days): print(d, msg, flush=True)
