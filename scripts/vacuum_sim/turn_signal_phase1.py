"""PHASE 1 (OUTCOME-BLIND) of the TURN SIGNAL ("capitulation / exhaustion") family. NO price after a bar's close is used to decide anything and NO trade outcome is computed.
Definition in the user's words (2026-11-09 chat; docs/OPEN_THREADS.md): these are entry / exit points that mark the END of the last move or the BEGINNING of a new one, not setups.
  STAGE 1 (end of the last move): a drop in bar time over a period (a CLUSTER: >= 3 of the last 5 bars are 'fast' by the user's own pace rule, RTH <= 15 s, Globex <= 0.65 x SMA50(dt) and <= 120 s),
     then a SPIKE of Ratio and ROC through their Bollinger bands (strict: Ratio z > 1.5 and |ROC z| > 2 in the same direction; loose: one through its band and the other within 0.5 sd of its band, 'a poke in one
     and a close poke in the other'), then the HOOK (the user's exit rule as coded in depth_tell2.trade_exit: ROC z back to <= 1.8 while the Ratio has fallen >= 0.25 sd from its peak since the spike).
  STAGE 2 (beginning of the new move): an OPPOSITE strict thrust onset within K bars after the hook, with no new extreme beyond the climax extreme by more than 0.5 x EMA10(TR) (the 'second stop' holds).
  EXTENSION: sign(ROC) x (Close - Close 240 min earlier, current session only) / ADR20 at the spike bar.
Windows: real-depth explore 2026-06-15..2026-10-09 (68 sessions, real Ratio), proxy-depth explore <= 2025-05-16 (trade-count proxy Ratio) reported SEPARATELY, never pooled. Sessions >= 2026-10-12 are NOT read for counts.
RECALL CHECK: the trader's labeled examples (2026-11-05 / 11-06, already seen, excluded from every evaluation) are run through the same frozen code with the PROXY Ratio and printed for the trader to compare with their marks."""
import sys, os, glob, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import features as Fm, v2
import depth_tell2 as D

ZR, ZC, HOOK_Z, HOOK_SD = Fm.Z_RATIO, Fm.Z_ROC, 1.8, 0.25
LOOK = 14400.0
DELAYS = ((1, 5), (6, 10), (11, 20), (21, 30))
KMAX = 30
EXAMPLES = {'2026-11-05': 'RTH', '2026-11-06': 'GBX'}   # the only already-seen sessions the recall check may read

