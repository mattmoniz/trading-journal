"""30-minute BID and ASK volume per 0.25 price from the RAW .scid records (all sessions), the way Sierra Chart's Volume by Price / Numbers Bars read them: every record's BidVolume and AskVolume are added
at the record's trade price (Close). Output scratch/vap_30m_ba/YYYY-MM-DD.tsv lines: ET_calendar_date HH:MM price bid_volume ask_volume. Reconciled per trade date: the sum of the records' TotalVolume must equal the
daily table total (build_vap_daily_20261026.py); bid + ask can be lower than total (records carrying neither side), and that gap is reported, not hidden.
Usage: build_vap_30m_ba_20261026.py START END   (trade dates; needs scratch/vap_daily/<date>.tsv)"""
import sys, os, datetime, collections
from multiprocessing import Pool
sys.path.insert(0, os.path.dirname(__file__))
import scid_reader as sr
import extract_cells_20261020 as ec
import build_vap_daily_20261026 as bv
ROOT = ec.ROOT
OUT = os.path.join(ROOT, 'scratch', 'vap_30m_ba'); os.makedirs(OUT, exist_ok=True)
def daily_total(d):
    fp = os.path.join(ROOT, 'scratch', 'vap_daily', d + '.tsv')
    return None if not os.path.exists(fp) else sum(int(l.split('\t')[1]) for l in open(fp) if l.strip())
def raw_ba(p, d):
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
    for dt, o, h, l, c, nt, tv, bvv, avv in sr._raw_records(p, start_date=prev):
        et = sr._to_et(dt); day = et.date()
        if day < prev: continue
        if day > dd: break
        m = et.hour * 60 + et.minute
        if day == prev and m < 1080: continue
        if day == dd and m >= 1020: continue
        if lay == 'std' and not (o == 0.0 or o < -1e30): continue          # same record filter as read_ticks (anything else is an anomaly it counts, not a trade)
        yield day, (m // 30) * 30, round(c / sr.SCID_PRICE_SCALE * sc * 4) / 4, tv, bvv, avv
def work(d):
    fp = os.path.join(OUT, d + '.tsv')
    if os.path.exists(fp): return d, 'exists'
    want = daily_total(d)
    if want is None: return d, 'no-daily-file'
    for code in ec.candidate_codes(bv.contract_of(d)):
        for p in ec.scid_paths(code):
            try:
                acc = collections.defaultdict(lambda: [0, 0]); tot = 0; ba = 0
                for day, slot, px, tv, b, a in raw_ba(p, d): c = acc[(day.isoformat(), slot, px)]; c[0] += b; c[1] += a; tot += tv; ba += b + a
            except ValueError: return d, 'nontick'
            if tot == want:
                with open(fp + '.tmp', 'w') as f:
                    for (day, slot, px), (b, a) in sorted(acc.items()): f.write(f'{day}\t{slot // 60:02d}:{slot % 60:02d}\t{px:.2f}\t{b}\t{a}\n')
                os.replace(fp + '.tmp', fp); return d, f'ok total {tot} bid+ask {ba} ({100 * ba / max(1, tot):.2f}%)'
    return d, 'NO-MATCH to the daily total'
if __name__ == '__main__':
    a = datetime.date.fromisoformat(sys.argv[1]); b = datetime.date.fromisoformat(sys.argv[2])
    days = [(a + datetime.timedelta(days=i)).isoformat() for i in range((b - a).days + 1)]
    days = [d for d in days if os.path.exists(os.path.join(ROOT, 'scratch', 'vap_daily', d + '.tsv'))]
    with Pool(int(os.environ.get('NPROC', '4'))) as pool:
        for d, msg in pool.imap(work, days): print(d, msg, flush=True)
