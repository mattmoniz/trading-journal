"""Sealed-era replay of the next-hour RANGE model. Pre-registration: docs/STRUCTURE_MODEL_SEALED_REPLAY_PREREG_20261108.md (family structure_model_sealed_replay_20261108, 2 counted tests).
Phase 1 builds the rows with the LIVE path (run_nightly.day_rows) and the FROZEN explore-only model, prints counts, drop reasons and the detectable effect, and NO outcome. Phase 2 labels and scores.
Windows: sealed (2025-05-19..2026-10-19) | explore_check (regression check on the last 40 explore sessions that have a research tick extraction; also asserts the live-path features equal explore_features.csv).
Usage: venv/bin/python scripts/structure_model/sealed_replay.py --phase 1|2 --window sealed|explore_check      (run through sealed_replay.mjs, which spends the sealed look between the phases)"""
import os, sys, json, argparse
import numpy as np, pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
ap = argparse.ArgumentParser(); ap.add_argument('--phase', type=int, required=True); ap.add_argument('--window', required=True, choices=['sealed', 'explore_check']); A = ap.parse_args(); sys.argv = sys.argv[:1]
import run_nightly as R, features as F, ticks_live as TL
REPO = R.REPO; WORK = os.path.join(REPO, 'scratch', 'structure_model_sealed_replay_20261108'); os.makedirs(WORK, exist_ok=True); TL.OUT = os.path.join(WORK, 'ticks'); os.makedirs(TL.OUT, exist_ok=True)
def cache_only(conn, d, force=False): a = TL.load(d); return (a, 'research tick extraction') if a is not None else (None, 'no validated tick extraction for this date')
TL.extract = cache_only                                                                                  # no live extraction inside the replay: only days the research extractor validated can qualify
R.TL.extract = cache_only
CAL = sorted(json.load(open(os.path.join(REPO, 'scratch', 'contract_by_date_20261020.json'))))
REF = pd.read_csv(R.EXPLORE); SEED = 20261108; NB = 4000
def window_dates():
    if A.window == 'sealed': return [d for d in CAL if '2025-05-19' <= d <= '2026-10-19']
    ex = sorted(REF.date.unique()); have = [d for d in ex if os.path.exists(os.path.join(TL.OUT, d + '.csv')) and d >= '2025-03-04']; return have[-40:]
def frozen_model():
    X = REF[F.M2_COLS].values.astype(float); y = REF.y.values; di = REF.di.values.astype(int)
    Xb = X[:, [F.M2_COLS.index(c) for c in F.BASE_COLS]]; Xp = X[:, [F.M2_COLS.index(c) for c in F.PERSIST_COLS]]
    return dict(m2=F.fit(X, y, di), base=F.fit(Xb, y, di), persist=F.fit(Xp, y, di))
def ci(draws, level=97.5): lo = (100 - level) / 2; return np.percentile(draws, lo), np.percentile(draws, 100 - lo)
def boot_imp(day_a, day_b, rng, n_days=None):
    """improvement = (sum a - sum b) / sum a over resampled days (a = baseline loss, b = model loss), per-day sums"""
    n = len(day_a) if n_days is None else n_days; out = np.empty(NB)
    for k in range(NB): i = rng.integers(0, len(day_a), n); out[k] = (day_a[i].sum() - day_b[i].sum()) / day_a[i].sum()
    return out
conn = R.get_connection(); dates = window_dates(); M = frozen_model(); rows_fp = os.path.join(WORK, f'rows_{A.window}.csv')
if A.phase == 1:
    why = {}; out = []; worst = 0.0
    for d in dates:
        res, note = R.day_rows(conn, d)
        if res is None:
            k = 'fewer than 15 of the 20 prior sessions validated' if note.startswith('only') else note.split(':')[-1].strip()[:70] if note.startswith('ticks') else note[:70]; why[k] = why.get(k, 0) + 1; continue
        rows, adr, b = res
        for r in rows:
            x = np.array([r[c] for c in F.M2_COLS]); xb = np.array([r[c] for c in F.BASE_COLS]); xp = np.array([r[c] for c in F.PERSIST_COLS])
            out.append(dict(date=d, T=r['T'], adr=adr, p2=float(F.predict(M['m2'], x)), p0=float(F.predict(M['base'], xb)), p3=float(F.predict(M['persist'], xp)), **{c: r[c] for c in F.M2_COLS}))
            if A.window == 'explore_check':
                ref = REF[(REF.date == d) & (REF['T'] == r['T'])]
                if len(ref): worst = max(worst, max(abs(float(r[c]) - float(ref.iloc[0][c])) for c in F.M2_COLS))
    df = pd.DataFrame(out); df.to_csv(rows_fp, index=False); nd = df.date.nunique() if len(df) else 0
    print(f'window {A.window}: {len(dates)} calendar sessions, {nd} qualify ({len(df)} rows); frozen model alpha {M["m2"]["alpha"]}, code hash {F.code_hash()[:8]}, trained on {len(REF)} explore rows')
    print('dropped, by reason:', why)
    if A.window == 'explore_check': print(f'live-path features vs explore_features.csv: worst absolute difference {worst:.2e}'); assert worst < 1e-6, 'LIVE PATH FEATURES DIFFER FROM THE RESEARCH ROWS'
    WF = pd.read_csv(os.path.join(REPO, 'scratch', 'structure_model_20261105', 'rows_walkforward.csv')); WF = WF[WF.scored == 1].copy()
    for c in ('p0', 'p2', 'p3'): WF['l' + c[1]] = (WF.y - WF[c]) ** 2
    g = WF.groupby('date')[['l0', 'l2', 'l3']].sum().values; rng = np.random.default_rng(SEED); lo1, hi1 = ci(boot_imp(g[:, 2], g[:, 1], rng, nd or None)); sd1 = np.std(boot_imp(g[:, 2], g[:, 1], rng, nd or None)); sd2 = np.std(boot_imp(g[:, 0], g[:, 1], rng, nd or None))
    print(f'DETECTABLE EFFECT at {nd} qualifying days (2.8 x SE from the explore walk-forward paired losses, resampled to that many days): T1 vs hard baseline {100 * 2.8 * sd1:.1f} percent, T2 vs HAR-X + clock {100 * 2.8 * sd2:.1f} percent (no sealed outcome has been read)')
    if A.window == 'sealed' and nd < 150: print('INCONCLUSIVE IN ADVANCE: fewer than 150 qualifying sessions'); sys.exit(3)
    sys.exit(0)
