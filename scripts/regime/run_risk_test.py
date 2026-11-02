"""Regime gauge vs the $2k trailing-floor risk test (docs/REGIME_RISK_TEST_PREREG_20261102.md). READS OUTCOMES -> look 102 logged first. Explore minute bars only (<= 2025-04-02).
Usage: nice -n 15 ./venv/bin/python3 scripts/regime/run_risk_test.py"""
import json, sys
import numpy as np
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/regime')
import regime_lib as RL, risk_sim as R
SEED = 20261102; ROOT = '/home/mmoniz/trading-journal'
J = json.load(open(f'{ROOT}/scratch/range_budget_bars_20261102.json'))
conn = RL.connect(); p, cut, rows, done, preds = RL.live_model(conn); conn.close()
d = [r for r in done if r['date'] in preds]; pr = np.array([preds[r['date']] for r in d]); dates = [r['date'] for r in d]
lab = {}; onr = np.array([(r['raw']['h'] - r['raw']['l']) / r['atr'] for r in d]); lab_on = {}
for k, r in enumerate(d):
    if k < 60: continue
    v = pr[max(0, k - 250):k]; lab[r['date']] = RL.bucket(pr[k], dict(q33=float(np.quantile(v, 1 / 3)), q67=float(np.quantile(v, 2 / 3))))
    w = onr[max(0, k - 250):k]; lab_on[r['date']] = 'QUIET' if onr[k] <= np.quantile(w, 1 / 3) else ('BUSY' if onr[k] >= np.quantile(w, 2 / 3) else 'NORMAL')
days = [x for x in J['dates'] if x in lab]; bars = [J['bars'][x] for x in days]; bucket = np.array([lab[x] for x in days]); busy = bucket == 'BUSY'; quiet = bucket == 'QUIET'
bucket_on = np.array([lab_on[x] for x in days]); ND = len(days)
print(f'evaluated explore days {ND} ({days[0]}..{days[-1]}); BUSY {int(busy.sum())}, NORMAL {int((bucket == "NORMAL").sum())}, QUIET {int(quiet.sum())}')
adv0, fin0 = R.windows(bars, 0.0)
mae_d = adv0.mean(axis=(1, 2)); sd2_d = (fin0 ** 2).sum(axis=1).mean(axis=1)          # per-day mean max adverse excursion; per-day mean squared sum of window moves over the two directions
def ratio(x, bz, qz, f): return f(x[bz]) / f(x[qz])
fT1 = lambda v: float(np.mean(v)); fT2 = lambda v: float(np.sqrt(np.mean(v)))
def test_ratio(x, f, lab_b, lab_q, name):
    rng = np.random.default_rng(SEED); obs = ratio(x, lab_b, lab_q, f); bs = []
    for _ in range(3000):
        i = rng.integers(0, ND, ND); b, q = lab_b[i], lab_q[i]; bs.append(ratio(x[i], b, q, f) if b.any() and q.any() else np.nan)
    lo, hi = np.nanpercentile(bs, [2.5, 97.5]); pl = []
    for _ in range(1000):
        s = int(rng.integers(1, ND)); pl.append(ratio(x, np.roll(lab_b, s), np.roll(lab_q, s), f))
    pl = np.array(pl); pp = float(np.mean(np.abs(np.log(pl)) >= abs(np.log(obs)))); h = ND // 2
    halves = [ratio(x[:h], lab_b[:h], lab_q[:h], f), ratio(x[h:], lab_b[h:], lab_q[h:], f)]
    return dict(name=name, obs=obs, lo=float(lo), hi=float(hi), p=pp, halves=halves, ok_sign=all(v > 1 for v in halves) if obs > 1 else all(v < 1 for v in halves))
