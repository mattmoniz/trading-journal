"""Nightly outcome-blind forecast tagger (docs/FORECAST_SERVICE_20261102.md). For one COMPLETED trade date: rebuild the 500-contract bars with the sidecar's validated builder (bootstrap.build_sessions, as tag_flips_day.py does),
compute the champion/challenger busy-or-quiet forecast at (a) every decision-grid bar -> forecast_points (with the realized travel once the window completed: PRICE data only, never P&L) and (b) the time of every RTH roster fire
(ACTIVE and SHADOW primaries) and every V1 tell trade -> forecast_tags. NEVER reads P&L or any trade outcome column. No order impact, no live-path change.
Usage: python3 forecast_tag_day.py DATE [--dry]   (idempotent upserts)"""
import os, sys, json, datetime
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, '..', 'amt_tell_live')); sys.path.insert(0, os.path.join(HERE, '..', 'amt_vbars'))
import persist, bootstrap, core
import vbars as V, forecast_features as FF, tell_state as TS
RULE = 'split'; PRIMARY = (V.DEC_FIRST, V.DEC_LAST)

def load_models(conn):
    with conn.cursor() as c: c.execute("SELECT version, horizon_min, role, params FROM forecast_models WHERE role IN ('CHAMPION','CHALLENGER') ORDER BY id"); return [(v, int(h), r, p if isinstance(p, dict) else json.loads(p)) for v, h, r, p in c.fetchall()]

def preds_for(row, models):
    return {v: dict(h=h, role=r, log=lf, value=val) for v, h, r, p in models for lf, val in [FF.predict(p, row)]}

def realized(ctx, ts, horizons):
    S = ctx['S']; end, comp = S['end'], S['comp']; out = {}
    for h in horizons:
        hz = comp & (end > ts) & (end <= ts + h * 60.0); full = bool(end[comp].max() >= ts + h * 60.0 - 60.0)
        out[str(h)] = float((S['h'][hz].max() - S['l'][hz].min()) / ctx['atr']) if (hz.any() and full) else None
    return out

def main():
    d = sys.argv[1]; dry = '--dry' in sys.argv; conn = persist.connect(); dd = datetime.date.fromisoformat(d); dow = dd.weekday()
    models = load_models(conn)
    if not models: print(f'{d}: no champion forecast model registered yet (run forecast_train.py)'); sys.exit(4)
    horizons = sorted({h for _, h, _, _ in models})
    with conn.cursor() as c: c.execute("SELECT n_bars FROM amt_tell_sessions WHERE trade_date=%s AND bar_rule=%s", (d, RULE)); sr = c.fetchone()
    sess, ok, info = bootstrap.build_sessions(conn, d, [RULE])
    if sess is None: print(f'{d}: cannot rebuild bars ({info})'); sys.exit(2)
    s = sess[RULE]; n = len(s.sb.done); stored = sr[0] if sr else None
    print(f'{d}: rebuilt {n} bars (stored session n_bars {stored}), validated vs the database RTH volume: {ok}')
    if stored is not None and abs(stored - n) > 3: print('REFUSED: rebuilt bar count differs from the live session by more than 3 bars'); sys.exit(3)
    prior, _ = persist.load_prior_stats(conn, d, RULE); ctx = core.build_ctx(s.finished_bars(), d, prior)
    if ctx is None: print(f'{d}: no usable baseline / thin overnight, nothing tagged'); sys.exit(5)
    S = ctx['S']; end, comp = S['end'], S['comp']; nb = ctx['n']; pts = []
    for i in [i for i in range(V.MOVE_N, nb) if comp[i] and V.DEC_FIRST <= end[i] <= V.DEC_LAST][::V.THIN]:
        row = FF.activity_row(ctx, float(end[i]), dow)
        if row is None: continue
        pts.append((d, int(i), float(end[i]), {k: row[k] for k in row if k != 'i0'}, preds_for(row, models), realized(ctx, float(end[i]), horizons), bool(ok)))
    tags = []
    with conn.cursor() as c:
        c.execute("""SELECT id, setup_type, fired_at::text FROM active_setups WHERE trade_date = %s AND origin_status IN ('ACTIVE','SHADOW') AND is_cluster_primary AND is_rth ORDER BY id""", (d,)); fires = c.fetchall()
        c.execute("SELECT id, sig_idx FROM amt_tell_trades WHERE trade_date=%s AND bar_rule=%s AND book='V1' ORDER BY id", (d, RULE)); tells = c.fetchall()
    def add(kind, rid, stype, fired, ts):
        row = FF.activity_row(ctx, ts, dow)
        if row is None: return False
        tags.append((kind, rid, d, stype, fired, ts, row['i0'], PRIMARY[0] <= ts <= PRIMARY[1], {k: row[k] for k in row if k != 'i0'}, preds_for(row, models), bool(ok))); return True
    nf = sum(add('ROSTER_FIRE', rid, st, fa, TS.et_to_session_sec(fa.split(' ')[1])) for rid, st, fa in fires)
    nt = sum(add('TELL_TRADE', rid, 'AMT_TELL_V1', None, float(end[sig])) for rid, sig in tells if sig < nb)
    print(f'decision-grid points {len(pts)}; roster fires {len(fires)} (tagged {nf}); tell trades {len(tells)} (tagged {nt})')
    if dry: print('dry run, nothing written'); return
    with conn.cursor() as c:
        for p in pts:
            c.execute("""INSERT INTO forecast_points (trade_date, bar_idx, ts_sec, features, preds, realized, validated) VALUES (%s,%s,%s,%s,%s,%s,%s)
                         ON CONFLICT (trade_date, bar_idx) DO UPDATE SET preds = forecast_points.preds || EXCLUDED.preds, realized = EXCLUDED.realized, validated = EXCLUDED.validated""", (p[0], p[1], p[2], json.dumps(p[3]), json.dumps(p[4]), json.dumps(p[5]), p[6]))
        for t in tags:
            c.execute("""INSERT INTO forecast_tags (kind, ref_id, trade_date, setup_type, fired_at, ts_sec, bar_idx, in_primary_window, features, preds, validated) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                         ON CONFLICT (kind, ref_id) DO UPDATE SET preds = forecast_tags.preds || EXCLUDED.preds, features = EXCLUDED.features, validated = EXCLUDED.validated, tagged_at = now()""",
                      t[:8] + (json.dumps(t[8]), json.dumps(t[9]), t[10]))
    conn.commit(); print(f'wrote {len(pts)} points, {len(tags)} tags')

main()
