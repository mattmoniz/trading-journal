"""Train and register a forecast model version (docs/FORECAST_SERVICE_20261102.md). Ridge on log E_h with the study's activity features, alpha by time-ordered inner CV (run_p2b.choose_alpha). Reads explore
decision points (through 2025-05-16) and, from `forecast_points`, any forward points whose window has completed. Usage: ../../venv/bin/python forecast_train.py HORIZON_MIN [--role CHAMPION|CHALLENGER] [--dry]"""
import sys, json, hashlib, datetime
import numpy as np, pandas as pd
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/ml_meta_labeling')
import run_p2b as P, forecast_features as FF, tell_state as TS
from db import get_connection

def explore_frame(h):
    _, ctxs, _ = TS.sessions_and_contexts(); df = P.build_points(ctxs, horizons=(h,)); return df[df[f'full{h}']].reset_index(drop=True)

def X_of(df):
    rows = df.to_dict('records'); return np.vstack([FF.vector(r) for r in rows])

def fit(df, h):
    X = X_of(df); y = np.log(np.maximum(df[f'E{h}'].values, 1e-4)); mu, sd = X.mean(0), X.std(0); sd[sd == 0] = 1.0; Z = (X - mu) / sd
    a = P.choose_alpha(Z, y, df['date'].values); ym = float(y.mean()); w = P.ridge_solve(Z.T @ Z, Z.T @ (y - ym), a)
    return dict(alpha=a, ym=ym, mu=mu.tolist(), sd=sd.tolist(), coef=w.tolist())

def main():
    h = int(sys.argv[1]); role = sys.argv[sys.argv.index('--role') + 1] if '--role' in sys.argv else 'CHAMPION'; dry = '--dry' in sys.argv
    df = explore_frame(h); params = fit(df, h); through = str(df.date.max())
    version = f'ridge-act-h{h}-{through}-' + hashlib.sha256(json.dumps(params, sort_keys=True).encode()).hexdigest()[:8]
    print(f'horizon {h} min: trained on {len(df)} explore points on {df.date.nunique()} dates through {through}; alpha {params["alpha"]}; version {version}')
    if dry: return
    conn = get_connection(); cur = conn.cursor()
    cur.execute("""INSERT INTO forecast_models (version, horizon_min, role, trained_through, train_n, feature_names, params, notes) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (version) DO NOTHING""", (version, h, role, through, len(df), json.dumps(FF.FEATURE_NAMES), json.dumps(params), json.dumps(dict(source='explore decision grid, no forward points yet', study='scripts/amt_context/PREREG_ROSTER_CONTEXT.md'))))
    conn.commit(); conn.close(); print('registered', version, role)

if __name__ == '__main__': main()
