"""COUNTED TESTS of docs/VACUUM_CONTEXT_EXIT_PREREG_20261109.md (rows 28+29; amendments A1-A4): A = skip thrusts that follow an extended move, B = ratchet vs 30-bar hold on NON-extended thrusts; per track (RTH, Globex).
PRIMARY counted corpus = the 513 explore sessions 2023-03..2025-05-16 (A2); the 68 depth-era 2026 sessions are the uncounted SIGN GATE. Lock-free first, lock-applied pass reported (A3). 4 tests, Holm 0.10.
REAL MODE READS SIGNAL OUTCOMES: it needs env CET_LOOK_ID (the ledger look logged FIRST by scripts/run_context_exit_tests.mjs, hr-023) and --go. `--selftest` runs the whole statistics pipeline on SYNTHETIC outcomes attached to the event
GEOMETRY file (no signal outcome is read). `--simcheck` runs the event-simulation code path on RANDOM bars (random direction, shifted off the signals) for a few sessions. Usage: see the two flags above."""
import os, sys, glob, json, bisect
import numpy as np, pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import features as Fm, v2, context_exit_phase1 as P1, context_exit_blind_audit as BA
OUTD = v2.OUT; SEED = 20261111; BOOT = 4000; POOL = 10; ALPHA = 0.10
lines = []
def say(s=''): print(s); lines.append(s)

# ------------------------------------------------------------------ simulation of the arms on every event (REAL) and on random bars (the control pool)
def sim_chain(files, want, corpus, rng, shift=False, max_sessions=None, events=True, pool_n=None):
    hist = {'RTH': [], 'GBX': []}; prevS = None; ev = []; pool = []; nsess = 0
    for p in files:
        S = Fm.load_full(p)
        if S is None: continue
        d = S['date']; assert d <= P1.HI_PRIMARY and d != '2026-11-06', d
        tsp = Fm.track_split(S); close = Fm.EARLY_CLOSE if d in Fm.EARLY else Fm.CLOSE; prs = {}
        for name in ('RTH', 'GBX'):
            prev = hist[name][-Fm.K_PRIOR:]
            if len(prev) >= Fm.K_PRIOR: prs[name] = Fm.priors_of(prev)
        if len(prs) == 2 and prevS is not None and (want is None or d in want) and (max_sessions is None or nsess < max_sessions):
            nsess += 1; Pc, n0, reset = v2.continuous(prevS, S); F = v2.feats(Pc, n0, reset, prs, close); etr = Fm.ema(F['tr']); adr = P1.adr20(hist['RTH']); en = Pc['en']
            flats = {'RTH': int(np.where(en <= close - 300.0)[0].max()), 'GBX': int(np.where(en <= 55790.0)[0].max())}
            for r in ([r for r in v2.events2(Pc, n0, F, close) if r['fam'] == 'E0' and r['track']] if events else []):      # events=False (--mc): NO signal bar is simulated, only random bars
                k = r['k']; dr = int(r['dir']); t = float(S['en'][k]); E = float('nan')
                if t >= P1.LAG and not np.isnan(adr) and adr > 0:
                    j = int(np.searchsorted(S['en'], t - P1.LAG, side='right')) - 1
                    if j >= 0: E = dr * (S['c'][k] - S['c'][j]) / adr
                a = n0 + k
                if shift: a = min(a + int(rng.integers(40, 300)), len(en) - 40); dr = int(rng.choice([-1, 1]))      # --simcheck only: RANDOM bars, never the signal bar
                x = arms_all(Pc, etr, a, dr, flats[r['track']])
                if x: ev.append(dict(corpus=corpus, date=d, track=r['track'], k=k, t=t, dir=int(r['dir']), E=E, adr=adr, stop=float(2.5 * etr[a]), hour=int(Fm.hour_et(np.array([t]))[0]), **x))
            for tr, lo, hi in (('RTH', 56100.0, close - 600.0), ('GBX', 1800.0, 55500.0)):
                idxs = {}
                for kk in range(len(S['c'])):
                    if lo <= S['en'][kk] <= hi and kk >= Fm.WARM: idxs.setdefault(int(Fm.hour_et(np.array([S['en'][kk]]))[0]), []).append(n0 + kk)
                for h, ix in idxs.items():
                    for a in rng.choice(ix, size=min(pool_n or POOL, len(ix)), replace=False):
                        dr_ = int(rng.choice([-1, 1])); x = arms_all(Pc, etr, int(a), dr_, flats[tr])
                        if x: pool.append(dict(corpus=corpus, date=d, track=tr, hour=h, k=int(a - n0), t=float(en[a]), dir=dr_, stop=float(2.5 * etr[a]), **x))
        for name, T in tsp.items(): hist[name].append(T)
        prevS = S
    return pd.DataFrame(ev), pd.DataFrame(pool)

