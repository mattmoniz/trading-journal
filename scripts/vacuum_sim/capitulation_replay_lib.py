"""Shared pieces of the capitulation-exit historical replays (capitulation_replay_a5.py, capitulation_replay_a6.py, the flush / defended-level replay): the patched vacuum event build,
the per-direction event index, risk-set control selection, the 500V bar cache for the placebo exit, and the day-blocked bootstrap helpers. Extracted 2026-11-09 night (cv-079) so the
three scripts cannot drift; behaviour is identical to the inlined originals (verified by reproducing the recorded a5 / a6 outputs, seeds included)."""
import os, sys, json, bisect, datetime, collections, glob
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import features as Fm, context_exit_phase1 as P1
import capitulation_replay_phase1 as C
D = C.OUTD
B_DEFAULT = 4000

def build_events():
    """Vacuum onsets (live detector's code) with extension flag, plus o1 (next 500V bar open) and c (signal bar close)."""
    orig = P1.session_events
    def patched(S, *a, **k):
        out = orig(S, *a, **k)
        for e in out: kk = e['k']; e['o1'] = float(S['o'][kk + 1]) if kk + 1 < len(S['o']) else float('nan'); e['c'] = float(S['c'][kk])
        return out
    P1.session_events = patched
    return C.build_events()

class EventIndex:
    def __init__(self, ev):
        self.ev = ev; self.byd = {1: [], -1: []}
        for i, e in enumerate(ev): self.byd[e['dir']].append((C.wall(e['date'], e['t']), i))
        for d in self.byd: self.byd[d].sort()
        self.keys = {d: [x[0] for x in self.byd[d]] for d in self.byd}
    def window(self, d, f, rs):
        """events of direction d strictly inside (f, rs), each with its bar-end wall time `ts`"""
        lo = bisect.bisect_right(self.keys[d], f); hi = bisect.bisect_left(self.keys[d], rs)
        return [self.ev[self.byd[d][k][1]] | dict(ts=self.byd[d][k][0]) for k in range(lo, hi)]
    def ext_before(self, d, f, tx):
        lo = bisect.bisect_right(self.keys[d], f); hi = bisect.bisect_right(self.keys[d], tx)
        return any(self.ev[self.byd[d][k][1]]['flag'] == 'EXT' for k in range(lo, hi))

def reopen(ts): m = ts.hour * 60 + ts.minute; return 1080 <= m < 1110

def make_ctrl(idx, sig, pool_rows, poolkey, rng, ND=20, eligible=None):
    """Risk-set controls: for each signalled row x (first thrust after s elapsed seconds) the rows y of the same pool key, other trade day, still open at f_y + s with no earlier
    extended same-direction thrust; ND drawn without replacement into x['ctrl'] = [(y, tx)]. Draw order = order of `sig`. Returns the list of available-control counts."""
    pool = collections.defaultdict(list)
    for y in pool_rows:
        k = poolkey(y)
        if k is not None: pool[k].append(y)
    nc = []
    for x in sig:
        s = (x['first']['ts'] - x['f']).total_seconds(); cs = []
        for y in pool[poolkey(x)]:
            if y['id'] == x['id'] or y['td'] == x['td'] or (eligible and not eligible(x, y)): continue
            tx = y['f'] + datetime.timedelta(seconds=s)
            if tx < y['rs'] and not idx.ext_before(y['side'], y['f'], tx): cs.append((y, tx))
        nc.append(len(cs)); x['ctrl'] = [cs[i] for i in rng.choice(len(cs), size=min(ND, len(cs)), replace=False)] if cs else []
    return nc

class BarCache:
    def __init__(self, cap=25):
        rf = sorted(p for p in glob.glob(os.path.join(Fm.BARS, '*.bars.tsv')) if os.path.basename(p)[:10] <= Fm.LAST_EXPLORE); files, _ = P1.primary_files()
        self.pmap = {os.path.basename(p)[:10]: p for p in rf + files}; self.c = collections.OrderedDict(); self.cap = cap
    def get(self, td):
        if td in self.c: self.c.move_to_end(td); return self.c[td]
        S = Fm.load_full(self.pmap[td]) if td in self.pmap else None; v = (S['en'], S['o']) if S else None; self.c[td] = v
        if len(self.c) > self.cap: self.c.popitem(last=False)
        return v
    def exit_open(self, td, tx):
        """open of the 500V bar AFTER the bar containing wall time tx (what a market order placed at tx would get)"""
        b = self.get(td)
        if b is None: return None
        en, o = b; t = (tx - (datetime.datetime.fromisoformat(td) - datetime.timedelta(days=1) + datetime.timedelta(hours=18))).total_seconds(); k = int(np.searchsorted(en, t, side='left'))
        return float(o[k + 1]) if k + 1 < len(o) else None

