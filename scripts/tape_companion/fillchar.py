"""Fill-model step 1 (docs/FILL_MODEL_SCOPE_20261103.md plan v2): DESCRIPTIVE characterization of slippage after a trigger, gaps, and how resting limits behave, from raw .scid TICKS on a sample of EXPLORE sessions (every 5th, through 2025-05-16). Market microstructure only: NO strategy outcome is read.
Randomly placed hypothetical stop triggers and resting limits (seeded by date), measured on the real tape. One session in memory at a time. Usage: nice python fillchar.py [--only DATE ...]"""
import sys, os, datetime, statistics
HERE = os.path.dirname(os.path.abspath(__file__)); TM = os.path.join(HERE, '..', 'tick_microstructure')
sys.path.insert(0, TM); sys.path.insert(0, os.path.join(HERE, '..', 'amt_tell_live')); sys.path.insert(0, HERE)
import numpy as np, pandas as pd
import extract_volbars_20261028 as V
X, sr = V.X, V.sr
import extract_stuffed_20261020 as XS
from barbuilder import session_sec
SEED, TICK, W, NTRIG = 20261103, 0.25, 900.0, 300
SEG = {'RTH': [('RTH 09:35-10:30', 300, 3600), ('RTH 10:30-14:00', 3600, 16200), ('RTH 14:00-15:30', 16200, 21600)],
       'GLOBEX': [('GLX 18:30-22:00', 1800, 14400), ('GLX 22:00-02:00', 14400, 28800), ('GLX 02:00-08:30', 28800, 52200)]}

def ticks_arrays(p, d, which):
    """(t seconds since the session start, price, size, aggressor +1/-1/0) for RTH (09:30-16:00) or GLOBEX (18:00 prev day - 09:30)."""
    dd = datetime.date.fromisoformat(d); lay = X._sniff_layout(p, dd)
    if lay in ('empty', 'other'): return None
    sc = 1.0
    if lay == 'std':
        pr = []
        for k, t0 in enumerate(sr.read_ticks(p, start_date=dd, end_date=dd)):
            pr.append(t0.price)
            if k >= 300: break
        if pr and statistics.median(pr) < 1000: sc = 100.0
    prev = dd - datetime.timedelta(days=1)
    it = (sr.read_ticks(p, start_date=prev if which == 'GLOBEX' else dd, end_date=dd) if lay == 'std' else V._legacy_range(p, prev if which == 'GLOBEX' else dd, dd))
    T, P, S, A = [], [], [], []
    for t in it:
        px = t.price * sc if sc != 1.0 else t.price
        if which == 'RTH':
            if t.ts_et.date() != dd: continue
            s = t.ts_et.hour * 3600 + t.ts_et.minute * 60 + t.ts_et.second + t.ts_et.microsecond / 1e6
            if not (34200 <= s < 57600): continue
            T.append(s - 34200)
        else:
            s = session_sec(t.ts_et, dd)
            if s is None or s >= 55800: continue
            T.append(s)
        P.append(px); S.append(t.size); A.append(1 if t.aggressor == 'BUY' else -1 if t.aggressor == 'SELL' else 0)
    if len(T) < 1000: return None
    o = np.argsort(np.array(T), kind='stable')
    return np.array(T)[o], np.array(P)[o], np.array(S)[o], np.array(A, dtype=np.int8)[o]

def pick_file(d):
    """the contract file whose RTH tick volume matches price_bars_primary within 3 percent (same rule as the other extractors)"""
    for code in X.candidate_codes(X.CAL[d]):
        for p in X.scid_paths(code):
            try: tk = XS.ticks_for(p, d)
            except ValueError: continue
            if tk and d in X.DBVOL and abs(sum(x[2] for x in tk) - X.DBVOL[d]) <= 0.03 * X.DBVOL[d]: return p
    return None

