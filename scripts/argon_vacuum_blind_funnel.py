"""Blind funnel count + power gate for the Argon liquidity-vacuum pullback spec (candidate Q4-4).
PREREG: docs/ARGON_VACUUM_BLIND_FUNNEL_PREREG_20261108.md (frozen before this script existed). Spec: docs/GeminiArgonsnq_liquidity_vacuum_v2_spec.md.
Reads ONLY scratch/volbars500_full_20261028 (Explore dates <= 2025-05-16). Reads no forward price OF A TRIGGER and no candidate outcome; the only price-forward quantity is the
UNCONDITIONAL fast-tape 30-bar volatility used as sigma in the power formula (prereg 4C). Never reads the sealed-era directory."""
import sys, os, glob, json, math, bisect
import numpy as np
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
BARS = os.path.join(ROOT, 'scratch', 'volbars500_full_20261028')
assert 'holdout' not in BARS
LAST_EXPLORE = '2025-05-16'
OPEN_SEC, CLOSE_SEC, EARLY_CLOSE_SEC = 55800.0, 79200.0, 69300.0
EARLY = set(json.load(open(os.path.join(ROOT, 'scratch', 'early_close_dates_20261108.json'))))
TICK = 0.25; COST_RT = 1.50                      # spec: cost_rt_pts = 2/2 + 2 ticks
L_IMP, L_TR, L_RECL, L_DELTA, WARMUP, K_PRIOR = 10, 10, 2, 3, 30, 20
ALPHA = 2.0 / (L_TR + 1)
ENTRY_FROM_END, ENTRY_BEFORE_CLOSE, FLAT_BEFORE_CLOSE = 56100.0, 600.0, 300.0
Q_ACT, Q_CLV_LONG, Q_CLV_SHORT = 0.60, 0.60, 0.40
EFF_MIN, DELTAIMB_MIN, DISP_ATR = 0.45, 0.15, 0.10

def session_from_rows(d, rows):
    """rows = complete, vol==500 bars as (start, end, o, h, l, c, vol, bid, ask) (already rounded as the .bars.tsv files round them). Applies the RTH slice (prereg section 3): start>=09:30, end<=close.
    SHARED by the batch count and the live shadow so both slice identically. Returns the session dict or None when fewer than 1 RTH bar (callers apply the N_rth>=60 qualifier)."""
    close = EARLY_CLOSE_SEC if d in EARLY else CLOSE_SEC
    keep = [r for r in rows if r[0] >= OPEN_SEC and r[1] <= close]
    if not keep: return None
    a = np.array(keep)
    return dict(date=d, close=close, st=a[:, 0], en=a[:, 1], o=a[:, 2], h=a[:, 3], l=a[:, 4], c=a[:, 5], v=a[:, 6], delta=a[:, 8] - a[:, 7],
                aggr=float((a[:, 7] + a[:, 8]).sum() / a[:, 6].sum()), n=len(keep))

def load_day(path):
    """RTH slice of one day file (.bars.tsv: idx start end open high low close vol bid ask ntrades complete). Returns the session dict, or None when it has under 60 RTH bars (not a qualifying session)."""
    d = os.path.basename(path)[:10]; rows = []
    for ln in open(path):
        p = ln.rstrip('\n').split('\t')
        if len(p) < 12: continue
        st, en, o, h, l, c, v, bid, ask = (float(x) for x in p[1:10])
        if p[11] != '1' or v != 500: continue
        rows.append((st, en, o, h, l, c, v, bid, ask))
    S = session_from_rows(d, rows)
    return S if S is not None and S['n'] >= 60 else None

def wq(vals_by_session, q):
    """Session-equal-weighted step quantile: each session's bars weigh 1/(K*N_s); smallest value whose cumulative weight >= q."""
    K = len(vals_by_session); xs = []; ws = []
    for v in vals_by_session:
        if len(v) == 0: continue
        xs.append(np.asarray(v, float)); ws.append(np.full(len(v), 1.0 / (K * len(v))))
    x = np.concatenate(xs); w = np.concatenate(ws); i = np.argsort(x, kind='stable'); x, w = x[i], w[i]
    cw = np.cumsum(w) / w.sum(); return float(x[min(int(np.searchsorted(cw, q - 1e-12, side='left')), len(x) - 1)])

