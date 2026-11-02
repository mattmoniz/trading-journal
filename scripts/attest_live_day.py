"""Nightly live attestation (docs/G0_GAP_AUDIT_20261101.md items 6 and 7). Read-only against live data; writes ONLY live_attestations and, on a problem, one line to scratch/server_errors.jsonl.
Checks for one trade date D (default: today ET; --days N also re-checks the previous N weekdays):
  tell_replay_parity  rebuild the 500-contract bars of D from the tick file with the sidecar's own builder, replay the research code on them (final=True) and compare EVERY tell trade with what the live sidecar
                      logged in amt_tell_trades (decision hash, exit bar, exit reason, net dollars); also the stored bars hash. Catches a tick-file gap, a drifted live feature, a booking bug.
  broker_entry_exit   every real ENTRY fill of an origin ACTIVE row of D has a matching closing fill and no row is left open after the close (RTH rows); lists orphans.
  broker_pnl_gap      model P&L (actual_pnl) vs the broker result (broker_pnl) for rows of D that have both: count, mean gap, largest gaps; rows with a filled entry but no broker_pnl are listed.
A check is OK / DIVERGENCE / ERROR / SKIPPED (nothing to check). Usage: python3 scripts/attest_live_day.py [DATE] [--days N] [--dry]"""
import os, sys, json, datetime, tempfile, hashlib
HERE = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, 'scripts', 'amt_tell_live')); sys.path.insert(0, os.path.join(REPO, 'scripts', 'tick_microstructure'))
import persist, bootstrap, session, barbuilder
RULE = 'split'
def et_today():
    import zoneinfo; return datetime.datetime.now(zoneinfo.ZoneInfo('America/New_York')).date()

def alert(msg):
    try: open(os.path.join(REPO, 'scratch', 'server_errors.jsonl'), 'a').write(json.dumps(dict(ts=datetime.datetime.utcnow().isoformat() + 'Z', type='SERVER_ERROR', message=msg, detail=None)) + '\n')
    except Exception: pass

def save(conn, d, name, status, detail, dry):
    print(f'  {name}: {status} {json.dumps(detail, default=str)[:400]}')
    if dry: return
    with conn.cursor() as c:
        c.execute("""INSERT INTO live_attestations (trade_date, check_name, status, detail) VALUES (%s,%s,%s,%s::jsonb) ON CONFLICT (trade_date, check_name) DO UPDATE SET status=EXCLUDED.status, detail=EXCLUDED.detail, checked_at=now()""", (d, name, status, json.dumps(detail, default=str)))
    conn.commit()
    if status in ('DIVERGENCE', 'ERROR'): alert(f'LIVE ATTESTATION {status}: {name} on {d}: {json.dumps(detail, default=str)[:300]} (see live_attestations)')

def replay_parity(conn, d):
    with conn.cursor() as c:
        c.execute("SELECT state, n_bars, bars_sha256 FROM amt_tell_sessions WHERE trade_date=%s AND bar_rule=%s", (d, RULE)); sr = c.fetchone()
        c.execute("SELECT book, sig_idx, decision_hash, status, exit_idx, exit_reason, net_dollars FROM amt_tell_trades WHERE trade_date=%s AND bar_rule=%s", (d, RULE)); live = {(r[0], r[1]): r for r in c.fetchall()}
    if sr is None or sr[0] != 'FINAL': return 'SKIPPED', dict(reason='no FINAL tell session for this date', state=sr[0] if sr else None)
    dd = datetime.date.fromisoformat(d); prev = dd - datetime.timedelta(days=1); contract = persist.contract_for(conn, d); dbv = persist.db_rth_volume(conn, d)
    prior, _ = persist.load_prior_stats(conn, d, RULE); ls = None; best = None
    for p in bootstrap.candidate_paths(contract, dd):
        cand = session.LiveSession(d, RULE, prior)
        for t in bootstrap.sr.read_ticks(p, start_date=prev, end_date=dd): cand.feed_trade(t)
        cand.finish_scale_detection(); tot = cand.rth_contracts
        if tot == 0: continue
        if dbv > 0 and abs(tot - dbv) <= bootstrap.TOL * dbv: ls = cand; break
        if best is None or abs(tot - dbv) < abs(best[1] - dbv): best = (cand, tot)
    if ls is None: return 'ERROR', dict(reason='no tick file reproduces the database RTH volume within tolerance', db_rth=dbv, best_rth=best[1] if best else None)
    res = ls.evaluate(force=True, final=True)
    if res is None: return 'ERROR', dict(reason='replay returned no result (no usable baseline)')
    replay = {}
    for book, trs in res['books'].items():
        for tr in trs: replay[(book, int(tr['sig']))] = tr
    only_live = sorted(set(live) - set(replay)); only_replay = sorted(set(replay) - set(live)); mism = []
    for k in sorted(set(live) & set(replay)):
        r = replay[k]; l = live[k]; h = persist.decision_hash(r)
        if h != l[2]: mism.append(dict(key=k, what='decision_hash'))
        elif int(r['xj']) != l[4] or str(r['reason']) != l[5] or abs(float(r['net']) - float(l[6] if l[6] is not None else 0)) > 1e-6: mism.append(dict(key=k, what='exit', live=(l[4], l[5], float(l[6]) if l[6] is not None else None), replay=(int(r['xj']), r['reason'], float(r['net']))))
    with tempfile.TemporaryDirectory() as tmp: sha = barbuilder.write_session_files(ls.finished_bars(), os.path.join(tmp, 'b.tsv'), os.path.join(tmp, 'v.tsv'))
    bars_ok = (sha == sr[2]); n_bars = len(ls.finished_bars())
    detail = dict(live_trades=len(live), replay_trades=len(replay), only_live=only_live, only_replay=only_replay, mismatches=mism[:10], n_mismatch=len(mism), bars_rebuilt=n_bars, bars_stored=sr[1], bars_hash_equal=bars_ok)
    return ('OK' if not (only_live or only_replay or mism or not bars_ok) else 'DIVERGENCE'), detail

