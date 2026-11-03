"""Shared tape/level library for the hold-or-slice study and the call-snapshot tool (docs/LEVEL_HOLD_SLICE_AND_TAPE_COMPANION_SCOPE_20261103.md).
Per-second RTH arrays come from scratch/persec_px_20261021/DATE.tsv (second_of_day buy_aggr sell_aggr low high last, only seconds with trades).
EVENT FINDING AND FEATURES use information up to the decision second only. LABELS are a separate function (label_event) that is not called until the pre-registration is frozen."""
import os, glob
import numpy as np, pandas as pd
ROOT = '/home/mmoniz/trading-journal'
PERSEC = ROOT + '/scratch/persec_px_20261021'
PERSEC_GLOBEX = ROOT + '/scratch/persec_globex_20261103'
PERSEC_SNAP = ROOT + '/scratch/persec_snap'      # on-demand extracts for dates after the bulk extract (call snapshots)
RTH0, RTH1 = 34200, 57600; N = RTH1 - RTH0
class Sess:
    """one trading session shape. start = ET second-of-day of index 0 (Globex starts 18:00 of the PREVIOUS calendar day = 64800); file_off = what to subtract from the file's first column to get the index."""
    def __init__(self, name, n, start, file_off, d_dir, first_ok, last_ok, h0, nh, names=None, form=True):
        self.name, self.n, self.start, self.file_off, self.d_dir, self.first_ok, self.last_ok, self.h0, self.nh, self.names, self.form = name, n, start, file_off, d_dir, first_ok, last_ok, h0, nh, names, form
    def hour_of(self, idx): return int((self.start + idx) // 3600) % 24
    def hidx(self, idx): return (self.hour_of(idx) - self.h0) % 24

FIRST_OK, LAST_OK = 34200 + 300, 55800            # RTH: contacts from 09:35 (RTH-open dead zone ends) to 15:30 (room for dwell + cap before 16:00); absolute ET seconds
D_DWELL, CAP, TOL_F, REARM_F, M_F, S_F = 60, 900, 0.5, 1.0, 1.0, 1.0   # FROZEN in the pre-registration
FAM = {'OR_HL': [f'OR{n}_{s}' for n in (5, 10, 15, 30) for s in ('HIGH', 'LOW')], 'MIDS': ['OR5_MID', 'OR10_MID', 'OR15_MID', 'OR30_MID', 'IB_MID', 'PD_OR_MID', 'PD_IB_MID', 'PW_MID'], 'IB_HL': ['IB_HIGH', 'IB_LOW'], 'OVN': ['ONH', 'ONL'],
       'PRIOR_DAY': ['PD_HIGH', 'PD_LOW', 'PD_CLOSE', 'PD_POC', 'PD_IB_HIGH', 'PD_IB_LOW'], 'VALUE_AREA': [f'{p}_{s}' for p in ('PD', 'PW', 'PM', 'PY', '3M') for s in ('VAH', 'VAL')],
       'WM_PIVOTS': ['WPP', 'WR1', 'WR2', 'WS1', 'WS2', 'MPP', 'MR1', 'MR2', 'MS1', 'MS2'], 'OPENS_VWAP': ['DAILY_OPEN', 'WEEKLY_OPEN', 'MONTHLY_OPEN', 'WEEKLY_VWAP', 'MONTHLY_VWAP'],
       'PERIOD_HLP': ['PW_HIGH', 'PW_LOW', 'PW_POC', 'PM_HIGH', 'PM_LOW', 'PM_POC', 'PY_POC', '3M_POC']}      # the 9 MAJOR families (user classes); FLOOR and CAMARILLA are MINOR and excluded
FORM = {**{f'OR{n}_{s}': n * 60 for n in (5, 10, 15, 30) for s in ('HIGH', 'LOW', 'MID')}, 'IB_HIGH': 3600, 'IB_LOW': 3600, 'IB_MID': 3600}   # seconds after 09:30 before the level exists
NAME2FAM = {n: f for f, ns in FAM.items() for n in ns}
FAMS = list(FAM)
GLOBEX_OK = {n for n in NAME2FAM if NAME2FAM[n] in ('PRIOR_DAY', 'VALUE_AREA', 'WM_PIVOTS', 'PERIOD_HLP') or n in ('PD_OR_MID', 'PD_IB_MID', 'PW_MID', 'WEEKLY_OPEN', 'MONTHLY_OPEN', 'WEEKLY_VWAP', 'MONTHLY_VWAP')}   # known at the 18:00 open; OR/IB/final ONH-ONL/DAILY_OPEN are same-day-future and excluded
RTH = Sess('RTH', N, RTH0, RTH0, PERSEC, FIRST_OK - RTH0, LAST_OK - RTH0, 9, 7)
GLOBEX = Sess('GLOBEX', 55800, 64800, 0, PERSEC_GLOBEX, 1800, 55800 - 1800, 18, 24, names=GLOBEX_OK, form=False)   # contacts 18:30 (no-trade window cv-056) to 08:30

def persec_dates(sess=None):
    sess = sess or RTH
    return sorted(os.path.basename(p)[:10] for p in glob.glob(sess.d_dir + '/*.tsv'))

def load_day(d, sess=None):
    """dense per-second arrays over the session (RTH 09:30:00-15:59:59, or Globex 18:00-09:29:59): buy, sell, last (ffilled), low, high (= last when no trade)."""
    sess = sess or RTH; n = sess.n
    fp = f'{sess.d_dir}/{d}.tsv'
    if not os.path.exists(fp) and sess is RTH: fp = f'{PERSEC_SNAP}/{d}.tsv'
    df = pd.read_csv(fp, sep='\t', header=None, names=['sec', 'buy', 'sell', 'low', 'high', 'last'])
    df = df[(df.sec >= sess.file_off) & (df.sec < sess.file_off + n)]; ix = (df.sec - sess.file_off).values
    buy = np.zeros(n); sell = np.zeros(n); last = np.full(n, np.nan); low = np.full(n, np.nan); high = np.full(n, np.nan)
    buy[ix] = df.buy.values; sell[ix] = df.sell.values; last[ix] = df['last'].values; low[ix] = df.low.values; high[ix] = df.high.values
    s = pd.Series(last).ffill().bfill().values; last = s
    low = np.where(np.isnan(low), last, low); high = np.where(np.isnan(high), last, high)
    return dict(buy=buy, sell=sell, last=last, low=low, high=high)

SCALE_MIN = int(os.environ.get('TAPE_SCALE_MIN', '5'))      # scale unit in minutes (set from feasibility counts BEFORE any outcome; see the pre-registration)
def day_scale(A, mins=None):
    """session scale = median range of non-overlapping SCALE_MIN-minute blocks (blocks with trades)"""
    k = (mins or SCALE_MIN) * 60; n = (len(A['buy']) // k) * k
    tr = (A['buy'] + A['sell'])[:n].reshape(-1, k).sum(1) > 0
    rng = (A['high'][:n].reshape(-1, k).max(1) - A['low'][:n].reshape(-1, k).min(1))[tr]
    return float(np.median(rng)) if len(rng) else np.nan

def hour_rates(A, sess=None):
    """mean volume per second by clock hour of the session (RTH: index 0 = hour 9 (the 09:30-10:00 half hour) .. 6 = hour 15; Globex: index 0 = hour 18 .. 23 = hour 17, hours 9-17 empty -> 0)"""
    sess = sess or RTH; v = A['buy'] + A['sell']; h = np.array([sess.hidx(i) for i in range(0, len(v), 60)]).repeat(60)[:len(v)]
    return np.array([v[h == k].mean() if (h == k).any() else 0.0 for k in range(sess.nh)])

class Baselines:
    """causal baselines for a date: scale and per-clock-hour volume rate = median over the previous 20 sessions (all persec dates, not only explore)."""
    def __init__(self, dates, sess=None):
        self.dates = dates; self.cache = {}; self.sess = sess or RTH
        self.sc, self.vr = {}, {}
    def prep(self, d):
        if d not in self.sc:
            A = load_day(d, self.sess); self.sc[d] = day_scale(A); self.vr[d] = hour_rates(A, self.sess)
    def for_date(self, d, k=20):
        i = self.dates.index(d)
        if i < k: return None
        prev = self.dates[i - k:i]
        for p in prev: self.prep(p)
        scale = float(np.median([self.sc[p] for p in prev])); vr = np.median(np.vstack([self.vr[p] for p in prev]), 0)
        return scale, vr

def clusters(prices, tol):
    """single-link merge of sorted level prices within tol; returns list of (center, lo, hi, [indices])"""
    o = np.argsort(prices); out = []; cur = [o[0]]
    for j in o[1:]:
        if prices[j] - prices[cur[-1]] <= tol: cur.append(j)
        else: out.append(cur); cur = [j]
    out.append(cur)
    return [(float(np.median(prices[c])), float(prices[c].min()), float(prices[c].max()), list(c)) for c in out]

def find_touches(A, levels, scale, vol_rate, tol_f=TOL_F, rearm_f=REARM_F, pseudo=False, sess=None):
    """first-contact episodes of level clusters. levels: {name: price}. Epochs = the distinct formation times, so a level only exists once formed.
    Returns events with the information at the decision second t0 = contact + D_DWELL (features), NOT labels."""
    tol = tol_f * scale; rearm = rearm_f * scale; last, high, low = A['last'], A['high'], A['low']
    sess = sess or RTH; n_s = sess.n; fm = FORM if sess.form else {}
    names = [n for n in levels if (n in NAME2FAM and (sess.names is None or n in sess.names)) or pseudo]; ev = []
    forms = sorted(set([0] + [fm.get(n, 0) for n in names])); touch_no = {}
    for ei, f0 in enumerate(forms):
        f1 = forms[ei + 1] if ei + 1 < len(forms) else n_s
        act = [n for n in names if fm.get(n, 0) <= f0]
        if not act: continue
        pr = np.array([levels[n] for n in act], float)
        for (c, lo, hi, mem) in clusters(pr, tol):
            blo, bhi = lo - tol, hi + tol
            inb = (high >= blo) & (low <= bhi); far = (np.abs(last - c) >= rearm + (hi - lo) / 2)
            fpos = np.where(far)[0]; prev_contact = -1
            for i in np.where(inb[1:] & ~inb[:-1])[0] + 1:
                if i < max(f0 + 1, sess.first_ok) or i >= min(f1, sess.last_ok): continue
                lo_i = np.searchsorted(fpos, prev_contact + 1); armed = (lo_i < len(fpos) and fpos[lo_i] < i)
                if prev_contact < 0 and not armed: continue
                prev_contact = i
                if not armed: continue
                lp = last[i - 1]
                if lp > bhi: s = 1
                elif lp < blo: s = -1
                else: continue
                key = round(c, 2); touch_no[key] = touch_no.get(key, 0) + 1
                ev.append(dict(i=i, center=c, lo=lo, hi=hi, side=s, members=[act[m] for m in mem], touch_no=touch_no[key]))
    ev.sort(key=lambda e: e['i'])
    return ev

def xser(A, center, s):
    """x = s*(price - center): positive on the approach (bounce) side. returns x_last, x_max (best excursion in a second), x_min (worst)."""
    if s == 1: return A['last'] - center, A['high'] - center, A['low'] - center
    return center - A['last'], center - A['low'], center - A['high']

def tape_features(A, e, t0, scale, vol_rate, tol_f=TOL_F, sess=None):
    """the feature vector at second index t0 for an event dict (i = contact index, center, lo, hi, side, members, touch_no). Seconds <= t0 only. Shared by the study and the call-snapshot tool."""
    sess = sess or RTH; i, c, s = e['i'], e['center'], e['side']; tol = tol_f * scale
    xl, xmax, xmin = xser(A, c, s)
    buy, sell = A['buy'], A['sell']; al = s * (buy - sell); vol = buy + sell
    def share(a, b): v = vol[a:b + 1].sum(); return float(al[a:b + 1].sum() / v) if v > 0 else 0.0
    hr = min(sess.hidx(t0), len(vol_rate) - 1)
    vr = vol[max(t0 - 59, 0):t0 + 1].mean() / max(vol_rate[hr], 1e-9)
    b10 = [al[t0 - 119 + 10 * k: t0 - 109 + 10 * k].sum() for k in range(12)] if t0 >= 120 else []
    sg = [np.sign(v) for v in b10 if v != 0]; flips = np.mean([sg[k] != sg[k + 1] for k in range(len(sg) - 1)]) if len(sg) >= 4 else np.nan
    cum_v = vol[:t0 + 1].sum()
    band = (np.abs(A['last'][i:t0 + 1] - c) <= tol + (e['hi'] - e['lo']) / 2)
    ap = (xl[max(i - 300, 0)] - xl[i]) / scale
    f = dict(approach_speed=ap, dwell_frac=float(band.mean()), penetration=float(xmin[i:t0 + 1].min() / scale), bounce_so_far=float(xmax[i:t0 + 1].max() / scale),
             vol_ratio=float(np.log(vr + 0.01)), delta30=share(max(t0 - 29, 0), t0), delta120=share(max(t0 - 119, 0), t0), cumdelta=float(al[:t0 + 1].sum() / cum_v) if cum_v > 0 else 0.0, tussle=flips,
             dist_open=float(s * (A['last'][i] - A['last'][0]) / scale), log_scale=float(np.log(scale)), side=s, touch_no=e['touch_no'], n_levels=len(e['members']),
             hour=sess.hour_of(t0), t0=t0)
    for fam in FAMS: f['fam_' + fam] = int(any(NAME2FAM.get(m) == fam for m in e['members']))
    return f

def gate_and_features(A, e, scale, vol_rate, tol_f=TOL_F, dwell=D_DWELL, m_f=M_F, s_f=S_F, sess=None):
    """decision at t0 = contact + dwell. Returns (status, feats) with status in OK / THROUGH / ALREADY_HELD / EDGE."""
    i, c, s = e['i'], e['center'], e['side']; t0 = i + dwell; tol = tol_f * scale
    sess = sess or RTH
    if t0 >= sess.n - 1: return 'EDGE', None
    xl, xmax, xmin = xser(A, c, s)
    if xl[t0] < -tol: return 'THROUGH', None
    if xmax[i:t0 + 1].max() >= m_f * scale: return 'ALREADY_HELD', None
    if xmin[i:t0 + 1].min() <= -s_f * scale: return 'THROUGH', None
    return 'OK', tape_features(A, e, t0, scale, vol_rate, tol_f, sess)

def snapshot(A, t_call, level, direction, scale, vol_rate, tol_f=TOL_F, look_back=900, sess=None):
    """tape state at second index t_call for a user call. direction 'LONG' = level acts as support (side +1: price came from above and should bounce up), 'SHORT' = resistance (side -1).
    The contact is the last time before the call that price entered the level band from outside; if none within look_back seconds, the call second minus 60 is used. Seconds <= t_call only."""
    s = 1 if direction.upper() == 'LONG' else -1; tol = tol_f * scale; lo = hi = float(level)
    inb = (A['high'] >= lo - tol) & (A['low'] <= hi + tol); i = None
    for j in range(t_call, max(t_call - look_back, 1), -1):
        if inb[j] and not inb[j - 1]: i = j; break
    status = 'CONTACT_FOUND' if i is not None else 'NO_CONTACT_IN_WINDOW'
    if i is None: i = max(t_call - 60, 1)
    e = dict(i=i, center=lo, lo=lo, hi=hi, side=s, members=['USER_LEVEL'], touch_no=1)
    f = tape_features(A, e, t_call, scale, vol_rate, tol_f, sess); xl, _, _ = xser(A, lo, s)
    f.update(status=status, secs_since_contact=int(t_call - i), x_now=float(xl[t_call] / scale), price_now=float(A['last'][t_call]))
    return f

def label_event(A, e, scale, dwell=D_DWELL, m_f=M_F, s_f=S_F, cap=CAP, sess=None):
    """OUTCOME LABEL. HOLD=1 if x reaches +m before -s after the decision second, SLICE=0 if -s first, NaN if neither within cap or both in the same second. DO NOT CALL before the pre-registration is frozen and the look is logged."""
    c, s, t0 = e['center'], e['side'], e['i'] + dwell; xl, xmax, xmin = xser(A, c, s); m, sl = m_f * scale, s_f * scale
    end = min(t0 + cap, (sess or RTH).n - 1)
    for t in range(t0 + 1, end + 1):
        h, sd = xmax[t] >= m, xmin[t] <= -sl
        if h and sd: return np.nan
        if h: return 1.0
        if sd: return 0.0
    return np.nan