def tr_ema(S):
    h, l, c = S['h'], S['l'], S['c']; n = len(c)
    tr = np.empty(n); tr[0] = h[0] - l[0]
    tr[1:] = np.maximum.reduce([h[1:] - l[1:], np.abs(h[1:] - c[:-1]), np.abs(l[1:] - c[:-1])])
    ema = np.empty(n); ema[0] = tr[0]
    for i in range(1, n): ema[i] = ALPHA * tr[i] + (1 - ALPHA) * ema[i - 1]
    return tr, ema

def clv_of(S):
    rng = S['h'] - S['l']
    return np.where(rng > 0, (S['c'] - S['l']) / np.where(rng > 0, rng, 1), 0.5)

def priors_for(prev):
    """prev = the K_PRIOR most recent qualifying sessions BEFORE the scored one (never the scored session itself)."""
    atr = float(np.mean([s['h'].max() - s['l'].min() for s in prev]))
    raw = [s['en'] - s['st'] for s in prev]
    pos = [r[r >= 0.001] for r in raw]
    floor = max(wq(pos, 0.01), 0.005)
    dts = [np.maximum(r, floor) for r in raw]
    base = float(np.median([np.median(x) for x in dts]))
    act_thr = wq([base / x for x in dts], Q_ACT)                      # Activity = BaseDur / dt
    clv = [clv_of(s) for s in prev]
    return dict(atr=atr, floor=floor, base=base, act_thr=act_thr, clv_hi=wq(clv, Q_CLV_LONG), clv_lo=wq(clv, Q_CLV_SHORT))

def segments(S):
    """Halt rule (spec 2.2): a gap or bar longer than 300 s inside RTH restarts warmup/EMA_TR. Returns seg_start index per bar."""
    n = S['n']; seg = np.zeros(n, int); cur = 0; halts = 0
    for k in range(1, n):
        if S['st'][k] - S['en'][k - 1] > 300.0 or S['en'][k] - S['st'][k] > 300.0: cur = k; halts += 1
        seg[k] = cur
    return seg, halts

def features(S, P):
    n = S['n']; seg, halts = segments(S)
    h, l, c, dl = S['h'], S['l'], S['c'], S['delta']
    tr = np.empty(n); ema = np.empty(n)
    for k in range(n):
        if seg[k] == k:
            tr[k] = h[k] - l[k]; ema[k] = tr[k]
        else:
            tr[k] = max(h[k] - l[k], abs(h[k] - c[k - 1]), abs(l[k] - c[k - 1])); ema[k] = ALPHA * tr[k] + (1 - ALPHA) * ema[k - 1]
    dt = np.maximum(S['en'] - S['st'], P['floor']); act = P['base'] / dt; fast = act >= P['act_thr']
    since = np.arange(n) - seg
    dcand = np.ones(n, int); dis = np.zeros(n); eff = np.zeros(n); dimb = np.zeros(n); okimp = np.zeros(n, bool)
    for k in range(L_IMP, n):
        if since[k] < L_IMP: continue
        mv = c[k] - c[k - L_IMP]; dcand[k] = 1 if mv >= 0 else -1; dis[k] = abs(mv)
        eff[k] = abs(mv) / max(tr[k - L_IMP + 1:k + 1].sum(), TICK)
        vs = S['v'][k - L_IMP + 1:k + 1].sum(); dimb[k] = dcand[k] * dl[k - L_IMP + 1:k + 1].sum() / vs
        disp_ok = dis[k] >= max(DISP_ATR * P['atr'], 2.5 * ema[k], 10.0 * COST_RT)
        okimp[k] = disp_ok and eff[k] >= EFF_MIN and dimb[k] >= DELTAIMB_MIN and fast[k]
    clv = clv_of(S); d3 = np.zeros(n); fl_hi = np.zeros(n, bool); fl_lo = np.zeros(n, bool)
    for k in range(n):
        if since[k] >= L_DELTA - 1:
            d3[k] = dl[k - L_DELTA + 1:k + 1].sum(); fl_hi[k] = clv[k] >= P['clv_hi'] and d3[k] > 0; fl_lo[k] = clv[k] <= P['clv_lo'] and d3[k] < 0
    inwin = (S['en'] >= ENTRY_FROM_END) & (S['en'] <= S['close'] - ENTRY_BEFORE_CLOSE) & (since >= WARMUP)
    return dict(seg=seg, halts=halts, tr=tr, ema=ema, fast=fast, since=since, dcand=dcand, okimp=okimp, fl_hi=fl_hi, fl_lo=fl_lo, inwin=inwin, c=c, h=h, l=l)

