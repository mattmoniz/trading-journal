import struct
import datetime
import math
import os
import json
import bisect
import numpy as np
from zoneinfo import ZoneInfo
from collections import defaultdict

SCID_FILE = '/home/mmoniz/trading-journal/scratch/NQU6.CME.scid'
FIRST_INT = 4252016377
LAST_INT = 4252016385
TICK = 0.25
UTC = ZoneInfo('UTC')
ET = ZoneInfo('America/New_York')

# ---------------------------------------------------------
# JS PORT
# ---------------------------------------------------------
def _round(p):
    return math.floor(p / TICK + 0.5) * TICK

def compute_profile(bars):
    if not bars:
        return None
    vol_map = {}
    for b in bars:
        h, l, v = b["high"], b["low"], b["volume"]
        if not (h >= l):
            continue
        levels = max(1, round((h - l) / TICK) + 1)
        vpl = v / levels
        p = l
        while p <= h + TICK / 2:
            lvl = _round(p)
            vol_map[lvl] = vol_map.get(lvl, 0.0) + vpl
            p += TICK
    entries = sorted(
        [{"price": float(p), "volume": v} for p, v in vol_map.items()],
        key=lambda e: e["price"],
    )
    if len(entries) < 3:
        return None
    total_vol = sum(e["volume"] for e in entries)
    max_vol = max(e["volume"] for e in entries)
    poc_idx = next(i for i, e in enumerate(entries) if e["volume"] == max_vol)
    va_vol = entries[poc_idx]["volume"]
    up_i = poc_idx + 1
    dn_i = poc_idx - 1
    while va_vol < total_vol * 0.70 and (up_i < len(entries) or dn_i >= 0):
        up_add = entries[up_i]["volume"] if up_i < len(entries) else 0.0
        dn_add = entries[dn_i]["volume"] if dn_i >= 0 else 0.0
        if up_add >= dn_add and up_i < len(entries):
            va_vol += up_add; up_i += 1
        elif dn_i >= 0:
            va_vol += dn_add; dn_i -= 1
        else:
            va_vol += up_add; up_i += 1
    vah = entries[up_i - 1]["price"] if (up_i - 1) >= 0 else entries[poc_idx]["price"]
    val = entries[dn_i + 1]["price"] if (dn_i + 1) < len(entries) else entries[poc_idx]["price"]
    return {"poc": entries[poc_idx]["price"], "vah": vah, "val": val,
            "maxVol": max_vol, "totalVol": total_vol, "entries": entries}

def med50(profile):
    entries = profile["entries"]
    half = profile["totalVol"] / 2.0
    cum = 0.0
    for e in entries:
        cum += e["volume"]
        if cum >= half:
            return e["price"]
    return entries[-1]["price"]

class IncrementalProfile:
    def __init__(self):
        self.vol_map = {}
        self.total_vol = 0.0
    def add(self, price, vol):
        lvl = _round(price)
        self.vol_map[lvl] = self.vol_map.get(lvl, 0.0) + vol
        self.total_vol += vol
    def get_stats(self):
        if not self.vol_map: return None, None
        entries = sorted([{"price": float(p), "volume": v} for p, v in self.vol_map.items()], key=lambda e: e["price"])
        if len(entries) < 3: return None, None
        max_vol = -1
        poc_price = None
        for e in entries:
            if e["volume"] > max_vol:
                max_vol = e["volume"]
                poc_price = e["price"]
        
        half = self.total_vol / 2.0
        cum = 0.0
        med50_price = entries[-1]["price"]
        for e in entries:
            cum += e["volume"]
            if cum >= half:
                med50_price = e["price"]
                break
        return poc_price, med50_price

# ---------------------------------------------------------
# PARSER
# ---------------------------------------------------------
def parse_scid(filepath):
    print("Parsing SCID...")
    total_raw_vol = 0
    total_parent_vol = 0
    sessions = defaultdict(lambda: {'globex': [], 'rth': []})
    
    with open(filepath, 'rb') as f:
        header = f.read(56)
        header_size = struct.unpack('<I', header[4:8])[0]
        f.seek(header_size)
        
        chunk_size = 40 * 500000
        record_struct = struct.Struct('<qffffIIII')
        
        in_run = False
        run_vol = 0
        
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            num_records = len(chunk) // 40
            for dt_ms, op, hi, lo, cl, num_trades, tot_vol, bid_vol, ask_vol in record_struct.iter_unpack(chunk[:num_records*40]):
                op_int = struct.unpack('<I', struct.pack('<f', op))[0]
                price_points = cl / 100.0 if cl > 100000 else cl
                
                dt_utc = datetime.datetime(1899, 12, 30, tzinfo=UTC) + datetime.timedelta(microseconds=dt_ms)
                et_dt = dt_utc.astimezone(ET)
                hour = et_dt.hour
                minuteOfDay = hour * 60 + et_dt.minute
                
                if hour >= 18:
                    session_date = (et_dt.date() + datetime.timedelta(days=1)).strftime('%Y-%m-%d')
                else:
                    session_date = et_dt.date().strftime('%Y-%m-%d')
                    
                leg = None
                if hour >= 18 or minuteOfDay < 570:
                    leg = 'globex'
                elif 570 <= minuteOfDay <= 959:
                    leg = 'rth'
                    
                total_raw_vol += tot_vol
                is_boundary = False
                
                if op_int == FIRST_INT:
                    in_run = True
                    run_vol = tot_vol
                elif in_run:
                    run_vol += tot_vol
                    if op_int == LAST_INT:
                        in_run = False
                        is_boundary = True
                        total_parent_vol += run_vol
                else:
                    is_boundary = True
                    total_parent_vol += tot_vol
                    
                if leg:
                    sessions[session_date][leg].append({
                        'ts': et_dt,
                        'price': price_points,
                        'vol': tot_vol,
                        'is_boundary': is_boundary
                    })
                    
    print(f"Volume conservation: raw={total_raw_vol} parent={total_parent_vol}")
    if total_raw_vol != total_parent_vol:
        raise ValueError("Kill Criterion K7 (Parse positive control) FAILED: Volume conservation broken.")
    return sessions

