"""Nightly cycle of the next-hour RANGE shadow model (docs/STRUCTURE_SHADOW_MODEL_DESIGN_20261105.md). Called from scripts/run_daily_calibration.sh (8:20 PM ET Mon-Fri, after the close). SHADOW ONLY: it reads bars, ticks and the HAR history, never a trade or a P&L, and nothing reads its output for a decision.
Order, every night: (1) PREDICT today's four rows (10:30, 11:30, 13:00, 14:30) with the latest model artifact that was FROZEN BEFORE the session (artifact trained_at earlier than the 09:30 open; a day with no such artifact is simply not a forward row), features from data before each decision minute only;
(2) LABEL every finished row (the realized next-hour range) in a separate step that never touches a prediction; (3) REFIT the champion (ridge, M2 features) and the HAR-X + clock baseline on the explore rows + every labelled forward row and freeze them as a new artifact (never changed during a session);
(4) export the labelled forward rows and rebuild public/structure_model.json. A failed day is logged and retried next night and never fails the daily job. Prints COUNTS only (no skill statistic), so nightly runs cannot cause optional stopping (cv-006).
Usage: venv/bin/python scripts/structure_model/run_nightly.py [--date YYYY-MM-DD] [--rehearsal] [--no-refit]    (--rehearsal: compute and print one day with the latest artifact, writes nothing)"""
import os, sys, json, glob, subprocess, datetime, argparse
import numpy as np, pandas as pd
from zoneinfo import ZoneInfo
HERE = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.abspath(os.path.join(HERE, '..', '..')); sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(REPO, 'scripts'))
import features as F, ticks_live as TL
from ml_meta_labeling.db import get_connection
ET = ZoneInfo('America/New_York'); WORK = os.path.join(REPO, 'scratch', 'structure_model_20261105'); MODELS = os.path.join(WORK, 'models'); os.makedirs(MODELS, exist_ok=True)
EXPLORE = os.path.join(WORK, 'explore_features.csv'); N_EXPLORE_DAYS = int(pd.read_csv(EXPLORE, usecols=['di']).di.max()) + 1                  # derived from the explore rows, not hardcoded (DeepSeek round Z)
ap = argparse.ArgumentParser(); ap.add_argument('--date'); ap.add_argument('--rehearsal', action='store_true'); ap.add_argument('--no-refit', action='store_true'); A = ap.parse_args()


def now_et(): return datetime.datetime.now(ET).replace(tzinfo=None, microsecond=0)


def session_bars(cur, d):
    cur.execute("SELECT (EXTRACT(hour FROM ts)::int * 60 + EXTRACT(minute FROM ts)::int - 570) AS m, open::float, high::float, low::float, close::float FROM price_bars_primary WHERE symbol='NQ' AND ts >= %s::timestamp + interval '9 hours 30 minutes' AND ts < %s::timestamp + interval '16 hours' ORDER BY ts", (d, d))
    rows = cur.fetchall(); b = {k: np.full(390, np.nan) for k in ('o', 'h', 'l', 'c')}
    for m, o, h, l, c in rows:
        if 0 <= m < 390: b['o'][m], b['h'][m], b['l'][m], b['c'][m] = o, h, l, c
    return b if len(rows) >= 385 else None


def prior_ranges(cur, d, n=22):
    cur.execute("SELECT trade_date::text, rth_range::float FROM daily_rth_stats WHERE trade_date < %s::date AND n_bars >= 385 ORDER BY trade_date DESC LIMIT %s", (d, n)); r = cur.fetchall()[::-1]; return [x[0] for x in r], [x[1] for x in r]


def overnight_range(cur, d):
    cur.execute("SELECT MAX(high)::float - MIN(low)::float FROM price_bars_primary WHERE symbol='NQ' AND ts >= (%s::date - 1)::timestamp + interval '18 hours' AND ts < %s::timestamp + interval '9 hours 30 minutes'", (d, d)); return cur.fetchone()[0]


def legs_for(d, adr):
    out = subprocess.run(['node', os.path.join(HERE, 'legs_helper.mjs'), d], capture_output=True, text=True, cwd=REPO); j = json.loads(out.stdout.strip().split('\n')[-1]); g = F.leg_grid_size(adr); return {T: j[str(T)][str(g)] for T in F.TIMES}


