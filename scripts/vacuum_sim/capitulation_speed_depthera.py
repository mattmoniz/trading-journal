"""Row 44 amendment A2 (docs/CAPITULATION_SPEED_EXIT_PREREG_20261110.md): confirmation of the reversed RTH speed lead on the depth-era window 2026-06-15..2026-10-09.
Stages: count (outcome-blind) | run (only after the look is logged).
ONE pass over (1) explore (volbars500_full: builds the rolling extension and pace history exactly as rows 42 / 44; parity with those rows is asserted) and (2) the post-explore sessions (volbars500_holdout, BARS ONLY):
sessions before 2026-06-15 only update the priors (no events, no outcomes, nothing added to the rolling lists); sessions 2026-06-15..2026-10-09 produce climaxes with the cutoffs seeded from the last 600 explore values."""
import os, sys, csv, glob, json, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import capitulation_speed as CS
CR, G, Fm, v2, SH = CS.CR, CS.G, CS.Fm, CS.v2, CS.SH
TS = CR.TS
HOLD_DIR = os.path.join(G.ROOT, 'scratch', 'volbars500_holdout_20261103'); DEPTH_FROM, DEPTH_TO = '2026-06-15', '2026-10-09'
KEEP, MINH, LOCK = 600, 60, 30
OUT = os.path.join(G.ROOT, 'scratch', 'capitulation_speed_20261110')

def session_files():
    ex = sorted(p for p in glob.glob(os.path.join(Fm.BARS, '*.bars.tsv')) if os.path.basename(p)[:10] <= Fm.LAST_EXPLORE)
    post = sorted(p for p in glob.glob(os.path.join(HOLD_DIR, '*.bars.tsv')) if os.path.basename(p)[:10] <= DEPTH_TO)
    return [(p, 'explore') for p in ex] + [(p, 'post') for p in post]

def one_pass(outcomes):
    hist = {'RTH': [], 'GBX': []}; s1 = {'RTH': [], 'GBX': []}; ph = {'RTH': [], 'GBX': []}; prevS = None; rows = []; par = collections.Counter()
    for p, kind in session_files():
        S = Fm.load_full(p)
        if S is None: continue
        d = S['date']; tsp = Fm.track_split(S); close = Fm.EARLY_CLOSE if d in Fm.EARLY else Fm.CLOSE
        in_depth = kind == 'post' and DEPTH_FROM <= d <= DEPTH_TO; want = kind == 'explore' or in_depth
        if want:
            prs = {}
            for name in ('RTH', 'GBX'):
                prev = hist[name][-Fm.K_PRIOR:]
                if len(prev) >= Fm.K_PRIOR: prs[name] = Fm.priors_of(prev)
            if len(prs) == 2:
                rt = hist['RTH'][-20:]; adr20 = float(np.mean([T['h'].max() - T['l'].min() for T in rt])) if len(rt) >= 10 else None
                P, n0, reset = v2.continuous(prevS, S); n = len(P['c']); Fm.L_ROC = 10; F = v2.feats(P, n0, reset, prs, close); F['etr'] = Fm.ema(F['tr']); etr = F['etr']; en, st, o, h, l, c = P['en'], P['st'], P['o'], P['h'], P['l'], P['c']
                evs = TS.turn_events(P, n0, F, close, adr20); cuts = {tr: (float(np.percentile(s1[tr][-KEEP:], 67)) if len(s1[tr][-KEEP:]) >= MINH else None) for tr in ('RTH', 'GBX')}; lock = {'RTH': -1, 'GBX': -1}; newp = collections.defaultdict(list)
                for e in evs:
                    if e['kind'] != 'S1_SPIKE' or e['ext'] is None or np.isnan(e['ext']): continue
                    tr, a = e['track'], e['a']
                    if tr == 'GBX' and en[a] < 1800.0: continue
                    if cuts[tr] is None or e['ext'] < cuts[tr] or a < lock[tr]: continue
                    lock[tr] = a + LOCK
                    pw = F['pace'][max(a - 4, n0):a + 1]
                    if np.all(np.isnan(pw)): continue
                    pace5 = float(np.nanmin(pw)); newp[tr].append(pace5)
                    cut = float(np.percentile(ph[tr][-KEEP:], 100 / 3)) if len(ph[tr][-KEEP:]) >= MINH else None
                    if kind == 'explore':
                        par[(tr, 'climax')] += 1
                        if cut is not None: par[(tr, 'scored')] += 1; par[(tr, 'fast')] += int(pace5 <= cut)
                        continue
                    if cut is None: par[(tr, 'depth-noncut')] += 1; continue
                    r = dict(date=d, track=tr, dir=int(e['dir']), fast=int(pace5 <= cut), pace5=round(pace5, 4), dur_min5=float(np.nanmin(F['dur'][max(a - 4, n0):a + 1])))
                    if outcomes:
                        s = int(e['dir']); lim = G.LIM if tr == 'GBX' else close - 300.0
                        oc = SH.calc_outcome(en, o, h, l, c, a, s, float(etr[a]), lim, n, n0=n0); r['f0'] = None if (oc is None or isinstance(oc, tuple)) else oc['fwd']
                        j = next((q for q in range(a + 1, min(a + 60, n)) if st[q] >= en[a] + 7.0), None); r['f7'] = None
                        if j is not None and j - 1 > a - 1:
                            o7 = SH.calc_outcome(en, o, h, l, c, j - 1, s, float(etr[j - 1]), lim, n, n0=n0); r['f7'] = None if (o7 is None or isinstance(o7, tuple)) else o7['fwd']
                    rows.append(r)
                for e in evs:
                    if e['kind'] in ('S1_CLUSTER', 'S1_SPIKE') and e['ext'] is not None and not np.isnan(e['ext']): s1[e['track']].append(float(e['ext'])) if (kind == 'explore' or in_depth) else None
                for tr in ('RTH', 'GBX'): ph[tr] += newp[tr]
        for name, T in tsp.items(): hist[name].append(T)
        prevS = S
    return rows, par

