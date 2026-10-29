"""Spike exhaustion, marks only. Usage: ../../venv/bin/python run_spike.py"""
import sys, csv, numpy as np
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_80rule'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_exhaust')
import engine as E, spike as S
SPLIT = '2025-05-16'
def hhmm(t): m = 570 + t; return f'{m // 60:02d}:{m % 60:02d}'
def events_all(m=S.M, q=S.Q):
    raw = E.load_sessions(); allS = E.build_eligible(raw); ex = [s for s in allS if s['d'] <= SPLIT]
    stats = [S.thrust(s['a'], m) for s in ex]; res = {}
    for si, s in enumerate(ex):
        thr = S.thresholds(stats, si, q)
        if thr is None: continue
        res[s['d']] = S.detect(s['a'], stats[si], thr, m)
    return res
# user circles read off the screenshots (date, HH:MM, kind), +/- 5 minutes
CIRC = [('2023-05-18', '10:32', 'high'), ('2023-05-18', '13:23', 'high'), ('2023-05-18', '15:17', 'high'), ('2023-05-19', '09:43', 'high'), ('2023-05-19', '11:40', 'low'), ('2023-05-19', '12:22', 'high'), ('2023-05-19', '14:16', 'low'),
        ('2023-05-22', '10:12', 'low'), ('2023-05-22', '11:48', 'low'), ('2023-05-22', '12:34', 'low'), ('2023-05-23', '14:23', 'low'), ('2023-05-23', '15:20', 'low')]
def mins(hm): return int(hm[:2]) * 60 + int(hm[3:]) - 570
if __name__ == '__main__':
    for m, q in ((S.M, S.Q), (3, S.Q), (8, S.Q), (S.M, 65), (S.M, 85)):
        res = events_all(m, q); ev = [e for v in res.values() for e in v]
        print(f"M={m} Q={q}: sessions {len(res)}, events {len(ev)} ({len(ev) / max(1, len(res)):.2f}/session), strong {sum(e['strong'] for e in ev)}, weak {sum(not e['strong'] for e in ev)}, spike highs {sum(e['dir'] == -1 for e in ev)}, lows {sum(e['dir'] == 1 for e in ev)}, sessions with >=1 {sum(1 for v in res.values() if v)}")
        if (m, q) == (S.M, S.Q):
            with open('spikes_explore.csv', 'w', newline='') as f:
                w = csv.writer(f); w.writerow(['date', 'dir', 't', 'u', 'ext', 'base', 'strong'])
                for d, v in res.items():
                    for e in v: w.writerow([d, e['dir'], e['t'], e['u'], round(e['ext'], 2), round(e['base'], 2), int(e['strong'])])
            hits = 0
            for d, hm, kind in CIRC:
                tt = mins(hm); near = [e for e in res.get(d, []) if abs(e['t'] - tt) <= 5]; want = -1 if kind == 'high' else 1; ok = [e for e in near if e['dir'] == want]; hits += bool(ok)
                print(f"  circle {d} {hm} {kind}: " + (', '.join(f"MARK peak {hhmm(e['t'])} back {hhmm(e['u'])} {'STRONG' if e['strong'] else 'weak'}" for e in ok) if ok else 'no mark' + (f" (other-direction mark near: {[hhmm(e['t']) for e in near]})" if near else '')))
            print(f'  hit {hits} of {len(CIRC)}; marks on those 5 days: {sum(len(res.get(d, [])) for d in ["2023-05-18","2023-05-19","2023-05-22","2023-05-23","2023-05-24"])}')
