"""LIVE detector of the user's ORIGINAL expansion rule (Q4-5): ROC10 expansion onset (|Z_ROC10| > 2, direction = the sign of ROC10), Globex AND RTH tracks, using the SAME code as the research (scripts/vacuum_sim/features.py + v2.py: continuous gap-masked windows, the user's Sierra
Bollinger definitions). BOTH tracks fire as candidates (2026-11-09, user: 'Fire in rth and globex'): next-bar-open entry, 30-bar hold, one position at a time per track -> flag `taken`. Research: Globex expansions continued in 2026 (not significant), RTH expansions REVERTED (so the RTH fade-equivalent is shown next to the with-expansion result). SHADOW ONLY: places NO orders, nothing in active_setups, no server change.
Stateless replay on every new bar (a restart loses nothing); decision columns frozen at insert, outcomes fill once. Health on 127.0.0.1:8906. Usage: shadow.py [--once-date D --dry-out FILE] [--port 8906]"""
import os, sys, time, json, hashlib, argparse, datetime, threading, traceback, fcntl, glob, shutil, subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer
from zoneinfo import ZoneInfo
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
for sub in ('scripts/amt_tell_live', 'scripts/tick_microstructure', 'scripts', 'scripts/vacuum_sim'): sys.path.insert(0, os.path.join(ROOT, sub))
import numpy as np
import persist, session, tailer, bootstrap, barbuilder
import importlib.util
def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(spec); sys.modules[name] = m; spec.loader.exec_module(m); return m
# the research modules are loaded under unique names: scripts/tick_microstructure/features.py has the same file name and bootstrap/extract_cells already imported it
Fm = _load('vac_features', os.path.join(ROOT, 'scripts', 'vacuum_sim', 'features.py'))
_saved = sys.modules.get('features'); sys.modules['features'] = Fm
v2 = _load('vac_v2', os.path.join(ROOT, 'scripts', 'vacuum_sim', 'v2.py'))
if _saved is not None: sys.modules['features'] = _saved
import turn_signal as TS
assert TS.Z_RATIO == Fm.Z_RATIO and TS.Z_ROC == Fm.Z_ROC, 'turn_signal thresholds must equal the research features'
ET = ZoneInfo('America/New_York'); STORE = os.path.join(ROOT, 'scratch', 'vacuum_live'); os.makedirs(STORE, exist_ok=True)
PRI = os.path.join(ROOT, 'scratch', 'argon_vacuum_live', 'priors'); POLL_S, CATCHUP_BYTES, HOLD = 1.0, 40 * 20000, 30
STATUS = dict(ok=False, state='STARTING', session=None, started=time.time(), loopAt=None, errors=0, lastError=None, bars=0, events=0, taken=0, pid=os.getpid())
def log(*a): print('[vacuum-live]', datetime.datetime.now(ET).strftime('%H:%M:%S'), *a, flush=True)
def session_for(now):
    wd = now.weekday(); h = now.hour
    if h >= 18: return ('CLOSED', None) if wd in (4, 5) else ('LIVE', str(now.date() + datetime.timedelta(days=1)))
    if h < 17: return ('CLOSED', None) if wd in (5, 6) else ('LIVE', str(now.date()))
    return ('GAP', None)