def parity(par):
    assert par[('RTH', 'climax')] == 738 and par[('GBX', 'climax')] == 200, dict(par)
    assert par[('RTH', 'fast')] == 238 and par[('GBX', 'fast')] == 50 and par[('RTH', 'scored')] == 676, dict(par)
    print('parity with rows 42 / 44 on the explore pass: RTH 738 climaxes (676 scored, 238 extreme-fast), Globex 200 (50): OK')

def count():
    rows, par = one_pass(False); parity(par)
    print(f'DEPTH-ERA WINDOW {DEPTH_FROM}..{DEPTH_TO} (outcome-blind counts):')
    for tr in ('RTH', 'GBX'):
        r = [x for x in rows if x['track'] == tr]; f = [x for x in r if x['fast']]
        print(f'  {tr}: {len(r)} climaxes on {len({x["date"] for x in r})} days; extreme-fast {len(f)} on {len({x["date"] for x in f})} days; not fast {len(r) - len(f)}; gate (>= 100 extreme-fast on >= 60 days): {"MET" if len(f) >= 100 and len({x["date"] for x in f}) >= 60 else "NOT MET"}')
    return rows

def run():
    rows, par = one_pass(True); parity(par)
    for tr in ('RTH', 'GBX'):
        r = [x for x in rows if x['track'] == tr and x['f0'] is not None]; fa = [(x['date'], x['f0']) for x in r if x['fast']]; nf = [(x['date'], x['f0']) for x in r if not x['fast']]
        gate = len(fa) >= 100 and len({d for d, _ in fa}) >= 60
        print(f'\n{tr}: climaxes {len(r)}; extreme-fast {len(fa)} on {len({d for d, _ in fa})} days; gate {"MET" if gate else "NOT MET (inconclusive by power)"}')
        if not fa or not nf: continue
        mf = G.boot_mean(fa, 21); mn = G.boot_mean(nf, 22); d = G.boot_diff(fa, nf, 1600 if tr == 'RTH' else 1601)
        print(f'  CONTINUE pre-cost over 30 bars (entry Open[a+1]): extreme-fast {mf["mean"]:+.2f} [{mf["lo"]:+.2f}, {mf["hi"]:+.2f}] (N {mf["n"]}) | not fast {mn["mean"]:+.2f} [{mn["lo"]:+.2f}, {mn["hi"]:+.2f}] (N {mn["n"]}) | fast minus not fast D = {d["mean"]:+.2f} [{d["lo"]:+.2f}, {d["hi"]:+.2f}], one-sided p (D > 0) {d["p"]:.3f}')
        f7 = [(x['date'], x['f7']) for x in r if x['fast'] and x['f7'] is not None]; n7 = [(x['date'], x['f7']) for x in r if not x['fast'] and x['f7'] is not None]
        if f7 and n7: d7 = G.boot_diff(f7, n7, 23); print(f'  7 s delayed entry: fast {np.mean([v for _, v in f7]):+.2f} (N {len(f7)}) | not fast {np.mean([v for _, v in n7]):+.2f} (N {len(n7)}) | D7 = {d7["mean"]:+.2f} [{d7["lo"]:+.2f}, {d7["hi"]:+.2f}]')
        verdict = 'CONFIRMED' if gate and d['mean'] > 0 and d['p'] < 0.05 and f7 and np.mean([v for _, v in f7]) > np.mean([v for _, v in n7]) else ('KILLED' if gate and d['mean'] <= 0 else 'INCONCLUSIVE BY POWER' if not gate else 'NOT CONFIRMED')
        if tr == 'RTH': print(f'  PRE-REGISTERED VERDICT (RTH): {verdict}; the explore result was D = +10.37 [+4.81, +16.61] (extreme-fast +6.42, not fast -3.95)')
    json.dump(rows, open(os.path.join(OUT, 'depthera_rows.json'), 'w'))

if __name__ == '__main__':
    st = sys.argv[1] if len(sys.argv) > 1 else ''
    if st == 'count': count()
    elif st == 'run': run()
    else: print(__doc__)
