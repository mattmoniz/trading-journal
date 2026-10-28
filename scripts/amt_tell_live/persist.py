"""Persistence for the live tell detector (tables from scripts/migrate_amt_tell_live_20261028.mjs). The sidecar is stateless: the database is a durable VIEW of a deterministic replay, so every write is an idempotent upsert
and the integrity rule is: a stored decision never changes. Decision columns are frozen at insert (decision_hash); a later replay that disagrees raises a DECISION_DRIFT alarm instead of overwriting; a CLOSED trade is frozen entirely
(an outcome that later differs raises OUTCOME_DRIFT). Only an OPEN trade's lifecycle columns are updated.
All timestamps are naive ET built from tick UTC instants with zoneinfo (never from JS Date parsing)."""
import os, json, math, hashlib, datetime
from zoneinfo import ZoneInfo
import psycopg2, psycopg2.extras
ET = ZoneInfo('America/New_York')
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))


def _env():
    out = {}
    for line in open(os.path.join(ROOT, '.env')):
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1); out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def connect():
    e = _env()
    c = psycopg2.connect(host=e.get('DB_HOST', 'localhost'), port=int(e.get('DB_PORT', 5432)), dbname=e.get('DB_NAME', 'trading_journal'), user=e['DB_USER'], password=e['DB_PASSWORD'])
    c.autocommit = True
    with c.cursor() as cur: cur.execute("SET TIME ZONE 'America/New_York'")
    return c


def et_naive(dt_utc):
    return None if dt_utc is None else dt_utc.astimezone(ET).replace(tzinfo=None)


def now_et():
    return datetime.datetime.now(datetime.timezone.utc).astimezone(ET).replace(tzinfo=None)


def _clean(x):
    """JSON-safe copy: numpy scalars -> python, NaN/inf -> None."""
    if isinstance(x, dict): return {str(k): _clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)): return [_clean(v) for v in x]
    if hasattr(x, 'item') and not isinstance(x, (str, bytes)): x = x.item()
    if isinstance(x, float) and (math.isnan(x) or math.isinf(x)): return None
    return x


def decision_hash(tr):
    """Hash of EVERYTHING logged about the decision (components incl. the activity ratio, ladder, node list, signal-bar facts, stop, entry): a later replay that disagrees on any of it is a DECISION_DRIFT alarm."""
    d = tr['details']
    a = d.get('A'); a = None if a is None or (isinstance(a, float) and math.isnan(a)) else round(float(a), 4)
    basis = dict(dir=int(tr['dir']), sig=int(tr['sig']), ei=int(tr['ei']), entry=round(float(tr['entry']), 2), stop=round(float(tr['stop']), 2), fb=bool(tr['fb']),
                 comps=[bool(d['fast']), bool(d['flip']), bool(d['osc']), bool(d['strides']), int(d['L']), a], nodes=d['nodes_left'], n_nodes=int(d['n_nodes_total']),
                 sig_end_sec=round(float(d['sig_end_sec']), 3), sig_close=round(float(d['sig_close']), 2))
    return hashlib.sha1(json.dumps(basis, sort_keys=True).encode()).hexdigest()[:16]


def level_context(conn, d, px):
    """CONTEXT ONLY (user question 2026-10-28: does the tell behave differently near the app's named levels?): the three nearest rows of level_prices for trade date d to the entry price, as [name, level price, entry minus level in points]
    (positive = entry above the level). Stored under details['level_ctx']; deliberately NOT part of decision_hash and never read by the tell, which uses only its own volume profile. None when the date has no levels yet."""
    with conn.cursor() as cur:
        cur.execute("SELECT level_name, price::float FROM level_prices WHERE trade_date = %s AND price IS NOT NULL", (d,))
        rows = cur.fetchall()
    if not rows: return None
    near = sorted(rows, key=lambda r: abs(r[1] - px))[:3]
    return dict(n_levels=len(rows), nearest=[[n, round(p, 2), round(px - p, 2)] for n, p in near])


def alarm(conn, kind, detail):
    with conn.cursor() as cur: cur.execute("INSERT INTO amt_tell_alarms (at, kind, detail) VALUES (%s,%s,%s)", (now_et(), kind[:30], json.dumps(_clean(detail), default=str)))


