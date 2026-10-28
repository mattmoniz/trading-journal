"""Baseline bootstrap for the live tell detector: the tell's ACTIVITY component compares the last 10 bars' pace with the mean seconds-per-bar of the same clock hour over the PRIOR 20 sessions
(research: trade.prep / run_trade.py). The live sidecar persists each finished session's stats (amt_tell_session_stats); this module fills the gap when fewer than 20 are stored, by rebuilding recent
completed sessions from the tick files with the SAME builder and the SAME validation the batch extractor applied (a session counts only if its tick RTH volume is within 3 percent of price_bars_primary)."""
import os, sys, datetime
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, '..', 'tick_microstructure'))
import scid_reader as sr
import extract_cells_20261020 as X          # candidate_codes / scid_paths / _sniff_layout (contract-file naming and layout rules); imports static scratch json at load
import persist, core, session

TOL = 0.03


def candidate_paths(contract, dd):
    out = []
    for code in X.candidate_codes(contract):
        for p in X.scid_paths(code):
            if p not in out and X._sniff_layout(p, dd) == 'std': out.append(p)
    return out


def primary_paths(contract, dd):
    """Standard-layout tick files of the calendar contract itself (not the neighbouring quarters the batch extractor also tried for roll weeks, which only a volume validation may select)."""
    return [p for p in X.scid_paths(X.candidate_codes(contract)[0]) if X._sniff_layout(p, dd) == 'std']


def completed_session_dates(conn, before, n):
    """The n most recent weekday trade dates before `before` that have data in the DB (price_bars_contract_calendar), oldest first. Sunday rows are the start of Monday's session and are not sessions."""
    with conn.cursor() as cur:
        cur.execute("SELECT trade_date FROM price_bars_contract_calendar WHERE symbol='NQ' AND trade_date < %s AND extract(dow FROM trade_date) BETWEEN 1 AND 5 AND bar_count >= 100 ORDER BY trade_date DESC LIMIT %s", (before, n))
        rows = [r[0] for r in cur.fetchall()]
    return sorted(rows)


def build_sessions(conn, d, rules):
    """Rebuild session d (a completed trade date string) for each bar rule from the tick files. Returns ({rule: LiveSession}, validated_flag, info) or (None, False, reason)."""
    dd = datetime.date.fromisoformat(d); prev = dd - datetime.timedelta(days=1); contract = persist.contract_for(conn, d)
    if contract is None: return None, False, 'no contract in calendar'
    dbv = persist.db_rth_volume(conn, d); best = None
    for p in candidate_paths(contract, dd):
        sess = {r: session.LiveSession(d, r, []) for r in rules}
        for t in sr.read_ticks(p, start_date=prev, end_date=dd):
            for s in sess.values(): s.feed_trade(t)
        for s in sess.values(): s.finish_scale_detection()
        tot = sess[rules[0]].rth_contracts
        if tot == 0: continue
        ok = dbv > 0 and abs(tot - dbv) <= TOL * dbv
        if ok: return sess, True, dict(file=p, contract=contract, rth=tot, db=dbv)
        if best is None or abs(tot - dbv) < abs(best[1]['rth'] - dbv): best = (sess, dict(file=p, contract=contract, rth=tot, db=dbv))
    if best is None: return None, False, 'no tick file with data'
    return best[0], False, best[1]


def stored_dates(conn, d, rules, n):
    """Dates before d with a validated stats row for EVERY rule (the last n per rule)."""
    return set.intersection(*[set(persist.load_prior_stats(conn, d, r, n=n)[1]) for r in rules])


def ensure_baseline(conn, d, rules, need=20, log=print):
    """Make sure each rule has `need` validated stored sessions before d; rebuilds the missing recent ones, most recent first, from the tick files. Returns {rule: n_stored_after}.
    Only the most recent need+6 completed weekday sessions are considered (a session that fails validation is stored with validated=false and does not count, as in the batch extraction)."""
    have = stored_dates(conn, d, rules, need + 6)
    todo = [x for x in completed_session_dates(conn, d, need + 6) if str(x) not in have]
    for x in reversed(todo):
        if min(len(persist.load_prior_stats(conn, d, r, n=need)[1]) for r in rules) >= need: break
        ds = str(x); sess, ok, info = build_sessions(conn, ds, rules)
        if sess is None:
            log(f'[bootstrap] {ds}: skipped ({info})'); continue
        for r, s in sess.items():
            bars = s.finished_bars()
            if bars: persist.save_session_stats(conn, ds, r, core.stats_of_session(bars, ds), len(bars), ok)
        log(f'[bootstrap] {ds}: {"validated" if ok else "NOT validated"} {info}')
    return {r: len(persist.load_prior_stats(conn, d, r, n=need)[1]) for r in rules}