# ---- phase 2: labels and the verdict
df = pd.read_csv(rows_fp); cur = conn.cursor(); ys = []; cache = {}
for r in df.itertuples():
    if r.date not in cache: cache[r.date] = R.session_bars(cur, r.date)
    b = cache[r.date]; ys.append(F.label(b, int(r.T), float(r.adr)) if b is not None else np.nan)
df['y'] = ys; df = df.dropna(subset=['y']).copy()
for c in ('p0', 'p2', 'p3'): df['l' + c[1]] = (df.y - df[c]) ** 2
g = df.groupby('date')[['l0', 'l2', 'l3']].sum(); days = list(g.index); G = g.values; rng = np.random.default_rng(SEED)
t1 = (G[:, 2].sum() - G[:, 1].sum()) / G[:, 2].sum(); t2 = (G[:, 0].sum() - G[:, 1].sum()) / G[:, 0].sum(); b1 = boot_imp(G[:, 2], G[:, 1], rng); b2 = boot_imp(G[:, 0], G[:, 1], rng)
h = len(days) // 2; hv = [(G[s][:, 2].sum() - G[s][:, 1].sum()) / G[s][:, 2].sum() for s in (slice(0, h), slice(h, None))]
print(f'{len(days)} days, {len(df)} rows, {days[0]}..{days[-1]}')
print(f'T1 model vs HARD baseline: {100 * t1:+.2f} percent, CI97.5 [{100 * ci(b1)[0]:+.2f}, {100 * ci(b1)[1]:+.2f}]; halves {100 * hv[0]:+.2f} / {100 * hv[1]:+.2f}')
print(f'T2 model vs HAR-X + clock: {100 * t2:+.2f} percent, CI97.5 [{100 * ci(b2)[0]:+.2f}, {100 * ci(b2)[1]:+.2f}]   (explore replay claim: +24.9 percent)')
lead = ci(b1)[0] > 0 and hv[0] > 0 and hv[1] > 0
print('VERDICT (prereg section 3): ' + ('LEAD' if lead else 'NOT SHOWN') + f'  [T1 lower bound above 0: {ci(b1)[0] > 0}; halves both positive: {hv[0] > 0 and hv[1] > 0}]' + ('   (explore_check: in-sample regression check, not a result)' if A.window == 'explore_check' else ''))
print('\n--- REPORTED, NOT COUNTED ---'); adr_med = df.drop_duplicates('date').adr.median(); print(f'median ADR in this window {adr_med:.1f} points (explore era median {REF.drop_duplicates("date").adr.median():.1f})')
for T, x in df.groupby('T'): print(f'  T={int(T):3d}: n {len(x)}, vs hard {100 * (x.l3.sum() - x.l2.sum()) / x.l3.sum():+.2f}%, vs HAR-X+clock {100 * (x.l0.sum() - x.l2.sum()) / x.l0.sum():+.2f}%')
df['half'] = df.date.str[:4] + np.where(df.date.str[5:7].astype(int) <= 6, 'H1', 'H2')
for k, x in df.groupby('half'): print(f'  {k}: days {x.date.nunique()}, vs hard {100 * (x.l3.sum() - x.l2.sum()) / x.l3.sum():+.2f}%, vs HAR-X+clock {100 * (x.l0.sum() - x.l2.sum()) / x.l0.sum():+.2f}%')
for nm, c in (('model', 'p2'), ('hard baseline', 'p3'), ('HAR-X+clock', 'p0')): e = np.abs(df.adr * np.exp(df.y) - df.adr * np.exp(df[c])); print(f'  mean absolute error, {nm}: {e.mean():.1f} points; correlation with realized {np.corrcoef(df[c], df.y)[0, 1]:.3f}')
sl = np.polyfit(df.p2, df.y, 1)[0]; print(f'  calibration slope of realized on predicted (1.0 = calibrated): {sl:.3f}'); w = (g.l2 < g.l3).mean(); print(f'  share of days the model beats the hard baseline: {100 * w:.1f}%')