def virt(x, px): return x['side'] * (px - x['p0']) * 2 - 2.0          # dollars per 1 MNQ, cost $2 (1.0 pt), same basis as active_setups.actual_pnl

def events(g, key, tk='first'):
    """collapse rows sharing one thrust to one event (cv-025); value = mean of `key` over its rows"""
    m = collections.defaultdict(list)
    for x in g:
        if x.get(key) is not None and x[tk]: m[(x[tk]['date'], x[tk]['t'])].append(x)
    return [dict(v=float(np.mean([y[key] for y in v])), td=v[0]['td']) for v in m.values()]

def mean(s): return float(np.mean([e['v'] for e in s]))

def dbb(evs, rg, B=B_DEFAULT):
    """day-blocked bootstrap of the mean of event values"""
    days = sorted({e['td'] for e in evs}); byday = {d: [e for e in evs if e['td'] == d] for d in days}; out = []
    for _ in range(B):
        pick = rg.choice(len(days), size=len(days)); out.append(np.mean([e['v'] for i in pick for e in byday[days[i]]]))
    return np.array(out)

def wins(v, p=.05):
    a = np.sort(v); k = int(len(a) * p); return float(np.clip(v, a[k], a[-k - 1]).mean()) if k else float(np.mean(v))

def holm(ps, alpha=0.10):
    """ps = [(name, p, floor_ok)] -> {name: passes}; a test below its floor cannot pass"""
    order = sorted(ps, key=lambda t: t[1]); alive = True; out = {}
    for i, (n, p, fl) in enumerate(order): alive = alive and fl and p <= alpha / (len(order) - i); out[n] = alive
    return out


# ---------------------------------------------------------------------------------------------------------------------------------------------------------------
# Replace-the-target arms (A10 / A10.2): minute-bar hold simulation shared by capitulation_replay_a10.py and capitulation_replay_a10_extras.py (extracted 2026-11-09 night, cv-079)
class HoldSim:
    """minute bars from a TSV (ts, o, h, l, c; naive ET) plus the C0 / matched-target simulations"""
    def __init__(self, path):
        M = [l.rstrip('\n').split('\t') for l in open(path)]
        self.T = np.array([np.datetime64(m[0]).astype('datetime64[s]').astype(np.int64) for m in M]); self.O = np.array([float(m[1]) for m in M]); self.H = np.array([float(m[2]) for m in M]); self.Lo = np.array([float(m[3]) for m in M]); self.C = np.array([float(m[4]) for m in M])
    @staticmethod
    def ep(dt): return int(np.datetime64(dt.replace(microsecond=0)).astype('datetime64[s]').astype(np.int64))
    def c0(self, f, side, p0, stp, exp, tgt=None):
        """hold with the ORIGINAL stop to expiry (exit at the expiry bar's open); with `tgt` a price target is added (bar order: expiry, stop, target; a target gapped through fills at the open). Returns (kind, exit dt, px) or None when the bars end first."""
        T, O, H, Lo = self.T, self.O, self.H, self.Lo; i = int(np.searchsorted(T, self.ep(f), side='right')); ex = self.ep(exp)
        while i < len(T):
            if T[i] >= ex: return ('EXP', datetime.datetime.utcfromtimestamp(int(T[i])), float(O[i]))
            if (Lo[i] <= stp) if side == 1 else (H[i] >= stp): return ('STOP', datetime.datetime.utcfromtimestamp(int(T[i])), float(min(stp, O[i]) if side == 1 else max(stp, O[i])))
            if tgt is not None and ((H[i] >= tgt) if side == 1 else (Lo[i] <= tgt)): return ('TARGET', datetime.datetime.utcfromtimestamp(int(T[i])), float(max(tgt, O[i]) if side == 1 else min(tgt, O[i])))
            i += 1
        return None
    def prot(self, f, side, p0, stp, exp, t1):
        """Protected hold P0 (A12): original stop; the first minute bar whose range reaches t1 (the row's own target, used as a TRIGGER) arms the protection, the stop moves to the entry price from the NEXT bar on (stop is checked before the target within a bar); gap-aware fills; no target; expiry bar's open otherwise. Returns (kind STOP|BE|EXP, exit dt, px, armed) or None."""
        T, O, H, Lo = self.T, self.O, self.H, self.Lo; i = int(np.searchsorted(T, self.ep(f), side='right')); ex = self.ep(exp); stop = stp; armed = False
        while i < len(T):
            dt = datetime.datetime.utcfromtimestamp(int(T[i]))
            if T[i] >= ex: return ('EXP', dt, float(O[i]), armed)
            if (Lo[i] <= stop) if side == 1 else (H[i] >= stop): return ('BE' if armed else 'STOP', dt, float(min(stop, O[i]) if side == 1 else max(stop, O[i])), armed)
            if not armed and ((H[i] >= t1) if side == 1 else (Lo[i] <= t1)): armed = True; stop = p0
            i += 1
        return None
    def close_before(self, dt, minutes):
        """close of the last minute bar at or before dt - minutes (None if the bars do not reach back that far)"""
        t = self.ep(dt) - minutes * 60; i = int(np.searchsorted(self.T, t, side='right')) - 1
        return float(self.C[i]) if i >= 0 and self.T[0] <= t else None

