"""Stage B extractor (docs/BOOKMAP_STAGE_B_DEPTH_PREREG_20261102.md): replay one session's raw Sierra .depth records and the same contract's .scid trade records in time order and write, per RTH second, a heatmap of the touch:
for tick levels r = -20..+20 around the best bid at the END of the second: displayed size, ADDED size, PULLED (cancelled, not traded) size, TRADED (executed) size, plus best bid/ask and aggressive buy/sell volume.
A drop in a level's size is a TRADE up to the executed volume at that price within +/-50 ms, the rest a CANCEL. A CLEAR_BOOK rebuild is a RESYNC (buffered, committed at the end-of-batch flag, never counted as flow).
Usage: python extract_heatmap.py DATE [--check]   (writes scratch/depth_stageb_20261102/DATE.npz)"""
import os, sys, struct, datetime, glob
import numpy as np
from numba import njit
from zoneinfo import ZoneInfo
OUT = '/home/mmoniz/trading-journal/scratch/depth_stageb_20261102'; DEPTH_DIRS = ['/mnt/c/SierraChart/Data/MarketDepthData', '/mnt/c/SierraChart-DTC/Data/MarketDepthData']; SCID_DIRS = ['/mnt/c/SierraChart-DTC/Data', '/mnt/c/SierraChart/Data']
SIZE = 1 << 19; R = 20; W = 2 * R + 1; TOL_US = 50_000; EPOCH_SHIFT = 2209161600
DEPTH_DT = np.dtype([('dt', '<i8'), ('cmd', 'u1'), ('flags', 'u1'), ('nord', '<u2'), ('price', '<f4'), ('qty', '<u4'), ('res', '<u4')])
SCID_DT = np.dtype([('dt', '<i8'), ('o', '<f4'), ('h', '<f4'), ('l', '<f4'), ('c', '<f4'), ('numtr', '<u4'), ('vol', '<u4'), ('bidvol', '<u4'), ('askvol', '<u4')])

def sc_micros(date, hh, mm):
    d = datetime.datetime.fromisoformat(date).replace(hour=hh, minute=mm, tzinfo=ZoneInfo('America/New_York')); return (int(d.timestamp()) + EPOCH_SHIFT) * 1_000_000

def find_files(date, contract):
    """contract like NQZ26 (calendar contract of the date) -> depth file NQZ6.CME.DATE.depth and scid NQZ26.scid"""
    letter, yr = contract[2], contract[-1]; dep = [f for d in DEPTH_DIRS for f in glob.glob(f'{d}/NQ{letter}{yr}.CME.{date}.depth')]
    scid = [f for d in SCID_DIRS for f in glob.glob(f'{d}/{contract}.scid')]; return (max(dep, key=os.path.getsize) if dep else None), (scid[0] if scid else None)

def bsearch(mm, target):
    lo, hi = 0, len(mm)
    while lo < hi:
        mid = (lo + hi) // 2
        if mm[mid]['dt'] < target: lo = mid + 1
        else: hi = mid
    return lo