def broker_checks(conn, d):
    out = {}
    with conn.cursor() as c:
        c.execute("""SELECT s.id, s.setup_type, s.status, s.resolution, s.actual_pnl, s.broker_pnl, s.fired_at::text, s.resolved_at::text,
                       (SELECT count(*) FROM order_placements o WHERE o.setup_id=s.id AND o.purpose='ENTRY' AND o.status='FILLED') AS entry_fills,
                       (SELECT count(*) FROM order_placements o WHERE o.setup_id=s.id AND o.purpose IN ('EXIT','STOP') AND o.status='FILLED') AS exit_fills
                     FROM active_setups s WHERE s.trade_date=%s AND s.origin_status='ACTIVE'""", (d,)); rows = c.fetchall()
    filled = [r for r in rows if r[8] > 0]
    orphans = [dict(id=r[0], type=r[1], status=r[2], resolution=r[3], fired_at=r[6]) for r in filled if r[9] == 0]
    open_after = [dict(id=r[0], type=r[1], status=r[2]) for r in filled if r[7] is None and r[2] in ('ACTIVE', 'SHADOW')]
    out['broker_entry_exit'] = ('SKIPPED', dict(reason='no real entry fills for this date')) if not filled else (('OK' if not (orphans or open_after) else 'DIVERGENCE'), dict(rows_with_entry_fill=len(filled), entry_without_exit_fill=orphans, still_open=open_after))
    both = [r for r in filled if r[4] is not None and r[5] is not None]; nobroker = [dict(id=r[0], type=r[1]) for r in filled if r[5] is None and r[3] not in ('NOT_FILLED',)]
    if not filled: out['broker_pnl_gap'] = ('SKIPPED', dict(reason='no real entry fills for this date'))
    else:
        gaps = sorted(((float(r[4]) - float(r[5])), r[0]) for r in both); mean = sum(g for g, _ in gaps) / len(gaps) if gaps else None
        out['broker_pnl_gap'] = ('OK' if not nobroker else 'DIVERGENCE', dict(rows_with_both=len(both), mean_gap=round(mean, 2) if mean is not None else None, largest_gaps=[dict(id=i, gap=round(g, 2)) for g, i in (gaps[:2] + gaps[-2:])] if gaps else [], filled_without_broker_pnl=nobroker))
    return out

def main():
    a = [x for x in sys.argv[1:] if not x.startswith('--')]; dry = '--dry' in sys.argv; days = int(sys.argv[sys.argv.index('--days') + 1]) if '--days' in sys.argv else 0
    if '--days' in sys.argv: a = [x for x in a if x != str(days)]
    base = datetime.date.fromisoformat(a[0]) if a else et_today(); conn = persist.connect(); dates = []; k = 0
    while len(dates) < days + 1:
        x = base - datetime.timedelta(days=k); k += 1
        if x.weekday() < 5: dates.append(x)
    for dd in dates:
        d = dd.isoformat(); print(f'== {d}')
        try: st, det = replay_parity(conn, d)
        except Exception as e: st, det = 'ERROR', dict(error=str(e)[:300])
        save(conn, d, 'tell_replay_parity', st, det, dry)
        try: res = broker_checks(conn, d)
        except Exception as e: res = {'broker_entry_exit': ('ERROR', dict(error=str(e)[:300])), 'broker_pnl_gap': ('ERROR', dict(error=str(e)[:300]))}
        for name, (st, det) in res.items(): save(conn, d, name, st, det, dry)

if __name__ == '__main__': main()
