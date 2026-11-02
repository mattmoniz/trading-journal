"""Regime gauge, DAY part (docs/REGIME_GAUGE_20261102.md): a small ridge model of the RTH range (in ATR20 units) from information known at 09:25 ET: prior-day range, overnight range and volume (through 09:24), the pre-open gap, day of week. SHADOW: informs, never orders.
Features (all causal at 09:25): log(pdRangeAtr), onr = overnight (high - low) / ATR20, onv = log(overnight volume / mean overnight volume of the 20 prior valid days), gap_pre = |last pre-open close - prior RTH close| / ATR20, Tuesday..Friday dummies. Target: log(RTH range / ATR20) of the day.
Buckets QUIET / NORMAL / BUSY = terciles of the walk-forward out-of-sample predictions (expanding, strictly earlier days). The first 120 valid days only train; the model is refit every 10 days in the walk-forward and once on all complete days for live use."""
import sys, os, json, hashlib, datetime
_a = sys.argv[:]; sys.argv = sys.argv[:1]
import numpy as np
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/ml_meta_labeling'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_tell_live'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_context')
import run_p2b as P, persist
sys.argv = _a
ROOT = '/home/mmoniz/trading-journal'; CACHE = f'{ROOT}/scratch/regime_day_features_cache.json'; DATASET = f'{ROOT}/scratch/overnight_rth_dataset_20261026.json'; FIRST_TRAIN, STEP = 120, 10
NAMES = ['log_pdr', 'onr', 'onv', 'gap_pre', 'dow2', 'dow3', 'dow4', 'dow5']

def connect(): return persist.connect()

def stats(conn):
    cur = conn.cursor(); cur.execute("SELECT trade_date::text, rth_range::float, n_bars FROM daily_rth_stats WHERE trade_date >= '2023-02-01' ORDER BY trade_date"); return [(d, r, n) for d, r, n in cur.fetchall()]

def raw_day(conn, d, pd_):
    """overnight high/low/volume through 09:24, last pre-open close (09:20-09:24) and the prior RTH close, from price_bars_primary with both timestamp bounds (one query)."""
    cur = conn.cursor(); cur.execute("""SELECT max(high) FILTER (WHERE ts >= %s::timestamp), min(low) FILTER (WHERE ts >= %s::timestamp), sum(volume) FILTER (WHERE ts >= %s::timestamp), (array_agg(close ORDER BY ts) FILTER (WHERE ts >= %s::timestamp))[count(*) FILTER (WHERE ts >= %s::timestamp)],
        (array_agg(close ORDER BY ts) FILTER (WHERE ts < %s::timestamp))[count(*) FILTER (WHERE ts < %s::timestamp)], count(*) FILTER (WHERE ts >= %s::timestamp) FROM price_bars_primary WHERE symbol='NQ' AND ts >= %s::timestamp AND ts < %s::timestamp""",
        (f'{pd_} 18:00', f'{pd_} 18:00', f'{pd_} 18:00', f'{d} 09:20', f'{d} 09:20', f'{pd_} 16:00', f'{pd_} 16:00', f'{pd_} 18:00', f'{pd_} 15:50', f'{d} 09:25'))
    h, l, v, pre, pc, n = cur.fetchone(); return None if h is None or pc is None or pre is None else dict(h=float(h), l=float(l), vol=float(v or 0), pre=float(pre), pc=float(pc), n=int(n))

def load_cache(): return json.load(open(CACHE)) if os.path.exists(CACHE) else {}

def build_rows(conn, upto=None):
    """per valid date: raw features at 09:25 (cached; a date is cached once, its inputs never change) and the realized RTH range once the day is complete. Returns the ordered list of dicts."""
    st = stats(conn)
    if upto and st[-1][0] < upto: st.append((upto, 0.0, 0))          # today (or any date) not yet in daily_rth_stats: the day outlook only needs information known at 09:25
    cache = load_cache(); valid = set(r['date'] for r in json.load(open(DATASET))['rows']); out = []; changed = False
    for i in range(21, len(st)):
        d, rng, n = st[i]; pd_ = st[i - 1][0]
        if upto and d > upto: continue
        known_valid = d in valid or (d > '2026-10-23' and n >= 371) or d == upto
        if not known_valid and d not in cache: continue
        if d not in cache:
            rd = raw_day(conn, d, pd_)
            if rd is None: continue
            cache[d] = rd; changed = True
        out.append(dict(date=d, idx=i, atr=float(np.mean([x[1] for x in st[i - 20:i]])), pdr=st[i - 1][1], rng=rng if n >= 371 else None, raw=cache[d], dow=datetime.date.fromisoformat(d).weekday()))
    if changed: json.dump(cache, open(CACHE, 'w'))
    for k, r in enumerate(out):                      # overnight-volume baseline = the 20 prior VALID rows
        prior = [x['raw']['vol'] for x in out[max(0, k - 20):k]]; r['onv'] = float(np.log(r['raw']['vol'] / np.mean(prior))) if len(prior) >= 15 and np.mean(prior) > 0 and r['raw']['vol'] > 0 else None
    return [r for r in out if r['onv'] is not None]

def vec(r):
    a = r['atr']; return np.array([np.log(max(r['pdr'] / a, 1e-3)), (r['raw']['h'] - r['raw']['l']) / a, r['onv'], abs(r['raw']['pre'] - r['raw']['pc']) / a] + [1.0 * (r['dow'] == w) for w in (1, 2, 3, 4)])

def target(r): return float(np.log(max(r['rng'] / r['atr'], 1e-3)))

def fit(rows):
    X = np.vstack([vec(r) for r in rows]); y = np.array([target(r) for r in rows]); mu, sd = X.mean(0), X.std(0); sd[sd == 0] = 1.0; Z = (X - mu) / sd
    a = P.choose_alpha(Z, y, np.array([r['date'] for r in rows])); ym = float(y.mean()); w = P.ridge_solve(Z.T @ Z, Z.T @ (y - ym), a); return dict(alpha=a, ym=ym, mu=mu.tolist(), sd=sd.tolist(), coef=w.tolist(), names=NAMES, n=len(rows), through=rows[-1]['date'])

def predict(p, r): return float(p['ym'] + ((vec(r) - np.array(p['mu'])) / np.array(p['sd'])) @ np.array(p['coef']))

def walk_forward(rows):
    """out-of-sample log predictions for every day after the first 120 (refit every 10 days on strictly earlier days)."""
    done = [r for r in rows if r['rng'] is not None]; preds = {}
    for b in range(FIRST_TRAIN, len(done), STEP):
        p = fit(done[:b])
        for r in done[b:b + STEP]: preds[r['date']] = predict(p, r)
    return done, preds

def cutoffs(preds, upto_idx=None, window=250):
    v = np.array([preds[d] for d in sorted(preds)][-window:]); return dict(q33=float(np.quantile(v, 1 / 3)), q67=float(np.quantile(v, 2 / 3)), n=int(len(v)))

def bucket(pred_log, cut): return 'QUIET' if pred_log <= cut['q33'] else ('BUSY' if pred_log >= cut['q67'] else 'NORMAL')

def live_model(conn, upto=None):
    """final model on all COMPLETE valid days + cutoffs from the walk-forward predictions."""
    rows = build_rows(conn, upto); done, preds = walk_forward(rows); p = fit(done); p['version'] = 'regime-day-v1-' + p['through'] + '-' + hashlib.sha256(json.dumps(p, sort_keys=True).encode()).hexdigest()[:8]; return p, cutoffs(preds), rows, done, preds
