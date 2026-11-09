"""Tell context reader (docs/TELL_CONTEXT_OVERLAY_SCOPE_20261103.md). READ-ONLY with respect to trading: tails the live Sierra NQ tick file with the tell's own bar builder (split rule), and for every amt_tell_trades row
(bar_rule='split') that has no row yet in tell_context_fires computes the context of that fire (scripts/tell_context/context.py) from the completed bars through the fire's signal bar, and appends it. It places NO
orders, writes nothing to active_setups or amt_tell_*, and gates nothing. A stored context row is never updated. Stateless: a restart replays the session from the tick file, and a fire already stored is skipped.
Health on http://127.0.0.1:8897/health for the Node manager. Usage: reader.py [--once-date YYYY-MM-DD] [--port 8897]"""
import os, sys, time, json, hashlib, argparse, datetime, threading, traceback
from http.server import BaseHTTPRequestHandler, HTTPServer
from zoneinfo import ZoneInfo
HERE = os.path.dirname(os.path.abspath(__file__)); AMT = os.path.join(HERE, '..', 'amt_tell_live')
sys.path.insert(0, HERE); sys.path.insert(0, AMT); sys.path.insert(0, os.path.join(HERE, '..', 'tick_microstructure'))
import persist, session, tailer, core
from sidecar import session_for, Runner
from context import context_at_fire
import watcher, shadow

ET = ZoneInfo('America/New_York')
POLL_S = 1.0
CATCHUP_BYTES = 40 * 20000
SIG_TOL = 0.51                      # the signal close stored by the tell must equal the close of our bar at sig_idx (a different bar sequence would make the context wrong)
STATUS = dict(ok=False, state='STARTING', session=None, started=time.time(), loopAt=None, rows=0, pending=0, stuck=0, watcher=None, watcherChanges=0, shadowOpen=0, parityFailures=0, errors=0, lastError=None, backlog=None, pid=os.getpid())
STUCK_MIN = 10                      # a caught-up reader that still cannot reach a fire's signal bar this many minutes after the fire is reported as stuck (health, manager problem string)


def log(*a): print('[tell-context]', datetime.datetime.now(ET).strftime('%H:%M:%S'), *a, flush=True)


def code_version():
    h = hashlib.sha1()
    for f in (os.path.join(HERE, 'context.py'), os.path.join(HERE, 'shape_cuts.json'), os.path.join(HERE, 'watcher.py'), os.path.join(HERE, 'shadow.py'), os.path.join(AMT, 'barbuilder.py'), os.path.join(HERE, '..', 'amt_vbars', 'trade.py'), os.path.join(HERE, '..', 'amt_vbars', 'vbars.py')): h.update(open(f, 'rb').read())     # the bar builder and the tell's gate feed the context too
    return h.hexdigest()[:16]


def _jsonable(o):
    if hasattr(o, 'item'): return o.item()
    return str(o)