def load_prior_stats(conn, d, rule, n=20):
    """[(rth_range, {hour:int -> mean_seconds}), ...] oldest first, the n validated sessions before d for this bar rule."""
    with conn.cursor() as cur:
        cur.execute("SELECT trade_date, rth_range, hour_mean FROM amt_tell_session_stats WHERE bar_rule=%s AND validated AND trade_date < %s ORDER BY trade_date DESC LIMIT %s", (rule, d, n))
        rows = cur.fetchall()
    rows.reverse()
    return [(float('nan') if r is None else float(r), {int(k): float(v) for k, v in hm.items()}) for _, r, hm in rows], [str(x[0]) for x in rows]


def save_session_stats(conn, d, rule, stats, n_bars, validated):
    rng, hm = stats
    with conn.cursor() as cur:
        cur.execute("""INSERT INTO amt_tell_session_stats (trade_date, bar_rule, rth_range, hour_mean, n_bars, validated, built_at) VALUES (%s,%s,%s,%s,%s,%s,%s)
                       ON CONFLICT (trade_date, bar_rule) DO UPDATE SET rth_range=EXCLUDED.rth_range, hour_mean=EXCLUDED.hour_mean, n_bars=EXCLUDED.n_bars, validated=EXCLUDED.validated, built_at=EXCLUDED.built_at""",
                    (d, rule, None if rng is None or (isinstance(rng, float) and math.isnan(rng)) else float(rng), json.dumps({str(k): v for k, v in hm.items()}), int(n_bars), bool(validated), now_et()))


def db_rth_volume(conn, d):
    with conn.cursor() as cur:
        cur.execute("SELECT COALESCE(SUM(volume),0) FROM price_bars_primary WHERE symbol='NQ' AND ts >= %s::date + time '09:30' AND ts < %s::date + time '16:00'", (d, d))
        return int(cur.fetchone()[0])


def contract_for(conn, d):
    """Front contract for trade date d from price_bars_contract_calendar (latest row on or before d)."""
    with conn.cursor() as cur:
        cur.execute("SELECT contract FROM price_bars_contract_calendar WHERE symbol='NQ' AND trade_date <= %s ORDER BY trade_date DESC LIMIT 1", (d,))
        r = cur.fetchone()
    return r[0] if r else None


def save_session(conn, d, rule, **kw):
    cols = ['contract', 'tick_file', 'state', 'n_bars', 'last_tick_at', 'n_trades', 'contracts', 'rth_contracts', 'db_rth_contracts', 'vol_diff_pct', 'tail_backwards', 'baseline_n', 'bars_sha256', 'eval_ms']
    vals = [kw.get(c) for c in cols]
    sets = ', '.join(f'{c}=EXCLUDED.{c}' for c in cols) + ', updated_at=EXCLUDED.updated_at'
    with conn.cursor() as cur:
        cur.execute(f"INSERT INTO amt_tell_sessions (trade_date, bar_rule, {', '.join(cols)}, updated_at) VALUES (%s,%s,{', '.join(['%s'] * len(cols))},%s) ON CONFLICT (trade_date, bar_rule) DO UPDATE SET {sets} WHERE amt_tell_sessions.state <> 'FINAL' OR EXCLUDED.state = 'FINAL'",
                    [d, rule] + vals + [now_et()])


def _path(S, ei, xj):
    return [[int(j), round(float(S['h'][j]), 2), round(float(S['l'][j]), 2), round(float(S['c'][j]), 2)] for j in range(ei, min(xj, len(S['c']) - 1) + 1)]


