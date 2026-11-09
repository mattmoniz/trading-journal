"""Depth-levels calibration on ONE day (2026-11-06) against the user's quoted Ratio values; reads NO outcome. Rebuilds the order book from the .depth stream (full snapshot every 10 minutes: CLEAR_BOOK + ADD batch), and at every
500V bar CLOSE sums the top-L bid and top-L ask levels (Sierra 'Bid & Ask Depth Bars', Sum mode, Close subgraph). Ratio_L = EMA10(TR) / EMA10(depth_L). The user's anchors (their Nov 6 read of the chart): Ratio about 0.040 -> 0.052 around the 12:36 short, below 0.030 in the 13:00-14:37 stall.
Usage: depth_calibrate.py [DATE]  (default 2026-11-06)"""
import sys, os, datetime, numpy as np
from zoneinfo import ZoneInfo
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
DATE = sys.argv[1] if len(sys.argv) > 1 else '2026-11-06'
DEPTH = f'/mnt/c/SierraChart-DTC/Data/MarketDepthData/NQZ26.{DATE}.depth'
BARS = os.path.join(ROOT, 'scratch', 'amt_tell_live', f'{DATE}.split.bars.tsv')
ET = ZoneInfo('America/New_York'); EPOCH = datetime.datetime(1899, 12, 30, tzinfo=ZoneInfo('UTC'))
LS = (1, 3, 5, 10, 20, 50, 1000)
dt = np.dtype([('t', '<i8'), ('cmd', 'u1'), ('fl', 'u1'), ('no', '<u2'), ('px', '<f4'), ('q', '<u4'), ('r', '<u4')])
mm = np.memmap(DEPTH, dtype=dt, mode='r', offset=64); n = len(mm)
d0 = datetime.datetime.fromisoformat(DATE); prev = d0 - datetime.timedelta(days=1)
sess0 = datetime.datetime(prev.year, prev.month, prev.day, 18, 0, tzinfo=ET)           # session start, 18:00 ET of the prior calendar day (an unusual Monday session is not handled here)
us = lambda dtm: int((dtm - EPOCH).total_seconds() * 1e6)
rows = []
for ln in open(BARS):
    q = ln.rstrip('\n').split('\t')
    if len(q) < 12 or q[11] != '1': continue
    rows.append([float(x) for x in q[1:11]])
a = np.array(rows).T; st, en, o, h, l, c, vol, bid, ask, ntr = a
WIN0, WIN1 = 12 * 3600 - 55 * 60 + 0, 14 * 3600 + 45 * 60                                  # 11:05 .. 14:45 ET (EMA warm-up before the 12:20 region)
sec = lambda hh, mm_: (hh * 3600 + mm_ * 60) + 6 * 3600                                      # seconds since 18:00 of the prior day
sel = np.where((en >= WIN0 + 6 * 3600 - 6 * 3600 + 6 * 3600 - 0) & (en <= sec(14, 45)))[0] if False else np.where((en >= sec(11, 5)) & (en <= sec(14, 45)))[0]
t_lo = us(sess0 + datetime.timedelta(seconds=float(en[sel[0]]) - 1800)); t_hi = us(sess0 + datetime.timedelta(seconds=float(en[sel[-1]]) + 5))
times = mm['t']; i_lo = int(np.searchsorted(times, t_lo)); i_hi = int(np.searchsorted(times, t_hi))
# back up to the last CLEAR_BOOK at or before i_lo (snapshot), scanning in chunks
j = i_lo; start = None
while j > 0 and start is None:
    k0 = max(0, j - 2_000_000); idx = np.where(mm['cmd'][k0:j] == 1)[0]
    if len(idx): start = k0 + int(idx[-1])
    j = k0
print(f'depth records {n:,}; window records {i_hi - start:,} (snapshot at record {start})', flush=True)
bid_b = {}; ask_b = {}; bar_end_us = [us(sess0 + datetime.timedelta(seconds=float(x))) for x in en[sel]]; bi = 0; depth = np.full((len(sel), len(LS)), np.nan)
def topL(book, rev):
    ks = sorted(book, reverse=rev); return [book[k] for k in ks]
chunk = 500_000; pos = start
while pos < i_hi and bi < len(sel):
    blk = mm[pos:min(pos + chunk, i_hi)]; T = blk['t']; C = blk['cmd']; P = blk['px']; Q = blk['q']
    for r in range(len(blk)):
        while bi < len(sel) and T[r] > bar_end_us[bi]:
            bl = topL(bid_b, True); al = topL(ask_b, False)
            for li, L in enumerate(LS): depth[bi, li] = sum(bl[:L]) + sum(al[:L])
            bi += 1
        if bi >= len(sel): break
        cm = C[r]
        if cm == 1: bid_b.clear(); ask_b.clear()
        elif cm in (2, 4): bid_b[float(P[r])] = int(Q[r])
        elif cm in (3, 5): ask_b[float(P[r])] = int(Q[r])
        elif cm == 6: bid_b.pop(float(P[r]), None)
        elif cm == 7: ask_b.pop(float(P[r]), None)
    pos += chunk
print('bars with a depth value:', int(np.sum(~np.isnan(depth[:, 0]))), 'of', len(sel), flush=True)
hh, ll, cc = h[sel], l[sel], c[sel]; pc = np.r_[cc[0], cc[:-1]]; tr = np.maximum.reduce([hh - ll, np.abs(hh - pc), np.abs(ll - pc)])
def ema(x, L=10):
    al = 2 / (L + 1); o_ = np.empty(len(x)); o_[0] = x[0]
    for i in range(1, len(x)): o_[i] = al * x[i] + (1 - al) * np.nan_to_num(o_[i - 1]) if False else al * x[i] + (1 - al) * o_[i - 1]
    return o_
etr = ema(tr); tt = lambda s: f'{int(s + 18 * 3600) % 86400 // 3600:02d}:{int(s + 18 * 3600) % 86400 % 3600 // 60:02d}'
hhmm = np.array([tt(x) for x in en[sel]])
print('\nL      depth@12:37  Ratio@12:20  @12:30  @12:36  @12:37  @12:40  @12:50 | stall 13:00-14:37 mean  share<0.030 | day median depth')
for li, L in enumerate(LS):
    dp = depth[:, li]; ok = ~np.isnan(dp)
    if ok.sum() < 20: print(f'L={L}: too few'); continue
    d2 = dp.copy(); first = np.where(ok)[0][0]; d2[:first] = dp[first]; d2 = np.where(np.isnan(d2), np.nan_to_num(np.nanmedian(dp)), d2)
    ratio = etr / np.maximum(ema(d2), 1e-6)
    def at(t0): m = np.where(hhmm >= t0)[0]; return ratio[m[0]] if len(m) else float('nan')
    stall = (hhmm >= '13:00') & (hhmm <= '14:37')
    print(f'L={L:<5d} {at("12:37") and d2[np.where(hhmm >= "12:37")[0][0]]:11.0f}  {at("12:20"):11.4f} {at("12:30"):7.4f} {at("12:36"):7.4f} {at("12:37"):7.4f} {at("12:40"):7.4f} {at("12:50"):7.4f} | {ratio[stall].mean():10.4f} {np.mean(ratio[stall] < 0.030):12.2f} | {np.median(d2):10.0f}')
print('\nUser anchors: Ratio about 0.040 before and 0.052 at the 12:33-12:52 short (peak 0.052); below 0.030 in the 13:00-14:37 stall.')
