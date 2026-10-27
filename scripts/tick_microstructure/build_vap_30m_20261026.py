"""30-minute volume-at-price from NQ .scid tick data (all sessions), at 0.25-point resolution, reconciled per trade date to the daily table's total (build_vap_daily_20261026.py).
Why: the user reads per-bar value areas and POCs (Sierra, one profile per bar, POC in orange); any bar size (30m, 1h, 4h, session) can be composed from 30-minute cells, and a per-bar POC from
1-minute bars with the volume spread over each bar's range is wrong on exactly the profiles that matter. Output: scratch/vap_30m/YYYY-MM-DD.tsv  lines: ET_calendar_date HH:MM price volume
(the trade-date session runs 18:00 ET prior calendar day to 17:00 ET; a bar is labelled by the ET calendar date and the 30-minute slot it starts in).
Usage: build_vap_30m_20261026.py START END   (trade dates, inclusive; reads scratch/vap_daily/<date>.tsv for the reconciliation target, so build the daily file first)"""
import sys, os, json, datetime, collections
from multiprocessing import Pool
sys.path.insert(0, os.path.dirname(__file__))
import scid_reader as sr
import extract_cells_20261020 as ec
import build_vap_daily_20261026 as bv
ROOT = ec.ROOT
OUT = os.path.join(ROOT, 'scratch', 'vap_30m'); os.makedirs(OUT, exist_ok=True)
def daily_total(d):
    fp = os.path.join(ROOT, 'scratch', 'vap_daily', d + '.tsv')
    if not os.path.exists(fp): return None
    return sum(int(l.split('\t')[1]) for l in open(fp) if l.strip())
def ticks_ts(p, d):
    dd = datetime.date.fromisoformat(d); prev = dd - datetime.timedelta(days=1)
    lay = ec._sniff_layout(p, dd)
    if lay == 'empty': lay = ec._sniff_layout(p, prev)
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
            yield day, (m // 30) * 30, round(t.price * sc * 4) / 4, t.size
def work(d):
    fp = os.path.join(OUT, d + '.tsv')
    if os.path.exists(fp): return d, 'exists'
    want = daily_total(d)
    if want is None: return d, 'no-daily-file'
    con = bv.contract_of(d)
    for code in ec.candidate_codes(con):
        for p in ec.scid_paths(code):
            try:
                acc = collections.defaultdict(int); tot = 0
                for day, slot, px, sz in ticks_ts(p, d): acc[(day.isoformat(), slot, px)] += sz; tot += sz
            except ValueError: return d, 'nontick'
            if tot == want:
                with open(fp + '.tmp', 'w') as f:
                    for (day, slot, px), v in sorted(acc.items()): f.write(f'{day}\t{slot // 60:02d}:{slot % 60:02d}\t{px:.2f}\t{v}\n')
                os.replace(fp + '.tmp', fp); return d, f'ok {tot} ({len(acc)} cells)'
    return d, 'NO-MATCH to the daily total'
if __name__ == '__main__':
    a = datetime.date.fromisoformat(sys.argv[1]); b = datetime.date.fromisoformat(sys.argv[2])
    days = [(a + datetime.timedelta(days=i)).isoformat() for i in range((b - a).days + 1)]
    days = [d for d in days if os.path.exists(os.path.join(ROOT, 'scratch', 'vap_daily', d + '.tsv'))]
    with Pool(int(os.environ.get('NPROC', '4'))) as pool:
        for d, msg in pool.imap(work, days): print(d, msg, flush=True)