def day_rows(conn, d):
    """The four feature rows of day d from live inputs, or (None, reason)."""
    cur = conn.cursor(); b = session_bars(cur, d)
    if b is None: return None, 'no complete RTH session in the database'
    dates22, r22 = prior_ranges(cur, d)
    if len(r22) < 22: return None, 'fewer than 22 prior sessions'
    adr = float(np.median(r22[-20:])); on = overnight_range(cur, d)
    if on is None: return None, 'no overnight bars'
    k, note = TL.extract(conn, d)
    if k is None: return None, 'ticks: ' + note
    prior = []
    for p in dates22[-20:]:
        pk, _n = TL.extract(conn, p); pb = session_bars(cur, p)
        if pk is not None and pb is not None: prior.append(dict(h=pb['h'], l=pb['l'], vol=pk['vol']))
    if len(prior) < 15: return None, f'only {len(prior)} prior sessions have valid ticks'
    try: rows = F.feature_rows(b, adr, F.har_features(r22, adr, on), k, prior, legs_for(d, adr))
    except ValueError as e: return None, str(e)
    return (rows, adr, b), f'{note}; {len(prior)}/20 prior sessions with valid ticks'


def artifacts(): return sorted(glob.glob(os.path.join(MODELS, 'model_*.json')))


def frozen_before(ts):
    """The latest artifact fitted before the timestamp ts (naive ET)."""
    ok = [json.load(open(p)) for p in artifacts()]; ok = [m for m in ok if m['trained_at'] < ts.isoformat(timespec='seconds')]; return ok[-1] if ok else None


def refit(conn):
    cur = conn.cursor(); E = pd.read_csv(EXPLORE); cur.execute("SELECT trade_date::text, decision_min, features, y FROM structure_model_rows WHERE y IS NOT NULL ORDER BY trade_date, decision_min"); fw = cur.fetchall()
    X = E[F.M2_COLS].values.astype(float); y = E.y.values; di = E.di.values.astype(int); fdays = sorted({r[0] for r in fw}); idx = {d: N_EXPLORE_DAYS + j for j, d in enumerate(fdays)}
    if fw:
        X = np.vstack([X, np.array([[r[2][c] for c in F.M2_COLS] for r in fw], float)]); y = np.concatenate([y, [r[3] for r in fw]]); di = np.concatenate([di, [idx[r[0]] for r in fw]])
    Xb = X[:, [F.M2_COLS.index(c) for c in F.BASE_COLS]]; Xp = X[:, [F.M2_COLS.index(c) for c in F.PERSIST_COLS]]; m2 = F.fit(X, y, di); mb = F.fit(Xb, y, di); mp = F.fit(Xp, y, di); t = now_et(); through = fdays[-1] if fdays else '2025-05-16'
    art = dict(version=f'ridge-m2-{through}-{F.code_hash()[:8]}', trained_at=t.isoformat(timespec='seconds'), trained_through=through, n_rows=int(len(y)), n_forward_rows=len(fw), code_hash=F.code_hash(), m2=m2, base=mb, persist=mp, m2_cols=F.M2_COLS, base_cols=F.BASE_COLS, persist_cols=F.PERSIST_COLS)
    json.dump(art, open(os.path.join(MODELS, 'model_' + t.strftime('%Y%m%d_%H%M%S') + datetime.datetime.now().strftime('_%f') + '.json'), 'w')); return art


