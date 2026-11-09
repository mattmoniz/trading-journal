"""No-lookahead / stateless-replay test for the live shadow (docs/ARGON_VACUUM_LIVE_SHADOW_DESIGN_20261108.md). For sample Explore sessions: evaluate the SAME functions the live path calls on the bars
completed so far (m = 1..n), record every trigger the first time it appears, and require (a) the first-seen set == the full-day batch set, (b) a trigger seen at bar m never changes or disappears when later
bars arrive (decision hash identical), (c) no trigger is ever seen BEFORE its own bar has completed. MUTATION: corrupt every bar after bar m0 and require that triggers at bars <= m0 do not change.
Usage: test_incremental.py [n_days=6] [seed=7]"""
import sys, os, glob, random, hashlib, json
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(HERE, '..'))
import numpy as np
import argon_vacuum_blind_funnel as M
MAX_PB = 20

def rows_of(S, m):
    return [(S['st'][i], S['en'][i], S['o'][i], S['h'][i], S['l'][i], S['c'][i], 500.0, 0.0, 0.0) for i in range(m)]

def sub(S, m):
    T = {k: (v[:m] if isinstance(v, np.ndarray) else v) for k, v in S.items()}; T['n'] = m; return T

def events(S, P):
    F = M.features(S, P); ev = M.run_fsm(S, F, P, MAX_PB, False)[0]; fv = M.run_ffc(S, F)
    return {('CAND', k, d): round(r, 2) for k, d, r in ev} | {('FFC', k, d): 0.0 for k, d in fv}

def main():
    n_days = int(sys.argv[1]) if len(sys.argv) > 1 else 6; seed = int(sys.argv[2]) if len(sys.argv) > 2 else 7
    files = sorted(f for f in glob.glob(M.BARS + '/*.bars.tsv') if os.path.basename(f)[:10] <= M.LAST_EXPLORE)
    days = [s for s in (M.load_day(f) for f in files) if s is not None]
    pos = {d['date']: i for i, d in enumerate(days)}
    trig_days = sorted({ln.split(',')[0] for ln in open(os.path.join(M.ROOT, 'scratch', 'argon_blind_funnel_20261108', 'triggers.csv')).read().split('\n')[1:] if ln})   # days where the batch count found setup triggers
    random.seed(seed); picks = sorted(pos[d] for d in random.sample(trig_days, n_days) if pos[d] >= M.K_PRIOR); bad = 0
    for i in picks:
        S = days[i]; P = M.priors_for(days[i - M.K_PRIOR:i]); full = events(S, P); seen = {}; viol = []
        for m in range(M.WARMUP + 1, S['n'] + 1):
            ev = events(sub(S, m), P)
            for key, v in ev.items():
                if key[1] >= m: viol.append(('future-bar', key))
                if key in seen and seen[key] != v: viol.append(('changed', key, seen[key], v))
                seen.setdefault(key, v)
            for key in list(seen):
                if key[1] < m and key not in ev: viol.append(('vanished', key))
        same = set(seen) == set(full) and all(seen[k] == full[k] for k in full)
        # mutation: corrupt every bar after m0 (a different future) and require the triggers up to m0 to be unchanged
        m0 = S['n'] // 2; T = {k: (v.copy() if isinstance(v, np.ndarray) else v) for k, v in S.items()}
        rng = np.random.default_rng(1); j = np.arange(m0, S['n'])
        T['c'][j] += rng.normal(0, 40, len(j)); T['h'][j] = np.maximum(T['h'][j], T['c'][j]) + 3; T['l'][j] = np.minimum(T['l'][j], T['c'][j]) - 3
        mut = {k: v for k, v in events(T, P).items() if k[1] < m0}; base = {k: v for k, v in full.items() if k[1] < m0}
        mut_ok = mut == base
        ok = same and not viol and mut_ok; bad += (not ok)
        print(f"{S['date']} bars {S['n']} cand {sum(1 for k in full if k[0] == 'CAND')} ffc {sum(1 for k in full if k[0] == 'FFC')} first-seen==batch {same} violations {len(viol)} mutation-stable {mut_ok} -> {'PASS' if ok else 'FAIL'}", flush=True)
        if viol: print('   ', viol[:4])
    print('TEST', 'PASS' if bad == 0 else f'FAIL ({bad} days)')
    sys.exit(1 if bad else 0)

if __name__ == '__main__': main()