def arms_all(Pc, etr, a, dr, flat):
    x = BA.arms(Pc, etr, a, dr, flat)
    if not x: return None
    m = BA.arms(Pc, etr, a, -dr, flat)
    return dict(H=x['H'][0], holdH=x['H'][1], R=x['R'][0], holdR=x['R'][1], secsR=x['R'][3], R2=x['R2'][0], Hm=m['H'][0], to_flat=x['to_flat'])

def synth(rng):
    """SELFTEST: attach synthetic outcomes (no signal outcome read) to the GEOMETRY file of the audit (date, track, E, hour, stop)."""
    g = pd.read_csv(os.path.join(OUTD, 'context_exit_events_20261109.csv')); n = len(g)
    g['H'] = rng.normal(0, 30, n); g['R'] = g.H + rng.normal(0, 15, n); g['R2'] = g.R + rng.normal(0, 5, n); g['Hm'] = rng.normal(0, 30, n)      # TRUE NULL: ratchet = hold + noise
    g['secsR'] = 0.0; g['holdH'] = 30; g['holdR'] = rng.geometric(1 / 12, n); g['to_flat'] = rng.integers(30, 400, n)
    pl = g[['corpus', 'date', 'track', 'hour']].copy(); m = len(pl); pl['H'] = rng.normal(0, 30, m); pl['R'] = pl.H + rng.normal(0, 15, m); pl['R2'] = pl.R
    return g.drop(columns=['wick', 'roc', 'fail1', 'dur1'], errors='ignore'), pl

# ------------------------------------------------------------------ classification (frozen expanding 2/3 rule, both corpora in time order) and statistics
def classify(df):
    df = df.sort_values(['date', 't']).reset_index(drop=True); df['ext'] = np.nan
    for tr in ('RTH', 'GBX'):
        L = []
        for i in df.index[(df.track == tr) & ~df.E.isna()]:
            if len(L) >= P1.MIN_SEED: df.at[i, 'ext'] = float(df.at[i, 'E'] >= np.quantile(L, 2 / 3))
            bisect.insort(L, df.at[i, 'E'])
    return df

class Days:
    def __init__(self, dates, y):
        u, inv = np.unique(dates, return_inverse=True); self.u = u; self.s = np.bincount(inv, weights=y, minlength=len(u)); self.n = np.bincount(inv, minlength=len(u)).astype(float)
    def boot(self, rng):
        idx = rng.integers(0, len(self.u), (BOOT, len(self.u))); return self.s[idx].sum(1) / np.maximum(self.n[idx].sum(1), 1)

def win(y, q=0.05):
    lo, hi = np.quantile(y, [q, 1 - q]); return np.clip(y, lo, hi)

