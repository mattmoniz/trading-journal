"""T2 of docs/TELL_VS_ROC_COINCIDENCE_PREREG_20261109.md (row 31, amendments A1-A3): V1 net dollars per tell entry WITH the causal thrust flag minus WITHOUT it, day-blocked, within-hour permutation placebo.
READS OUTCOMES in real mode, so real mode REQUIRES env T2_LOOK_ID (the ledger look must be logged first by scripts/run_tell_roc_t2.mjs, hr-023) and the flag --go. `--selftest` replaces the outcome by synthetic noise
(same N, same dates) to check the machinery and its calibration; it reads NO outcome. Usage: ../../venv/bin/python tell_roc_t2.py --selftest   |   T2_LOOK_ID=<id> ../../venv/bin/python tell_roc_t2.py --go"""
import os, sys, csv, json
import numpy as np
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'scratch')
ENT = os.path.join(D, 'vacuum_sim_20261108', 'tell_roc_step1_entries_20261109.csv'); ROWS = os.path.join(D, 'tell_context_20261103', 'tell_floor_target_rows.csv')
BOOT, PERM = 4000, 2000; SEED = 20261110; lines = []
def say(s=''): print(s); lines.append(s)

def load(selftest):
    ent = list(csv.DictReader(open(ENT))); rng = np.random.default_rng(SEED)
    if selftest:
        for e in ent: e['net'] = float(rng.normal(0, 60)); e['pts'] = float(rng.normal(0, 30)); e['risk'] = float(e['stop']) if e['stop'] else float('nan')
        return ent
    out = {}
    for r in csv.DictReader(open(ROWS)):
        if r['F'] == '': continue
        out[(r['date'], round(float(r['end_sec']), 1))] = r
    miss = 0
    for e in ent:
        r = out.get((e['date'], round(float(e['t']), 1)))
        if r is None: miss += 1; e['net'] = float('nan'); e['pts'] = float('nan'); e['risk'] = float('nan'); continue
        e['net'] = float(r['v1_net']); e['pts'] = float(r['v1_pts']); e['risk'] = float(r['risk_pts']) if r['risk_pts'] else float('nan')
    say(f'joined entries {len(ent) - miss} of {len(ent)} (unmatched {miss})'); return [e for e in ent if not np.isnan(e['net'])]

def arrays(ent):
    return dict(date=np.array([e['date'] for e in ent]), flag=np.array([int(e['flag']) for e in ent]).astype(bool), pre=np.array([int(e['pre']) for e in ent]).astype(bool), imm=np.array([int(e['imm']) for e in ent]).astype(bool),
                hour=np.array([int(e['hour']) for e in ent]), dir=np.array([int(e['dir']) for e in ent]), net=np.array([e['net'] for e in ent]), pts=np.array([e['pts'] for e in ent]), risk=np.array([e['risk'] for e in ent]))

def diff(y, f): return y[f].mean() - y[~f].mean()                # sum(pnl)/N per group, hr-062: the point estimate is a plain mean, only the CI is day-blocked

def day_boot(a, y, f, rng):
    dates = np.unique(a['date']); idx = {d: np.where(a['date'] == d)[0] for d in dates}; out = []
    for _ in range(BOOT):
        pick = rng.integers(0, len(dates), len(dates)); ix = np.concatenate([idx[dates[j]] for j in pick]); ff = f[ix]
        if ff.all() or (~ff).all(): continue
        out.append(y[ix][ff].mean() - y[ix][~ff].mean())
    return np.array(out)

def perm_hour(a, y, f, rng):
    out = []; hrs = np.unique(a['hour']); groups = [np.where(a['hour'] == h)[0] for h in hrs]
    for _ in range(PERM):
        ff = f.copy()
        for g in groups: ff[g] = rng.permutation(f[g])
        out.append(diff(y, ff))
    return np.array(out)

