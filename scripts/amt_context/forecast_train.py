"""Train and register a forecast model version (docs/FORECAST_SERVICE_20261102.md). Ridge on log E_h with the study's activity features, alpha by time-ordered inner CV (run_p2b.choose_alpha).
Training data = the explore decision grid (through 2025-05-16, cached on disk, immutable) PLUS, when --through DATE is given, every COMPLETE and VALIDATED forward point in `forecast_points` with trade_date <= DATE (the learning loop's
data path; 2026-11-02: before this the script read explore points only, so a retrain reproduced the champion). Every registered model carries trained_through = the last date of data used, so an evaluator can refuse any point on or before it.
Usage: ../../venv/bin/python forecast_train.py HORIZON_MIN [--role CHAMPION|CHALLENGER] [--through DATE] [--dry]"""
import sys, os, json, hashlib, pickle
_argv = sys.argv[:]; sys.argv = sys.argv[:1]           # run_p2b reads sys.argv[1] at import time
import numpy as np, pandas as pd
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/ml_meta_labeling')
import run_p2b as P, forecast_features as FF, tell_state as TS
from db import get_connection
sys.argv = _argv
CACHE = '/home/mmoniz/trading-journal/scratch/forecast_explore_frame_h{h}.pkl'

def explore_frame(h):
    """explore decision points with complete h-minute windows; cached (the explore data never changes; the cache key is the feature-name list)."""
    path = CACHE.format(h=h); key = hashlib.sha256(json.dumps(FF.FEATURE_NAMES).encode()).hexdigest()[:8]
    if os.path.exists(path):
        c = pickle.load(open(path, 'rb'))
        if c.get('key') == key: return c['df']
    _, ctxs, _ = TS.sessions_and_contexts(); df = P.build_points(ctxs, horizons=(h,)); df = df[df[f'full{h}']].reset_index(drop=True)
    pickle.dump(dict(key=key, df=df), open(path, 'wb')); return df

def forward_frame(conn, h, through):
    """complete, validated forward points on or before `through` (a date string), as the same row format the explore frame has. Never includes a point after `through`."""
    cur = conn.cursor()
    cur.execute("SELECT trade_date::text, features, realized FROM forecast_points WHERE validated AND trade_date <= %s::date AND (realized->>%s) IS NOT NULL ORDER BY trade_date, bar_idx", (through, str(h)))
    rows = []
    for d, f, rz in cur.fetchall():
        f = f if isinstance(f, dict) else json.loads(f); rz = rz if isinstance(rz, dict) else json.loads(rz); r = {k: f[k] for k in FF.CONT + ['bucket', 'dow']}; r['date'] = d; r[f'E{h}'] = float(rz[str(h)]); rows.append(r)
    return pd.DataFrame(rows)

def training_frame(conn, h, through=None):
    """(df, info): explore points, plus forward points <= through when given."""
    ex = explore_frame(h); info = dict(explore_n=int(len(ex)), explore_through=str(ex.date.max()), forward_n=0, forward_days=0)
    if through is None: return ex, info
    fw = forward_frame(conn, h, through)
    if len(fw): info.update(forward_n=int(len(fw)), forward_days=int(fw.date.nunique()), forward_through=str(fw.date.max()))
    cols = FF.CONT + ['bucket', 'dow', 'date', f'E{h}']; df = pd.concat([ex[cols], fw[cols]], ignore_index=True) if len(fw) else ex[cols]
    assert len(fw) == 0 or str(fw.date.max()) <= through, 'a forward point after the cutoff entered the training frame'
    return df, info

def X_of(df):
    return np.vstack([FF.vector(r) for r in df.to_dict('records')])

def fit(df, h, names=None):
    """ridge on log E_h. names = optional subset of FF.FEATURE_NAMES (the PERSIST baseline uses the trailing ranges + clock only)."""
    X = X_of(df); idx = list(range(X.shape[1])) if names is None else [FF.FEATURE_NAMES.index(n) for n in names]; X = X[:, idx]
    y = np.log(np.maximum(df[f'E{h}'].values, 1e-4)); mu, sd = X.mean(0), X.std(0); sd[sd == 0] = 1.0; Z = (X - mu) / sd
    a = P.choose_alpha(Z, y, df['date'].values); ym = float(y.mean()); w = P.ridge_solve(Z.T @ Z, Z.T @ (y - ym), a)
    p = dict(alpha=a, ym=ym, mu=mu.tolist(), sd=sd.tolist(), coef=w.tolist())
    if names is not None: p['names'] = list(names)
    return p

def predict(params, row):
    """log-forecast from stored params for a raw feature row; handles the subset models."""
    v = FF.vector(row)
    if 'names' in params: v = v[[FF.FEATURE_NAMES.index(n) for n in params['names']]]
    z = (v - np.array(params['mu'])) / np.array(params['sd']); return float(params['ym'] + z @ np.array(params['coef']))

def register(conn, h, role, df, params, info, notes_extra=None):
    through = info.get('forward_through') or info['explore_through']; through = max(through, info['explore_through'])
    version = f'ridge-act-h{h}-{through}-' + hashlib.sha256(json.dumps(params, sort_keys=True).encode()).hexdigest()[:8]; cur = conn.cursor()
    notes = dict(source='explore decision grid' + (' plus forward points' if info['forward_n'] else ', no forward points'), **info, **(notes_extra or {}))
    cur.execute("""INSERT INTO forecast_models (version, horizon_min, role, trained_through, train_n, feature_names, params, notes) VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (version) DO NOTHING""",
                (version, h, role, through, len(df), json.dumps(FF.FEATURE_NAMES), json.dumps(params), json.dumps(notes))); conn.commit(); return version, through

def main():
    h = int(sys.argv[1]); role = sys.argv[sys.argv.index('--role') + 1] if '--role' in sys.argv else 'CHAMPION'; dry = '--dry' in sys.argv; through = sys.argv[sys.argv.index('--through') + 1] if '--through' in sys.argv else None
    conn = get_connection(); df, info = training_frame(conn, h, through); params = fit(df, h)
    print(f'horizon {h} min: trained on {len(df)} points ({info["explore_n"]} explore through {info["explore_through"]}, {info["forward_n"]} forward on {info["forward_days"]} days); alpha {params["alpha"]}')
    if dry: conn.close(); return
    version, th = register(conn, h, role, df, params, info); conn.close(); print('registered', version, role, 'trained_through', th)

if __name__ == '__main__': main()
