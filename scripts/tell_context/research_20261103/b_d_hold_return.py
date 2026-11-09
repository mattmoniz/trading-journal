"""Pre-registered test (docs/B_D_HOLD_OR_RETURN_PREREG_20261103.md, ledger family b_d_hold_return_20261103): after price closes outside the FROZEN value area of the profile 60 minutes earlier, does it HOLD outside or RETURN, and does that
tell a final multi-hump day (B-like) from a D? Descriptive on the explore window; uses only bars completed by the decision time T for the classification, final-profile labels (scratch/tell_context_20261103/b_d_formation_rows.json) as targets.
Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/b_d_hold_return.py   (ONE run; look logged first)"""
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hold_return_lib import *
from hold_return_lib import rng
ROWS = json.load(open(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'b_d_formation_rows.json')))
PRIMARY = dict(T=12.5, back=60, hold=30, mfac=1.0); TS = {'11:30': 11.5, '12:30': 12.5, '13:30': 13.5}
# ---- phase 1: classify every session at every decision time and print the counts + detectable effect BEFORE any outcome is read
S_ALL = {}
for p in sorted(glob.glob(ROOT + '/*.bars.tsv')):
    d = os.path.basename(p)[:10]
    if d > '2025-05-16' or d not in ROWS: continue
    S = load(p)
    if S: S_ALL[d] = S
D = sorted(S_ALL); C = {}
for name, T in TS.items(): C[name] = {d: classify(S_ALL[d], T, 60, 30, 1.0) for d in D}
print(len(D), 'sessions evaluated (explore); primary T=12:30, 60 min look-back, 30 min hold window, margin 1x median bar range')
for name in TS:
    c = [v['cls'] for v in C[name].values()]; print(f'  T={name}: HELD {c.count("HELD")}  RETURNED {c.count("RETURNED")}  STAYED {c.count("STAYED")}  not evaluable {c.count("NA")}')
nH, nR = [sum(v['cls'] == k for v in C['12:30'].values()) for k in ('HELD', 'RETURNED')]; mde = 2.8 * np.sqrt(0.34 * 0.66 * (1 / max(nH, 1) + 1 / max(nR, 1)))
print(f'  detectable risk difference at the primary (80 percent power, p=0.34): about {mde:.2f}  ->  ' + ('INCONCLUSIVE IN ADVANCE (above 0.25), no verdict will be drawn' if mde > 0.25 else 'testable (at or below 0.25)'))
# ---- phase 2: outcomes
bim = np.array([ROWS[d]['final']['bimod'] for d in ROWS]); q90, q25 = float(np.quantile(bim, .9)), float(np.quantile(bim, .25))
def target(d): return int(ROWS[d]['final']['bimod'] >= CUT)
def pack(name):
    rows = [dict(C[name][d], date=d, week=week(d), y=target(d)) for d in D if C[name][d]['cls'] in ('HELD', 'RETURNED')]
    cuts = np.quantile([r['exc'] for r in rows], [1 / 3, 2 / 3])                              # terciles of the excursion size over the departed sample (a feature known at T, no outcome)
    for r in rows: r['xb'] = int(np.searchsorted(cuts, r['exc']))
    return rows