def hhmm(en):
    s = (18 * 3600 + float(en)) % 86400; return '%02d:%02d:%02d' % (int(s // 3600), int(s % 3600 // 60), int(s % 60))

def detect(P, n0, F, close, adr20, loose=False):
    """Returns a list of dict rows, one per Stage-1 CANDIDATE spike (with hook / stage-2 fields when they occur). Causal: each field depends only on bars up to the event's own bar."""
    en, c, h, l = P['en'], P['c'], P['h'], P['l']; n = len(c); idx = np.arange(n)
    z, zr, ratio, rs = F['zroc'], F['zr'], F['ratio'], F['rs']; etr = F['etr']
    d = np.where(F['roc'] > 0, 1, np.where(F['roc'] < 0, -1, 0)); ok = ~np.isnan(z) & ~np.isnan(zr); same = np.sign(z) == d
    strict = ok & (np.abs(z) > ZC) & same & (zr > ZR)
    sp = strict | (ok & same & (zr > ZR) & (np.abs(z) > ZC - 0.5)) | (ok & same & (np.abs(z) > ZC) & (zr > ZR - 0.5)) if loose else strict
    uf = F['user_fast'].astype(int); nf = np.zeros(n, int)
    for j in range(5): nf += np.r_[np.zeros(j, int), uf[:n - j]]
    cluster = nf >= 3
    on_sp = D.onset(sp) & (idx >= n0); on_strict = D.onset(strict) & (idx >= n0)
    rth_w = (en >= 56100.0) & (en <= close - 600.0); gbx_w = en <= 55500.0
    rows = []
    for a in np.where(on_sp & cluster & (rth_w | gbx_w))[0]:
        da = int(d[a]); track = 'GBX' if gbx_w[a] else 'RTH'
        i0 = n0 + int(np.searchsorted(en[n0:], en[a] - LOOK)); ext = da * (c[a] - c[min(i0, a)]) / adr20 if adr20 else np.nan
        hook = None; pk = ratio[a]
        for j in range(a + 1, min(a + KMAX, n - 1) + 1):
            pk = max(pk, ratio[j])
            if not np.isnan(z[j]) and da * z[j] <= HOOK_Z and (pk - ratio[j]) >= HOOK_SD * rs[a]: hook = j; break
        r = dict(a=int(a), t=hhmm(en[a]), en=float(en[a]), track=track, dir=da, ext=float(ext), hook=None if hook is None else int(hook - a), s2={}, reopen=bool(en[a] < 1800.0))
        if hook is not None:
            xt = float(h[max(n0, a - 4):hook + 1].max()) if da > 0 else float(l[max(n0, a - 4):hook + 1].min())
            for s in range(hook + 1, min(hook + 50, n - 1) + 1):
                if on_strict[s] and int(d[s]) == -da:
                    held = (float(h[hook + 1:s + 1].max()) <= xt + 0.5 * etr[a]) if da > 0 else (float(l[hook + 1:s + 1].min()) >= xt - 0.5 * etr[a])
                    r['s2'] = dict(delay=int(s - hook), held=bool(held), t=hhmm(en[s])); break
        rows.append(r)
    nthrust = int((D.onset(ok & (np.abs(z) > ZC) & same) & (idx >= n0) & (rth_w | gbx_w)).sum())
    return rows, nthrust

def episodes(rows):
    """merge Stage-1 events of the same track and direction within 30 bars into one episode (first one kept)"""
    out, last = [], {}
    for r in sorted(rows, key=lambda x: (x.get('date', ''), x['track'], x['dir'], x['a'])):
        k = (r.get('date', ''), r['track'], r['dir'])
        if k in last and r['a'] - last[k] < 30: last[k] = r['a']; continue
        last[k] = r['a']; out.append(r)
    return out

def sessions_real(lo=None, hi=None, only=None):
    lo = lo or D.LO; hi = hi or D.HI
    srcs = {}
    for pat in ('scratch/volbars500_holdout_20261103/*.bars.tsv', 'scratch/amt_tell_live/*.split.bars.tsv', 'scratch/argon_vacuum_live/priors/*.bars.tsv'):
        for p in glob.glob(os.path.join(Fm.ROOT, pat)):
            d = os.path.basename(p)[:10]
            if '2026-04-15' <= d <= hi: srcs.setdefault(d, p)
    dates = sorted(srcs); assert max(dates) <= hi
    hist = {'RTH': [], 'GBX': []}; prevS = None; prevd = None
    for d in dates:
        S = Fm.load_full(srcs[d])
        if S is None: continue
        tsp = Fm.track_split(S); close = Fm.EARLY_CLOSE if d in Fm.EARLY else Fm.CLOSE; prs = {}
        for name in ('RTH', 'GBX'):
            prev = hist[name][-Fm.K_PRIOR:]
            if len(prev) >= Fm.K_PRIOR: prs[name] = Fm.priors_of(prev)
        cp = os.path.join(D.C2, f'{d}.npz')
        if lo <= d <= hi and (only is None or d in only) and len(prs) == 2 and os.path.exists(cp) and prevS is not None:
            P, n0, reset = v2.continuous(prevS, S); F = v2.feats(P, n0, reset, prs, close); F['etr'] = Fm.ema(F['tr'])
            dc = D.depth_arrays(S['en'], np.load(cp)); pcp = os.path.join(D.C2, f'{prevd}.npz'); dp = D.depth_arrays(prevS['en'], np.load(pcp)) if os.path.exists(pcp) else None
            if dc is not None:
                cont = {k: np.concatenate([dp[k] if dp is not None else np.full(len(prevS['en']), np.nan), dc[k]]) for k in dc}
                rr = D.real_ratio(F, D.ffill(cont['bid_all'] + cont['ask_all']))
                if rr is not None:
                    F['ratio'], F['zr'], F['rs'] = rr
                    rt = hist['RTH'][-20:]; adr = float(np.mean([T['h'].max() - T['l'].min() for T in rt])) if len(rt) >= 20 else None
                    yield d, P, n0, F, close, adr
        for name, T in tsp.items(): hist[name].append(T)
        prevS = S; prevd = d

def sessions_proxy(files, only=None, upto='2025-05-16'):
    hist = {'RTH': [], 'GBX': []}; prevS = None
    for p in files:
        S = Fm.load_full(p)
        if S is None: continue
        d = S['date']
        if d > upto and not (only and d in only): continue
        tsp = Fm.track_split(S); close = Fm.EARLY_CLOSE if d in Fm.EARLY else Fm.CLOSE; prs = {}
        for name in ('RTH', 'GBX'):
            prev = hist[name][-Fm.K_PRIOR:]
            if len(prev) >= Fm.K_PRIOR: prs[name] = Fm.priors_of(prev)
        if len(prs) == 2 and prevS is not None and (not only or d in only):
            P, n0, reset = v2.continuous(prevS, S); F = v2.feats(P, n0, reset, prs, close); F['etr'] = Fm.ema(F['tr'])
            rt = hist['RTH'][-20:]; adr = float(np.mean([T['h'].max() - T['l'].min() for T in rt])) if len(rt) >= 20 else None
            yield d, P, n0, F, close, adr
        for name, T in tsp.items(): hist[name].append(T)
        prevS = S

def report(title, gen, loose):
    print(f'\n=== {title} ({"LOOSE" if loose else "STRICT"} spike) ===')
    allr, nsess, nth = [], collections.Counter(), collections.Counter()
    for d, P, n0, F, close, adr in gen:
        rows, nt = detect(P, n0, F, close, adr, loose)
        for r in rows: r['date'] = d
        allr += rows; nsess[d[:4]] += 1; nth['n'] += nt
    ns = sum(nsess.values())
    print(f'sessions {ns}; thrust onsets (any, in the two entry windows) {nth["n"]} ({nth["n"] / max(ns, 1):.1f}/session)')
    for trk in ('RTH', 'GBX'):
        R = [r for r in allr if r['track'] == trk]; E = np.array([r['ext'] for r in R if not np.isnan(r['ext'])])
        hk = [r for r in R if r['hook'] is not None]
        print(f'  {trk}: Stage-1 candidates (cluster + spike) {len(R)} ({len(R) / max(ns, 1):.2f}/session), episodes (merged within 30 bars) {len(episodes(R))}, with a hook within {KMAX} bars {len(hk)} ({100 * len(hk) / max(len(R), 1):.0f}%)')
        if len(R): print('     hook delay (bars) buckets ' + ', '.join(f'{a}-{b}: {sum(1 for r in hk if a <= r["hook"] <= b)}' for a, b in DELAYS))
        if len(E): print('     extension at the spike (ADR20): percentiles 33/50/67/80 = ' + ' / '.join(f'{np.percentile(E, q):.2f}' for q in (33, 50, 67, 80)) + f'; share >= 0.75 ADR: {100 * np.mean(E >= 0.75):.0f}%')
        if len(hk):
            top = [r for r in hk if not np.isnan(r['ext']) and E.size and r['ext'] >= np.percentile(E, 67)]
            print(f'     Stage 1 (hook) events {len(hk)}; in the top extension tercile {len(top)}; reopen (18:00-18:30) {sum(1 for r in hk if r["reopen"])}')
            for K in (15, 30, 50):
                s2 = [r for r in hk if r['s2'] and r['s2']['delay'] <= K and r['s2']['held']]
                s2t = [r for r in top if r['s2'] and r['s2']['delay'] <= K and r['s2']['held']]
                print(f'     Stage 2 (opposite thrust within {K} bars of the hook, climax extreme held): all {len(s2)} ({100 * len(s2) / len(hk):.0f}%); top-tercile Stage 1: {len(s2t)} of {len(top)}; independent episodes {len(episodes([r for r in s2]))}')
    return allr

def recall():
    print('\n=== RECALL CHECK on the trader\'s seen examples (PROXY Ratio; excluded from every evaluation) ===')
    srcs = {}
    for pat in ('scratch/volbars500_holdout_20261103/*.bars.tsv', 'scratch/amt_tell_live/*.split.bars.tsv', 'scratch/argon_vacuum_live/priors/*.bars.tsv'):
        for p in glob.glob(os.path.join(Fm.ROOT, pat)): srcs.setdefault(os.path.basename(p)[:10], p)
    files = [srcs[d] for d in sorted(srcs) if d >= '2026-08-01']
    marks = {'2026-11-06': [('11-05 18:19 selling climax (V-bottom)', 19 * 60), ('11-06 04:36 buying exhaustion', 10 * 3600 + 36 * 60)], '2026-11-05': [('11-05 11:35 poke-and-reject top', 17 * 3600 + 35 * 60), ('11-05 13:04 / 13:08 double-test bottom', 19 * 3600 + 4 * 60)]}
    def gens():
        for d, P, n0, F, close, adr in sessions_real(lo='2026-10-12', hi='2026-11-06', only=set(marks)): yield 'REAL', d, P, n0, F, close, adr
        for d, P, n0, F, close, adr in sessions_proxy(files, only=set(marks), upto='2026-11-06'): yield 'PROXY', d, P, n0, F, close, adr
    for kind, d, P, n0, F, close, adr in gens():
        for loose in (False, True):
            rows, _ = detect(P, n0, F, close, adr, loose)
            print(f' {kind} Ratio, session {d} ({"loose" if loose else "strict"}): ' + (', '.join(f'{r["t"]} {r["track"]} dir {r["dir"]:+d} ext {r["ext"]:.2f}' + (f' hook+{r["hook"]}' if r["hook"] is not None else ' no hook') + (f' S2@{r["s2"]["t"]}{"" if r["s2"]["held"] else "(breached)"}' if r["s2"] else '') for r in rows) or 'no candidates'))
        for lab, sec in marks[d]: print(f'   mark: {lab} -> {hhmm(sec)} (seconds since 18:00 = {sec})')

if __name__ == '__main__':
    for loose in (False, True):
        report('REAL-DEPTH explore 2026-06-15..2026-10-09', sessions_real(), loose)
    srcs = sorted(glob.glob(os.path.join(Fm.BARS, '*.bars.tsv')))
    report('PROXY-DEPTH explore <= 2025-05-16 (separate, never pooled)', sessions_proxy(srcs), False)
    recall()
