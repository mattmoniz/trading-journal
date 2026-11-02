"""Learning loop of the shadow forecast service (docs/FORECAST_SERVICE_20261102.md rules 1-5, amended 2026-11-02 after DeepSeek round D). Run weekly (Sunday, run_weekly_backtests.sh); prints COUNTS until the first look, never a skill statistic before it.
CALENDAR (non-overlapping, so the protection against optional stopping is real): forward trading days are counted in order. Look i (0, 1, 2, ...) needs 20 x (i + 2) COMPLETE validated forward days; its HELD-OUT span is days [20 x (i + 1), 20 x (i + 2)) and every model it evaluates is trained
ONLY on explore points plus forward days BEFORE that span (a point on or before a model's trained_through is never evaluated). Look 0 (day 40) is also the champion's forward confirmation F1/F1b (docs/FORECAST_SERVICE_20261102.md).
Each look: trains a CHALLENGER on the pre-span data, evaluates CHAMPION, CHALLENGER, PERSIST (ridge on rr15/rr30/rr60 + clock) and a clock-bucket baseline by out-of-sample Spearman with E_h, day-blocked bootstrap CI and a date-permutation p for challenger minus champion; a challenger replaces the
champion only if the CI lower bound > 0 AND p < 0.05 AND the last promotion was at least 28 days ago; one ledger row per look (family forecast_learning_loop); decay alarm: the champion's Spearman on the span below the 5th percentile of the explore rolling-20-date Spearman raises an OPEN_DECISION.
Usage: ../../venv/bin/python forecast_loop.py [--status] [--dry]"""
import sys, os, json, subprocess, datetime
_argv = sys.argv[:]; sys.argv = sys.argv[:1]
import numpy as np, pandas as pd
from scipy.stats import rankdata
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/ml_meta_labeling')
import forecast_train as FT, forecast_features as FF, run_p2b as P
from db import get_connection
sys.argv = _argv
H, SPAN, BOOT, DRAWS, SEED, PROMO_GAP_DAYS, FAMILY = 30, 20, 3000, 1000, 20261102, 28, 'forecast_learning_loop'
PERSIST_NAMES = ['rr15', 'rr30', 'rr60'] + [f'bucket_{b}' for b in range(1, 10)] + [f'dow_{w}' for w in range(1, 5)]
rho = lambda a, b: float(np.corrcoef(rankdata(a), rankdata(b))[0, 1])

def complete_days(conn, h=H):
    """forward trading days whose every validated point has a complete h-minute window, in order."""
    cur = conn.cursor(); cur.execute("SELECT trade_date::text, count(*), count(*) FILTER (WHERE (realized->>%s) IS NOT NULL) FROM forecast_points WHERE validated GROUP BY trade_date ORDER BY 1", (str(h),))
    return [d for d, n, k in cur.fetchall() if n > 0 and n == k]

def looks_done(conn):
    cur = conn.cursor(); cur.execute("SELECT count(*) FROM research_looks WHERE family=%s", (FAMILY,)); return int(cur.fetchone()[0])

def span_for(i): return 20 * (i + 1), 20 * (i + 2)      # [start, end) indices into the complete forward days

def span_frame(conn, days, h=H):
    """all complete validated points on the given days, with raw features and realized E_h."""
    cur = conn.cursor(); cur.execute("SELECT trade_date::text, features, realized FROM forecast_points WHERE validated AND trade_date = ANY(%s::date[]) AND (realized->>%s) IS NOT NULL ORDER BY trade_date, bar_idx", (days, str(h))); rows = []
    for d, f, rz in cur.fetchall():
        f = f if isinstance(f, dict) else json.loads(f); rz = rz if isinstance(rz, dict) else json.loads(rz); r = {k: f[k] for k in FF.CONT + ['bucket', 'dow']}; r['date'] = d; r[f'E{h}'] = float(rz[str(h)]); rows.append(r)
    return pd.DataFrame(rows)

def evaluable(df, trained_through):
    """the guard: points on or before a model's trained_through are never evaluated."""
    return df[df.date > str(trained_through)].reset_index(drop=True)

def model_preds(df, params):
    return np.array([FT.predict(params, r) for r in df.to_dict('records')])