def flat_time(f):
    m = f.hour * 60 + f.minute
    if 570 <= m < 960: return f.replace(hour=15, minute=55, second=0, microsecond=0)
    base = f.replace(hour=9, minute=29, second=50, microsecond=0)
    return base if m < 570 else base + datetime.timedelta(days=1)

def roll_skip_dates(tsv_path):
    """Dates unsafe for minute-bar P&L (contract-roll stitching): the repo's NQ roll-week dates (roll_week_dates.json, acdShared.getNqRollWeekDates) UNION the data-detected stitching dates: a 00:00 minute bar whose open differs from the previous close by more than 150 points marks the roll; that date and the 5 days before and 1 after are skipped (2023-12 and 2024-03 are missing from the repo list but show +210 / +247 point jumps)."""
    skip = set(json.load(open(os.path.join(D, 'roll_week_dates.json')))); prev = None
    for l in open(tsv_path):
        p = l.rstrip('\n').split('\t')
        if prev is not None and p[0][11:19] == '00:00:00' and abs(float(p[1]) - prev) > 150:
            d0 = datetime.date.fromisoformat(p[0][:10])
            for k in range(-5, 2): skip.add((d0 + datetime.timedelta(days=k)).isoformat())
        prev = float(p[4])
    return skip

def build_hold_rows(idx, rows, tags, sim, end=datetime.datetime(2026, 10, 9, 23, 59), skip=None):
    """The A10 row list: per real row its C0 path, first extended thrust before the C0 exit (`first`), first non-extended thrust (`firstnon`), tags and geometry."""
    R = []; drop = collections.Counter()
    for r in rows:
        t = tags.get(str(r['id']))
        if not t: drop['no tags'] += 1; continue
        if r['p0'] is None or r['stp'] is None: drop['no entry/stop'] += 1; continue
        f = datetime.datetime.fromisoformat(r['f']); exp = datetime.datetime.fromisoformat(r['exp']) if r.get('exp') else flat_time(f)
        if exp > end or exp <= f: drop['expiry out of range'] += 1; continue
        side = t['side']; s = sim.c0(f, side, r['p0'], r['stp'], exp)
        if s is None: drop['bars end'] += 1; continue
        kind, tx, px = s
        if skip and any((f.date() + datetime.timedelta(days=k)).isoformat() in skip for k in range(0, (tx.date() - f.date()).days + 1)): drop['roll week / stitching'] += 1; continue
        cand = idx.window(side, f, tx); ok = lambda c: not reopen(c['ts']) and c['o1'] == c['o1']
        ext = [c for c in cand if c['flag'] == 'EXT' and ok(c)]; non = [c for c in cand if c['flag'] == 'NONEXT' and ok(c)]
        R.append(dict(id=r['id'], st=r['setup_type'], td=r['td'], f=f, exp=exp, rs=tx, side=side, p0=r['p0'], stp=r['stp'], t1=r.get('t1'), adr=r.get('adr'), c0kind=kind, c0px=px, first=ext[0] if ext else None, firstnon=non[0] if non else None,
                      b=bool(t['at_boundary']), p=bool(t['pivot_live']), rtrack='RTH' if (f.hour * 60 + f.minute >= 570 and f.hour < 16) else 'GBX'))
    return R, drop