# ---------------------------------------------------------
# MAIN
# ---------------------------------------------------------
# PERFORMANCE NOTE (Claude, 2026-08-23): the original version of this script called
# compute_profile() on the FULL growing tick slice at every one of ~700-1000
# volume-bar checkpoints per session -- O(N^2) in tick count per session, and
# get_baseline() re-streamed every train session's bars plus did an O(N) linear
# timestamp scan on every call. On real tick volumes (tens of thousands of ticks/
# session) this did not finish -- the prior dispatch's own timeout is consistent
# with this. Fixed by using IncrementalProfile (already defined above, O(1) amortized
# add(), only get_stats()'s sort scales with distinct PRICE LEVELS not tick count --
# ~1000s not ~10000s+) for the whole pipeline, not just the flip-diagnostic, and by
# precomputing volume-bar checkpoints and a bisect-able forward-return lookup ONCE
# per date instead of recomputing inside every downstream call. IncrementalProfile is
# mathematically equivalent to compute_profile()+med50() here because every entry in
# this script is a real per-trade print with high==low==price, which makes
# compute_profile's H-L-spread loop a single-iteration no-op (levels=1, vpl=v) --
# verified by inspection before relying on it, not assumed.
V = 500
H_PRIMARY = 15
BUCKETS = [0, 25000, 50000, 100000, 200000, 400000, float('inf')]

def get_bucket(cum_vol):
    for i in range(len(BUCKETS) - 1):
        if BUCKETS[i] <= cum_vol < BUCKETS[i + 1]:
            return i
    return len(BUCKETS) - 2