def day_blocked(df, pa, pb, y, seed):
    """Spearman(a, y), Spearman(b, y), the a-b difference with a day-blocked bootstrap CI and a date-permutation p (target permuted across days, predictions fixed)."""
    rng = np.random.default_rng(seed); days = df.date.values; ud = np.unique(days); idx = [np.where(days == d)[0] for d in ud]; ra, rb = rho(pa, y), rho(pb, y); boots = []
    for _ in range(BOOT): ix = np.concatenate([idx[j] for j in rng.integers(0, len(ud), len(ud))]); boots.append(rho(pa[ix], y[ix]) - rho(pb[ix], y[ix]))
    nulls = []
    for _ in range(DRAWS):
        perm = rng.permutation(len(ud)); src = np.zeros(len(y), int)
        for k, d in enumerate(ud): ia, ib = idx[k], idx[perm[k]]; src[ia] = ib[np.arange(len(ia)) % len(ib)]
        nulls.append(rho(pa, y[src]) - rho(pb, y[src]))
    lo, hi = np.percentile(boots, [2.5, 97.5]); return dict(ra=ra, rb=rb, diff=ra - rb, lo=float(lo), hi=float(hi), p=float((np.sum(np.array(nulls) >= ra - rb) + 1) / (DRAWS + 1)))

def decay_floor(conn, champ_id, notes, h=H):
    """5th percentile of the explore rolling-20-date Spearman (the walk-forward no-tell forecast), stored once in the champion's notes."""
    if 'decay_floor' in notes: return float(notes['decay_floor'])
    import walkforward_forecast as WF
    df = FT.explore_frame(h); dates = [str(x) for x in sorted(df.date.unique())]; pos = {d: k for k, d in enumerate(dates)}; R = df[df.date.map(lambda d: WF.block_of(pos[d]) is not None)].copy(); R['blk'] = R.date.map(lambda d: WF.block_of(pos[d])); lf = WF.block_forecasts(df, dates, R)
    rolling = []; ds = sorted(R.date.unique())
    for k in range(0, len(ds) - SPAN + 1, 5):
        m = R.date.isin(ds[k:k + SPAN]).values; rolling.append(rho(lf[m], R[f'E{h}'].values[m]))
    fl = float(np.percentile(rolling, 5)); cur = conn.cursor(); cur.execute("UPDATE forecast_models SET notes = COALESCE(notes,'{}'::jsonb) || %s::jsonb WHERE id=%s", (json.dumps(dict(decay_floor=fl, decay_floor_windows=len(rolling))), champ_id)); conn.commit(); return fl

def flag(slug, text, priority='MEDIUM'):
    subprocess.run(['node', '/home/mmoniz/trading-journal/scripts/flag_decision.mjs', '--add', json.dumps(dict(slug=slug, priority=priority, sourceFile='docs/FORECAST_SERVICE_20261102.md', sourceDate=str(datetime.date.today()), decisionText=text))], capture_output=True, text=True)