def session_scale(t, p):
    k = 300.0; b = (t // k).astype(int); df = pd.DataFrame({'b': b, 'p': p}).groupby('b').p.agg(['max', 'min']); return float(np.median(df['max'] - df['min']))

def analyze(t, p, s, a, which, scale, rng):
    rows_t, rows_l = [], []; n = len(t)
    for name, lo, hi in SEG[which]:
        idx = np.searchsorted(t, rng.uniform(lo, hi, NTRIG // 3 if which == 'RTH' else NTRIG // 3)); idx = idx[(idx > 0) & (idx < n - 10)]
        for i in idx:
            jmax = np.searchsorted(t, t[i] + W); ref = p[i]
            for dist_f in (0.5, 1.0, 2.0):
                d = dist_f * scale
                for side in (-1, 1):                                    # side -1: sell stop under the market (long stop); +1: buy stop above (short stop)
                    trig = ref + side * d; seg = p[i + 1:jmax]
                    hit = np.flatnonzero(seg <= trig) if side == -1 else np.flatnonzero(seg >= trig)
                    if len(hit) == 0: rows_t.append(dict(seg=name, f=dist_f, trig=0, slip=np.nan, slip1s=np.nan, gap=np.nan)); continue
                    j = i + 1 + hit[0]; slip = (trig - p[j]) if side == -1 else (p[j] - trig)
                    w1 = np.flatnonzero((t >= t[j]) & (t <= t[j] + 1.0)); ex = (p[w1].min() if side == -1 else p[w1].max()) if len(w1) else p[j]
                    rows_t.append(dict(seg=name, f=dist_f, trig=1, slip=slip / TICK, slip1s=((trig - ex) if side == -1 else (ex - trig)) / TICK, gap=t[j] - t[j - 1]))
            # resting BUY limit placed 0.25 and 0.5 scale below the market; touch = first print at or below L
            for dist_f in (0.25, 0.5):
                L = ref - dist_f * scale; L = round(L / TICK) * TICK; seg = p[i + 1:jmax]; hit = np.flatnonzero(seg <= L)
                if len(hit) == 0: rows_l.append(dict(seg=name, f=dist_f, touch=0)); continue
                j = i + 1 + hit[0]; tj = t[j]; jend = np.searchsorted(t, tj + 300.0)
                thr = np.flatnonzero(p[j:jend] <= L - TICK)           # first print at least one tick THROUGH the limit within 5 minutes of the first touch
                thr2 = np.flatnonzero(p[j:jend] <= L - 2 * TICK)
                vol_at = float(s[j:(j + thr[0]) if len(thr) else jend][p[j:(j + thr[0]) if len(thr) else jend] == L].sum())    # lots printed AT the limit price before it traded through (queue-ahead proxy)
                k60 = np.searchsorted(t, tj + 60.0); fwd = (p[min(k60, n - 1)] - L) / scale
                rows_l.append(dict(seg=name, f=dist_f, touch=1, thru1=int(len(thr) > 0), thru2=int(len(thr2) > 0), vol_at=vol_at, t_thru=(t[j + thr[0]] - tj) if len(thr) else np.nan, fwd60=fwd, first_below=(L - p[j]) / TICK))
    return rows_t, rows_l

def main():
    only = sys.argv[2:] if len(sys.argv) > 2 and sys.argv[1] == '--only' else None
    dates = sorted(os.path.basename(x)[:10] for x in os.listdir(V.OUT) if x.endswith('.bars.tsv')); dates = [d for d in dates if d <= '2025-05-16']
    sample = only or dates[::5]; allt, alll = [], []
    for d in sample:
        p = pick_file(d)
        if p is None: print(d, 'no file'); continue
        for which in ('RTH', 'GLOBEX'):
            tk = ticks_arrays(p, d, which)
            if tk is None: print(d, which, 'no ticks'); continue
            t, px, sz, ag = tk; sc = session_scale(t, px); rng = np.random.default_rng(SEED + int(d.replace('-', '')) + (0 if which == 'RTH' else 7))
            rt, rl = analyze(t, px, sz, ag, which, sc, rng)
            for r in rt: r.update(date=d, sess=which, scale=sc)
            for r in rl: r.update(date=d, sess=which, scale=sc)
            allt += rt; alll += rl; print(d, which, 'ticks', len(t), 'scale %.1f' % sc, flush=True)
            del t, px, sz, ag, tk
    pd.DataFrame(allt).to_csv('/home/mmoniz/trading-journal/scratch/fillchar_triggers_20261103.csv', index=False); pd.DataFrame(alll).to_csv('/home/mmoniz/trading-journal/scratch/fillchar_limits_20261103.csv', index=False)
main()