def main():
    sessions = parse_scid(SCID_FILE)
    sorted_dates = sorted(list(sessions.keys()))
    print(f"Loaded {len(sorted_dates)} sessions.")

    flip_stats = []
    date_checkpoints = {}   # date -> [{idx, close_ts, close_price, cum_vol, d50, dpoc}]
    date_ts_price = {}      # date -> (sorted_epoch_list, price_list) for forward-return lookup

    print("Single incremental pass per session: flip-magnitude diagnostic + volume-bar checkpoints...")
    for date in sorted_dates:
        globex = sessions[date]['globex']
        rth = sessions[date]['rth']
        if not globex or not rth:
            continue

        merged = IncrementalProfile()
        for r in globex:
            merged.add(r['price'], r['vol'])
        last_poc, last_med50 = merged.get_stats()

        rth_prof = IncrementalProfile()
        checkpoints = []
        bar_close = None
        bar_vol = 0
        cum_vol = 0
        max_dpoc, max_dmed = 0.0, 0.0

        for r in rth:
            price, vol = r['price'], r['vol']
            rth_prof.add(price, vol)
            merged.add(price, vol)
            bar_close = price
            bar_vol += vol
            cum_vol += vol

            # PERFORMANCE NOTE: get_stats() sorts all distinct price levels seen so far
            # (O(M log M), M ~ 1000s) -- calling it at EVERY boundary print (~200-250k/
            # session, confirmed via the unbundling count: 18.8M parent prints / 60
            # sessions) is computationally intractable in pure Python (estimated 10s of
            # billions of ops across the pilot). Throttled to the same cadence as the
            # volume-bar checkpoint (every V=500 contracts) for BOTH the flip-diagnostic
            # and the checkpoint recording -- still frequent enough to catch large flips
            # (the 309pt jump found in the 1-min pilot happened well within a single
            # 500-contract window), just not literally every single print. Documented
            # deviation from the design review's "every print" wording, made for
            # measured performance reasons, not silently.
            if r['is_boundary'] and bar_vol >= V:
                poc_rth, med_rth = rth_prof.get_stats()
                poc_24, med_24 = merged.get_stats()

                if poc_24 is not None and last_poc is not None:
                    max_dpoc = max(max_dpoc, abs(poc_24 - last_poc))
                    max_dmed = max(max_dmed, abs(med_24 - last_med50))
                    last_poc, last_med50 = poc_24, med_24

                if poc_rth is not None and poc_24 is not None:
                    checkpoints.append({
                        'idx': len(checkpoints), 'close_ts': r['ts'], 'close_price': bar_close,
                        'cum_vol': cum_vol,
                        'd50': abs(med_rth - med_24), 'dpoc': abs(poc_rth - poc_24),
                    })
                bar_vol = 0

        flip_stats.append((date, max_dpoc, max_dmed))
        date_checkpoints[date] = checkpoints
        date_ts_price[date] = ([r['ts'].timestamp() for r in rth], [r['price'] for r in rth])

    pocs = [x[1] for x in flip_stats]
    meds = [x[2] for x in flip_stats]
    dpoc_p50 = np.median(pocs) if pocs else 0
    dpoc_p95 = np.percentile(pocs, 95) if pocs else 0
    dmed_p50 = np.median(meds) if meds else 0
    dmed_p95 = np.percentile(meds, 95) if meds else 0
    print(f"Flip-Magnitude: max_dpoc p50={dpoc_p50:.2f}, p95={dpoc_p95:.2f}")
    print(f"Flip-Magnitude: max_dmed p50={dmed_p50:.2f}, p95={dmed_p95:.2f}")

    train_dates = sorted_dates[:int(len(sorted_dates) * 0.7)]
    test_dates = sorted_dates[int(len(sorted_dates) * 0.7):]

    def get_forward_return_fast(date, start_ts, H_minutes):
        target_ts = start_ts + datetime.timedelta(minutes=H_minutes)
        if target_ts.hour * 60 + target_ts.minute > 959:
            return None
        ts_list, price_list = date_ts_price.get(date, ([], []))
        if not ts_list:
            return None
        idx = bisect.bisect_right(ts_list, target_ts.timestamp()) - 1
        return price_list[idx] if idx >= 0 else None

    print("Phase 1: Calibrate thresholds on train")
    bucket_d50s = defaultdict(list)
    for date in train_dates:
        for ck in date_checkpoints.get(date, []):
            bucket_d50s[get_bucket(ck['cum_vol'])].append(ck['d50'])
    theta = {}
    for i in range(len(BUCKETS) - 1):
        theta[i] = max(TICK, np.percentile(bucket_d50s[i], 25)) if bucket_d50s[i] else TICK
    print(f"Thresholds by bucket: {theta}")

    print("Phase 2: Volume-matched baselines from train")
    def get_baseline(cum_vol_target, H_minutes):
        rets = []
        for date in train_dates:
            for ck in date_checkpoints.get(date, []):
                if ck['cum_vol'] >= cum_vol_target:
                    ret_price = get_forward_return_fast(date, ck['close_ts'], H_minutes)
                    if ret_price is not None:
                        rets.append(ret_price - ck['close_price'])
                    break
        return np.mean(rets) if rets else 0.0

    print("Phase 3: Measure test edge")
    results = []
    for date in test_dates:
        tau_ck = None
        for ck in date_checkpoints.get(date, []):
            if ck['idx'] < 10:
                continue
            if ck['d50'] <= theta[get_bucket(ck['cum_vol'])]:
                tau_ck = ck
                break

        if tau_ck:
            ret15_price = get_forward_return_fast(date, tau_ck['close_ts'], H_PRIMARY)
            if ret15_price is not None:
                ret15 = ret15_price - tau_ck['close_price']
                mu = get_baseline(tau_ck['cum_vol'], H_PRIMARY)
                delta = ret15 - mu
                results.append({
                    'date': date, 'tau': tau_ck['idx'], 'cum_vol': tau_ck['cum_vol'],
                    'd50': tau_ck['d50'], 'dpoc': tau_ck['dpoc'],
                    'ret15': ret15, 'baseline': mu, 'delta': delta,
                    'bucket': get_bucket(tau_ck['cum_vol']),
                })

    if len(results) > 0:
        deltas = [r['delta'] for r in results]
        mean_delta = np.mean(deltas)
        std_delta = np.std(deltas)
        se = std_delta / math.sqrt(len(deltas))
        t_stat = mean_delta / se if se > 0 else 0
        print(f"Test events: {len(results)}")
        print(f"Mean delta: {mean_delta:.4f}, SE: {se:.4f}, t-stat: {t_stat:.2f}")
    else:
        print("No test events.")
        
    out_path = '/home/mmoniz/trading-journal/scratch/poc_convergence_results.json'
    with open(out_path, 'w') as f:
        # custom converter for json serialization of np types
        def default_conv(o):
            if isinstance(o, (np.int64, np.int32, np.int16, np.int8)): return int(o)
            if isinstance(o, (np.float64, np.float32, np.float16)): return float(o)
            raise TypeError
        json.dump({
            'flip_stats': flip_stats,
            'results': results
        }, f, indent=2, default=default_conv)

if __name__ == '__main__':
    main()