def rdown(x): return math.floor(x / TICK + 1e-9) * TICK
def rup(x): return math.ceil(x / TICK - 1e-9) * TICK

def run_fsm(S, F, P, max_pb, scan):
    """Spec 5.3 pullback FSM, bar-close only. scan=True: the uncensored EOD scanner (records pb_bars, max_pb=inf). Returns (events, aborts, counters, pb_list)."""
    n = S['n']; h, l, c = F['h'], F['l'], F['c']; ema = F['ema']
    state = 0; ev = []; ab = {}; cnt = dict(arms=0, reached=0, reclaims=0, cooled=0); pbs = []; last = {1: -10**9, -1: -10**9}
    def fail(r):
        nonlocal state
        ab[r] = ab.get(r, 0) + 1; state = 0
    for k in range(n):
        if F['seg'][k] == k and k > 0 and state != 0: fail('halt')
        if state == 0:
            if F['inwin'][k] and F['okimp'][k]:
                d = int(F['dcand'][k]); a = max(0, k - L_IMP)
                wo = float(l[a:k + 1].min()) if d == 1 else float(h[a:k + 1].max())
                peak = float(h[k]) if d == 1 else float(l[k]); ext = float(l[k]) if d == 1 else float(h[k])
                reached = False; impb = 0; pbb = 0; state = 1; cnt['arms'] += 1
            continue
        # PULLBACK_ARMED
        bar_ext = float(h[k]) if d == 1 else float(l[k])
        if (not reached) and d * (bar_ext - peak) > 0:
            peak = bar_ext; ext = float(l[k]) if d == 1 else float(h[k]); pbb = 0; impb += 1
            if impb > 30: fail('imp_bars'); continue
        else:
            ext = min(ext, float(l[k])) if d == 1 else max(ext, float(h[k])); pbb += 1
        rng = max(d * (peak - wo), TICK); retr = d * (peak - ext) / rng
        if retr >= 0.25 and not reached: reached = True; cnt['reached'] += 1
        if retr > 0.50: fail('retrace'); continue
        if d * (c[k] - wo) <= 0: fail('origin'); continue
        if pbb > max_pb: fail('maxpb'); continue
        if S['en'][k] > S['close'] - ENTRY_BEFORE_CLOSE: fail('window'); continue
        ext2 = max(h[k - 1], h[k - 2]) if d == 1 else min(l[k - 1], l[k - 2])
        fl = F['fl_hi'][k] if d == 1 else F['fl_lo'][k]
        if reached and pbb >= 2 and d * (c[k] - ext2) > 0 and fl:
            cnt['reclaims'] += 1
            if scan:
                if d * (c[k] - peak) <= ema[k]: pbs.append(pbb)
                state = 0; continue
            if not F['fast'][k] or not F['inwin'][k]: fail('gates'); continue
            stop = rdown(ext - 0.5 * ema[k]) if d == 1 else rup(ext + 0.5 * ema[k])
            ref = float(c[k]); sref = min(stop, rdown(ref - 4.0 * COST_RT)) if d == 1 else max(stop, rup(ref + 4.0 * COST_RT))
            risk = d * (ref - sref)
            if risk > 0.35 * P['atr']: fail('risk'); continue
            if d * (c[k] - peak) > 1.0 * ema[k]: fail('chase'); continue
            if k - last[d] < 30: cnt['cooled'] += 1; state = 0; continue
            last[d] = k; ev.append((k, d, float(risk))); state = 0
    return ev, ab, cnt, pbs

