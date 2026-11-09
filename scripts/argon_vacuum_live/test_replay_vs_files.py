"""Live-path replay test (design section tests): replay a COMPLETED session through the real shadow code path (tick file -> LiveSession -> bar-by-bar evaluate -> dry-run rows) and compare with the FILE path
(the saved split bars through the batch functions, same priors, same max_pb). Pass: identical trigger keys, entry_ref and risk for both arms. Usage: test_replay_vs_files.py DATE MIN_PRIORS"""
import sys, os, json, subprocess
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.abspath(os.path.join(HERE, '..', '..')); sys.path.insert(0, os.path.join(ROOT, 'scripts'))
import argon_vacuum_blind_funnel as M
d, minp = sys.argv[1], int(sys.argv[2]); out = os.path.join(ROOT, 'scratch', 'argon_vacuum_live', f'dry_{d}.json')
subprocess.run([sys.executable, '-I', os.path.join(HERE, 'shadow.py'), '--once-date', d, '--dry-out', out, '--min-priors', str(minp)], check=True, cwd=ROOT)
r = json.load(open(out)); PRI = os.path.join(ROOT, 'scratch', 'argon_vacuum_live', 'priors')
priors = [M.load_day(os.path.join(PRI, f'{x}.bars.tsv')) for x in r['priors']]
S = M.load_day(os.path.join(ROOT, 'scratch', 'amt_tell_live', f'{d}.split.bars.tsv'))
P = M.priors_for(priors); F = M.features(S, P); evc = M.run_fsm(S, F, P, r['max_pb'], False)[0]; evf = M.run_ffc(S, F)
want = {('CAND', k, dr): (round(float(S['c'][k]), 2), round(risk, 2)) for k, dr, risk in evc} | {('FFC', k, dr): (round(float(S['c'][k]), 2), None) for k, dr in evf}
got = {(x['arm'], x['bar'], x['dir']): (round(x['entry_ref'], 2), None if x['risk'] is None else round(x['risk'], 2)) for x in r['rows']}
print(f'{d}: live-path rth bars {r["n_rth"]} vs file bars {S["n"]}; live triggers {len(got)} (cand {sum(1 for k in got if k[0]=="CAND")}) file triggers {len(want)} (cand {sum(1 for k in want if k[0]=="CAND")})')
only_l = set(got) - set(want); only_f = set(want) - set(got); diff = {k for k in got if k in want and got[k] != want[k]}
print('only live', sorted(only_l)[:5], 'only file', sorted(only_f)[:5], 'value diffs', sorted(diff)[:5])
ok = r['n_rth'] == S['n'] and not only_l and not only_f and not diff
print('REPLAY TEST', 'PASS' if ok else 'FAIL'); sys.exit(0 if ok else 1)
