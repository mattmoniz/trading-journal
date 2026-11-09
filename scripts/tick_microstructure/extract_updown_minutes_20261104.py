"""Per-minute UP-TICK / DOWN-TICK volume (Sierra 'Cumulative Delta Bars - Up/Down Tick Volume' rule, see updown_tick_delta.py) for the FULL trading day (Globex 18:00 the previous calendar day through the 16:00 RTH close) per explore trade date, so the cumulative sum can be reset at 18:00 like the user's pane.
Reuses extract_cells_20261020's contract map, layout sniffing, price scaling and the DB-volume validation (a date is kept only if the tick RTH total matches price_bars_primary RTH volume within 3 percent), the same selection as extract_volbars_20261028.py.
Output scratch/updown_1m_20261104/YYYY-MM-DD.csv: ts (ET minute), up_vol, down_vol, unclassified_vol, volume, close. Usage: extract_updown_minutes_20261104.py [--only DATE ...]   (UD_POOL = workers, default 4)"""
import sys, os, datetime, json
from multiprocessing import Pool
sys.path.insert(0, os.path.dirname(__file__))
import extract_cells_20261020 as X
sr = X.sr
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'amt_tell_live'))
from barbuilder import session_sec
from extract_volbars_20261028 import _legacy_range      # the same legacy-layout reader the 500-contract bars use (no second copy)
OUT = os.environ.get('UD_OUT') or os.path.join(X.ROOT, 'scratch', 'updown_1m_20261104'); os.makedirs(OUT, exist_ok=True)      # UD_OUT: a separate folder for the post-explore dates so explore-era scripts that list this folder can never pick them up
LAST_EXPLORE = '2025-05-16'
HL = json.load(open(os.environ['UD_HL_JSON'])) if os.environ.get('UD_HL_JSON') else {}      # date -> [database RTH high, low], optional second acceptance test (see minutes_for)

def minutes_for_path(p, d):
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
    prev = dd - datetime.timedelta(days=1); tot = 0; mins = {}; prev_px = None; direction = 0; hi = -1e18; lo = 1e18
    for t in (sr.read_ticks(p, start_date=prev, end_date=dd) if lay == 'std' else _legacy_range(p, prev, dd)):
        if session_sec(t.ts_et, dd) is None: continue
        px = t.price * sc; m = t.ts_et.replace(second=0, microsecond=0, tzinfo=None)
        if t.ts_et.date() == dd and 570 <= t.ts_et.hour * 60 + t.ts_et.minute < 960: tot += int(t.size); hi = max(hi, px); lo = min(lo, px)
        r = mins.get(m)
        if r is None: r = mins[m] = [0, 0, 0, 0, px]
        if prev_px is not None:
            if px > prev_px: direction = 1
            elif px < prev_px: direction = -1
        k = 0 if prev_px is None or direction == 0 else (1 if direction == 1 else 2)
        r[{0: 2, 1: 0, 2: 1}[k]] += int(t.size); r[3] += int(t.size); r[4] = px; prev_px = px
    return mins, tot, hi, lo

def minutes_for(d):
    best = None
    for code in X.candidate_codes(X.CAL[d]):
        for p in X.scid_paths(code):
            try: mins, tot, hi, lo = minutes_for_path(p, d)
            except ValueError: return 'nontick'
            if mins is None: continue
            if d in X.DBVOL and abs(tot - X.DBVOL[d]) <= 0.03 * X.DBVOL[d]: return mins
            if HL.get(d) and tot > 0 and abs(hi - HL[d][0]) <= 0.5 and abs(lo - HL[d][1]) <= 0.5: return mins      # hr-070: the database RTH volume is inflated on some mid-2025 dates (ticks are right); such a date is accepted when the tick RTH high and low equal the database bars' to within two ticks (the right contract and the right session)
    return None

def work(d):
    fp = os.path.join(OUT, d + '.csv')
    if os.path.exists(fp): return d, 'exists'
    r = minutes_for(d)
    if r == 'nontick': return d, 'nontick'
    if r is None: return d, 'nomatch'
    with open(fp + '.tmp', 'w') as f:
        f.write('ts,up_vol,down_vol,unclassified_vol,volume,close\n')
        for m in sorted(r): u, dn, un, v, c = r[m]; f.write(f"{m.strftime('%Y-%m-%d %H:%M:%S')},{u},{dn},{un},{v},{c:.2f}\n")
    os.replace(fp + '.tmp', fp); return d, f'{len(r)} minutes'

if __name__ == '__main__':
    dates = [d for d in sorted(X.CAL) if '2023-03-06' <= d <= LAST_EXPLORE]
    if len(sys.argv) > 2 and sys.argv[1] == '--only': dates = sys.argv[2:]
    if len(sys.argv) > 3 and sys.argv[1] == '--range': dates = [d for d in sorted(X.CAL) if sys.argv[2] <= d <= sys.argv[3]]      # inclusive dates, e.g. --range 2025-05-19 2026-10-19 (CAL ends 2026-10-19)
    with Pool(int(os.environ.get('UD_POOL', 4))) as pool:
        n = 0
        for d, s in pool.imap_unordered(work, dates):
            n += 1
            if n % 25 == 0 or s in ('nomatch', 'nontick'): print(n, d, s, flush=True)
    print('done', n)