class Contrast:
    """Day-level sums of the CONTRAST  mean_EXT(y) - mean_NON(y)  (test A, per amendment A7: 'do extended thrusts do worse than the other thrusts?'). contrib() sums exactly to point(); loso() leaves one day out."""
    def __init__(self, dates, y, g):
        u, inv = np.unique(dates, return_inverse=True); nd = len(u); g = np.asarray(g, bool); self.u = u
        self.se = np.bincount(inv, weights=np.where(g, y, 0.0), minlength=nd); self.ne = np.bincount(inv, weights=g.astype(float), minlength=nd)
        self.sn = np.bincount(inv, weights=np.where(g, 0.0, y), minlength=nd); self.nn = np.bincount(inv, weights=(~g).astype(float), minlength=nd)
    def point(self): return self.se.sum() / max(self.ne.sum(), 1) - self.sn.sum() / max(self.nn.sum(), 1)
    def boot(self, rng):
        idx = rng.integers(0, len(self.u), (BOOT, len(self.u))); ne = self.ne[idx].sum(1); nn = self.nn[idx].sum(1); ok = (ne > 0) & (nn > 0)
        return (self.se[idx].sum(1) / np.maximum(ne, 1) - self.sn[idx].sum(1) / np.maximum(nn, 1))[ok]
    def contrib(self): return self.se / max(self.ne.sum(), 1) - self.sn / max(self.nn.sum(), 1)
    def loso(self):
        Se, Ne, Sn, Nn = self.se.sum(), self.ne.sum(), self.sn.sum(), self.nn.sum()
        return (Se - self.se) / np.maximum(Ne - self.ne, 1) - (Sn - self.sn) / np.maximum(Nn - self.nn, 1)

