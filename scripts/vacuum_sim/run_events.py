"""Event lists (NO outcomes) for the user's original idea. Usage: run_events.py            -> Explore history, counts per track/family/year, events.csv
                                                              run_events.py --day 2026-11-06 [--from 12:20 --to 13:05]  -> the events of one day (priors from the live prior store + tell bars), for the user's chart check"""
import sys, os, glob, csv, argparse, datetime
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import features as Fm
OUT = os.path.join(Fm.ROOT, 'scratch', 'vacuum_sim_20261108'); os.makedirs(OUT, exist_ok=True)

def et(s):
    t = int(s + 18 * 3600) % 86400; return f'{t // 3600:02d}:{t % 3600 // 60:02d}:{t % 60:02d}'

def run(paths, want_day=None):
    hist = {'RTH': [], 'GBX': []}; rows = []; nsess = {'RTH': 0, 'GBX': 0}; info = {}
    for p in paths:
        S = Fm.load_full(p)
        if S is None: continue
        for name, T in Fm.track_split(S).items():
            prev = hist[name][-Fm.K_PRIOR:]
            if len(prev) >= Fm.K_PRIOR or (want_day and S['date'] == want_day and len(prev) >= 15):
                PR = Fm.priors_of(prev); F = Fm.features(T, PR); ev = Fm.events(T, F); nsess[name] += 1
                for fam, k, d in ev:
                    rows.append(dict(date=S['date'], track=name, fam=fam, bar=k, end_sec=round(float(T['en'][k]), 3), t=et(T['en'][k]), dir=d, zr=round(float(F['zr'][k]), 2), zroc=round(float(F['zroc'][k]), 2),
                                     roc=round(float(F['roc'][k]), 1), dur=round(float(F['dur'][k]), 2), pace=round(float(F['pace'][k]), 3), close=float(T['c'][k])))
                if want_day and S['date'] == want_day: info = dict(T=T, F=F, n_prior=len(prev))
            hist[name].append(T)
    return rows, nsess, info

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--day'); ap.add_argument('--from', dest='tfrom'); ap.add_argument('--to', dest='tto'); a = ap.parse_args()
    if a.day:
        pri = sorted(glob.glob(os.path.join(Fm.ROOT, 'scratch', 'argon_vacuum_live', 'priors', '*.bars.tsv')))
        tell = os.path.join(Fm.ROOT, 'scratch', 'amt_tell_live', f'{a.day}.split.bars.tsv'); paths = [x for x in pri if os.path.basename(x)[:10] < a.day] + [tell]
        rows, ns, info = run(paths, want_day=a.day)
        rows = [r for r in rows if r['date'] == a.day]
        print(f'{a.day}: priors used {info.get("n_prior")} sessions; events (cooldown {Fm.COOL} bars/direction):')
        for r in sorted(rows, key=lambda r: r['end_sec']):
            if a.tfrom and not (a.tfrom <= r['t'][:5] <= (a.tto or '23:59')): continue
            print(f"  {r['t']} {r['track']} {r['fam']} {'LONG ' if r['dir'] == 1 else 'SHORT'} close {r['close']:.2f}  Zratio {r['zr']:5.2f} Zroc {r['zroc']:5.2f} ROC10 {r['roc']:7.1f} dur {r['dur']:6.1f}s pace-cdf {r['pace']:.2f}")
        sys.exit(0)
    paths = sorted(p for p in glob.glob(os.path.join(Fm.BARS, '*.bars.tsv')) if os.path.basename(p)[:10] <= Fm.LAST_EXPLORE)
    rows, ns, _ = run(paths)
    with open(os.path.join(OUT, 'events.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
    print(f'scored track-sessions: {ns}; events written: {len(rows)}')
    for tr in ('RTH', 'GBX'):
        print(f'== {tr}  ({ns[tr]} sessions)')
        for fam in Fm.FAMILIES:
            r = [x for x in rows if x['track'] == tr and x['fam'] == fam]; days = len({x["date"] for x in r})
            print(f'   {fam}: events {len(r):6d}  per session {len(r) / max(ns[tr], 1):.3f}  active days {days:4d}  long {sum(1 for x in r if x["dir"] == 1)} short {sum(1 for x in r if x["dir"] == -1)}')
        e2 = [x for x in rows if x['track'] == tr and x['fam'] == 'E2']
        if e2:
            pc = np.array([x['pace'] for x in e2]); pc = pc[~np.isnan(pc)]
            print(f'   E2 pace-cdf terciles: fast(<=1/3) {np.mean(pc <= 1 / 3):.2f} middle {np.mean((pc > 1 / 3) & (pc < 2 / 3)):.2f} slow(>=2/3) {np.mean(pc >= 2 / 3):.2f}; E2 with dur <= 15 s: {np.mean(np.array([x["dur"] for x in e2]) <= 15):.2f}')