print(f'\nRESOLUTION (before any verdict): day-blocked bootstrap CI half-widths on the BUSY/QUIET ratios are printed with each ratio below; days per extreme bucket {int(busy.sum())} / {int(quiet.sum())}; the paired pass-share CI is +/-1.96 SD/sqrt(40) over 40 pools of 500 paths.')
t1 = test_ratio(mae_d, fT1, busy, quiet, 'T1 mean max adverse excursion'); t2 = test_ratio(sd2_d, fT2, busy, quiet, 'T2 daily random-direction P&L SD')
# gate: C0 at E = 0 must reproduce theory exp(-T/D) = 22.3 percent +/- 4 before any arm is read
adv_e, fin_e = {}, {}
for E in (0, 10, 25): adv_e[E], fin_e[E] = R.windows(bars, ((E / R.K) + R.COST) / 2)
arms = list(R.ARMS); out0, med0 = R.run_arms(adv_e[0], fin_e[0], busy, ['C0'], seed=SEED)
gate = 100 * out0['C0'][:, 0].mean(); print(f'\nGATE: C0 pass share at E = 0 is {gate:.1f} percent (theory 22.3 +/- 4)')
if abs(gate - 22.3) > 4: print('GATE FAILED: simulator does not reproduce the driftless pass odds; stopping before any arm is read'); sys.exit(1)
print('\n== T1 / T2: do BUSY-gauge days really swing more? ==')
for t in (t1, t2): print(f'{t["name"]}: BUSY/QUIET ratio {t["obs"]:.3f}  CI [{t["lo"]:.3f}, {t["hi"]:.3f}]  placebo p {t["p"]:.3f}  halves {t["halves"][0]:.3f} / {t["halves"][1]:.3f}  same sign both halves: {t["ok_sign"]}')
print(f'  context: mean max adverse of a random-direction window trade: BUSY {mae_d[busy].mean():.1f} pts, NORMAL {mae_d[bucket == "NORMAL"].mean():.1f}, QUIET {mae_d[quiet].mean():.1f}; daily SD proxy BUSY {fT2(sd2_d[busy]):.0f} pts, QUIET {fT2(sd2_d[quiet]):.0f}')
b2 = bucket_on == 'BUSY'; q2 = bucket_on == 'QUIET'
for nm, x, f in (('T1', mae_d, fT1), ('T2', sd2_d, fT2)): print(f'  UNCOUNTED baseline (buckets from the overnight range alone): {nm} ratio {ratio(x, b2, q2, f):.3f}')
yr = np.array([x[:4] for x in days])
for y in sorted(set(yr)):
    m = yr == y
    if (m & busy).sum() >= 10 and (m & quiet).sum() >= 10: print(f'  by year {y}: T1 ratio {ratio(mae_d, busy & m, quiet & m, fT1):.3f} (BUSY {(m & busy).sum()} / QUIET {(m & quiet).sum()} days)')
def block(E, a, b, blk=1):
    out, med = R.run_arms(adv_e[E], fin_e[E], busy, ['C0'] + [a], seed=SEED, block=blk); return out, med
print('\n== T3-T6: paired change vs C0 at E = 0 (percentage points; breach, pass; 95% CI) ==')
labels = {}
out, med = R.run_arms(adv_e[0], fin_e[0], busy, arms, seed=SEED)
print('C0 shares at E = 0: pass {:.1f} breach {:.1f} frozen {:.1f} open {:.1f}; median day of pass {:.0f}'.format(*(100 * out['C0'].mean(0)), med['C0']))
for a in arms[1:]:
    dp = R.paired(out, 'C0', a, 0); db = R.paired(out, 'C0', a, 1); fr = 100 * out[a][:, 2].mean()
    lab_a = 'HELPS' if dp[1] > 0 else ('HURTS' if dp[2] < 0 else ('PRESERVES' if (dp[1] > -2 and db[2] < 0) else 'NOT SHOWN')); labels[a] = lab_a
    print(f'{a}: pass change {dp[0]:+.1f} [{dp[1]:+.1f}, {dp[2]:+.1f}]; breach change {db[0]:+.1f} [{db[1]:+.1f}, {db[2]:+.1f}]; own shares pass {100 * out[a][:, 0].mean():.1f} breach {100 * out[a][:, 1].mean():.1f} frozen {fr:.1f}  -> {lab_a}')
print('\nUNCOUNTED 5-day-block check at E = 0:')
outb, _ = R.run_arms(adv_e[0], fin_e[0], busy, arms, seed=SEED, block=5)
for a in arms[1:]: dp = R.paired(outb, 'C0', a, 0); db = R.paired(outb, 'C0', a, 1); print(f'  {a}: pass change {dp[0]:+.1f} [{dp[1]:+.1f}, {dp[2]:+.1f}]; breach change {db[0]:+.1f} [{db[1]:+.1f}, {db[2]:+.1f}]')
print('\nHYPOTHETICAL edge scenarios (fixed-dollar net edge per day; NO edge is known to exist; an upper bound for the gauge):')
for E in (10, 25):
    o, m = R.run_arms(adv_e[E], fin_e[E], busy, arms, seed=SEED); print(f' E = {E}: C0 pass {100 * o["C0"][:, 0].mean():.1f} breach {100 * o["C0"][:, 1].mean():.1f}; ' + '; '.join(f'{a} pass {R.paired(o, "C0", a, 0)[0]:+.1f} [{R.paired(o, "C0", a, 0)[1]:+.1f},{R.paired(o, "C0", a, 0)[2]:+.1f}] breach {R.paired(o, "C0", a, 1)[0]:+.1f}' for a in arms[1:]))
print('\nLABELS:', labels, '| T1 passes' if (t1['obs'] > 1 and t1['lo'] > 1 and t1['p'] < 0.05 and t1['ok_sign']) else '| T1 does not pass', '| T2 passes' if (t2['obs'] > 1 and t2['lo'] > 1 and t2['p'] < 0.05 and t2['ok_sign']) else '| T2 does not pass')