def predict_day(conn, d, rehearsal=False):
    res, note = day_rows(conn, d)
    if res is None: print(f'  {d}: no rows ({note})'); return 0
    rows, adr, b = res; session_open = datetime.datetime.fromisoformat(d + 'T09:30:00')
    art = (json.load(open(artifacts()[-1])) if artifacts() else None) if rehearsal else frozen_before(session_open)
    if art is None: print(f'  {d}: no artifact was frozen before the session: not a forward row'); return 0
    cur = conn.cursor(); n = 0
    for r in rows:
        x = np.array([r[c] for c in F.M2_COLS]); xb = np.array([r[c] for c in F.BASE_COLS]); xp = np.array([r[c] for c in F.PERSIST_COLS]); p2 = float(F.predict(art['m2'], x)); p0 = float(F.predict(art['base'], xb)); p3 = float(F.predict(art['persist'], xp))
        if rehearsal: print(f"  {d} T={r['T']:3d}: model range {adr * np.exp(p2):6.1f} pts, baseline {adr * np.exp(p0):6.1f} pts, persistence baseline {adr * np.exp(p3):6.1f} pts, realized {adr * np.exp(F.label(b, r['T'], adr)):6.1f} pts"); continue
        cur.execute("INSERT INTO structure_model_rows (trade_date, decision_min, model_version, code_hash, adr, features, pred_ln, base_ln, base2_ln) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (trade_date, decision_min) DO NOTHING", (d, r['T'], art['version'], F.code_hash(), adr, json.dumps({c: r[c] for c in F.M2_COLS}, ), p2, p0, p3)); n += cur.rowcount
        if cur.rowcount == 0:                                                                                  # a re-run never overwrites a frozen prediction; say so when it WOULD have been a different model
            cur.execute("SELECT model_version, code_hash FROM structure_model_rows WHERE trade_date = %s AND decision_min = %s", (d, r['T'])); old = cur.fetchone()
            if old and (old[0] != art['version'] or old[1] != F.code_hash()): print(f"  WARNING {d} T={r['T']}: row already exists from {old[0]} (code {old[1][:8]}); kept, not replaced by {art['version']}")
    if not rehearsal: conn.commit(); print(f'  {d}: {n} new forward rows (model {art["version"]}; {note})')
    return n


def label_pending(conn):
    cur = conn.cursor(); cur.execute("SELECT trade_date::text, decision_min, adr FROM structure_model_rows WHERE y IS NULL ORDER BY trade_date, decision_min"); todo = cur.fetchall(); n = 0; cache = {}
    for d, T, adr in todo:
        if d not in cache: cache[d] = session_bars(cur, d)
        b = cache[d]
        if b is None or np.isnan(b['h'][T:T + 60]).any(): continue                                   # the hour has not finished (or bars are missing): never impute
        y = F.label(b, T, adr); cur.execute("UPDATE structure_model_rows SET y = %s, realized_pts = %s, labelled_at = localtimestamp WHERE trade_date = %s AND decision_min = %s AND y IS NULL", (y, adr * float(np.exp(y)), d, T)); n += cur.rowcount
    conn.commit(); return n, len(todo) - n


def export_forward(conn):
    cur = conn.cursor(); cur.execute("SELECT trade_date::text, decision_min, y, base_ln, pred_ln, base2_ln, adr FROM structure_model_rows WHERE y IS NOT NULL ORDER BY trade_date, decision_min")
    pd.DataFrame(cur.fetchall(), columns=['date', 'T', 'y', 'p0', 'p2', 'p3', 'adr']).to_csv(os.path.join(WORK, 'forward_rows.csv'), index=False)


if __name__ == '__main__':
    conn = get_connection(); today = A.date or datetime.datetime.now(ET).date().isoformat(); print(f'structure model nightly: {today}{" (rehearsal)" if A.rehearsal else ""}')
    booted = False
    if not artifacts() and not A.rehearsal: booted = True; art = refit(conn); print(f'  no artifact existed: fitted v0 {art["version"]} on {art["n_rows"]} explore rows (frozen now; the first forward session is the next one that opens after {art["trained_at"]})')
    if A.rehearsal: predict_day(conn, today, True); sys.exit(0)
    if datetime.date.fromisoformat(today).weekday() < 5: predict_day(conn, today)
    nl, left = label_pending(conn); print(f'  labelled {nl} rows ({left} rows still waiting for their hour to finish)')
    if not A.no_refit and not booted: art = refit(conn); print(f'  refit and froze {art["version"]} on {art["n_rows"]} rows ({art["n_forward_rows"]} forward)')
    export_forward(conn); subprocess.run([sys.executable, os.path.join(HERE, 'build_payload.py')], cwd=REPO)
    cur = conn.cursor(); cur.execute("SELECT COUNT(*), COUNT(DISTINCT trade_date), COUNT(y) FROM structure_model_rows"); n_, nd, nlab = cur.fetchone(); print(f'  forward rows so far: {n_} on {nd} days, {nlab} labelled')