class Health(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps(STATUS, default=str).encode(); self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
def onset(m): return m & ~np.r_[False, m[:-1]]
def calc_outcome(en, o, h, l, c, a, dr, etr_a, lim, n_bars, hold=HOLD, mult=2.5, cost=2.0):
    """30-bar hold from Open[a+1], clamped at the hard flat (lim = 55790 s since 18:00 for Globex = 09:29:50, close - 300 for RTH). Returns None while the exit bar does not exist yet; ('NOENTRY',) when the cutoff passed before bar a+1;
    otherwise dict(fwd, net_nostop, net_stop25, mfe, mae, note). The V0 stop (mult x EMA10(TR) at the signal bar, bar high/low, fill at the stop or the open if gapped, +1 tick) is evaluated bar by bar."""
    if a + 1 >= n_bars: return None
    inside = np.where(en[:n_bars] <= lim)[0]; passed = bool(np.any(en[:n_bars] > lim)); flat = int(inside.max()) if len(inside) else -1
    target = a + hold
    if target < n_bars and en[target] <= lim: last = target; note = 'hold'
    elif passed:
        if flat < a + 1: return ('NOENTRY',)
        last = min(target, flat); note = 'flat-clamped' if last < target else 'hold'
    else: return None
    entry = float(o[a + 1]); fwd = dr * (float(c[last]) - entry); seg = slice(a + 1, last + 1)
    mfe = (h[seg].max() - entry) if dr == 1 else (entry - l[seg].min()); mae = (entry - l[seg].min()) if dr == 1 else (h[seg].max() - entry)
    stop = entry - dr * mult * float(etr_a); net_s = None
    for t in range(a + 1, last + 1):
        if (dr == 1 and l[t] <= stop) or (dr == -1 and h[t] >= stop):
            px = (stop if t == a + 1 else (min(stop, o[t]) if dr == 1 else max(stop, o[t]))) - dr * 0.25; net_s = dr * (px - entry) - cost; note = note + '+stop'; break
    if net_s is None: net_s = fwd - cost
    return dict(fwd=round(fwd, 2), net_nostop=round(fwd - cost, 2), net_stop25=round(net_s, 2), mfe=round(float(mfe), 2), mae=round(float(mae), 2), note=note, entry=entry)

class Live:
    def __init__(self, once_date=None, dry_out=None):
        self.once_date = once_date; self.dry_out = dry_out; self.dry = []; self.conn = None; self.d = None; self.ls = None; self.tl = None; self.stored = {}; self.n_done_eval = 0; self.end_reached = False; self.first_eval = True
        self.tstored = {}; self.tqual = set(); self.adr20 = None; self.prior67 = {}
        try: self.prior67 = json.load(open(os.path.join(ROOT, 'scratch', 'vacuum_sim_20261108', 'turn_ext_prior.json')))['pct67']
        except Exception as ex: log('turn prior missing (the order rule will not qualify anything until the table has its own history):', ex)
    def db(self):
        if self.conn is None or self.conn.closed: self.conn = persist.connect()
        return self.conn
    def load_history(self, d):
        files = sorted(f for f in glob.glob(os.path.join(PRI, '*.bars.tsv')) if os.path.basename(f)[:10] < d)[-24:]
        hist = {'RTH': [], 'GBX': []}; prev = None
        for f in files:
            S = Fm.load_full(f)
            if S is None: continue
            for name, T in Fm.track_split(S).items(): hist[name].append(T)
            prev = S
        need = 15 if self.once_date else Fm.K_PRIOR      # a replay test may run with 15 prior sessions (as the research code allowed for a test day); live needs 20
        rt = hist['RTH'][-20:]; self.adr20 = float(np.mean([T['h'].max() - T['l'].min() for T in rt])) if len(rt) >= 10 else None      # mean RTH range of the last up-to-20 prior sessions (>= 10 needed: the live priors folder holds fewer than 20 early on)
        self.prs = {n: Fm.priors_of(hist[n][-Fm.K_PRIOR:]) for n in ('RTH', 'GBX') if len(hist[n]) >= need}; self.prevS = prev; self.nprior = {n: len(v) for n, v in hist.items()}
        self.prev_date = os.path.basename(files[-1])[:10] if files else None
    def start_session(self, d):
        self.d = d; dd = datetime.date.fromisoformat(d); self.dd = dd; self.contract = persist.contract_for(self.db(), d)
        cands = bootstrap.primary_paths(self.contract, dd) if self.contract else []; self.path = max(cands, key=lambda p: os.stat(p).st_mtime) if cands else None
        if self.path is None: log('NO_TICK_FILE', d); self.d = None; return
        STATUS.update(session=d, state='HISTORY', contract=self.contract, tickFile=self.path); STATUS['loopAt'] = time.time(); self.load_history(d)
        with self.db().cursor() as c:
            c.execute("SELECT track, bar_idx, direction, decision_hash FROM vacuum_live_events WHERE trade_date=%s", (d,)); self.stored = {(t, k, int(x)): h for t, k, x, h in c.fetchall()}
            try:
                c.execute("SELECT track, bar_idx, kind, direction, decision_hash, hook_delay FROM turn_signal_events WHERE trade_date=%s", (d,)); self.tstored = {(t, k, kd, int(x)): (h, hd) for t, k, kd, x, h, hd in c.fetchall()}
                c.execute("SELECT track, bar_idx, kind, direction FROM turn_signal_events WHERE trade_date=%s AND qualified", (d,)); self.tqual = {(t, k, kd, int(x)) for t, k, kd, x in c.fetchall()}
            except Exception as ex: self.conn.rollback(); self.tstored = {}; self.tqual = set(); log('turn table not readable:', ex)
        self.ls = session.LiveSession(d, 'split', []); self.tl = tailer.ScidTailer(self.path, from_date=dd - datetime.timedelta(days=1)); self.end_reached = False; self.n_done_eval = 0; self.first_eval = True
        log(f'session {d}: {self.contract} file {self.path} prior sessions {self.nprior} (prev {self.prev_date}) stored events {len(self.stored)}'); STATUS['state'] = 'CATCHUP'
    def arrays(self):
        done = self.ls.sb.done
        if not done: return None
        a = np.array([[float(f"{b['start']:.3f}"), float(f"{b['end']:.3f}"), b['o'], b['h'], b['l'], b['c'], float(b['v']), float(f"{b['bid']:.1f}"), float(f"{b['ask']:.1f}"), float(b['n'])] for b in done]).T
        return dict(date=self.d, st=a[0], en=a[1], o=a[2], h=a[3], l=a[4], c=a[5], v=a[6], bid=a[7], ask=a[8], ntr=a[9])
    def analyse(self):
        S = self.arrays()
        if S is None or self.prevS is None or len(self.prs) < 2: return None
        close = Fm.EARLY_CLOSE if self.d in Fm.EARLY else Fm.CLOSE; P, n0, reset = v2.continuous(self.prevS, S); F = v2.feats(P, n0, reset, self.prs, close); n = len(P['c'])
        en, c, h, l, o = P['en'], P['c'], P['h'], P['l'], P['o']; idx = np.arange(n); z = F['zroc']; zr = F['zr']; roc = F['roc']
        ok = (idx >= n0) & ~np.isnan(z); prev_ok = np.r_[False, ~np.isnan(z[:-1])]; dd = np.where(roc > 0, 1, np.where(roc < 0, -1, 0))
        c0u = ~np.isnan(z) & (np.abs(z) > Fm.Z_ROC) & (np.sign(z) == dd); on0 = onset(c0u) & prev_ok
        gw = ok & (en <= 55500.0); rw = ok & (en >= 56100.0) & (en <= close - 600.0); etr = Fm.ema(F['tr'])
        ev = []; lock = {'GBX': -1, 'RTH': -1}; flow = np.where(dd > 0, F['fl_l'], F['fl_s'])
        for a in np.where(on0 & (gw | rw))[0]:
            tr = 'GBX' if gw[a] else 'RTH'; dr = int(dd[a]); taken = False
            if a >= lock[tr]: taken = True; lock[tr] = a + HOLD            # one position at a time per track (30-bar hold); BOTH tracks fire as candidates
            ctx = dict(user_fast=bool(F['user_fast'][a]), pace_cdf=None if np.isnan(F['pace'][a]) else round(float(F['pace'][a]), 3), flow_aligned=bool(flow[a]), acc=round(float(F['acc'][a]), 3), hour_et=int(Fm.hour_et(np.array([en[a]]))[0]), zr_proxy=None if np.isnan(zr[a]) else round(float(zr[a]), 2))
            ev.append(dict(a=int(a), k=int(a - n0), tr=tr, dr=dr, taken=taken, ctx=ctx))
        return dict(P=P, F=F, n0=n0, etr=etr, ev=ev, close=close, S=S)
    def evaluate(self):
        r = self.analyse()
        if r is None: return
        P, F, n0, etr = r['P'], r['F'], r['n0'], r['etr']; c, o, h, l, en = P['c'], P['o'], P['h'], P['l'], P['en']; nowet = datetime.datetime.now(ET).replace(tzinfo=None); new = 0
        for e in r['ev']:
            a, k, tr, dr = e['a'], e['k'], e['tr'], e['dr']; key = (tr, k, dr)
            hsh = hashlib.sha1(json.dumps([self.d, tr, k, dr, round(float(c[a]), 2), e['taken']]).encode()).hexdigest()[:16]
            if key in self.stored:
                if self.stored[key] != hsh: log('ALARM DRIFT', key, self.stored[key], hsh)
                continue
            fired = persist.et_naive(self.ls.bar_end_utc[k]); late = round((nowet - fired).total_seconds() / 60.0, 1)
            row = (self.d, tr, k, dr, fired, float(en[a]), float(c[a]), float(F['zroc'][a]), float(F['roc'][a]), float(etr[a]), float(F['dur'][a]), float(F['zr'][a]) if not np.isnan(F['zr'][a]) else None, e['taken'], hsh, nowet, late, json.dumps(e['ctx']))
            if self.dry_out: self.dry.append(dict(track=tr, bar=k, dir=dr, taken=e['taken'], zroc=round(row[7], 3), roc=round(row[8], 1)))
            else:
                with self.db().cursor() as cu:
                    cu.execute("""INSERT INTO vacuum_live_events (trade_date, track, bar_idx, direction, fired_at, bar_end_sec, signal_close, zroc, roc10, etr, dur, zr_proxy, taken, decision_hash, detected_at, late_min, ctx)
                                  VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (trade_date, track, bar_idx, direction) DO NOTHING""", row)
            self.stored[key] = hsh; new += 1
            if not self.dry_out and late < 3: self.refresh_monitor(force=True)
            if not self.dry_out and late < 3: log(f'*** FIRE {self.d} {tr} {"LONG " if dr == 1 else "SHORT"} signal close {c[a]:.2f}  Z_ROC {F["zroc"][a]:+.2f} ROC10 {F["roc"][a]:+.1f}  taken={e["taken"]}  -> entry at the next bar open, 30-bar hold (Globex candidate)' + ('' if tr == 'GBX' else '  [RTH: logged for information]'))
        try: self.evaluate_turn(r)
        except Exception as ex: self.conn = None; STATUS['turnErrors'] = STATUS.get('turnErrors', 0) + 1; STATUS['turnLastError'] = f'{type(ex).__name__}: {ex}'; log('TURN_ERROR', traceback.format_exc()[-400:])    # never lets the turn signal break the expansion-rule logging
        STATUS.update(bars=len(self.ls.sb.done), events=len(self.stored), taken=sum(1 for _ in r['ev'] if _['taken'])); self.first_eval = False
        if self.dry_out: return
        # outcomes (fill once): the entry open of bar a+1 as soon as it exists; the clamped 30-bar outcome once its exit bar exists
        close = r['close']; en_all = P['en']; nb = len(c)
        with self.db().cursor() as cu:
            cu.execute("SELECT id, track, bar_idx, direction, entry_open FROM vacuum_live_events WHERE trade_date=%s AND outcome_at IS NULL", (self.d,)); pend = cu.fetchall()
            for rid, tr, k, dr, eo in pend:
                a = n0 + k
                if a + 1 < nb and eo is None: cu.execute("UPDATE vacuum_live_events SET entry_open=%s WHERE id=%s AND entry_open IS NULL", (float(o[a + 1]), rid))
                lim = 55790.0 if tr == 'GBX' else close - 300.0
                oc = calc_outcome(en_all, o, h, l, c, a, int(dr), float(etr[a]), lim, nb)
                if oc is None: continue
                if isinstance(oc, tuple): cu.execute("UPDATE vacuum_live_events SET exit_note='no-entry (cutoff)', outcome_at=%s WHERE id=%s AND outcome_at IS NULL", (nowet, rid)); continue
                cu.execute("UPDATE vacuum_live_events SET fwd30=%s, net_nostop=%s, net_stop25=%s, mfe30=%s, mae30=%s, exit_note=%s, outcome_at=%s WHERE id=%s AND outcome_at IS NULL", (oc['fwd'], oc['net_nostop'], oc['net_stop25'], oc['mfe'], oc['mae'], oc['note'][:24], nowet, rid))
    def ext_cut(self, tr):
        """Top-tercile cutoff of Stage-1 extensions of this track: the rolling distribution of the table's own PRIOR sessions once it has >= 60 events, else the explore prior (data-derived, never typed)."""
        with self.db().cursor() as cu:
            cu.execute("SELECT ext_adr FROM turn_signal_events WHERE track=%s AND kind IN ('S1_CLUSTER','S1_SPIKE') AND ext_adr IS NOT NULL AND trade_date < %s ORDER BY id DESC LIMIT 600", (tr, self.d))
            v = [float(x[0]) for x in cu.fetchall()]
        if len(v) >= 60: return float(np.percentile(v, 67)), 'rolling'
        return self.prior67.get(tr), 'explore-prior'
    def evaluate_turn(self, r):
        """TURN SIGNAL (scripts/vacuum_sim/turn_signal.py, shared with the research): log Stage-1 / Stage-2 events; mark the ORDER candidates (a Stage-2 ignition whose linked opposite Stage 1 held and whose extension is in the
        top tercile) `taken` under a one-position-at-a-time lock per track, entry window from 18:30 ET (Globex no-trade at the reopen) to the same cutoffs as the expansion rule; fill the 30-bar outcome like the expansion rule."""
        P, F, n0, etr, close = r['P'], r['F'], r['n0'], r['etr'], r['close']; F['etr'] = etr
        c, o, h, l, en = P['c'], P['o'], P['h'], P['l'], P['en']; nowet = datetime.datetime.now(ET).replace(tzinfo=None); nb = len(c)
        evs = TS.turn_events(P, n0, F, close, self.adr20)
        cuts = {tr: self.ext_cut(tr) for tr in ('RTH', 'GBX')}; lock = {'GBX': -1, 'RTH': -1}; new = 0
        for e in evs:
            a, tr, dr, kd = e['a'], e['track'], e['dir'], e['kind']; k = a - n0
            qual = TS.qualifies(e, cuts[tr][0]) and (tr == 'RTH' or en[a] >= 1800.0); taken = False
            if qual and a >= lock[tr]: taken = True; lock[tr] = a + HOLD
            key = (tr, k, kd, dr); hsh = hashlib.sha1(json.dumps([self.d, tr, k, kd, dr, round(float(c[a]), 2), qual, taken]).encode()).hexdigest()[:16]
            if key in self.tstored:
                oh, ohook = self.tstored[key]
                if oh != hsh: log('ALARM TURN DRIFT', key, oh, hsh)
                if kd == 'S1_SPIKE' and ohook is None and e['hook'] is not None and not self.dry_out:
                    with self.db().cursor() as cu: cu.execute("UPDATE turn_signal_events SET hook_delay=%s WHERE trade_date=%s AND track=%s AND bar_idx=%s AND kind=%s AND direction=%s AND hook_delay IS NULL", (e['hook'], self.d, tr, k, kd, dr))
                    self.tstored[key] = (oh, e['hook'])
                continue
            fired = persist.et_naive(self.ls.bar_end_utc[k]); late = round((nowet - fired).total_seconds() / 60.0, 1); lk = e['linked'] or {}
            row = (self.d, tr, k, kd, dr, fired, float(en[a]), float(c[a]), float(e['etr']), None if e['ext'] is None or e['ext'] != e['ext'] else round(float(e['ext']), 4), e['nfast'], e['zroc'], e['zr'], e['strict'], e['hook'],
                   lk.get('kind'), (lk.get('a') - n0) if lk else None, lk.get('delay'), lk.get('held'), None if not lk or lk.get('ext1') != lk.get('ext1') else round(float(lk.get('ext1')), 4), bool(qual), cuts[tr][0], bool(taken), hsh, nowet, late)
            if self.dry_out: self.dry.append(dict(turn=True, track=tr, bar=k, kind=kd, dir=dr, t=TS.hhmm(en[a]), ext=row[9], linked=lk.get('kind'), held=lk.get('held'), qualified=bool(qual), taken=bool(taken)))
            else:
                with self.db().cursor() as cu:
                    cu.execute("""INSERT INTO turn_signal_events (trade_date, track, bar_idx, kind, direction, fired_at, bar_end_sec, signal_close, etr, ext_adr, nfast, zroc, zr_proxy, strict, hook_delay, linked_kind, linked_bar, linked_delay, held, linked_ext,
                                  qualified, ext_cut, taken, decision_hash, detected_at, late_min) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (trade_date, track, bar_idx, kind, direction) DO NOTHING""", row)
            self.tstored[key] = (hsh, e['hook']); new += 1
            if qual: self.tqual.add(key)
            if not self.dry_out and late < 3 and (qual or kd == 'S1_SPIKE'): log(f'*** TURN {kd} {self.d} {tr} {"LONG " if dr == 1 else "SHORT"} close {c[a]:.2f} ext {row[9]} qualified={qual} taken={taken}' + (f' linked {lk.get("kind")} +{lk.get("delay")} bars held={lk.get("held")}' if lk else ''))
            if not self.dry_out and late < 3 and qual: self.refresh_monitor(force=True)
        STATUS.update(turnEvents=len(self.tstored), turnQualified=len(self.tqual))
        if self.dry_out: return
        with self.db().cursor() as cu:
            cu.execute("SELECT id, track, bar_idx, direction, entry_open FROM turn_signal_events WHERE trade_date=%s AND kind='S2_IGNITION' AND outcome_at IS NULL", (self.d,)); pend = cu.fetchall()
            for rid, tr, k, dr, eo in pend:
                a = n0 + k
                if a + 1 < nb and eo is None: cu.execute("UPDATE turn_signal_events SET entry_open=%s WHERE id=%s AND entry_open IS NULL", (float(o[a + 1]), rid))
                lim = 55790.0 if tr == 'GBX' else close - 300.0
                oc = calc_outcome(en, o, h, l, c, a, int(dr), float(etr[a]), lim, nb)
                if oc is None: continue
                if isinstance(oc, tuple): cu.execute("UPDATE turn_signal_events SET exit_note='no-entry (cutoff)', outcome_at=%s WHERE id=%s AND outcome_at IS NULL", (nowet, rid)); continue
                cu.execute("UPDATE turn_signal_events SET fwd30=%s, net_nostop=%s, net_stop25=%s, mfe30=%s, mae30=%s, exit_note=%s, outcome_at=%s WHERE id=%s AND outcome_at IS NULL", (oc['fwd'], oc['net_nostop'], oc['net_stop25'], oc['mfe'], oc['mae'], oc['note'], nowet, rid))
    def refresh_monitor(self, force=False):
        """Refresh the vacuumLive (and argonShadow) keys of public/learning_monitor.json via scripts/argon_vacuum_live/refresh_monitor.mjs, every minute and after a fire. Never blocks, never overlaps."""
        if self.dry_out or self.once_date: return
        if getattr(self, '_rm', None) is not None and self._rm.poll() is None: return
        if not force and time.time() - getattr(self, '_rm_at', 0) < 60: return
        node = shutil.which('node')
        if node is None: return
        self._rm_at = time.time()
        try: self._rm = subprocess.Popen([node, os.path.join(ROOT, 'scripts', 'argon_vacuum_live', 'refresh_monitor.mjs')], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception as e: log('monitor refresh failed to start', e)
    def pump(self):
        for t in self.tl.poll(max_records=200000):
            if t.ts_et.date() > self.dd or (t.ts_et.date() == self.dd and t.ts_et.hour >= 17): self.end_reached = True; break
            self.ls.feed_trade(t)
        backlog = self.tl.backlog_bytes(); STATUS['backlog'] = backlog; STATUS['bars'] = len(self.ls.sb.done); STATUS['lastTick'] = str(persist.et_naive(self.ls.last_tick_utc))
        if backlog < CATCHUP_BYTES:
            self.ls.finish_scale_detection()
            if len(self.ls.sb.done) != self.n_done_eval:
                try: self.evaluate(); self.n_done_eval = len(self.ls.sb.done)
                except Exception as e: self.conn = None; STATUS['errors'] += 1; STATUS['lastError'] = f'{type(e).__name__}: {e}'; log('EVAL_ERROR', traceback.format_exc()[-500:])
            STATUS['state'] = 'LIVE'
    def run(self, port):
        if not self.once_date:
            lock = open(os.path.join(STORE, '.lock'), 'w')
            try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError: log('another vacuum-live is running; exiting'); return
            threading.Thread(target=lambda: HTTPServer(('127.0.0.1', port), Health).serve_forever(), daemon=True).start()
        log(f'started pid {os.getpid()}')
        while True:
            try:
                now = datetime.datetime.now(ET); kind, d = (('LIVE', self.once_date) if self.once_date else session_for(now))
                if self.once_date and self.d and self.end_reached:
                    self.evaluate(); json.dump(self.dry, open(self.dry_out, 'w'), indent=1); log('once-date done', len(self.dry)); return
                if self.d and not self.once_date and (kind != 'LIVE' or d != self.d): self.d = None; STATUS['state'] = 'IDLE'
                if kind == 'LIVE' and self.d is None: self.start_session(d)
                if self.d: self.pump(); self.refresh_monitor()
                STATUS.update(ok=True, loopAt=time.time())
            except Exception as e: STATUS['errors'] += 1; STATUS['lastError'] = f'{type(e).__name__}: {e}'; log('LOOP_ERROR', traceback.format_exc()[-500:])
            time.sleep(POLL_S)
if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--once-date'); ap.add_argument('--dry-out'); ap.add_argument('--port', type=int, default=8906); a = ap.parse_args()
    if a.once_date and not a.dry_out: sys.exit('--once-date requires --dry-out (a replay must not write the live table)')
    Live(a.once_date, a.dry_out).run(a.port)
