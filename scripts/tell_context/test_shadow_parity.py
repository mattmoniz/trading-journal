"""Integration check (needs the DB and the tick file): replay one session, re-simulate every V1 split fire through shadow.simulate_fire and compare book A with the tell's own amt_tell_trades row, then print B and C and the forward stop-placement books D, E and F (live-path ctx from the tick file).
Usage: venv/bin/python scripts/tell_context/test_shadow_parity.py [DATE]   (default 2026-11-03). Run with ulimit -v 4000000 (hr-028)."""
import os, sys, datetime, json, time
HERE = os.path.dirname(os.path.abspath(__file__)); AMT = os.path.join(HERE, '..', 'amt_tell_live')
sys.path.insert(0, HERE); sys.path.insert(0, AMT); sys.path.insert(0, os.path.join(HERE, '..', 'tick_microstructure'))
import numpy as np
import persist, session, tailer, core, shadow
from sidecar import Runner

d = sys.argv[1] if len(sys.argv) > 1 else '2026-11-03'; dd = datetime.date.fromisoformat(d)
conn = persist.connect(); r = Runner(('split',)); path = r.pick_path(d); r.conn.close()
prior, _ = persist.load_prior_stats(conn, d, 'split'); ls = session.LiveSession(d, 'split', prior)
tl = tailer.ScidTailer(path, from_date=dd - datetime.timedelta(days=1))
while True:
    ch = tl.poll(max_records=200000)
    if not ch and tl.backlog_bytes() == 0: break
    for t in ch: ls.feed_trade(t)
ls.finish_scale_detection(); ctx = core.build_ctx(ls.sb.all_bars(), d, prior); assert ctx is not None, 'no baseline'
with conn.cursor() as cur:
    cur.execute("""SELECT t.id, t.direction, t.sig_idx, t.stop_price::float, t.status, t.exit_reason, t.net_dollars::float, c.label, c.val::float, c.vah::float, (c.context->>'range20')::float
                   FROM amt_tell_trades t LEFT JOIN tell_context_fires c ON c.tell_trade_id = t.id WHERE t.trade_date = %s AND t.bar_rule = 'split' AND t.book = 'V1' ORDER BY t.id""", (d,))
    rows = cur.fetchall()
bad = 0; TIMES = []
for (tid, direction, sig, stop, status, xr, net, label, val, vah, r20) in rows:
    t0 = time.perf_counter(); out = shadow.simulate_fire(ctx, dict(sig_idx=sig, direction=direction, tell_stop=stop, label=label, val=val, vah=vah, range20=r20), final=True); t1 = time.perf_counter()
    ok, why = shadow.parity(out['A'], dict(status=status, exit_reason=xr, net_dollars=net)); bad += (ok is False)                                                       # None = the trade is still open, not compared: not a failure
    f = lambda b: '%s %s stop %.2f net %+.2f%s' % ('LONG' if b['direction'] == 1 else 'SHORT', b['exit_reason'], b['stop'], b['net'], ' (follows tell)' if b['followed_a'] else '')
    stp = shadow.simulate_stop_books(ctx, dict(sig_idx=sig, direction=direction, tell_stop=stop), final=True, a=out['A']); t2 = time.perf_counter(); TIMES.append((t1 - t0, t2 - t1))
    print(tid, label, '| parity', why, '| A', f(out['A']), '| B', f(out['B']), '| C', f(out['C']) + ('  guard: ' + out['C']['guard'] if out['C'].get('guard') else ''))
    print('     stop books | ' + ' | '.join('%s %s' % (b, f(stp[b])) for b in shadow.STOP_BOOKS))
if TIMES: print('COST per fire (seconds): books A, B, C %.2f mean / %.2f max; stop books D, E, F %.2f mean / %.2f max' % (np.mean([a for a, _ in TIMES]), max(a for a, _ in TIMES), np.mean([b for _, b in TIMES]), max(b for _, b in TIMES)))
print('PARITY FAILURES:', bad, 'of', len(rows)); sys.exit(1 if bad else 0)
