"""Live SHADOW detector for the Argon liquidity-vacuum pullback (candidate Q4-4). Design: docs/ARGON_VACUUM_LIVE_SHADOW_DESIGN_20261108.md. NO orders, NO writes to active_setups, no server change.
Tails the live NQ tick file (same path choice, bar rule and LiveSession as the tell sidecar), and at every completed bar replays the batch functions of scripts/argon_vacuum_blind_funnel.py on the RTH slice so far
(stateless: a restart loses nothing; scripts/argon_vacuum_live/test_incremental.py proves a trigger seen at bar k never changes or disappears). Triggers of BOTH arms (CAND, FFC) are logged to argon_vacuum_shadow with
frozen decision columns; outcomes (forward 10/30/60-bar change from the reclaim close, MFE/MAE 30) fill once after the session. Health on http://127.0.0.1:8905/health.
Usage: shadow.py [--once-date YYYY-MM-DD] [--port 8905]"""
import os, sys, time, json, hashlib, argparse, datetime, threading, traceback, fcntl, shutil, subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer
from zoneinfo import ZoneInfo
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(ROOT, 'scripts', 'amt_tell_live')); sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tick_microstructure')); sys.path.insert(0, os.path.join(ROOT, 'scripts'))
import numpy as np
import persist, session, tailer, bootstrap, barbuilder
import prior_store
import argon_vacuum_blind_funnel as M
ET = ZoneInfo('America/New_York')
STORE = os.path.join(ROOT, 'scratch', 'argon_vacuum_live'); os.makedirs(STORE, exist_ok=True)
SCANS = os.path.join(STORE, 'scans.json')
HOLIDAYS = {'2026-11-26', '2026-12-25'}      # NYSE full holidays (CME trades a short session); extend before 2027 (CALENDAR_COVERAGE alarm)
POLL_S, CATCHUP_BYTES, STALE_FILE_S, LATE_ALARM_MIN = 1.0, 40 * 20000, 300, 3.0
CODE = dict(shadow=1, spec='GeminiArgonsnq_liquidity_vacuum_v2_spec 2026-11-07', funnel='argon_vacuum_blind_funnel.py', prereg='ARGON_VACUUM_BLIND_FUNNEL_PREREG_20261108')
STATUS = dict(ok=False, state='STARTING', session=None, started=time.time(), loopAt=None, errors=0, lastError=None, bars=0, rthBars=0, cand=0, ffc=0, priorsN=0, maxPb=None, pid=os.getpid())

def log(*a): print('[argon-vac]', datetime.datetime.now(ET).strftime('%H:%M:%S'), *a, flush=True)

def session_for(now):
    """('LIVE', trade_date) while a CME NQ session is open, else ('GAP'|'CLOSED', None). Session d = 18:00 ET of the previous calendar day through 17:00 ET of d."""
    wd = now.weekday(); h = now.hour
    if h >= 18: return ('CLOSED', None) if wd in (4, 5) else ('LIVE', str(now.date() + datetime.timedelta(days=1)))
    if h < 17: return ('CLOSED', None) if wd in (5, 6) else ('LIVE', str(now.date()))
    return ('GAP', None)