def run_ffc(S, F):
    """FAST_FLOW_CONTROL (spec 6.2.3): 10-bar trend sign + fast tape + Flow_Aligned, 30-bar per-direction cooldown."""
    ev = []; last = {1: -10**9, -1: -10**9}; c = F['c']
    for k in range(L_IMP, S['n']):
        if not (F['inwin'][k] and F['fast'][k]) or F['since'][k] < L_IMP: continue
        mv = c[k] - c[k - L_IMP]
        if mv == 0: continue
        d = 1 if mv > 0 else -1
        if (F['fl_hi'][k] if d == 1 else F['fl_lo'][k]) and k - last[d] >= 30: last[d] = k; ev.append((k, d))
    return ev

def exposure(events, n, flat_idx):
    """Signed forward-exposure vector of one arm for one day (prereg 4B). Reads NO price: only trigger bar indices and directions."""
    w = np.zeros(n)
    for e in events:
        k, d = e[0], e[1]; w[k + 1:min(k + 30, flat_idx) + 1] += d
    return w / max(len(events), 1)

def main():
    files = sorted(f for f in glob.glob(os.path.join(BARS, '*.bars.tsv')) if os.path.basename(f)[:10] <= LAST_EXPLORE)
    days = [s for s in (load_day(f) for f in files) if s is not None]
    print(f'files {len(files)}  qualifying sessions (N_rth>=60) {len(days)}  first {days[0]["date"]} last {days[-1]["date"]}')
    bad = [s['date'] for s in days if s['aggr'] < 0.95]
    print(f'days with aggressor coverage <0.95: {len(bad)} {bad[:5]}')
    # pass 1: uncensored scanner on every session with a full prior window -> pb_bars lists
    feats = {}; scans = {}
    for i in range(K_PRIOR, len(days)):
        P = priors_for(days[i - K_PRIOR:i]); F = features(days[i], P); feats[i] = (P, F)
        scans[i] = run_fsm(days[i], F, P, float('inf'), True)[3]
    ev_c = {}; ev_f = {}; ab_tot = {}; cnt_tot = dict(arms=0, reached=0, reclaims=0, cooled=0); halts = 0; maxpbs = []
    for i in range(K_PRIOR, len(days)):
        P, F = feats[i]; pool = [x for j in range(max(K_PRIOR, i - K_PRIOR), i) for x in scans[j]]
        mp = int(np.clip(int(np.quantile(pool, 0.90, method='inverted_cdf')), 15, 35)) if len(pool) >= 10 else 20; maxpbs.append(mp)
        ev, ab, cnt, _ = run_fsm(days[i], F, P, mp, False); ev_c[i] = ev; ev_f[i] = run_ffc(days[i], F); halts += F['halts']
        for k, v in ab.items(): ab_tot[k] = ab_tot.get(k, 0) + v
        for k, v in cnt.items(): cnt_tot[k] += v
    idx = sorted(ev_c); ns = len(idx)
    mc = np.array([len(ev_c[i]) for i in idx]); mf = np.array([len(ev_f[i]) for i in idx])
    act_c = int((mc > 0).sum()); act_f = int((mf > 0).sum()); tot_c = int(mc.sum()); tot_f = int(mf.sum())
    neff = float(mc.sum() ** 2 / max((mc ** 2).sum(), 1))
    thirds = [int(mc[a:b].sum()) for a, b in zip(np.linspace(0, ns, 4).astype(int)[:-1], np.linspace(0, ns, 4).astype(int)[1:])]
    hours = {}
    for i in idx:
        for k, d, r in ev_c[i]: hh = (18 + int(days[i]['en'][k] // 3600)) % 24; hours[hh] = hours.get(hh, 0) + 1
    print(f'scored sessions {ns} (first {days[idx[0]]["date"]}, last {days[idx[-1]]["date"]}); halts {halts}; max_pb_bars median {int(np.median(maxpbs))} range {min(maxpbs)}-{max(maxpbs)}')
    print(f'CANDIDATE: arms {cnt_tot["arms"]} pullback-reached {cnt_tot["reached"]} reclaims {cnt_tot["reclaims"]} cooled {cnt_tot["cooled"]} TRIGGERS {tot_c} ({tot_c / ns:.3f}/session) active days {act_c} N_eff {neff:.1f} thirds {thirds}')
    print(f'   aborts {dict(sorted(ab_tot.items()))}  long {sum(1 for i in idx for e in ev_c[i] if e[1] == 1)} short {sum(1 for i in idx for e in ev_c[i] if e[1] == -1)}')
    print(f'   by hour_et {dict(sorted(hours.items()))}')
    print(f'FAST_FLOW_CONTROL: triggers {tot_f} ({tot_f / ns:.3f}/session) active days {act_f}')
    # power: sigma_b from fast-tape in-window bars (unconditional of any trigger)
    ch = []; w_c = []; w_f = []; w_d = []; w_x = []
    for i in idx:
        S = days[i]; P, F = feats[i]; n = S['n']; flat = int(np.where(S['en'] <= S['close'] - FLAT_BEFORE_CLOSE)[0].max())
        for t in range(n):
            if F['inwin'][t] and F['fast'][t] and t + 30 <= flat: ch.append(F['c'][t + 30] - F['c'][t])
        a = exposure(ev_c[i], n, flat) if ev_c[i] else None; b = exposure(ev_f[i], n, flat) if ev_f[i] else None
        if a is not None: w_c.append(float(a @ a))
        if b is not None: w_f.append(float(b @ b))
        if a is not None and b is not None: w_d.append(float((a - b) @ (a - b))); w_x.append(float(a @ b))
    ch = np.array(ch); sig30 = float(ch.std()); sig_b = sig30 / math.sqrt(30)
    mde_pool = 2.802 * sig_b * math.sqrt(np.mean(w_c)) / math.sqrt(max(act_c, 1)) if w_c else float('inf')
    mde_pair = 2.802 * sig_b * math.sqrt(np.mean(w_d)) / math.sqrt(len(w_d)) if w_d else float('inf')
    rho = float(np.mean(w_x) / math.sqrt(np.mean(w_c) * np.mean(w_f))) if w_x else float('nan')
    print(f'SIGMA fast-tape 30-bar forward change {sig30:.2f} pt (n={len(ch)}), per-bar {sig_b:.3f}; cluster factor ||w_C||^2 mean {np.mean(w_c) if w_c else float("nan"):.4f}; rho_day {rho:.3f}; jointly active days {len(w_d)}')
    print(f'MDE pooled {mde_pool:.2f} pt   MDE paired {mde_pair:.2f} pt   (cost floor 2.0 pt)')
    gates = dict(trig_per_session=(tot_c / ns, 0.70, tot_c / ns >= 0.70), active_days=(act_c, 250, act_c >= 250), mde_pool=(mde_pool, 3.50, mde_pool <= 3.50),
                 mde_pair=(mde_pair, 3.00, mde_pair <= 3.00), n_eff=(neff, 180, neff >= 180), thirds=(min(thirds), 40, min(thirds) >= 40))
    for k, (v, t, ok) in gates.items(): print(f'GATE {k}: {v:.3f} vs {t}  {"PASS" if ok else "FAIL"}')
    verdict = 'RESOLVABLE ON EXPLORE' if all(g[2] for g in gates.values()) else 'PARKED: UNDERPOWERED ON EXPLORE (not retired; reopen triggers in prereg section 6)'
    print('VERDICT:', verdict)
    out = os.path.join(ROOT, 'scratch', 'argon_blind_funnel_20261108')
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, 'triggers.csv'), 'w') as fh:
        fh.write('date,bar_idx,end_sec,dir,init_risk_pts\n')
        for i in idx:
            for k, d, r in ev_c[i]: fh.write(f'{days[i]["date"]},{k},{days[i]["en"][k]:.3f},{d},{r:.2f}\n')
    json.dump(dict(scored_sessions=ns, triggers=tot_c, active_days=act_c, n_eff=neff, thirds=thirds, ffc_triggers=tot_f, ffc_active_days=act_f, sigma30=sig30, sigma_bar=sig_b,
                   mde_pool=mde_pool, mde_pair=mde_pair, rho_day=rho, gates={k: [float(v), t, bool(ok)] for k, (v, t, ok) in gates.items()}, verdict=verdict, aborts=ab_tot, counters=cnt_tot),
              open(os.path.join(out, 'summary.json'), 'w'), indent=1)

if __name__ == '__main__': main()