def run_look(conn, days, i, dry=False, h=H):
    """one look: train the challenger on data strictly before the span, evaluate on the span, apply the promotion rule and the decay alarm."""
    a, b = span_for(i); span_days = days[a:b]; through = days[a - 1]; cur = conn.cursor(); cur.execute("SELECT id, version, params, notes, trained_through::text, created_at::date::text FROM forecast_models WHERE role='CHAMPION' AND horizon_min=%s", (h,)); champ = cur.fetchone()
    if champ is None: return dict(error='no champion registered')
    cid, cver, cparams, cnotes, cthrough, cdate = champ; cparams = cparams if isinstance(cparams, dict) else json.loads(cparams); cnotes = cnotes if isinstance(cnotes, dict) else (json.loads(cnotes) if cnotes else {})
    df_tr, info = FT.training_frame(conn, h, through); assert str(df_tr.date.max()) <= max(through, info['explore_through']) and df_tr.date[df_tr.date > info['explore_through']].max() <= through if info['forward_n'] else True
    chal = FT.fit(df_tr, h); pers = FT.fit(df_tr, h, PERSIST_NAMES); sp = span_frame(conn, span_days, h); assert len(sp) and sp.date.min() > str(through), 'held-out span overlaps the training data'
    bucket_mean = df_tr.groupby('bucket')[f'E{h}'].mean(); gm = df_tr[f'E{h}'].mean(); clock = np.array([bucket_mean.get(r['bucket'], gm) for r in sp.to_dict('records')])
    ev = evaluable(sp, cthrough); y = sp[f'E{h}'].values; pc = model_preds(sp, cparams); pn = model_preds(sp, chal); pp = model_preds(sp, pers)
    assert len(ev) == len(sp), 'the champion trained through a date inside the span'
    cmp_chal = day_blocked(sp, pn, pc, y, SEED + i); cmp_pers = day_blocked(sp, pc, pp, y, SEED + 100 + i); r_clock = rho(clock, y)
    floor = decay_floor(conn, cid, cnotes, h); r_champ = rho(pc, y); days_since = (datetime.date.today() - datetime.date.fromisoformat(cnotes.get('promoted_at', cdate))).days
    promote = cmp_chal['lo'] > 0 and cmp_chal['p'] < 0.05 and days_since >= PROMO_GAP_DAYS; decay = r_champ < floor
    res = dict(look=i, span=f'{span_days[0]}..{span_days[-1]}', n_points=len(sp), n_days=len(span_days), trained_through=through, champion=cver, r_champion=r_champ, r_challenger=cmp_chal['ra'], r_persist=rho(pp, y), r_clock=r_clock, challenger_minus_champion=cmp_chal,
               champion_minus_persist=cmp_pers, promote=bool(promote), days_since_promotion=days_since, decay_floor=floor, decay_alarm=bool(decay), train_info=info)
    if dry: return res
    version, th = FT.register(conn, h, 'CHALLENGER', df_tr, chal, info, dict(look=i, role_note='trained strictly before the held-out span'))
    if promote:
        cur.execute("UPDATE forecast_models SET role='RETIRED' WHERE id=%s", (cid,)); cur.execute("UPDATE forecast_models SET role='CHAMPION', notes = COALESCE(notes,'{}'::jsonb) || %s::jsonb WHERE version=%s", (json.dumps(dict(promoted_at=str(datetime.date.today()), promoted_from=cver, look=i)), version)); conn.commit()
    res['challenger'] = version
    text = f"look {i} span {res['span']} ({len(sp)} points): Spearman champion {r_champ:+.4f}, challenger {cmp_chal['ra']:+.4f}, PERSIST {res['r_persist']:+.4f}, clock {r_clock:+.4f}; challenger minus champion {cmp_chal['diff']:+.4f} CI [{cmp_chal['lo']:+.4f}, {cmp_chal['hi']:+.4f}] p {cmp_chal['p']:.3f}; champion minus PERSIST {cmp_pers['diff']:+.4f} CI [{cmp_pers['lo']:+.4f}, {cmp_pers['hi']:+.4f}]; promote={promote}; decay floor {floor:+.3f} alarm={decay}"
    cur.execute("""INSERT INTO research_looks (family, data_window, window_kind, tests, label, script, prereg, outcome, ref, notes) VALUES (%s,%s,'FORWARD',%s,%s,%s,%s,%s,%s,%s::jsonb) ON CONFLICT (ref) DO NOTHING""",
                (FAMILY, f'forward days {span_days[0]}..{span_days[-1]}', 2, f'forecast learning loop look {i}: challenger vs champion, champion vs PERSIST', 'scripts/amt_context/forecast_loop.py', 'docs/FORECAST_SERVICE_20261102.md', ('PROMOTED' if promote else 'KEPT') + (' DECAY_ALARM' if decay else ''), f'forecast_loop_look_{i}', json.dumps(res, default=str))); conn.commit()
    flag(f'forecast_loop_look_{i}_result', 'READ ONCE: ' + text, 'MEDIUM')
    if decay: flag(f'forecast_decay_alarm_look_{i}', f'The champion forecast fell below the data-derived decay floor ({floor:+.3f}) on forward days {res["span"]}: ' + text, 'HIGH')
    return res

def main():
    status_only = '--status' in sys.argv; dry = '--dry' in sys.argv; conn = get_connection(); days = complete_days(conn); i = looks_done(conn); need = 20 * (i + 2)
    print(f'forecast learning loop: {len(days)} complete forward days; looks done {i}; look {i} needs {need} complete days (held-out span = days {span_for(i)[0] + 1}..{need}).')
    if len(days) < need or status_only:
        print('waiting for forward data: no skill statistic is computed or printed before the look.' if len(days) < need else 'status only.'); conn.close(); return
    res = run_look(conn, days, i, dry=dry); conn.close(); print(json.dumps(res, indent=1, default=str)[:3000])

if __name__ == '__main__': main()