def report(name, tag):
    rows = pack(name); ci = boot(rows, rd); p = perm(rows); st = boot(rows, mh); print(f'\n[{tag}] T={name}  HELD N={sum(r["cls"]=="HELD" for r in rows)} final-multi-hump {100*np.mean([r["y"] for r in rows if r["cls"]=="HELD"]):.0f}%   RETURNED N={sum(r["cls"]=="RETURNED" for r in rows)} {100*np.mean([r["y"] for r in rows if r["cls"]=="RETURNED"]):.0f}%')
    print(f'   flag-only stratified {mh(rows, key=lambda r: r["flag"]):+.3f}  excursion-only stratified {mh(rows, key=lambda r: r["xb"]):+.3f}\n   risk difference {rd(rows):+.3f}  week-block 95% CI [{ci[0]:+.3f}, {ci[1]:+.3f}]  permutation p {p:.3f}   | stratified by developing flag x excursion tercile: {mh(rows):+.3f} CI [{st[0]:+.3f}, {st[1]:+.3f}]')
    for sd in ('UP', 'DOWN'):
        r2 = [r for r in rows if r['side'] == sd]; print(f'   side {sd:4s}: N={len(r2)} (held {sum(r["cls"]=="HELD" for r in r2)})  risk difference {rd(r2):+.3f}')
    stay = [dict(C[name][d], y=target(d)) for d in D if C[name][d]['cls'] == 'STAYED']; print(f'   (for context: STAYED N={len(stay)} final multi-hump {100*np.mean([r["y"] for r in stay]):.0f}%; base {100*np.mean([target(d) for d in D]):.0f}%)')
    return rows, ci, p, st
rows, ci, p, st = report('12:30', 'PRIMARY')
ok = [rd(rows) >= 0.15, ci[0] > 0, p < 0.05, st[0] > 0 and mh(rows) >= 0.05]
print('\nPRIMARY conditions: (1) diff >= 0.15', ok[0], '(2) CI excludes 0', ok[1], '(3) permutation p < 0.05', ok[2], '(4) flag x excursion stratified diff >= 0.05 with CI excluding 0', ok[3])
r11, r13 = pack('11:30'), pack('13:30'); same = rd(r11) > 0 and rd(r13) > 0; sides = all(rd([r for r in rows if r['side'] == sd]) > 0 for sd in ('UP', 'DOWN'))
print('(5) same sign at 11:30 and 13:30:', same, '| both sides positive at 12:30:', sides, '=> ' + ('MEETS ALL PRE-REGISTERED CONDITIONS (a CANDIDATE only; sealed confirmation still required)' if (all(ok) and same and sides and mde <= 0.25) else 'NOT SHOWN' if mde <= 0.25 else 'INCONCLUSIVE'))
print('\nSECONDARY (counted)'); report('11:30', 'c'); report('13:30', 'd')
B = [d for d in D if ROWS[d]['final']['bimod'] >= q90]; Dd = [d for d in D if ROWS[d]['final']['bimod'] <= q25 and ROWS[d]['final']['letter'] == 'D']
for g, ds in (('strong B', B), ('strong D', Dd)):
    cl = [C['12:30'][d]['cls'] for d in ds]; dep = [c for c in cl if c in ('HELD', 'RETURNED')]; print(f'[a] {g}: N={len(ds)} departed {len(dep)} HELD {100*dep.count("HELD")/max(len(dep),1):.0f}% of departed; STAYED {cl.count("STAYED")}')
o = [(C['12:30'][d]['outside'], ROWS[d]['final']['bimod']) for d in D if 'outside' in C['12:30'][d]]; rk = lambda a: np.argsort(np.argsort(a)).astype(float)
print(f'[b] Spearman of outside-volume share with final bimodality at 12:30: {np.corrcoef(rk([x[0] for x in o]), rk([x[1] for x in o]))[0,1]:+.3f} (N={len(o)})')
print('\nROBUSTNESS GRID at T=12:30 (risk difference HELD minus RETURNED, N held/returned; NOT tests)')
for back, hold, mf in itertools.product((45, 60, 90), (20, 30, 45), (0.5, 1.0, 2.0)):
    cc = {d: classify(S_ALL[d], 12.5, back, hold, mf) for d in D}; rr = [dict(cc[d], y=target(d)) for d in D if cc[d]['cls'] in ('HELD', 'RETURNED')]
    print(f'  back {back:2d} hold {hold:2d} margin {mf:3.1f}x: diff {rd(rr):+.3f}  N {sum(r["cls"]=="HELD" for r in rr)}/{sum(r["cls"]=="RETURNED" for r in rr)}' + ('   <- primary' if (back, hold, mf) == (60, 30, 1.0) else ''))
