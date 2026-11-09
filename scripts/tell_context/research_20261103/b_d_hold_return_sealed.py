"""SEALED / confirmation run of the 13:30 hold-or-return test (docs/B_D_HOLD_OR_RETURN_1330_SEALED_PREREG_20261103.md). Two phases, called by b_d_hold_return_sealed.mjs which spends the sealed look between them:
  --phase1  classify every eligible session (no target is read) and print the counts, exclusions and the detectable-effect line; exit code 3 = INCONCLUSIVE IN ADVANCE (the look is then NOT spent)
  --phase2  read the final-profile targets and print the pre-registered verdict
Window: --window sealed (scratch/volbars500_holdout_20261103) or explore (the regression check against ledger look 120's 13:30 secondary)."""
import os, sys, glob, json, argparse
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hold_return_lib as L
ap = argparse.ArgumentParser(); ap.add_argument('--phase', type=int, required=True); ap.add_argument('--window', default='sealed'); a = ap.parse_args()
DIR = os.path.join(L.REPO, 'scratch', 'volbars500_holdout_20261103') if a.window == 'sealed' else L.ROOT
LAST_EXPLORE = '2025-05-16'; EARLIEST_LAST_BAR = L.secs(15.0)             # frozen eligibility: a full session has RTH bars completing at or after 15:00 ET (drops early closes, where 13:30 is after the close)
BASE_P, MDE_LIMIT = 0.34, 0.25
T_PRIMARY, T_SEC = 13.5, (12.5, 11.5)
S, skipped = {}, {'short_or_early_close': 0}
for p in sorted(glob.glob(DIR + '/*.bars.tsv')):
    d = os.path.basename(p)[:10]
    if (a.window == 'sealed') != (d > LAST_EXPLORE): continue
    x = L.load(p)
    if x is None: skipped['short_or_early_close'] += 1; continue
    if x['end'][-1] < EARLIEST_LAST_BAR: skipped['short_or_early_close'] += 1; continue
    S[d] = x
D = sorted(S); C = {T: {d: L.classify(S[d], T, 60, 30, 1.0) for d in D} for T in (T_PRIMARY,) + T_SEC}
cnt = lambda T, k: sum(v['cls'] == k for v in C[T].values())
print(f'window {a.window}: {len(D)} eligible sessions ({D[0]}..{D[-1]}); excluded as short/early-close: {skipped["short_or_early_close"]}')
for T in (T_PRIMARY,) + T_SEC: print(f'  T={int(T)}:{int(round((T % 1) * 60)):02d}: HELD {cnt(T, "HELD")}  RETURNED {cnt(T, "RETURNED")}  STAYED {cnt(T, "STAYED")}  not evaluable {cnt(T, "NA")}')
nH, nR = cnt(T_PRIMARY, 'HELD'), cnt(T_PRIMARY, 'RETURNED'); mde = 2.8 * np.sqrt(BASE_P * (1 - BASE_P) * (1 / max(nH, 1) + 1 / max(nR, 1)))
print(f'  detectable risk difference at the primary (80 percent power, p={BASE_P}): about {mde:.2f}  ->  ' + ('INCONCLUSIVE IN ADVANCE (above 0.25): the sealed look will NOT be spent' if mde > MDE_LIMIT else 'testable'))
if a.phase == 1: sys.exit(3 if mde > MDE_LIMIT else 0)
ROWS = json.load(open(os.path.join(L.REPO, 'scratch', 'tell_context_20261103', 'b_d_formation_rows.json')))
bim = np.array([ROWS[d]['final']['bimod'] for d in ROWS]); q90, q25 = float(np.quantile(bim, .9)), float(np.quantile(bim, .25))      # cuts FROZEN from the explore window
FIN = {}
for d in D:
    x = S[d]; f = L.PS.features(x['px'], x['vol']); FIN[d] = (f['bimod'], L.PS.letter(f['va_mid'])) if f else None
D = [d for d in D if FIN[d]]; target = lambda d: int(FIN[d][0] >= L.CUT)
print(f'\nfinal multi-hump base rate in this window: {100*np.mean([target(d) for d in D]):.0f}% (explore 34%); cuts frozen from explore: multi-hump {L.CUT}, strong-B {q90:.2f}, strong-D {q25:.2f}')
def one(T, tag):
    rows = L.pack_rows(C[T], D, target); h = [r['y'] for r in rows if r['cls'] == 'HELD']; t = [r['y'] for r in rows if r['cls'] == 'RETURNED']
    ci = L.boot(rows, L.rd); p = L.perm(rows); st = L.boot(rows, L.mh)
    print(f'\n[{tag}] T={int(T)}:{int(round((T % 1) * 60)):02d}  HELD N={len(h)} multi-hump {100*np.mean(h):.0f}%   RETURNED N={len(t)} {100*np.mean(t):.0f}%   risk difference {L.rd(rows):+.3f} CI [{ci[0]:+.3f}, {ci[1]:+.3f}]  permutation p {p:.3f}')
    print(f'   stratified (developing flag x excursion tercile) {L.mh(rows):+.3f} CI [{st[0]:+.3f}, {st[1]:+.3f}]   flag-only {L.mh(rows, key=lambda r: r["flag"]):+.3f}   excursion-only {L.mh(rows, key=lambda r: r["xb"]):+.3f}')
    side = {sd: L.rd([r for r in rows if r['side'] == sd]) for sd in ('UP', 'DOWN')}; print('   sides: ' + '  '.join(f'{k} {v:+.3f} (N={sum(r["side"]==k for r in rows)})' for k, v in side.items()))
    return rows, ci, p, st, side
rows, ci, p, st, side = one(T_PRIMARY, 'PRIMARY')
ok = dict(diff_ge_015=L.rd(rows) >= 0.15, ci_excludes_0=ci[0] > 0, perm_p=p < 0.05, strat_ge_005_ci=(st[0] > 0 and L.mh(rows) >= 0.05), both_sides=all(v > 0 for v in side.values()))
print('\nPRIMARY conditions:', ok); print('=> ' + (f'CONFIRMED on the {a.window} window (all five pre-registered conditions met)' + (' - this was the one sealed look' if a.window == 'sealed' else ' - regression check only, NOT a confirmation') if all(ok.values()) else f'NOT CONFIRMED on the {a.window} window (failed: ' + ', '.join(k for k, v in ok.items() if not v) + ')'))
print('\nSECONDARY (counted, cannot change the verdict)')
r2 = one(T_SEC[0], 'a'); r3 = one(T_SEC[1], 'b')
print(f'\n[c] monotone in the clock (13:30 > 12:30 > 11:30)? {L.rd(rows):+.3f} > {L.rd(r2[0]):+.3f} > {L.rd(r3[0]):+.3f}: {L.rd(rows) > L.rd(r2[0]) > L.rd(r3[0])}')
B = [d for d in D if FIN[d][0] >= q90]; Dd = [d for d in D if FIN[d][0] <= q25 and FIN[d][1] == 'D']
for g, ds in (('strong B', B), ('strong D', Dd)):
    cl = [C[T_PRIMARY][d]['cls'] for d in ds]; dep = [c for c in cl if c in ('HELD', 'RETURNED')]; print(f'[d] {g}: N={len(ds)} departed {len(dep)} HELD {100*dep.count("HELD")/max(len(dep),1):.0f}% of departed; STAYED {cl.count("STAYED")}')