@njit(cache=True)
def kernel(d_dt, d_cmd, d_flg, d_px, d_qty, t_dt, t_px, t_vol, t_side, t0, nsec):
    bid = np.zeros(SIZE, np.int32); ask = np.zeros(SIZE, np.int32); tb = np.zeros(SIZE, np.int32); ta = np.zeros(SIZE, np.int32)
    pull = np.zeros(SIZE, np.int32); trd = np.zeros(SIZE, np.int32); add = np.zeros(SIZE, np.int32); rem_tr = np.zeros(SIZE, np.int32); rem_time = np.zeros(SIZE, np.int64)
    un_amt = np.zeros(SIZE, np.int32); un_time = np.zeros(SIZE, np.int64); un_sec = np.zeros(SIZE, np.int32); touched = np.empty(1 << 22, np.int32); is_t = np.zeros(SIZE, np.uint8); nt = 0
    o_sz = np.zeros((nsec, W), np.int32); o_pull = np.zeros((nsec, W), np.int32); o_trd = np.zeros((nsec, W), np.int32); o_add = np.zeros((nsec, W), np.int32)
    o_bb = np.full(nsec, -1, np.int32); o_ba = np.full(nsec, -1, np.int32); o_buy = np.zeros(nsec, np.int32); o_sell = np.zeros(nsec, np.int32); o_ntr = np.zeros(nsec, np.int32)
    bb = -1; ba = -1; in_batch = False; i = 0; j = 0; nd = len(d_dt); nT = len(t_dt); cur = 0
    while i < nd or j < nT:
        take_d = (j >= nT) or (i < nd and d_dt[i] <= t_dt[j]); t = d_dt[i] if take_d else t_dt[j]; sec = (t - t0) // 1_000_000
        while cur < sec and cur < nsec:                      # finalize second cur
            if bb >= 0:
                o_bb[cur] = bb; o_ba[cur] = ba
                for r in range(-R, R + 1):
                    idx = bb + r
                    if idx < 0 or idx >= SIZE: continue
                    o_sz[cur, r + R] = bid[idx] if idx <= bb else (ask[idx] if (ba >= 0 and idx >= ba) else 0)
                    o_pull[cur, r + R] = pull[idx]; o_trd[cur, r + R] = trd[idx]; o_add[cur, r + R] = add[idx]
            for q in range(nt):
                k = touched[q]; pull[k] = 0; trd[k] = 0; add[k] = 0; is_t[k] = 0
            nt = 0; cur += 1
        if sec >= nsec: break
        if take_d:
            c = d_cmd[i]; fl = d_flg[i]; idx = int(round(d_px[i] * 4.0)); qty = d_qty[i]; i += 1
            if c == 1:
                in_batch = True; tb[:] = 0; ta[:] = 0
            elif in_batch:
                if c == 2 or c == 4: tb[idx] = qty
                elif c == 3 or c == 5: ta[idx] = qty
                if fl & 1:
                    bid[:] = tb; ask[:] = ta; in_batch = False; bb = -1; ba = -1
                    for k in range(SIZE - 1, -1, -1):
                        if bid[k] > 0: bb = k; break
                    for k in range(SIZE):
                        if ask[k] > 0: ba = k; break
            elif idx > 0 and idx < SIZE - 1:
                is_bid = (c == 2 or c == 4 or c == 6); is_ask = (c == 3 or c == 5 or c == 7)
                if not (is_bid or is_ask): continue
                newq = qty if (c != 6 and c != 7) else 0
                old = bid[idx] if is_bid else ask[idx]
                if is_bid: bid[idx] = newq
                else: ask[idx] = newq
                if is_bid:
                    if newq > 0 and idx > bb: bb = idx
                    elif newq == 0 and idx == bb:
                        while bb > 0 and bid[bb] == 0: bb -= 1
                        if bid[bb] == 0: bb = -1
                else:
                    if newq > 0 and (ba < 0 or idx < ba): ba = idx
                    elif newq == 0 and idx == ba:
                        lim = min(SIZE - 1, ba + 20000)
                        while ba < lim and ask[ba] == 0: ba += 1
                        if ask[ba] == 0: ba = -1
                if sec >= 0 and bb >= 0 and ba >= 0 and idx >= bb - 40 and idx <= ba + 40:
                    delta = newq - old
                    if is_t[idx] == 0: is_t[idx] = 1; touched[nt] = idx; nt += 1
                    if delta > 0: add[idx] += delta
                    elif delta < 0:
                        d = -delta; expl = 0
                        if t - rem_time[idx] <= TOL_US and rem_tr[idx] > 0:
                            expl = min(d, rem_tr[idx]); rem_tr[idx] -= expl
                        cancel = d - expl
                        if cancel > 0: pull[idx] += cancel; un_amt[idx] = cancel; un_time[idx] = t; un_sec[idx] = sec
        else:
            idx = int(round(t_px[j] * 4.0)); v = t_vol[j]; s = t_side[j]; j += 1
            if sec < 0 or idx <= 0 or idx >= SIZE - 1: continue
            if is_t[idx] == 0: is_t[idx] = 1; touched[nt] = idx; nt += 1
            trd[idx] += v; o_ntr[sec] += 1
            if s > 0: o_buy[sec] += v
            elif s < 0: o_sell[sec] += v
            rr = 0
            if un_amt[idx] > 0 and t - un_time[idx] <= TOL_US:
                rr = min(v, un_amt[idx]); un_amt[idx] -= rr
                if un_sec[idx] == sec: pull[idx] -= rr
            if t - rem_time[idx] > TOL_US: rem_tr[idx] = 0
            rem_tr[idx] += v - rr; rem_time[idx] = t
    return o_sz, o_pull, o_trd, o_add, o_bb, o_ba, o_buy, o_sell, o_ntr, cur

def extract(date, contract):
    dpath, spath = find_files(date, contract)
    if not dpath or not spath: return None, f'missing file (depth {dpath}, scid {spath})'
    t0 = sc_micros(date, 9, 30); t1 = sc_micros(date, 16, 0); nsec = int((t1 - t0) // 1_000_000)
    dm = np.memmap(dpath, dtype=DEPTH_DT, mode='r', offset=64); i0 = bsearch(dm, t0); lo = max(0, i0 - 3_000_000)
    seg = np.array(dm[lo:i0]); clr = np.where(seg['cmd'] == 1)[0]
    if len(clr) == 0: return None, 'no CLEAR_BOOK snapshot in the 3M records before 09:30'
    start = lo + int(clr[-1]); i1 = bsearch(dm, t1); D = np.array(dm[start:i1]); sm = np.memmap(spath, dtype=SCID_DT, mode='r', offset=56); a = bsearch(sm, t0 - 5_000_000); b = bsearch(sm, t1)
    T = np.array(sm[a:b]); ok = ((T['o'] == 0.0) | (np.abs(T['o'] - (-1.99900095e+37)) < 1e30) | (np.abs(T['o'] - (-1.99900197e+37)) < 1e30)) & (T['vol'] > 0) & (T['c'] > 0)
    T = T[ok]; side = np.where(T['askvol'] > T['bidvol'], 1, np.where(T['bidvol'] > T['askvol'], -1, 0)).astype(np.int8)
    res = kernel(D['dt'], D['cmd'], D['flags'], D['price'] / 100.0, D['qty'], T['dt'], (T['c'] / 100.0 if np.median(T['c']) > 1e6 else T['c'].astype(np.float64)), T['vol'].astype(np.int32), side, np.int64(t0), nsec)
    names = ['sz', 'pull', 'trd', 'add', 'bb', 'ba', 'buy', 'sell', 'ntr']; out = dict(zip(names, res[:9])); out['finalized'] = res[9]; return out, dict(depth_records=len(D), trades=len(T), nsec=nsec)

if __name__ == '__main__':
    date = sys.argv[1]; sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_tell_live'); import persist; conn = persist.connect(); contract = persist.contract_for(conn, date)
    out, info = extract(date, contract)
    if out is None: print(date, 'FAILED', info); sys.exit(2)
    np.savez_compressed(f'{OUT}/{date}.npz', **{k: v for k, v in out.items()}); print(date, contract, info, 'seconds with a book', int((out['bb'] >= 0).sum()))
