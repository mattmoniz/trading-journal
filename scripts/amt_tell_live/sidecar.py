"""Live node-ladder tell sidecar (docs/AMT_TELL_LIVE_PROJECT_SPEC_20261028.md). Stage 1 = watch only: tails the live Sierra NQ tick file, builds 500-contract bars under BOTH overflow readings
(split / whole, Stage-0 gate 1 -- the user's Sierra bars decide which is right), replays the research tell evaluator on the session so far at every new forming bar, and persists every virtual trade of the two
books (V1 tell-fade exit, V3 hold-to-close) to amt_tell_trades. It places NO orders and writes nothing to active_setups.
Stateless by design: on every start the session is replayed from the tick file, so a restart neither loses nor late-inserts a signal (fired_at is the real tick time of the signal bar); the database holds a
durable view and a decision hash that turns any later disagreement into an alarm instead of a silent overwrite. Health on http://127.0.0.1:8898/health for the Node manager (watchdog + banner).
Usage: sidecar.py [--once-date YYYY-MM-DD] [--rules split,whole] [--port 8898]"""
import os, sys, time, json, hashlib, argparse, datetime, threading, traceback
from http.server import BaseHTTPRequestHandler, HTTPServer
from zoneinfo import ZoneInfo
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, '..', 'tick_microstructure'))
import persist, core, session, tailer, bootstrap, barbuilder
import scid_reader as sr

ET = ZoneInfo('America/New_York')
ROOT = persist.ROOT
OUT_DIR = os.path.join(ROOT, 'scratch', 'amt_tell_live')
POLL_S = 1.0
CATCHUP_BYTES = 40 * 20000          # fewer unread bytes than this = caught up with the file; before that, feed without evaluating
STALE_FILE_S = 300                  # a live NQ tick file that has not been written for this long during a session is an outage
VOL_TOL = 0.03
STATUS = dict(ok=False, state='STARTING', session=None, started=time.time(), loopAt=None, tickStale=False, lastEvalMs=None, errors=0, lastError=None, rules={}, backlog=None, pid=os.getpid())


def log(*a): print('[amt-tell]', datetime.datetime.now(ET).strftime('%H:%M:%S'), *a, flush=True)


def session_for(now):
    """('LIVE', trade_date) while a CME NQ session is open, else ('GAP'|'CLOSED', None). Session d = 18:00 ET of the previous calendar day through 17:00 ET of d (research definition)."""
    wd = now.weekday(); h = now.hour
    if h >= 18: return ('CLOSED', None) if wd in (4, 5) else ('LIVE', str(now.date() + datetime.timedelta(days=1)))
    if h < 17: return ('CLOSED', None) if wd in (5, 6) else ('LIVE', str(now.date()))
    return ('GAP', None)