def half_masks(dates):
    """chronological halves by CALENDAR date (median date), not by event count"""
    u = np.unique(dates); cut = u[len(u) // 2]; return dates < cut, dates >= cut

def sides_inconclusive(sides): return bool(len(sides) == 2 and np.sign(sides['LONG'][0]) != np.sign(sides['SHORT'][0]) and all(abs(v[0]) > 0.5 * v[1] for v in sides.values()))

def test_stats_A(sc, rng, label, cexp, hm):
    """TEST A (A7): contrast = mean(-P&L_H | EXTENDED) - mean(-P&L_H | NON-extended) over ALL scored events of the track; every gate runs on THIS contrast (not on the raw -P&L_H, which is positive under any null because each trade pays the 2 pt cost).
    control: the same contrast of (y - matched random-bar expectation); placebo: the same contrast of (y - (-P&L of the mirrored trade))."""
    dates = sc.date.values; g = (sc.ext.values == 1.0); y = -sc.H.values
    ct = Contrast(dates, y, g); bs = ct.boot(rng); d = float(ct.point()); p = float((1 + (bs <= 0).sum()) / (len(bs) + 1)); se = float(bs.std())
    dw = float(Contrast(dates, win(y), g).point()); infl = ct.point() - ct.loso(); top = np.argsort(-infl)[:2]      # influence of each day = Delta minus Delta without that day; drop the two most influential days and RECOMPUTE both group means with the remaining events (amendment A8)
    drop2 = float((ct.se.sum() - ct.se[top].sum()) / max(ct.ne.sum() - ct.ne[top].sum(), 1) - (ct.sn.sum() - ct.sn[top].sum()) / max(ct.nn.sum() - ct.nn[top].sum(), 1))
    h1, h2 = half_masks(dates); halves = [float(Contrast(dates[m], y[m], g[m]).point()) for m in (h1, h2)]
    adj = Contrast(dates, y - cexp, g); ctrl_lo = float(np.quantile(adj.boot(rng), .05)); pl_lo = float(np.quantile(Contrast(dates, y + hm, g).boot(rng), .05))      # y - (-hm) = y + hm
    sides = {}
    for nm, mk in (('LONG', sc.dir.values == 1), ('SHORT', sc.dir.values == -1)):
        if (mk & g).sum() > 20 and (mk & ~g).sum() > 20: cs = Contrast(dates[mk], y[mk], g[mk]); sides[nm] = (float(cs.point()), float(cs.boot(rng).std()))
    return dict(label=label, n=int(g.sum()), n_non=int((~g).sum()), days=int(len(ct.u)), mean=d, mean_ext=float(y[g].mean()), mean_non=float(y[~g].mean()), p=p, se=se, mde=2.8 * se, lo90=float(np.quantile(bs, .10)), ci95=[float(np.quantile(bs, .025)), float(np.quantile(bs, .975))],
                winsor=dw, trim25=float('nan'), median=float(np.median(y[g]) - np.median(y[~g])), drop_top2=drop2, loso_min=float(ct.loso().min()), halves=halves, ctrl_mean=float(adj.point()), ctrl_lo=ctrl_lo, beats_ctrl=bool(ctrl_lo > 0),
                placebo_lo=pl_lo, beats_placebo=bool(pl_lo > 0), inconclusive=sides_inconclusive(sides))

def test_stats(df, y, rng, label, cexp, placebo=None):
    """TEST B (and any one-sample paired statistic): y = ratchet minus hold on NON-extended events."""
    ds = Days(df.date.values, y); bs = ds.boot(rng); m = float(y.mean()); p = float((1 + (bs <= 0).sum()) / (BOOT + 1)); se = float(bs.std())
    h1, h2 = half_masks(df.date.values)
    top2 = np.argsort(-ds.s)[:2]; keep = np.ones(len(ds.u), bool); keep[top2] = False; loso_min = float(((ds.s.sum() - ds.s) / np.maximum(ds.n.sum() - ds.n, 1)).min())
    r = dict(label=label, n=int(len(y)), days=int(len(ds.u)), mean=m, p=p, se=se, mde=2.8 * se, lo90=float(np.quantile(bs, .10)), ci95=[float(np.quantile(bs, .025)), float(np.quantile(bs, .975))], winsor=float(win(y).mean()), trim25=float(np.sort(y)[int(len(y) * .25):len(y) - int(len(y) * .25)].mean()),
             median=float(np.median(y)), drop_top2=float(ds.s[keep].sum() / max(ds.n[keep].sum(), 1)), loso_min=loso_min, halves=[float(y[h1].mean()), float(y[h2].mean())], ctrl_mean=float((y - cexp).mean()))
    b3 = Days(df.date.values, y - cexp).boot(rng); r['ctrl_lo'] = float(np.quantile(b3, .05)); r['beats_ctrl'] = bool(r['ctrl_lo'] > 0)      # paired, day-blocked, one-sided 5 percent: the event minus its matched random-bar expectation
    sides = {}
    for nm, mk in (('LONG', df.dir.values == 1), ('SHORT', df.dir.values == -1)):
        if mk.sum() > 20: dm = Days(df.date.values[mk], y[mk]); sides[nm] = (float(y[mk].mean()), float(dm.boot(rng).std()))
    r['inconclusive'] = sides_inconclusive(sides)
    return r

def lock_book(df, pnl_col, hold_col):
    """production lock: one position per track and day; the next signal bar k must be at or after the exit bar of the held trade (each arm locks to ITS OWN actual exit: k + hold, hold = bars from the entry bar to the actual exit inclusive).
    Returns per-(date, track) sums."""
    out = {}; d = df.sort_values(['date', 'track', 't']); dates = d.date.values; tracks = d.track.values; ks = d.k.values; pn = d[pnl_col].values; hd = d[hold_col].values; lock = -1; tot = 0.0; key = None
    for i in range(len(d)):
        kk = (dates[i], tracks[i])
        if kk != key:
            if key is not None: out[key] = tot
            key = kk; lock = -1; tot = 0.0
        if ks[i] >= lock: tot += pn[i]; lock = ks[i] + int(hd[i])
    if key is not None: out[key] = tot
    return pd.Series(out)

def lock_taken(df, hold_col):
    """boolean Series (aligned to df.index): which events the production lock would take for an arm whose actual hold (bars) is hold_col"""
    d = df.sort_values(['date', 'track', 't']); keep = np.zeros(len(d), bool); lock = -1; key = None; ks = d.k.values; hd = d[hold_col].values; dates = d.date.values; tracks = d.track.values
    for i in range(len(d)):
        kk = (dates[i], tracks[i])
        if kk != key: key = kk; lock = -1
        if ks[i] >= lock: keep[i] = True; lock = ks[i] + int(hd[i])
    return pd.Series(keep, index=d.index).reindex(df.index)

# ------------------------------------------------------------------ control, the four tests, the gates
def control_draws(sub, pool, kind):
    """MATCHED CONTROL (prereg A6): for every event, the EXPECTATION of the control statistic over all random bars of the same date, track and hour (fallback: same track and hour on other dates, share reported). The comparison is then PAIRED and
    day-blocked (y_i - c_i), which carries the pool's own sampling noise. Test A control statistic = -P&L_H of the random bar; test B = ratchet minus hold of the random bar."""
    byk = {}; byf = {}; nfb = 0
    v = (-pool.H.values) if kind == 'A' else (pool.R.values - pool.H.values)
    for i, (d, tr, h) in enumerate(zip(pool.date.values, pool.track.values, pool.hour.values)): byk.setdefault((d, tr, h), []).append(i); byf.setdefault((tr, h), []).append(i)
    cexp = np.empty(len(sub))
    for j, (d, tr, h) in enumerate(zip(sub.date.values, sub.track.values, sub.hour.values)):
        c = byk.get((d, tr, h))
        if not c: c = byf.get((tr, h)); nfb += 1
        cexp[j] = v[c].mean()
    return cexp, nfb / max(len(sub), 1)

def run_corpus(ev, pool, rng, tag):
    """returns {test_name: result} for the 4 counted tests on one corpus (events already classified; pool = random bars of the same corpus). A cell with fewer than 30 events in either group is reported as insufficient (p = 1), never a crash."""
    out = {}
    for tr in ('RTH', 'GBX'):
        sc = ev[(ev.track == tr) & ev.ext.isin([0.0, 1.0])].copy(); allds = max(sc.date.nunique(), 1); pl = pool[pool.track == tr]; ne = int((sc.ext == 1.0).sum()); nn = int((sc.ext == 0.0).sum())
        for kind in ('A', 'B'):
            name = f'{kind}-{tr}'
            if ne < 30 or nn < 30: out[name] = dict(label=name, insufficient=True, n=ne if kind == 'A' else nn, days=0, p=1.0, mean=0.0); continue
            if kind == 'A':
                cx, fb = control_draws(sc, pl, 'A'); r = test_stats_A(sc, rng, name, cx, sc.Hm.values); ex = sc.ext.values == 1.0
                tk = lock_taken(sc, 'holdH').values; st = sc[tk]; lf = r['mean']
                lk = float(Contrast(st.date.values, -st.H.values, st.ext.values == 1.0).point()) if (st.ext == 1.0).any() and (st.ext == 0.0).any() else float('nan')
                r['lockfree'] = float(lf); r['lock'] = lk; r['lock_ok'] = bool(not np.isnan(lk) and np.sign(lk) == np.sign(lf) and lk >= 0.5 * lf) if lf > 0 else bool(not np.isnan(lk) and lk > 0)
                r['R_unit_mean'] = float((-sc.H.values / sc.stop.values)[ex].mean()); r['by_hour'] = {int(h): float((-sc.H.values)[ex & (sc.hour.values == h)].mean()) for h in sorted(set(sc.hour.values)) if (ex & (sc.hour.values == h)).sum() >= 30}
            else:
                sub = sc[sc.ext == 0.0]; y = sub.R.values - sub.H.values; cx, fb = control_draws(sub, pl, 'B'); r = test_stats(sub, y, rng, name, cx, None)
                lf = y.sum() / allds; bk_r = lock_book(sub, 'R', 'holdR'); bk_h = lock_book(sub, 'H', 'holdH'); dif = (bk_r.reindex(bk_r.index.union(bk_h.index)).fillna(0.0) - bk_h.reindex(bk_r.index.union(bk_h.index)).fillna(0.0)); lk = dif.sum() / allds
                byday = dif.groupby(level=0).sum().values; lock_lo = float(np.quantile(byday[rng.integers(0, len(byday), (BOOT, len(byday)))].mean(1), .05)); base = bool(np.sign(lk) == np.sign(lf) and lk >= 0.5 * lf) if lf > 0 else bool(lk > 0)
                trig = bool(sub.holdR.median() > 30); r['median_hold_R'] = float(sub.holdR.median()); r['lock_coprimary_trigger'] = trig; r['lockfree'] = float(lf); r['lock'] = float(lk); r['lock_lo'] = lock_lo; r['lock_ok'] = bool(base and (not trig or lock_lo > 0))      # A3(4): co-primary when the ratchet holds longer than the hold arm
                r['share_R_ge_55min'] = float((sub.secsR >= 3300).mean()); r['median_R_minutes'] = float(sub.secsR.median() / 60)      # R-pivot feasibility (a confirmed 30-minute pivot needs about 55 minutes), reporting only
                r['R2_minus_H'] = float((sub.R2 - sub.H).mean()); r['R_unit_mean'] = float(((sub.R - sub.H) / sub.stop).mean())
                if tr == 'GBX': q = pd.qcut(sub.to_flat, 3, labels=False, duplicates='drop'); r['by_bars_to_flat_tercile'] = [float(y[q.values == t].mean()) for t in sorted(set(q.values))]
                r['by_hour'] = {int(h): float(y[sub.hour.values == h].mean()) for h in sorted(set(sub.hour.values)) if (sub.hour.values == h).sum() >= 30}
            r['ctrl_fallback_share'] = float(fb); out[name] = r
    return out

def holm(res):
    """Holm step-down over ALL four tests (an INCONCLUSIVE or NOT SHOWN test still occupies its slot): reject the smallest p at alpha/m, continue only while every earlier one was rejected."""
    assert len(res) == 4, f'the counted family must have exactly 4 tests, got {sorted(res)}'
    names = sorted(res, key=lambda k: res[k]['p']); alive = True
    for rank, k in enumerate(names):
        res[k]['holm_alpha'] = ALPHA / (len(names) - rank); alive = alive and res[k]['p'] <= res[k]['holm_alpha']; res[k]['holm_pass'] = bool(alive)
    return res

def make_verdicts(rep, gate):
    out = {}
    for k, r in rep.items():
        if r.get('insufficient'): out[k] = dict(verdict='NOT SHOWN', conds={'enough events': False}); continue
        g = gate.get(k); gate_ok = bool(g is not None and np.sign(g['mean']) == np.sign(r['mean']))
        conds = {'N>=100 and days>=20': r['n'] >= 100 and r['days'] >= 20, 'Holm step-down': r['holm_pass'], 'winsorized>0': r['winsor'] > 0, 'drop-top-2-days>0': r['drop_top2'] > 0, 'LOSO min>0': r['loso_min'] > 0, 'beats matched random-bar control (paired, day-blocked)': r['beats_ctrl'],
                 'beats placebo (A)': r.get('beats_placebo', True), 'halves>=0': min(r['halves']) >= 0, 'lock pass': r['lock_ok'], '2026 sign gate': gate_ok}
        out[k] = dict(verdict='INCONCLUSIVE' if r['inconclusive'] else ('PASS' if all(conds.values()) else 'NOT SHOWN'), conds={a: bool(b) for a, b in conds.items()})
    return out

def mc_null(n_iter, rng):
    """Monte Carlo of the WHOLE pipeline under a true null, outcome-blind: the 'events' are RANDOM bars (random direction, same session, track and hour distribution) whose E_t is drawn from the real E_t distribution of the same track and hour
    (event GEOMETRY only), so extension is independent of every outcome; the control pool is a disjoint random-bar pool. Reports how often each test and any test would PASS. No signal bar is simulated."""
    rf = sorted(p for p in glob.glob(os.path.join(Fm.BARS, '*.bars.tsv')) if os.path.basename(p)[:10] <= Fm.LAST_EXPLORE); files, scored68 = P1.primary_files()
    _, p1 = sim_chain(rf, None, 'replication', rng, events=False, pool_n=6); _, p2 = sim_chain(files, scored68, 'primary', rng, events=False, pool_n=6); pool = pd.concat([p1, p2], ignore_index=True)
    geo = pd.read_csv(os.path.join(OUTD, 'context_exit_events_20261109.csv'))[['corpus', 'track', 'hour', 'E']]
    gE = {k: g.E.values for k, g in geo.groupby(['corpus', 'track', 'hour'])}
    say(f'MC null: random-bar pool {len(pool)} (re-split into mock events and control bars on EVERY iteration), iterations {n_iter}')
    passes = {}; anyp = 0; done = 0
    for it in range(n_iter):
        msk = rng.random(len(pool)) < 0.5; mock = pool[msk].reset_index(drop=True); ctrl = pool[~msk].reset_index(drop=True); m = mock.copy(); m['E'] = [rng.choice(gE[(c, t, h)]) if (c, t, h) in gE else np.nan for c, t, h in zip(m.corpus, m.track, m.hour)]
        m = classify(m); rep = run_corpus(m[m.corpus == 'replication'], ctrl[ctrl.corpus == 'replication'], rng, 'rep'); gate = run_corpus(m[m.corpus == 'primary'], ctrl[ctrl.corpus == 'primary'], rng, 'gate')
        holm(rep); v = make_verdicts(rep, gate); hit = [k for k in v if v[k]['verdict'] == 'PASS']; anyp += bool(hit); done += 1
        for k in v: passes[k] = passes.get(k, 0) + (v[k]['verdict'] == 'PASS')
        if it % 5 == 4: say(f'  after {done} completed iterations: any-PASS {anyp}; per test {passes}')
    say(f'MC null RESULT over {done} completed iterations: family-wise PASS rate {anyp / max(done, 1):.3f}; per-test PASS counts {passes}  (expect a family-wise rate at or below about 0.10 and per-test rates at or below about 0.05)')

def main():
    selftest = '--selftest' in sys.argv; simcheck = '--simcheck' in sys.argv; rng = np.random.default_rng(SEED)
    global BOOT
    if '--mc' in sys.argv:
        BOOT = 1000; n = int(sys.argv[sys.argv.index('--mc') + 1]); mc_null(n, rng); open(os.path.join(OUTD, 'context_exit_tests_mc_output.txt'), 'w').write('\n'.join(lines) + '\n'); return
    if simcheck:
        rf = sorted(p for p in glob.glob(os.path.join(Fm.BARS, '*.bars.tsv')) if os.path.basename(p)[:10] <= '2023-06-30')
        ev, pool = sim_chain(rf, None, 'replication', rng, shift=True, max_sessions=6)
        say(f'SIMCHECK (random shifted bars, NOT signals): events simulated {len(ev)}, pool {len(pool)}; H mean {ev.H.mean():+.2f} R mean {ev.R.mean():+.2f} R2 mean {ev.R2.mean():+.2f}; holdH median {ev.holdH.median():.0f}, holdR median {ev.holdR.median():.0f}'); return
    if selftest:
        ev, pool = synth(rng); say('SELFTEST: synthetic outcomes on the event geometry file (no signal outcome read)')
        for c in ('k', 't', 'dir', 'stop'):
            if c not in pool.columns: pool[c] = ev[c].iloc[:len(pool)].values if c in ev.columns else 0
    else:
        if '--go' not in sys.argv or not os.environ.get('CET_LOOK_ID'): sys.exit('REFUSED: real mode reads signal outcomes and needs --go and CET_LOOK_ID (scripts/run_context_exit_tests.mjs logs the ledger look first, hr-023).')
        tok = os.path.join(OUTD, '..', '.cet_look_token.json')            # written by the runner AFTER the ledger look was logged; a made-up CET_LOOK_ID cannot match it
        try: T = json.load(open(tok)); assert T['id'] == os.environ['CET_LOOK_ID'] and (__import__('time').time() * 1000 - T['at']) < 3600 * 1000
        except Exception: sys.exit('REFUSED: no valid ledger token (run scripts/run_context_exit_tests.mjs --go, which logs the look and writes the token).')
        say(f'REAL MODE, ledger look {os.environ["CET_LOOK_ID"]}')
        files, scored68 = P1.primary_files(); rf = sorted(p for p in glob.glob(os.path.join(Fm.BARS, '*.bars.tsv')) if os.path.basename(p)[:10] <= Fm.LAST_EXPLORE)
        e1, p1 = sim_chain(rf, None, 'replication', rng); e2, p2 = sim_chain(files, scored68, 'primary', rng); ev = pd.concat([e1, e2], ignore_index=True); pool = pd.concat([p1, p2], ignore_index=True)
        ev.to_csv(os.path.join(OUTD, 'context_exit_event_sims_20261109.csv'), index=False)       # cached BEFORE any statistic, so a statistics crash can be re-run from this file (policy: prereg A5)
    ev = classify(ev); res = {}
    for corpus, label in (('replication', 'PRIMARY COUNTED (513 sessions 2023-2025)'), ('primary', '2026 SIGN GATE (68 sessions, uncounted)')):
        e = ev[ev.corpus == corpus]; pl = pool[pool.corpus == corpus]; say(f'\n########## {label}: events {len(e)}, scored {int(e.ext.isin([0.0, 1.0]).sum())}, random-bar pool {len(pl)}')
        res[corpus] = run_corpus(e, pl, rng, corpus)
    holm(res['replication']); verdicts = make_verdicts(res['replication'], res['primary'])
    say('\n=========== VERDICTS (counted family = the 4 tests on the 513-session corpus, Holm 0.10 step-down) ===========')
    for k, r in res['replication'].items():
        g = res['primary'].get(k); v = verdicts[k]
        if r.get('insufficient'): say(f'  {k}: INSUFFICIENT EVENTS (n {r["n"]}) -> NOT SHOWN'); continue
        say(f'  {k}: N {r["n"]} days {r["days"]}; {"contrast" if k[0] == "A" else "mean"} {r["mean"]:+.2f} pt/trade (p {r["p"]:.4f} vs Holm alpha {r["holm_alpha"]:.3f}); MDE {r["mde"]:.2f}; winsorized {r["winsor"]:+.2f}, drop-top-2-days {r["drop_top2"]:+.2f}, trimmed25 {r["trim25"]:+.2f}, median {r["median"]:+.1f}; minus matched control {r["ctrl_mean"]:+.2f} (5th pct bound {r["ctrl_lo"]:+.2f}; fallback to other dates {100 * r["ctrl_fallback_share"]:.1f}%); lock-applied {r["lock"]:+.2f} vs lock-free {r["lockfree"]:+.2f}; 2026 gate mean {g["mean"] if g else float("nan"):+.2f}')
        say(f'      -> {v["verdict"]}; failed: ' + (', '.join(a for a, b in v['conds'].items() if not b) or 'none'))
        if k.startswith('B'): say(f'      ratchet median hold on the scored non-extended events {r["median_hold_R"]:.0f} bars (co-primary lock trigger if > 30: {r["lock_coprimary_trigger"]}); R2 minus H {r["R2_minus_H"]:+.2f}; share of ratchet trades lasting 55+ minutes {100 * r["share_R_ge_55min"]:.1f}% (median {r["median_R_minutes"]:.1f} min); R-unit mean {r["R_unit_mean"]:+.3f}')
    suffix = 'selftest' if selftest else 'result'
    json.dump(dict(results=res, verdicts=verdicts), open(os.path.join(OUTD, f'context_exit_tests_{suffix}.json'), 'w'), indent=1, default=float)
    open(os.path.join(OUTD, f'context_exit_tests_{suffix}_output.txt'), 'w').write('\n'.join(lines) + '\n')

if __name__ == '__main__': main()