def persist_result(conn, ls, res, code_version):
    """Upsert every trade of an evaluate() result for LiveSession ls. Returns dict(new=n, updated=n, drift=n)."""
    S = res['ctx']['S']; d = ls.d; rule = ls.rule; now = now_et(); stat = dict(new=0, updated=0, drift=0, vanished=0)
    with conn.cursor() as cur:
        cur.execute("SELECT book, sig_idx, decision_hash, status, exit_idx, exit_reason, net_dollars, exit_points, broke, mfe_points FROM amt_tell_trades WHERE trade_date=%s AND bar_rule=%s", (d, rule))
        have = {(r[0], r[1]): r for r in cur.fetchall()}
    seen = set()
    for book, trs in res['books'].items():
        for tr in trs:
            key = (book, int(tr['sig'])); seen.add(key); h = decision_hash(tr); ex = have.get(key)
            status = 'OPEN' if tr['open'] else 'CLOSED'
            fired = et_naive(ls.bar_end_utc[tr['sig']]) if tr['sig'] < len(ls.bar_end_utc) else None
            ei = int(tr['ei']); entry_at = et_naive(ls.bar_start_utc[ei]) if ei < len(ls.bar_start_utc) else None
            xj = int(tr['xj']); exit_start = et_naive(ls.bar_start_utc[xj]) if (not tr['open'] and xj < len(ls.bar_start_utc)) else None
            if ex is None:
                late = round((now - fired).total_seconds() / 60.0, 1) if fired else None
                try: lc = level_context(conn, d, float(tr['entry']))
                except Exception: lc = None      # context must never block a tell from being logged
                details_out = dict(tr['details'], level_ctx=lc)
                with conn.cursor() as cur:
                    cur.execute("""INSERT INTO amt_tell_trades (trade_date, bar_rule, book, sig_idx, direction, fired_at, entry_idx, entry_at, entry_price, stop_price, risk_points, stop_fallback, details, decision_hash, code_version,
                                   status, exit_idx, exit_bar_start, exit_reason, exit_points, net_dollars, broke, mfe_points, path, detected_at, late_min, updated_at)
                                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                                (d, rule, book, int(tr['sig']), int(tr['dir']), fired, ei, entry_at, round(float(tr['entry']), 2), round(float(tr['stop']), 2), round(float(tr['risk']), 2), bool(tr['fb']),
                                 json.dumps(_clean(details_out)), h, json.dumps(code_version), status, None if tr['open'] else xj, exit_start, None if tr['open'] else tr['reason'],
                                 None if tr['open'] else round(float(tr['pts']), 2), None if tr['open'] else round(float(tr['net']), 2), None if tr['open'] else bool(tr['broke']), round(float(tr['mfe']), 2),
                                 json.dumps(_path(S, ei, xj)), now, late, now))
                stat['new'] += 1; continue
            _, _, h0, st0, xi0, rs0, net0, pts0, broke0, mfe0 = ex
            if h0 != h:
                alarm(conn, 'DECISION_DRIFT', dict(date=d, rule=rule, book=book, sig=key[1], stored=h0, now=h)); stat['drift'] += 1; continue
            if st0 == 'CLOSED':
                if (not tr['open']) and (xi0 != xj or rs0 != tr['reason'] or net0 is None or abs(float(net0) - float(tr['net'])) > 0.005 or pts0 is None or abs(float(pts0) - float(tr['pts'])) > 0.005
                                         or broke0 != bool(tr['broke']) or mfe0 is None or abs(float(mfe0) - float(tr['mfe'])) > 0.005):
                    alarm(conn, 'OUTCOME_DRIFT', dict(date=d, rule=rule, book=book, sig=key[1], stored=(xi0, rs0, float(net0) if net0 is not None else None, bool(broke0)), now=(xj, tr['reason'], float(tr['net']), bool(tr['broke'])))); stat['drift'] += 1
                continue
            with conn.cursor() as cur:
                cur.execute("""UPDATE amt_tell_trades SET status=%s, exit_idx=%s, exit_bar_start=%s, exit_reason=%s, exit_points=%s, net_dollars=%s, broke=%s, mfe_points=%s, path=%s, updated_at=%s
                               WHERE trade_date=%s AND bar_rule=%s AND book=%s AND sig_idx=%s AND status='OPEN'""",
                            (status, None if tr['open'] else xj, exit_start, None if tr['open'] else tr['reason'], None if tr['open'] else round(float(tr['pts']), 2), None if tr['open'] else round(float(tr['net']), 2),
                             None if tr['open'] else bool(tr['broke']), round(float(tr['mfe']), 2), json.dumps(_path(S, ei, xj)), now, d, rule, book, key[1]))
            stat['updated'] += 1
    for key, ex in have.items():
        if key not in seen and ex[3] == 'OPEN':
            alarm(conn, 'TRADE_VANISHED', dict(date=d, rule=rule, book=key[0], sig=key[1])); stat['vanished'] += 1
    return stat