def analyse(a, label, y, rng):
    f = a['flag']; d = diff(y, f); bs = day_boot(a, y, f, rng); se = bs.std(); lo90 = np.quantile(bs, .10); lo95 = np.quantile(bs, .025); hi95 = np.quantile(bs, .975); p = float((1 + (bs <= 0).sum()) / (len(bs) + 1))
    say(f'\n##### {label}: N {len(y)} (flagged {f.sum()}, unflagged {(~f).sum()}), dates {len(np.unique(a["date"]))}')
    say(f'  MDE (80 percent power, 2.8 x SE) {2.8 * se:.1f} (units of y)')
    say(f'  mean flagged {y[f].mean():+.2f} / N, unflagged {y[~f].mean():+.2f} / N; difference {d:+.2f}; median flagged {np.median(y[f]):+.1f} vs unflagged {np.median(y[~f]):+.1f}')
    say(f'  day-blocked one-sided 90 percent lower bound {lo90:+.2f}; 95 percent CI [{lo95:+.2f}, {hi95:+.2f}]; one-sided p(diff <= 0) {p:.4f}')
    pm = perm_hour(a, y, f, rng); q975 = np.quantile(pm, .975); say(f'  within-hour permutation placebo: observed {d:+.2f} vs 97.5th percentile of permuted {q975:+.2f} -> {"EXCEEDS" if d > q975 else "does not exceed"}')
    order = np.argsort(a['date'], kind='stable'); h1, h2 = order[:len(order) // 2], order[len(order) // 2:]; dh = [diff(y[h], f[h]) for h in (h1, h2) if f[h].any() and (~f[h]).any()]
    say(f'  chronological halves: ' + ' / '.join(f'{x:+.2f}' for x in dh))
    sides = {}
    for lab, m in (('LONG', a['dir'] == 1), ('SHORT', a['dir'] == -1)):
        if f[m].any() and (~f[m]).any():
            bb = day_boot({k: v[m] for k, v in a.items()}, y[m], f[m], rng); sides[lab] = (diff(y[m], f[m]), bb.std()); say(f'  {lab}: N {m.sum()}, difference {sides[lab][0]:+.2f} (SE {sides[lab][1]:.2f})')
    inconcl = len(sides) == 2 and np.sign(sides['LONG'][0]) != np.sign(sides['SHORT'][0]) and all(abs(v[0]) > 0.5 * v[1] for v in sides.values())
    big = a['risk'] > 100; say(f'  stop > 100 pt group (runner population): N {big.sum()}, flagged {f[big].sum()}; difference {diff(y[big], f[big]) if f[big].any() and (~f[big]).any() else float("nan"):+.2f}; stop <= 100: difference {diff(y[~big], f[~big]) if f[~big].any() and (~f[~big]).any() else float("nan"):+.2f}')
    say('  by ET hour (difference, N flagged / unflagged): ' + '; '.join(f'{h}h {diff(y[a["hour"] == h], f[a["hour"] == h]):+.1f} ({f[a["hour"] == h].sum()}/{(~f[a["hour"] == h]).sum()})' for h in sorted(np.unique(a['hour'])) if f[a['hour'] == h].sum() > 5 and (~f[a['hour'] == h]).sum() > 5))
    g = {'none': ~a['pre'] & ~a['imm'], 'precursor only [t-10,t-3]': a['pre'] & ~a['imm'], 'immediate only [t-2,t]': ~a['pre'] & a['imm'], 'both': a['pre'] & a['imm']}
    say('  precursor vs immediate thrust window (mean y / N): ' + '; '.join(f'{k} {y[m].mean():+.1f} ({m.sum()})' for k, m in g.items() if m.sum() > 0))
    return dict(label=label, n=int(len(y)), diff=float(d), lo90=float(lo90), ci95=[float(lo95), float(hi95)], p=p, se=float(se), perm_q975=float(q975), exceeds=bool(d > q975), halves=[float(x) for x in dh], inconclusive=bool(inconcl))

def main():
    selftest = '--selftest' in sys.argv
    if not selftest:
        if '--go' not in sys.argv or not os.environ.get('T2_LOOK_ID'): sys.exit('REFUSED: real mode reads outcomes and needs --go and T2_LOOK_ID (run scripts/run_tell_roc_t2.mjs, which logs the ledger look first).')
        say(f'REAL MODE, ledger look {os.environ["T2_LOOK_ID"]}')
    ent = load(selftest); a = arrays(ent); rng = np.random.default_rng(SEED); res = {}
    if selftest:
        for k in range(3):                                             # calibration of the machinery under the null: share of one-sided p <= 0.10 over a few synthetic draws
            y = np.random.default_rng(SEED + k).normal(0, 60, len(a['flag'])); res[f'selftest{k}'] = analyse(a, f'SELFTEST synthetic noise {k} (no outcome read)', y, rng)
        say('\nSELFTEST done: expect small differences, p roughly uniform, placebo not exceeded in most draws.')
    else:
        res['dollars'] = analyse(a, 'T2 V1 net dollars per entry', a['net'], rng)
        ok = ~np.isnan(a['risk']) & (a['risk'] > 0); b = {k: v[ok] for k, v in a.items()}; res['R'] = analyse(b, 'T2 in R-multiples (net points / initial stop points)', b['pts'] / b['risk'], rng)
        r = res['dollars']; lead = r['p'] <= 0.10 and r['exceeds'] and all(h > 0 for h in r['halves']) and not r['inconclusive']        # T1 already passed (p 0.0002): T2 is tested at the remaining Holm level 0.10
        say(f'\nT2 verdict (Holm over T1 and T2, one-sided; lower bound > 0, placebo exceeded, both halves positive, not INCONCLUSIVE): {"LEAD" if lead else "NOT SHOWN"}'); res['verdict'] = 'LEAD' if lead else 'NOT SHOWN'
    json.dump(res, open(os.path.join(D, 'vacuum_sim_20261108', 'tell_roc_t2_%s.json' % ('selftest' if selftest else 'result')), 'w'), indent=1)
    open(os.path.join(D, 'vacuum_sim_20261108', 'tell_roc_t2_%s_output.txt' % ('selftest' if selftest else 'result')), 'w').write('\n'.join(lines) + '\n')

if __name__ == '__main__': main()