class Health(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps(STATUS, default=str).encode(); self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass


def serve_health(port):
    srv = HTTPServer(('127.0.0.1', port), Health); threading.Thread(target=srv.serve_forever, daemon=True).start()


class Runner:
    def __init__(self, rules, once_date=None):
        self.rules = rules; self.conn = None; self.cur = None; self.tl = None; self.d = None; self.path = None; self.contract = None; self.once_date = once_date
        self.last_alarm = {}; self.dirty = False; self.end_reached = False; self.dd = None; self.finalized_once = False; self.last_hb = 0.0; self.last_volcheck = 0.0; self.eval_ms = 0; self.code = core.code_version(); self.baseline_n = {}; self.last_eval_error_at = 0.0; self.last_stale_probe = 0.0

    # ---- helpers -----------------------------------------------------------------------------------------------------
    def db(self):
        if self.conn is None or self.conn.closed: self.conn = persist.connect()
        return self.conn

    def alarm(self, kind, detail, every=600):
        k = (kind, json.dumps(detail, sort_keys=True, default=str)[:60]); now = time.time()
        if now - self.last_alarm.get(k, 0) < every: return
        self.last_alarm[k] = now; log('ALARM', kind, detail)
        try: persist.alarm(self.db(), kind, detail)
        except Exception as e: log('could not write alarm', e)

    def pick_path(self, d):
        dd = datetime.date.fromisoformat(d); self.contract = persist.contract_for(self.db(), d)
        cands = bootstrap.primary_paths(self.contract, dd) if self.contract else []
        if not cands: return None
        return max(cands, key=lambda p: os.stat(p).st_mtime)        # the live file is the freshly written one (CLAUDE.md: which Sierra instance is live can flip)

    # ---- session lifecycle -------------------------------------------------------------------------------------------
    def busy_log(self, *a):
        """log() that also keeps the loop heartbeat moving, for long start-up work (baseline rebuild, missed-session recovery) so the manager does not read a busy sidecar as a wedged one."""
        log(*a); STATUS['loopAt'] = time.time()

    def start_session(self, d):
        self.d = d; self.path = self.pick_path(d)
        if self.path is None: self.alarm('NO_TICK_FILE', dict(date=d, contract=self.contract)); self.d = None; return
        log(f'session {d}: contract {self.contract}, tick file {self.path}')
        STATUS.update(session=d, state='BOOTSTRAP', contract=self.contract, tickFile=self.path); STATUS['loopAt'] = time.time()
        self.baseline_n = bootstrap.ensure_baseline(self.db(), d, self.rules, log=self.busy_log)
        if not self.once_date:
            STATUS['state'] = 'RECOVER'; self.recover_missed(d)
        self.cur = {}
        for r in self.rules:
            prior, _ = persist.load_prior_stats(self.db(), d, r); self.cur[r] = session.LiveSession(d, r, prior)
        self.dd = datetime.date.fromisoformat(d); self.end_reached = False
        self.tl = tailer.ScidTailer(self.path, from_date=self.dd - datetime.timedelta(days=1)); self.dirty = False
        STATUS.update(state='CATCHUP', baseline=self.baseline_n)

    def recover_missed(self, current_d):
        """A session that ended while the sidecar was not running (a restart or outage across a session boundary) was never finalized and its tells were never logged. Replay it from the tick file, log its tells
        (late_min shows they were found after the fact), book it FINAL. Only sessions at or after the first one this log ever recorded: earlier history belongs to the research, not to this forward log
        (and the sealed hold-out must not be looked at by accident). A recovered session without a full 20-session baseline is NOT booked (it would silently produce no decisions); it is retried at the next start."""
        with self.db().cursor() as c:
            c.execute("SELECT MIN(trade_date) FROM amt_tell_sessions"); first = c.fetchone()[0]
        if first is None: return
        for x in bootstrap.completed_session_dates(self.db(), current_d, 8):
            ds = str(x)
            if x < first: continue
            with self.db().cursor() as c:
                c.execute("SELECT count(*) FROM amt_tell_sessions WHERE trade_date=%s AND state='FINAL'", (ds,)); nfinal = c.fetchone()[0]
            if nfinal >= len(self.rules): continue
            self.busy_log(f'recovering missed session {ds}')
            sess, ok, info = bootstrap.build_sessions(self.db(), ds, self.rules)
            if sess is None: self.alarm('RECOVER_FAILED', dict(date=ds, why=str(info)), every=3600); continue
            short = []
            for r, ls in sess.items():
                ls.prior, _ = persist.load_prior_stats(self.db(), ds, r)
                if len(ls.prior) < core.PRIOR_N: short.append(r)
            if short: self.alarm('RECOVER_NO_BASELINE', dict(date=ds, rules=short), every=3600); continue
            ls0 = next(iter(sess.values())); dbv = persist.db_rth_volume(self.db(), ds); tick = ls0.rth_contracts
            vc = (tick, dbv, (100.0 * (tick - dbv) / dbv) if dbv else None)
            self._book_final(ds, sess, persist.contract_for(self.db(), ds), info.get('file') if isinstance(info, dict) else None, 0, vc)
            self.busy_log(f'recovered {ds}: volume check {vc}')

    def _feed(self, trades):
        """Feed logical trades to every rule's session; True if any created a new forming bar. Sets end_reached once a tick lies past the session end (17:00 ET of the trade date)."""
        trig = False; dd = self.dd
        for t in trades:
            if t.ts_et.date() > dd or (t.ts_et.date() == dd and t.ts_et.hour >= 17): self.end_reached = True; break
            for ls in self.cur.values(): trig |= ls.feed_trade(t)
        return trig

    def pump(self):
        trig = self._feed(self.tl.poll(max_records=200000))
        backlog = self.tl.backlog_bytes(); STATUS['backlog'] = backlog
        if backlog < CATCHUP_BYTES:
            for ls in self.cur.values(): trig |= ls.finish_scale_detection()      # a session start with fewer than 300 trades so far
        if trig: self.dirty = True
        if backlog < CATCHUP_BYTES:
            if self.dirty: self.evaluate_all(); self.dirty = False
            STATUS['state'] = 'LIVE'
        STATUS['tickStale'] = self.tick_file_stale()
        if STATUS['tickStale']: self.alarm('TICK_FILE_STALE', dict(file=self.path, age_s=int(time.time() - os.stat(self.path).st_mtime)))
        if self.tl.backwards: self.alarm('TICKS_BACKWARDS', dict(count=self.tl.backwards), every=3600)

    def tick_file_stale(self):
        """The tick file is an OUTAGE only if it stopped growing while the price database (a different Sierra export) is still receiving NQ bars -- the failure that matters (which Sierra instance is live can flip,
        CLAUDE.md). If the file AND the database are both quiet the market is closed or halted (early close, holiday, a thin hour) and the existing price-bars banner covers it. Probed at most once a minute."""
        if self.once_date: return False
        age = time.time() - os.stat(self.path).st_mtime
        if age <= STALE_FILE_S: self.last_stale_probe = 0.0; return False
        if time.time() - self.last_stale_probe < 60: return bool(STATUS.get('tickStale'))
        self.last_stale_probe = time.time()
        ls = next(iter(self.cur.values())); last_tick = persist.et_naive(ls.last_tick_utc)
        with self.db().cursor() as c:
            c.execute("SELECT MAX(ts) FROM price_bars_primary WHERE symbol='NQ' AND ts >= NOW()::timestamp - interval '45 minutes' AND ts <= NOW()::timestamp")
            latest = c.fetchone()[0]
        return bool(latest is not None and last_tick is not None and (latest - last_tick).total_seconds() > 120)

    def evaluate_all(self):
        t0 = time.time()
        for r, ls in self.cur.items():
            try:
                res = ls.evaluate()
                if res is None: continue
                st = persist.persist_result(self.db(), ls, res, self.code)
                if st['new'] or st['drift'] or st['vanished']: log(f'{ls.d} {r}: {st} bars={res["n_done"]}')
            except tailer.FileRewritten: raise
            except Exception as e:
                STATUS['errors'] += 1; self.last_eval_error_at = time.time(); STATUS['lastError'] = f'{type(e).__name__}: {e}'; self.alarm('EVAL_ERROR', dict(rule=r, err=str(e), tb=traceback.format_exc()[-800:]), every=120)
        self.eval_ms = int((time.time() - t0) * 1000); STATUS['lastEvalMs'] = self.eval_ms
        if self.eval_ms > 8000: self.alarm('EVAL_SLOW', dict(ms=self.eval_ms), every=1800)

    def heartbeat(self, state='LIVE'):
        now = time.time()
        if now - self.last_hb < 10: return
        self.last_hb = now; conn = self.db(); last_tick = None
        for r, ls in self.cur.items():
            last_tick = persist.et_naive(ls.last_tick_utc)
            persist.save_session(conn, self.d, r, contract=self.contract, tick_file=self.path, state=state, n_bars=len(ls.sb.done), last_tick_at=last_tick, n_trades=ls.n_trades, contracts=ls.contracts,
                                 rth_contracts=ls.rth_contracts, db_rth_contracts=None, vol_diff_pct=None, tail_backwards=self.tl.backwards, baseline_n=self.baseline_n.get(r), bars_sha256=None, eval_ms=self.eval_ms)
            STATUS['rules'][r] = dict(bars=len(ls.sb.done), trades=ls.n_trades, lastTick=str(last_tick))

    def volume_check(self, final=False):
        """Tick RTH contracts vs price_bars_primary for the same minutes (a wrong contract file or a corrupted feed shows up here)."""
        now = datetime.datetime.now(ET)
        if not final and (self.once_date or STATUS.get('state') != 'LIVE' or time.time() - self.last_volcheck < 1800 or now.hour < 10 or now.hour >= 16): return None      # intraday check only once caught up with the file
        self.last_volcheck = time.time(); ls = next(iter(self.cur.values())); dd = ls.dd
        lim = 960 if final else max(570, now.hour * 60 + now.minute - 5)
        with self.db().cursor() as c:
            c.execute("SELECT COALESCE(SUM(volume),0) FROM price_bars_primary WHERE symbol='NQ' AND ts >= %s::date + time '09:30' AND ts < %s::date + make_interval(mins => %s)", (self.d, self.d, lim))
            dbv = int(c.fetchone()[0])
        tick = sum(v for m, v in ls.rth_min.items() if m < lim)
        diff = 100.0 * (tick - dbv) / dbv if dbv else None
        if diff is not None and abs(diff) > 100 * VOL_TOL: self.alarm('VOLUME_MISMATCH', dict(date=self.d, tick=tick, db=dbv, diff_pct=round(diff, 2), upto_min=lim, file=self.path), every=3600)
        return tick, dbv, diff

    def _book_final(self, d, sessions, contract, path, backwards, vc):
        """Final evaluation (a trade still running is booked closed at the last close, as the research does), persist, stats, bar files and FINAL rows for one finished session. Shared by finalize() and recover_missed()."""
        validated = bool(vc and vc[2] is not None and abs(vc[2]) <= 100 * VOL_TOL)
        os.makedirs(OUT_DIR, exist_ok=True)
        for r, ls in sessions.items():
            res = ls.evaluate(force=True, final=True)
            if res is not None: persist.persist_result(self.db(), ls, res, self.code)
            bars = ls.finished_bars()
            if bars:
                persist.save_session_stats(self.db(), d, r, core.stats_of_session(bars, d), len(bars), validated)
                sha = barbuilder.write_session_files(bars, os.path.join(OUT_DIR, f'{d}.{r}.bars.tsv'), os.path.join(OUT_DIR, f'{d}.{r}.vap.tsv'))
            else: sha = None
            persist.save_session(self.db(), d, r, contract=contract, tick_file=path, state='FINAL', n_bars=len(bars), last_tick_at=persist.et_naive(ls.last_tick_utc), n_trades=ls.n_trades, contracts=ls.contracts,
                                 rth_contracts=ls.rth_contracts, db_rth_contracts=vc[1] if vc else None, vol_diff_pct=round(vc[2], 2) if vc and vc[2] is not None else None, tail_backwards=backwards,
                                 baseline_n=len(ls.prior), bars_sha256=sha, eval_ms=self.eval_ms)
        return validated

    def finalize(self):
        if not self.cur: return
        log(f'finalizing {self.d}')
        try:
            while self.tl.backlog_bytes() > 0 and not self.end_reached: self._feed(self.tl.poll(max_records=200000))
            for ls in self.cur.values(): ls.finish_scale_detection()
            vc = self.volume_check(final=True)
            validated = self._book_final(self.d, self.cur, self.contract, self.path, self.tl.backwards, vc)
            log(f'finalized {self.d}: validated={validated} volume check={vc}')
        except Exception as e:
            self.alarm('FINALIZE_ERROR', dict(date=self.d, err=str(e), tb=traceback.format_exc()[-800:]), every=60)
        self.cur = None; self.tl = None; self.d = None; self.finalized_once = True; STATUS.update(session=None, state='IDLE')

    # ---- main loop ---------------------------------------------------------------------------------------------------
    def step(self):
        if self.once_date and self.finalized_once: log('once-date replay finished'); raise SystemExit(0)
        now = datetime.datetime.now(ET); st, d = ('LIVE', self.once_date) if self.once_date else session_for(now)
        if self.cur is not None:
            past_close = (now.date() > datetime.date.fromisoformat(self.d)) or (now.date() == datetime.date.fromisoformat(self.d) and (now.hour, now.minute) >= (17, 2))
            if past_close or (st == 'LIVE' and d != self.d and not self.once_date):
                self.finalize()
                if self.once_date: return
        if self.cur is None and st == 'LIVE': self.start_session(d)
        if self.cur is not None:
            try: self.pump()
            except tailer.FileRewritten as e:
                self.alarm('FILE_REWRITTEN', dict(err=str(e), date=self.d), every=60); self.cur = None; self.tl = None; time.sleep(5); return
            self.volume_check(); self.heartbeat()
        elif st != 'LIVE': STATUS['state'] = st
        STATUS['loopAt'] = time.time(); STATUS['ok'] = (not STATUS['tickStale']) and (STATUS['errors'] < 20) and (time.time() - self.last_eval_error_at > 600)      # an evaluation error in the last 10 minutes is not 'ok' even before 20 pile up

    def run(self):
        while True:
            try: self.step()
            except Exception as e:
                STATUS['errors'] += 1; STATUS['lastError'] = f'{type(e).__name__}: {e}'; log('step error', traceback.format_exc()[-1200:])
                try: self.alarm('SIDECAR_ERROR', dict(err=str(e), tb=traceback.format_exc()[-800:]), every=300)
                except Exception: pass
                self.conn = None; time.sleep(5)
            time.sleep(POLL_S)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--rules', default='split,whole'); ap.add_argument('--port', type=int, default=8898); ap.add_argument('--once-date', help='replay one historical session as if live (testing)')
    a = ap.parse_args(); serve_health(a.port); log('starting', vars(a)); Runner(tuple(a.rules.split(',')), a.once_date).run()


if __name__ == '__main__':
    main()