class Health(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps(STATUS, default=str).encode(); self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass


class Reader:
    def __init__(self, once_date=None):
        self.once_date = once_date; self.conn = None; self.d = None; self.ls = None; self.tl = None; self.dd = None; self.end_reached = False; self.bars = []; self.code = code_version(); self.finished_once = False; self.prior = []; self.watch = None; self.w_seen = set(); self.w_n = -1; self.sh_n = -1

    def db(self):
        if self.conn is None or self.conn.closed: self.conn = persist.connect()
        return self.conn

    def start_session(self, d):
        runner = Runner(('split',))
        try: path = runner.pick_path(d)                              # the sidecar's own choice of tick file (the live file is the freshly written one); Runner is only used for that lookup
        finally:
            if runner.conn is not None and not runner.conn.closed: runner.conn.close()
        if path is None:
            log('no tick file for', d)
            if self.once_date: raise SystemExit(1)                   # a replay of a date with no file must end, not poll forever
            return False
        self.d = d; self.dd = datetime.date.fromisoformat(d); self.path = path; self.end_reached = False; self.bars = []
        self.prior, _ = persist.load_prior_stats(self.db(), d, 'split')                      # the tell's own 20-session baseline, needed to rebuild its ctx for the shadow books
        self.ls = session.LiveSession(d, 'split', self.prior); self.tl = tailer.ScidTailer(path, from_date=self.dd - datetime.timedelta(days=1)); self.watch = None; self.w_n = -1; self.sh_n = -1
        with self.db().cursor() as cur:
            cur.execute("SELECT bar_idx FROM tell_watcher_states WHERE trade_date = %s", (d,)); self.w_seen = {r[0] for r in cur.fetchall()}
        STATUS.update(session=d, state='CATCHUP'); log('session', d, path); return True

    def end_session(self):
        self.ls = None; self.tl = None; self.d = None; self.bars = []; STATUS.update(session=None, state='IDLE')

    def feed(self):
        for n, t in enumerate(self.tl.poll(max_records=200000)):
            if n % 20000 == 0: STATUS['loopAt'] = time.time()        # a long catch-up chunk must not look like a wedged loop
            if t.ts_et.date() > self.dd or (t.ts_et.date() == self.dd and t.ts_et.hour >= 17): self.end_reached = True; break
            self.ls.feed_trade(t)
        STATUS['backlog'] = self.tl.backlog_bytes()
        if STATUS['backlog'] < CATCHUP_BYTES: self.ls.finish_scale_detection()
        done = self.ls.sb.done                                       # extend the cached light copies of the completed bars (the context only needs end/high/low/close/vap)
        for b in done[len(self.bars):]: self.bars.append(dict(end=b['end'], h=b['h'], l=b['l'], c=b['c'], vap=b['vap']))

    def process_pending(self):
        with self.db().cursor() as cur:
            cur.execute("""SELECT t.id, t.book, t.direction, t.fired_at, t.entry_price::float, t.sig_idx, t.details->>'sig_close', (EXTRACT(EPOCH FROM (localtimestamp - t.fired_at)) / 60.0)
                           FROM amt_tell_trades t WHERE t.trade_date = %s AND t.bar_rule = 'split' AND t.book = 'V1'      -- V1 is the book that orders and the one the board scores; V3 and V1P carry the same fires
                             AND NOT EXISTS (SELECT 1 FROM tell_context_fires c WHERE c.tell_trade_id = t.id) ORDER BY t.id""", (self.d,))
            rows = cur.fetchall()
        STATUS['pending'] = len(rows); written = 0; stuck = 0
        for (tid, book, direction, fired_at, entry, sig_idx, sig_close, late_min) in rows:
            STATUS['loopAt'] = time.time()                           # keep the loop heartbeat moving through a long pass
            if sig_idx >= len(self.bars):                            # our bars have not reached the signal bar yet (catch-up)
                if late_min is not None and float(late_min) > STUCK_MIN and STATUS['backlog'] is not None and STATUS['backlog'] < CATCHUP_BYTES: stuck += 1
                continue
            bars = self.bars[:sig_idx + 1]
            if sig_close is not None and abs(float(sig_close) - bars[-1]['c']) > SIG_TOL:
                ctx = dict(direction=direction, entry=entry, label='UNKNOWN', reason='reader bars disagree with the tell: signal close %s vs %s' % (sig_close, bars[-1]['c']), gate={}); log('BAR MISMATCH', tid, sig_close, bars[-1]['c'])
            else: ctx = context_at_fire(bars, entry, direction)
            self.insert(tid, book, direction, fired_at, entry, sig_idx, ctx, late_min); written += 1
        if stuck and not STATUS['stuck']: log('STUCK: %d fire(s) older than %d min cannot be matched to a bar of this replay' % (stuck, STUCK_MIN))
        STATUS['stuck'] = stuck
        return written

    def insert(self, tid, book, direction, fired_at, entry, sig_idx, ctx, late_min):
        g = ctx.get('gate') or {}; sh = ctx.get('shape') or {}
        with self.db().cursor() as cur:
            cur.execute("""INSERT INTO tell_context_fires (tell_trade_id, trade_date, book, direction, fired_at, entry_price, sig_idx, label, reason, rth_minutes, val, poc, vah, location, tail, near_edge,
                             shape_letter, multi_hump, humps, va_mid, poc_pos, bimodality, up_broken, down_broken, opposite_broken, nearest_lvn, lvns_within_near, context, code_version, computed_at, late_min)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,localtimestamp,%s) ON CONFLICT (tell_trade_id) DO NOTHING""",
                        (tid, self.d, book, direction, fired_at, entry, sig_idx, ctx['label'], ctx.get('reason'), ctx.get('rth_minutes'), ctx.get('val'), ctx.get('poc'), ctx.get('vah'), ctx.get('location'), ctx.get('tail'), ctx.get('near_edge'),
                         sh.get('letter'), sh.get('multi_hump'), sh.get('humps'), sh.get('va_mid'), sh.get('poc_pos'), sh.get('bimodality'), g.get('up_broken'), g.get('down_broken'), g.get('opposite_broken'),
                         json.dumps(ctx.get('nearest_lvn'), default=_jsonable), json.dumps(ctx.get('lvns_within_near'), default=_jsonable), json.dumps(ctx, default=_jsonable), self.code, None if late_min is None else round(float(late_min), 1)))
        STATUS['rows'] += 1
        log('context', tid, book, 'dir', direction, 'entry', entry, '->', ctx['label'], ctx.get('tail'), ctx.get('location'), ctx.get('shape'))


    # ---- watcher and shadow books (docs/TELL_WATCHER_AND_SHADOW_BOOKS_DESIGN_20261103.md) -----------------------------------
    def run_watcher(self):
        """Recompute the day state over the completed bars (causal, memoryless per bar plus hysteresis) and append any state CHANGE not stored yet."""
        n = len(self.bars)
        if n == self.w_n or n == 0: return
        self.w_n = n; b = self.bars
        res = watcher.run([x['end'] for x in b], [x['h'] for x in b], [x['l'] for x in b], [x['c'] for x in b]); self.watch = res
        start = datetime.datetime.combine(self.dd - datetime.timedelta(days=1), datetime.time(18, 0))
        for ch in res['changes']:
            if ch['bar_idx'] in self.w_seen: continue
            with self.db().cursor() as cur:
                cur.execute("""INSERT INTO tell_watcher_states (trade_date, bar_idx, bar_end_et, state, prev_state, evidence, code_version) VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                            (self.d, ch['bar_idx'], start + datetime.timedelta(seconds=float(b[ch['bar_idx']]['end'])), ch['state'], ch['prev'], json.dumps(ch['evidence'], default=_jsonable), self.code))
            self.w_seen.add(ch['bar_idx']); log('watcher', self.d, 'bar', ch['bar_idx'], ch['prev'], '->', ch['state'])
        STATUS['watcher'] = res['current']; STATUS['watcherChanges'] = res['n_changes']

    def run_shadows(self, final=False):
        """Stateless replay of the shadow books for every fire of the session whose book A is not CLOSED yet: simulate on the completed bars so far, upsert OPEN, freeze once CLOSED."""
        with self.db().cursor() as cur:
            cur.execute("""SELECT t.id, t.direction, t.sig_idx, t.stop_price::float, t.status, t.exit_reason, t.net_dollars::float, c.label, c.val::float, c.vah::float, (c.context->>'range20')::float,
                                  NOT EXISTS (SELECT 1 FROM tell_shadow_trades s WHERE s.tell_trade_id = t.id)
                           FROM amt_tell_trades t JOIN tell_context_fires c ON c.tell_trade_id = t.id
                           WHERE t.trade_date = %s AND t.bar_rule = 'split' AND t.book = 'V1'
                             AND (NOT EXISTS (SELECT 1 FROM tell_shadow_trades s WHERE s.tell_trade_id = t.id) OR EXISTS (SELECT 1 FROM tell_shadow_trades s WHERE s.tell_trade_id = t.id AND s.status = 'OPEN')) ORDER BY t.id""", (self.d,))
            fires = cur.fetchall()
        STATUS['shadowOpen'] = len(fires); n_bars = len(self.bars)
        if not fires or not self.ls: return
        if n_bars == self.sh_n and not any(f[11] for f in fires): return          # nothing new: no new completed bar and no fire without its books yet (core.build_ctx re-runs the tell's prep over the whole session: once per bar, not once per poll)
        self.sh_n = n_bars
        ctx = core.build_ctx(self.ls.sb.all_bars(), self.d, self.prior)
        if ctx is None: return
        shown = self.watch['shown'] if self.watch else []
        for (tid, direction, sig, stop, status, xr, net, label, val, vah, r20, _new) in fires:
            STATUS['loopAt'] = time.time()
            out = shadow.simulate_fire(ctx, dict(sig_idx=sig, direction=direction, tell_stop=stop, label=label, val=val, vah=vah, range20=r20), final=final)
            if out is None: continue
            try:                                                                                                                  # forward stop-placement books D, E, F (shadow only, prereg 2026-11-04): a failure here must never cost the A/B/C rows
                if self.d >= shadow.STOP_BOOKS_FROM_DATE:                                                                         # forward-only: never back-fill a session before the deploying restart
                    stp = shadow.simulate_stop_books(ctx, dict(sig_idx=sig, direction=direction, tell_stop=stop), final=final, a=out['A'])
                    if stp: out.update(stp)
            except Exception as e:
                STATUS['errors'] += 1; STATUS['lastError'] = 'stop books: %s: %s' % (type(e).__name__, e); log('STOP BOOKS ERROR', tid, type(e).__name__, e)
            ok, why = shadow.parity(out['A'], dict(status=status, exit_reason=xr, net_dollars=net))
            if ok is False: STATUS['parityFailures'] += 1; log('PARITY FAILURE', tid, why)
            wstate = shown[sig] if sig < len(shown) else None
            for book, r in out.items():
                with self.db().cursor() as cur:
                    cur.execute("""INSERT INTO tell_shadow_trades (tell_trade_id, book, trade_date, direction, label, watcher_state, followed_a, guard, entry_idx, exit_idx, entry_price, stop_price, status, exit_reason, exit_points, net_dollars, broke, mfe_points, parity_ok, code_version)
                                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                                   ON CONFLICT (tell_trade_id, book) DO UPDATE SET status = EXCLUDED.status, exit_idx = EXCLUDED.exit_idx, exit_reason = EXCLUDED.exit_reason, exit_points = EXCLUDED.exit_points, net_dollars = EXCLUDED.net_dollars,
                                       broke = EXCLUDED.broke, mfe_points = EXCLUDED.mfe_points, parity_ok = EXCLUDED.parity_ok, updated_at = localtimestamp WHERE tell_shadow_trades.status = 'OPEN' AND tell_shadow_trades.code_version = EXCLUDED.code_version""",
                                (tid, book, self.d, r['direction'], label, wstate, r['followed_a'], r.get('guard'), r['entry_idx'], r['exit_idx'], round(r['entry'], 2), round(r['stop'], 2), r['status'], r['exit_reason'], round(r['pts'], 2), round(r['net'], 2),
                                 bool(r['broke']), round(r['mfe'], 2), ok if book == 'A' else None, self.code))
            log('shadow', tid, label, ' '.join('%s %+.2f' % (b, out[b]['net']) for b in sorted(out)), out['A']['status'])

    def passes(self, final=False):
        self.run_watcher(); self.run_shadows(final=final)

    def finalize(self):
        """End of a session: drain the tail, then the last watcher and shadow pass with the tell's `final` convention (a trade still running is booked closed at the last close)."""
        try:
            while self.tl is not None and self.tl.backlog_bytes() > 0 and not self.end_reached: self.feed()
            self.process_pending(); self.run_watcher(); self.run_shadows(final=True)
        except Exception as e: log('finalize error', e)

    def step(self):
        now = datetime.datetime.now(ET); st, d = ('LIVE', self.once_date) if self.once_date else session_for(now)
        if self.ls is not None:
            past_close = (now.date() > self.dd) or (now.date() == self.dd and (now.hour, now.minute) >= (17, 2))
            if (past_close or (st == 'LIVE' and d != self.d and not self.once_date)) and not self.once_date: self.finalize(); self.end_session()
        if self.ls is None and st == 'LIVE' and not self.finished_once: self.start_session(d)
        if self.ls is not None:
            try: self.feed()
            except tailer.FileRewritten as e: log('tick file rewritten, restarting the session', e); self.end_session(); time.sleep(5); return
            if STATUS['backlog'] is not None and STATUS['backlog'] < CATCHUP_BYTES:
                STATUS['state'] = 'LIVE'; self.process_pending(); self.passes(final=False) if not self.once_date else None
                if self.once_date and (self.tl.backlog_bytes() == 0 or self.end_reached): self.process_pending(); self.passes(final=True); self.finished_once = True; log('once-date replay finished'); raise SystemExit(0)
        elif st != 'LIVE': STATUS['state'] = st
        STATUS['loopAt'] = time.time(); STATUS['ok'] = STATUS['errors'] < 20

    def run(self):
        while True:
            try: self.step()
            except SystemExit: raise
            except Exception as e:
                STATUS['errors'] += 1; STATUS['lastError'] = '%s: %s' % (type(e).__name__, e); log('step error', traceback.format_exc()[-1200:]); self.conn = None; time.sleep(5)
            time.sleep(POLL_S)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--once-date'); ap.add_argument('--port', type=int, default=8897); a = ap.parse_args()
    srv = HTTPServer(('127.0.0.1', a.port), Health); threading.Thread(target=srv.serve_forever, daemon=True).start()
    log('starting', vars(a), 'code', code_version()); Reader(a.once_date).run()


if __name__ == '__main__':
    main()
