"""Per-session real-depth cache for the user's Ratio (docs/VACUUM_COMMON_SIM_PREREG_20261108.md amendment A3). Reads NO outcome. For one trade date: rebuild the order book from the largest NQ .depth file of that date (snapshot every 10 minutes),
and store, at every 500V bar CLOSE between 08:00 and 16:05 ET, the sum of ALL recorded bid+ask quantities (and the top-20-per-side sum as a sensitivity). Output scratch/vacuum_sim_20261108/depth_cache/DATE.npz (skipped if present).
Usage: depth_cache.py DATE [DATE ...]   |   depth_cache.py --list-file FILE   (run with a pool from the shell)"""
import sys, os, re, glob, datetime, numpy as np
from zoneinfo import ZoneInfo
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')); OUTD = os.path.join(ROOT, 'scratch', 'vacuum_sim_20261108', 'depth_cache'); os.makedirs(OUTD, exist_ok=True)
ET = ZoneInfo('America/New_York'); EPOCH = datetime.datetime(1899, 12, 30, tzinfo=ZoneInfo('UTC'))
dt = np.dtype([('t', '<i8'), ('cmd', 'u1'), ('fl', 'u1'), ('no', '<u2'), ('px', '<f4'), ('q', '<u4'), ('r', '<u4')])
DIRS = ['/mnt/c/SierraChart/Data/MarketDepthData', '/mnt/c/SierraChart-DTC/Data/MarketDepthData']
def depth_file(d):
    best = None
    for dr in DIRS:
        for f in glob.glob(os.path.join(dr, f'NQ[HMUZ]*.{d}.depth')):
            if re.match(r'^NQ[HMUZ]\d+(\.CME)?\.' + d + r'\.depth$', os.path.basename(f)):
                s = os.path.getsize(f)
                if best is None or s > best[0]: best = (s, f)
    return best
def bars_file(d):
    for pat in (f'scratch/argon_vacuum_live/priors/{d}.bars.tsv', f'scratch/volbars500_holdout_20261103/{d}.bars.tsv', f'scratch/amt_tell_live/{d}.split.bars.tsv', f'scratch/volbars500_full_20261028/{d}.bars.tsv'):
        p = os.path.join(ROOT, pat)
        if os.path.exists(p): return p
def run(d):
    out = os.path.join(OUTD, f'{d}.npz')
    if os.path.exists(out): return d, 'cached'
    df = depth_file(d); bf = bars_file(d)
    if not df or not bf or df[0] < 3e8: return d, 'missing/small'
    rows = []
    for ln in open(bf):
        q = ln.rstrip('\n').split('\t')
        if len(q) >= 12 and q[11] == '1': rows.append([float(x) for x in q[1:11]])
    a = np.array(rows).T; en = a[1]; sec = lambda hh, mi: hh * 3600 + mi * 60 + 6 * 3600
    sel = np.where((en >= sec(8, 0)) & (en <= sec(16, 5)))[0]
    if len(sel) < 100: return d, 'few bars'
    d0 = datetime.datetime.fromisoformat(d); prev = d0 - datetime.timedelta(days=1); sess0 = datetime.datetime(prev.year, prev.month, prev.day, 18, 0, tzinfo=ET)
    us = lambda x: int((x - EPOCH).total_seconds() * 1e6)
    mm = np.memmap(df[1], dtype=dt, mode='r', offset=64); times = mm['t']
    end_us = [us(sess0 + datetime.timedelta(seconds=float(x))) for x in en[sel]]
    i_lo = int(np.searchsorted(times, end_us[0] - 1_800_000_000)); i_hi = int(np.searchsorted(times, end_us[-1] + 5_000_000))
    j = i_lo; start = None
    while j > 0 and start is None:
        k0 = max(0, j - 2_000_000); idx = np.where(mm['cmd'][k0:j] == 1)[0]
        if len(idx): start = k0 + int(idx[-1])
        j = k0
    if start is None: return d, 'no snapshot'
    bid_b = {}; ask_b = {}; bi = 0; nb = len(sel); dall = np.full(nb, np.nan); d20 = np.full(nb, np.nan); pos = start; chunk = 500_000
    while pos < i_hi and bi < nb:
        blk = mm[pos:min(pos + chunk, i_hi)]; T = blk['t']; C = blk['cmd']; P = blk['px']; Q = blk['q']
        for r in range(len(blk)):
            while bi < nb and T[r] > end_us[bi]:
                bs = sorted(bid_b, reverse=True); as_ = sorted(ask_b)
                dall[bi] = sum(bid_b.values()) + sum(ask_b.values()); d20[bi] = sum(bid_b[k] for k in bs[:20]) + sum(ask_b[k] for k in as_[:20]); bi += 1
            if bi >= nb: break
            cm = C[r]
            if cm == 1: bid_b.clear(); ask_b.clear()
            elif cm in (2, 4): bid_b[float(P[r])] = int(Q[r])
            elif cm in (3, 5): ask_b[float(P[r])] = int(Q[r])
            elif cm == 6: bid_b.pop(float(P[r]), None)
            elif cm == 7: ask_b.pop(float(P[r]), None)
        pos += chunk
    np.savez(out + '.tmp.npz', en=en[sel], depth_all=dall, depth_20=d20, src=os.path.basename(df[1]))
    os.replace(out + '.tmp.npz', out); return d, f'ok {int(np.sum(~np.isnan(dall)))}/{nb} bars'
if __name__ == '__main__':
    args = sys.argv[1:]
    if args and args[0] == '--list-file': args = open(args[1]).read().split()
    for d in args: print(*run(d), flush=True)