class Health(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps(STATUS, default=str).encode(); self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass

def rows_and_map(ls):
    """Complete bars of a LiveSession as the rounded .bars.tsv rows (the numbers a replay from the files sees) and the raw bar index of every row."""
    rows = []; raw = []
    for i, b in enumerate(ls.sb.done):
        rows.append((float(f"{b['start']:.3f}"), float(f"{b['end']:.3f}"), b['o'], b['h'], b['l'], b['c'], float(b['v']), float(f"{b['bid']:.1f}"), float(f"{b['ask']:.1f}"))); raw.append(i)
    return rows, raw

def decision_hash(arm, d, k, dr, ref, risk, pri):
    return hashlib.sha1(json.dumps([arm, d, k, dr, round(ref, 2), None if risk is None else round(risk, 2), {a: round(b, 4) for a, b in pri.items()}], sort_keys=True).encode()).hexdigest()[:16]

def load_scans():
    try: return json.load(open(SCANS))
    except Exception: return {}

def max_pb_for(priors, scans):
    pool = [x for S in priors for x in scans.get(S['date'], [])]
    return (int(np.clip(int(np.quantile(pool, 0.90, method='inverted_cdf')), 15, 35)) if len(pool) >= 10 else 20), len(pool)

class Shadow:
    def __init__(self, once_date=None, dry_out=None, min_priors=M.K_PRIOR):
        self.once_date = once_date; self.dry_out = dry_out; self.dry_rows = []; self.min_priors = min_priors; self.conn = None; self.d = None; self.ls = None; self.tl = None; self.priors = []; self.stored = {}; self.alarmed = {}; self.last_hb = 0; self.n_done_eval = 0
        self.max_pb = 20; self.end_reached = False; self.finalized = set(); self.first_eval = True; self.late_start = False; self.path = None; self.contract = None; self.note = None

    def db(self):
        if self.conn is None or self.conn.closed: self.conn = persist.connect()
        return self.conn

    def refresh_monitor(self, force=False):
        """Refresh the argonShadow key of public/learning_monitor.json (Monitor & Learning page, cv-110) via refresh_monitor.mjs: after a new setup trigger and every minute. Never blocks the loop, never overlaps itself."""
        if self.dry_out or self.once_date: return
        if getattr(self, '_rm_proc', None) is not None and self._rm_proc.poll() is None: return
        if not force and time.time() - getattr(self, '_rm_at', 0) < 60: return
        node = shutil.which('node')
        if node is None: return
        self._rm_at = time.time()
        try: self._rm_proc = subprocess.Popen([node, os.path.join(HERE, 'refresh_monitor.mjs')], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception as e: log('monitor refresh failed to start', e)

    def alarm(self, kind, detail, every=600):
        k = (kind, json.dumps(detail, sort_keys=True, default=str)[:80]); now = time.time()
        if now - self.alarmed.get(k, 0) < every: return
        self.alarmed[k] = now; log('ALARM', kind, detail)
        try:
            with self.db().cursor() as c: c.execute("INSERT INTO argon_vacuum_shadow_alarms (kind, detail) VALUES (%s,%s)", (kind, json.dumps(detail, default=str)))
        except Exception as e: log('could not write alarm', e)

    def pick_path(self, d):
        dd = datetime.date.fromisoformat(d); self.contract = persist.contract_for(self.db(), d)
        cands = bootstrap.primary_paths(self.contract, dd) if self.contract else []
        return max(cands, key=lambda p: os.stat(p).st_mtime) if cands else None

    def start_session(self, d):
        self.d = d; self.path = self.pick_path(d)
        if self.path is None: self.alarm('NO_TICK_FILE', dict(date=d, contract=self.contract)); self.d = None; return
        STATUS.update(session=d, state='PRIORS', contract=self.contract, tickFile=self.path); STATUS['loopAt'] = time.time()
        if d[:4] > max(M.EARLY)[:4]: self.alarm('CALENDAR_COVERAGE', dict(date=d, early_close_list_ends=max(M.EARLY)), every=86400)      # the early-close list (scratch/early_close_dates_*.json) must be extended before a new year
        self.priors, self.note = prior_store.ensure_priors(self.db(), d, log=lambda *a: (log(*a), STATUS.__setitem__('loopAt', time.time())))
        if not self.dry_out and not self.once_date:
            try: self.backfill_outcomes(d)
            except Exception as e: self.alarm('BACKFILL_ERROR', dict(err=str(e)), every=3600)
        self.max_pb, npool = max_pb_for(self.priors, load_scans())
        STATUS.update(priorsN=len(self.priors), maxPb=self.max_pb, scanPool=npool, note=self.note)
        with self.db().cursor() as c:
            c.execute("SELECT arm, bar_idx, direction, decision_hash FROM argon_vacuum_shadow WHERE trade_date=%s", (d,)); self.stored = {(a, k, int(dr)): h for a, k, dr, h in c.fetchall()}
        self.ls = session.LiveSession(d, 'split', []); self.dd = datetime.date.fromisoformat(d); self.end_reached = False; self.n_done_eval = 0; self.first_eval = True; self.late_start = False
        self.tl = tailer.ScidTailer(self.path, from_date=self.dd - datetime.timedelta(days=1))
        log(f'session {d}: contract {self.contract} file {self.path} priors {len(self.priors)} max_pb {self.max_pb} stored triggers {len(self.stored)} {self.note or ""}')
        STATUS['state'] = 'CATCHUP'

    # ---- evaluation: the batch functions on the complete RTH bars so far ----------------------------------------------------------------------
    def analyse(self, final=False):
        rows, raw = rows_and_map(self.ls); S = M.session_from_rows(self.d, rows)
        if S is None: return None
        close = S['close']; keep = [j for j, r in enumerate(rows) if r[0] >= M.OPEN_SEC and r[1] <= close]; rawk = [raw[j] for j in keep]
        P = M.priors_for(self.priors); F = M.features(S, P)
        evc = M.run_fsm(S, F, P, self.max_pb, False)[0]; evf = M.run_ffc(S, F)
        return S, F, P, rawk, evc, evf

    def evaluate(self, final=False):
        if len(self.priors) < self.min_priors or self.d in HOLIDAYS or (self.late_start and not self.dry_out): return      # no inserts on an NYSE full holiday or after a late session start (bars would be phase-shifted)
        res = self.analyse(final)
        if res is None: return
        S, F, P, rawk, evc, evf = res; pri = {k: float(P[k]) for k in ('atr', 'floor', 'base', 'act_thr', 'clv_hi', 'clv_lo')}
        found = {}
        for k, dr, risk in evc: found[('CAND', k, dr)] = risk
        for k, dr in evf: found[('FFC', k, dr)] = None
        STATUS.update(bars=len(self.ls.sb.done), rthBars=S['n'], cand=sum(1 for x in found if x[0] == 'CAND'), ffc=sum(1 for x in found if x[0] == 'FFC'))
        nowet = datetime.datetime.now(ET).replace(tzinfo=None); new = 0
        for (arm, k, dr), risk in sorted(found.items(), key=lambda x: x[0][1]):
            h = decision_hash(arm, self.d, k, dr, float(S['c'][k]), risk, pri)
            if (arm, k, dr) in self.stored:
                if self.stored[(arm, k, dr)] != h: self.alarm('DRIFT', dict(arm=arm, bar=k, date=self.d, stored=self.stored[(arm, k, dr)], now=h), every=3600)
                continue
            fired = persist.et_naive(self.ls.bar_end_utc[rawk[k]]); late = round((nowet - fired).total_seconds() / 60.0, 1)
            feat = dict(ema_tr=float(F['ema'][k]), tr=float(F['tr'][k]), activity=float(P['base'] / max(S['en'][k] - S['st'][k], P['floor'])), since_open=int(F['since'][k]), raw_idx=int(rawk[k]), first_eval_after_catchup=bool(self.first_eval), backlog_bytes=STATUS.get('backlog'), late_start=bool(self.late_start),
                        eval_px=float(self.ls.sb.cur['c'] if self.ls.sb.cur is not None and self.ls.sb.cur['c'] is not None else self.ls.sb.done[-1]['c']), eval_utc=datetime.datetime.utcnow().isoformat(timespec='milliseconds'))
            row = (arm, self.d, k, dr, fired, float(S['st'][k]), float(S['en'][k]), float(S['c'][k]), risk, self.max_pb, json.dumps(pri), json.dumps(feat), h, json.dumps(CODE), nowet, late)
            if self.dry_out: self.dry_rows.append(dict(arm=arm, bar=k, dir=dr, fired=str(fired), entry_ref=float(S['c'][k]), risk=risk, hash=h))
            else:
                with self.db().cursor() as c:
                    c.execute("""INSERT INTO argon_vacuum_shadow (arm, trade_date, bar_idx, direction, fired_at, bar_start_sec, bar_end_sec, entry_ref, init_risk_pts, max_pb_bars, priors, feat, decision_hash, code_version, detected_at, late_min)
                                 VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (arm, trade_date, bar_idx, direction) DO NOTHING""", row)
            self.stored[(arm, k, dr)] = h; new += 1
            if arm == 'CAND': self.refresh_monitor(force=True)
            if arm == 'CAND': log(f'*** FIRE {self.d} bar {k} {"LONG" if dr == 1 else "SHORT"} @ {S["c"][k]} risk {risk:.2f} fired_at {fired} late {late} min')
            if late > LATE_ALARM_MIN and arm == 'CAND': self.alarm('LATE_INSERT', dict(date=self.d, bar=k, late_min=late), every=60)
        for key in list(self.stored):
            if key[1] < S['n'] and key not in found and not final: self.alarm('VANISHED', dict(key=list(key), date=self.d), every=3600)
        self.first_eval = False
        if new: log(f'{self.d}: +{new} triggers (cand {STATUS["cand"]} ffc {STATUS["ffc"]}) rth bars {S["n"]}')

    # ---- end of session: persist bars, scan for max_pb, fill outcomes ---------------------------------------------------------------------------
    def fill_outcomes(self, d, S):
        """Fill the once-only outcome columns of every unfilled trigger of trade date d from its COMPLETE session S (hard-flat clamp). Never overwrites (outcome_at IS NULL)."""
        flat_ok = S['en'] <= S['close'] - M.FLAT_BEFORE_CLOSE
        flat = int(np.where(flat_ok)[0].max()) if flat_ok.any() else S['n'] - 1
        nowet = datetime.datetime.now(ET).replace(tzinfo=None); c_, h_, l_ = S['c'], S['h'], S['l']; n = 0
        with self.db().cursor() as c:
            c.execute("SELECT id, bar_idx, direction FROM argon_vacuum_shadow WHERE trade_date=%s AND outcome_at IS NULL", (d,))
            for rid, k, dr in c.fetchall():
                if k >= S['n']: self.alarm('OUTCOME_BAR_MISSING', dict(date=d, bar=k, bars=S['n']), every=3600); continue
                f = {}
                for hz in (10, 30, 60): j = min(k + hz, flat); f[hz] = None if j <= k else round(float(dr * (c_[j] - c_[k])), 2)
                j30 = min(k + 30, flat)
                if j30 > k:
                    hi = float(h_[k + 1:j30 + 1].max()); lo = float(l_[k + 1:j30 + 1].min()); mfe = (hi - c_[k]) if dr == 1 else (c_[k] - lo); mae = (c_[k] - lo) if dr == 1 else (hi - c_[k])
                else: mfe = mae = None
                extra = dict(open_next=(float(S['o'][k + 1]) if k + 1 < S['n'] else None), bars_to_flat=int(flat - k))
                c.execute("UPDATE argon_vacuum_shadow SET fwd_10=%s, fwd_30=%s, fwd_60=%s, mfe_30=%s, mae_30=%s, outcome_at=%s, feat=COALESCE(feat,'{}'::jsonb) || %s::jsonb WHERE id=%s AND outcome_at IS NULL",
                          (f[10], f[30], f[60], None if mfe is None else round(float(mfe), 2), None if mae is None else round(float(mae), 2), nowet, json.dumps(extra), rid)); n += 1
        return n

    def drain(self):
        """Read the tick file to its end before finalizing (a session finalized mid-catch-up would persist a partial day)."""
        for _ in range(200):
            got = self.tl.poll(max_records=500000)
            for t in got:
                if t.ts_et.date() > self.dd or (t.ts_et.date() == self.dd and t.ts_et.hour >= 17): self.end_reached = True; return
                self.ls.feed_trade(t)
            if not got: return

    def finalize(self):
        d = self.d
        try:
            self.drain(); self.ls.finish_scale_detection(); self.evaluate(final=True); res = self.analyse(True); bars = self.ls.finished_bars()
            if self.dry_out:
                json.dump(dict(date=d, rows=self.dry_rows, n_rth=None if res is None else res[0]['n'], max_pb=self.max_pb, priors=[x['date'] for x in self.priors]), open(self.dry_out, 'w'), indent=1); log(f'DRY RUN {d}: {len(self.dry_rows)} triggers -> {self.dry_out}')
            elif res is not None and bars:
                S, F, P, rawk, evc, evf = res; nrth = S['n']; nowet = datetime.datetime.now(ET).replace(tzinfo=None)
                dbv = persist.db_rth_volume(self.db(), d); tick = self.ls.rth_contracts; vdiff = (100.0 * (tick - dbv) / dbv) if dbv else None
                if vdiff is not None and abs(vdiff) > 3.0: self.alarm('VOLUME_MISMATCH', dict(date=d, tick=tick, db=dbv, diff_pct=round(vdiff, 2), file=self.path), every=3600)
                qual = nrth >= 60; valid = bool(qual and not self.late_start and dbv and vdiff is not None and abs(vdiff) <= 3.0 and len(self.priors) >= self.min_priors)
                sha = None
                if valid and not self.once_date:
                    sha = barbuilder.write_session_files(bars, os.path.join(prior_store.PRI, f'{d}.bars.tsv'), os.path.join(prior_store.PRI, f'{d}.vap.tsv'))      # atomic (tmp + replace)
                    pbs = M.run_fsm(S, F, P, float('inf'), True)[3]; sc = load_scans(); sc[d] = pbs; json.dump(sc, open(SCANS + '.tmp', 'w')); os.replace(SCANS + '.tmp', SCANS)      # only a validated, complete session becomes a prior
                    self.fill_outcomes(d, S)
                elif valid: self.fill_outcomes(d, S)
                else: self.alarm('SESSION_NOT_VALIDATED', dict(date=d, qualifying=qual, late_start=self.late_start, vol_diff_pct=vdiff, db=dbv, priors=len(self.priors)), every=3600)
                with self.db().cursor() as c:
                    c.execute("""INSERT INTO argon_vacuum_shadow_sessions (trade_date, contract, tick_file, state, n_bars, n_rth_bars, n_cand, n_ffc, priors_n, last_tick_at, heartbeat_at, bars_sha256, notes)
                                 VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (trade_date) DO UPDATE SET state=EXCLUDED.state, n_bars=EXCLUDED.n_bars, n_rth_bars=EXCLUDED.n_rth_bars, n_cand=EXCLUDED.n_cand, n_ffc=EXCLUDED.n_ffc,
                                 last_tick_at=EXCLUDED.last_tick_at, heartbeat_at=EXCLUDED.heartbeat_at, bars_sha256=EXCLUDED.bars_sha256, notes=EXCLUDED.notes WHERE argon_vacuum_shadow_sessions.state <> 'FINAL'""",
                              (d, self.contract, self.path, 'FINAL' if valid else 'INVALID', len(bars), nrth, len(evc), len(evf), len(self.priors), persist.et_naive(self.ls.last_tick_utc), nowet, sha,
                               json.dumps(dict(qualifying=bool(qual), valid=valid, max_pb=self.max_pb, note=self.note, vol_tick=tick, vol_db=dbv, vol_diff_pct=vdiff, late_start=self.late_start))))
                log(f'{"FINAL" if valid else "INVALID"} {d}: rth bars {nrth} cand {len(evc)} ffc {len(evf)} qualifying {qual} vol_diff {vdiff}')
            self.finalized.add(d)
        except Exception as e:
            STATUS['errors'] += 1; STATUS['lastError'] = f'{type(e).__name__}: {e}'; self.conn = None; self.alarm('FINALIZE_ERROR', dict(date=d, err=str(e), tb=traceback.format_exc()[-600:]), every=60)
        self.d = None; self.ls = None; self.tl = None

    def backfill_outcomes(self, d):
        """Startup: triggers of earlier dates whose finalize never ran (downtime, an error) get their outcomes from the validated prior-store file of that date, if it exists."""
        with self.db().cursor() as c:
            c.execute("SELECT DISTINCT trade_date FROM argon_vacuum_shadow WHERE outcome_at IS NULL AND trade_date < %s", (d,)); dates = [str(x[0]) for x in c.fetchall()]
        for x in dates:
            p = os.path.join(prior_store.PRI, f'{x}.bars.tsv'); S = M.load_day(p) if os.path.exists(p) else None
            if S is None: self.alarm('OUTCOMES_ORPHANED', dict(date=x), every=86400); continue
            log(f'backfilled outcomes for {x}: {self.fill_outcomes(x, S)} rows')

    # ---- loop -----------------------------------------------------------------------------------------------------------------------------------
    def pump(self):
        trig = False
        for t in self.tl.poll(max_records=200000):
            if t.ts_et.date() > self.dd or (t.ts_et.date() == self.dd and t.ts_et.hour >= 17): self.end_reached = True; break
            self.ls.feed_trade(t)
        backlog = self.tl.backlog_bytes(); STATUS['backlog'] = backlog; STATUS['bars'] = len(self.ls.sb.done); STATUS['trades'] = self.ls.n_trades; STATUS['lastTick'] = str(persist.et_naive(self.ls.last_tick_utc))
        if backlog < CATCHUP_BYTES:
            self.ls.finish_scale_detection()
            if self.first_eval and self.ls.first_tick_utc is not None and not self.late_start:
                ft = self.ls.first_tick_utc.astimezone(ET)
                if ft > datetime.datetime.combine(self.dd - datetime.timedelta(days=1), datetime.time(19, 0), tzinfo=ET): self.late_start = True; self.alarm('LATE_SESSION_START', dict(date=self.d, first_tick=str(ft)), every=86400)
            if len(self.ls.sb.done) != self.n_done_eval:
                try: self.evaluate(); self.n_done_eval = len(self.ls.sb.done)
                except Exception as e:
                    self.conn = None; STATUS['errors'] += 1; STATUS['lastError'] = f'{type(e).__name__}: {e}'; self.alarm('EVAL_ERROR', dict(err=str(e), tb=traceback.format_exc()[-600:]), every=120)
            STATUS['state'] = 'LIVE' if len(self.priors) >= self.min_priors else 'NO_PRIORS'
        if not self.once_date:
            age = time.time() - os.stat(self.path).st_mtime
            STATUS['tickStale'] = age > STALE_FILE_S
            if STATUS['tickStale']:
                n = datetime.datetime.now(ET)
                if 9 <= n.hour < 16 and n.weekday() < 5: self.alarm('TICK_FILE_QUIET', dict(file=self.path, age_s=int(age)), every=1800)

    def heartbeat(self):
        self.refresh_monitor()
        if time.time() - self.last_hb < 15 or self.ls is None or self.dry_out: return
        self.last_hb = time.time()
        try:
            with self.db().cursor() as c:
                c.execute("""INSERT INTO argon_vacuum_shadow_sessions (trade_date, contract, tick_file, state, n_bars, n_rth_bars, n_cand, n_ffc, priors_n, last_tick_at, heartbeat_at)
                             VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW()) ON CONFLICT (trade_date) DO UPDATE SET state=EXCLUDED.state, n_bars=EXCLUDED.n_bars, n_rth_bars=EXCLUDED.n_rth_bars, n_cand=EXCLUDED.n_cand,
                             n_ffc=EXCLUDED.n_ffc, priors_n=EXCLUDED.priors_n, last_tick_at=EXCLUDED.last_tick_at, heartbeat_at=NOW() WHERE argon_vacuum_shadow_sessions.state <> 'FINAL'""",
                          (self.d, self.contract, self.path, STATUS['state'], STATUS['bars'], STATUS['rthBars'], STATUS['cand'], STATUS['ffc'], len(self.priors), persist.et_naive(self.ls.last_tick_utc)))
        except Exception as e: log('heartbeat failed', e)

    def run(self, port):
        if not self.once_date:                                  # a once-date replay (tests) takes no lock and opens no port, so it can run beside the live daemon
            lock = open(os.path.join(STORE, '.lock'), 'w')
            try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError: log('another shadow is running; exiting'); return
            threading.Thread(target=lambda: HTTPServer(('127.0.0.1', port), Health).serve_forever(), daemon=True).start()
        log(f'started pid {os.getpid()} health :{port if not self.once_date else "off"}')
        while True:
            try:
                now = datetime.datetime.now(ET); kind, d = (('LIVE', self.once_date) if self.once_date else session_for(now))
                if self.once_date and self.d and self.end_reached: self.finalize(); log('once-date run complete'); return
                if self.d and not self.once_date and (kind != 'LIVE' or d != self.d or self.end_reached): self.finalize(); STATUS['state'] = 'IDLE'
                if kind == 'LIVE' and self.d is None and (self.once_date or d not in self.finalized): self.start_session(d)
                if self.d:
                    self.pump(); self.heartbeat()
                STATUS.update(ok=True, loopAt=time.time())
            except tailer.FileRewritten as e: self.alarm('FILE_REWRITTEN', dict(err=str(e)), every=60); self.d = None
            except Exception as e:
                STATUS['errors'] += 1; STATUS['lastError'] = f'{type(e).__name__}: {e}'; self.alarm('LOOP_ERROR', dict(err=str(e), tb=traceback.format_exc()[-600:]), every=60)
            time.sleep(POLL_S)

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--once-date'); ap.add_argument('--port', type=int, default=8905); ap.add_argument('--dry-out', help='TEST ONLY: write triggers to this json, touch no table'); ap.add_argument('--min-priors', type=int, default=M.K_PRIOR, help='TEST ONLY'); ap.add_argument('--allow-db-write', action='store_true', help='TEST ONLY'); a = ap.parse_args()
    if (a.dry_out or a.min_priors != M.K_PRIOR) and not a.once_date: sys.exit('--dry-out/--min-priors need --once-date')
    if a.once_date and not a.dry_out and not a.allow_db_write: sys.exit('--once-date writes replay rows into the LIVE tables; use --dry-out FILE, or --allow-db-write for a deliberate test (then delete the test rows)')
    Shadow(a.once_date, a.dry_out, a.min_priors).run(a.port)
