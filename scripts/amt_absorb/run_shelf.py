"""Shelf marks census + fidelity check (PREREG_SHELF.md). EXPLORE only. Usage: ../../venv/bin/python run_shelf.py"""
import sys, csv, numpy as np
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_80rule'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_absorb')
import engine as E, shelf as SH
SPLIT = '2025-05-16'
def hhmm(t): m = 570 + t; return f'{m // 60:02d}:{m % 60:02d}'
def mins(hm): return int(hm[:2]) * 60 + int(hm[3:]) - 570
G = {'2023-08-04': [('09:30', '10:07'), ('11:40', '12:05'), ('12:33', '13:10'), ('13:55', '14:24'), ('14:48', '15:13'), ('15:37', '15:56')],
     '2023-08-07': [('09:47', '10:02'), ('10:22', '10:53'), ('11:13', '11:47'), ('11:46', '12:17')],
     '2023-08-08': [('09:30', '09:56'), ('09:50', '10:10'), ('10:25', '10:52'), ('11:00', '11:21'), ('11:40', '12:11'), ('14:36', '15:03')],
     '2023-08-09': [('09:54', '10:19'), ('11:01', '11:34'), ('11:57', '12:25'), ('13:36', '14:04'), ('14:21', '15:12'), ('15:19', '15:48')],
     '2023-08-10': [('09:47', '10:53'), ('11:25', '11:54'), ('12:39', '12:57'), ('14:53', '15:29'), ('15:28', '15:47'), ('13:47', '14:07')]}
def run(ex, w):
    Rs = [SH.ranges(s['a'], w) for s in ex]; res = {}
    for si, s in enumerate(ex):
        thr = SH.thresholds(Rs, si, SH.Q, 20, w)
        if thr is None: continue
        res[s['d']] = SH.shelves(s['a'], Rs[si], thr, E.atr14(s['a']), w)
    return res
if __name__ == '__main__':
    raw = E.load_sessions(); allS = E.build_eligible(raw); ex = [s for s in allS if s['d'] <= SPLIT]
    for w in (SH.W, 15, 40):
        res = run(ex, w); sh = [x for v in res.values() for x in v]; dur = [x['t1'] - x['t0'] + 1 for x in sh]
        print(f"W={w}: sessions {len(res)}, shelves {len(sh)} ({len(sh) / max(1, len(res)):.2f}/session), sessions with >=1 {sum(1 for v in res.values() if v)}, box length min: median {np.median(dur):.0f}, p25 {np.percentile(dur, 25):.0f}, p75 {np.percentile(dur, 75):.0f}, p90 {np.percentile(dur, 90):.0f}")
        if w == SH.W:
            with open('shelves_explore.csv', 'w', newline='') as f:
                wr = csv.writer(f); wr.writerow(['date', 't0', 'tc', 't1', 'hi', 'lo', 'tries'])
                for d, v in res.items():
                    for x in v: wr.writerow([d, x['t0'], x['tc'], x['t1'], round(x['hi'], 2), round(x['lo'], 2), x['tries']])
            hit = 0; tot = 0; tol = 5
            for d, bs in G.items():
                for a_, b_ in bs:
                    a0, b0 = mins(a_), mins(b_); tot += 1; ov = [x for x in res.get(d, []) if not (x['t1'] < a0 - tol or x['t0'] > b0 + tol)]; hit += bool(ov)
                    print(f"  {d} {a_}-{b_}: " + (', '.join(f"shelf {hhmm(x['t0'])}-{hhmm(x['t1'])}" for x in ov) if ov else 'no shelf'))
            print(f'  user week-2 boxes overlapped by a shelf mark: {hit} of {tot}; shelf marks on those 5 days: {sum(len(res.get(d, [])) for d in G)}')
