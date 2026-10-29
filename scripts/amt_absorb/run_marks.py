"""Marks only: run the frozen detector over the explore sessions. No outcomes. Usage: ../../venv/bin/python run_marks.py"""
import sys, csv, numpy as np
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_80rule'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_absorb')
import engine as E, absorb as A
SPLIT = '2025-05-16'
def hhmm(t): m = 570 + t; return f'{m // 60:02d}:{m % 60:02d}'
def events_all(k=A.K):
    raw = E.load_sessions(); allS = E.build_eligible(raw); ex = [s for s in allS if s['d'] <= SPLIT]
    stats = [A.window_stats(s['a'], k) for s in ex]; res = {}
    for si, s in enumerate(ex):
        thr = A.thresholds(stats, si, k)
        if thr is None: continue
        res[s['d']] = A.detect_both(s['a'], stats[si], thr, E.atr14(s['a']), k)
    return res, len(ex)
if __name__ == '__main__':
    for k in (A.K, 10, 40):
        res, n = events_all(k); ev = [e for v in res.values() for e in v]
        print(f"K={k}: sessions {len(res)}, events {len(ev)} ({len(ev) / max(1, len(res)):.2f}/session), strong {sum(e['strong'] for e in ev)}, weak {sum(not e['strong'] for e in ev)}, bullish {sum(e['dir'] == 1 for e in ev)}, bearish {sum(e['dir'] == -1 for e in ev)}, median tries {np.median([e['tries'] for e in ev]):.0f}, sessions with >=1 event {sum(1 for v in res.values() if v)}")
        if k == A.K:
            with open('events_explore.csv', 'w', newline='') as f:
                w = csv.writer(f); w.writerow(['date', 'dir', 't0', 't', 'u', 'wlo', 'whi', 'tries', 'strong'])
                for d, v in res.items():
                    for e in v: w.writerow([d, e['dir'], e['t0'], e['t'], e['u'], round(e['wlo'], 2), round(e['whi'], 2), e['tries'], int(e['strong'])])
            for d in ('2023-05-18',):
                print(d, 'events:', [(('STRONG ' if e['strong'] else 'weak ') + ('UP' if e['dir'] == 1 else 'DOWN'), f"window {hhmm(e['t0'])}-{hhmm(e['t'])}", f"leaves {hhmm(e['u'])}", f"range {e['wlo']:.1f}-{e['whi']:.1f}", f"tries {e['tries']}") for e in res.get(d, [])])
