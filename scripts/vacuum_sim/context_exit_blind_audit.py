"""OUTCOME-BLIND audit of Argon's review of rows 28/29 (look 213). Reads NO signal outcome. It produces (a) per-event geometry (E_t, stop distance, signal-bar wick) and per-session tape statistics, and
(b) arms R (ratchet) and H (30-bar hold) run on RANDOM bars with random direction (not signals), to bound the paired spread and hold time. Usage: ../../venv/bin/python context_exit_blind_audit.py"""
import os, sys, glob, csv, json, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import features as Fm, v2, context_exit_phase1 as P1
RNG = np.random.default_rng(20261110); PER = {'RTH': 12, 'GBX': 6}; COST = 2.0; SLIP = 0.25
OUTD = v2.OUT

def arms(P, etr, a, dr, flat):
    """H = live rule (stop at entry, 30 bars, hard flat); R = ratchet (stop follows the running favourable extreme at the same distance, no time exit, hard flat). Both enter at Open[a+1]."""
    h, l, c, o = P['h'], P['l'], P['c'], P['o']; e = a + 1
    if e > flat or np.isnan(etr[a]): return None
    dist = 2.5 * etr[a]; entry = o[e]; res = {}
    stop = entry - dr * dist; last = min(e + 29, flat); ex = None
    for t in range(e, last + 1):
        if (dr == 1 and l[t] <= stop) or (dr == -1 and h[t] >= stop):
            fill = stop if t == e else (min(stop, o[t]) if dr == 1 else max(stop, o[t])); ex = (t, fill - dr * SLIP); break
    if ex is None: ex = (last, c[last])
    res['H'] = (dr * (ex[1] - entry) - COST, ex[0] - e + 1)
    for name, dyn in (('R', False), ('R2', True)):
        stop = entry - dr * dist; ext = entry; ex = None; armed = False
        for t in range(e, flat + 1):
            if (dr == 1 and l[t] <= stop) or (dr == -1 and h[t] >= stop):
                fill = stop if t == e else (min(stop, o[t]) if dr == 1 else max(stop, o[t])); ex = (t, fill - dr * SLIP); break
            ext = max(ext, h[t]) if dr == 1 else min(ext, l[t])
            if dyn and dr * (ext - entry) >= dist: armed = True
            dd = min(dist, 2.5 * etr[t]) if (dyn and armed and not np.isnan(etr[t])) else dist
            ns = ext - dr * dd; stop = max(stop, ns) if dr == 1 else min(stop, ns)
        if ex is None: ex = (flat, c[flat])
        pk = dr * (ext - entry); pnl = dr * (ex[1] - entry) - COST
        res[name] = (pnl, ex[0] - e + 1, pk - (pnl + COST), float(P['en'][ex[0]] - P['en'][e]))      # 4th value: wall-clock seconds from the entry bar to the exit bar (reporting only)
    res['to_flat'] = flat - e + 1
    return res

def chain(files, want=None):
    hist = {'RTH': [], 'GBX': []}; prevS = None; ev = []; sess = []; rb = []
    for p in files:
        S = Fm.load_full(p)
        if S is None: continue
        d = S['date']; assert d <= P1.HI_PRIMARY and d != '2026-11-06'
        tsp = Fm.track_split(S); close = Fm.EARLY_CLOSE if d in Fm.EARLY else Fm.CLOSE; prs = {}
        for name in ('RTH', 'GBX'):
            prev = hist[name][-Fm.K_PRIOR:]
            if len(prev) >= Fm.K_PRIOR: prs[name] = Fm.priors_of(prev)
        if len(prs) == 2 and prevS is not None and (want is None or d in want):
            Pc, n0, reset = v2.continuous(prevS, S); F = v2.feats(Pc, n0, reset, prs, close); etr = Fm.ema(F['tr']); adr = P1.adr20(hist['RTH']); en = Pc['en']
            rows = [r for r in v2.events2(Pc, n0, F, close) if r['fam'] == 'E0' and r['track']]
            for r in rows:
                k = r['k']; i = n0 + k; Sh, Sl, Sc, So = S['h'][k], S['l'][k], S['c'][k], S['o'][k]; rng = Sh - Sl; dr = r['dir']
                wick = ((Sh - Sc) if dr == 1 else (Sc - Sl)) / rng if rng > 0 else float('nan')       # share of the bar's range given back at the thrust end (0 = closed on the extreme)
                E = float('nan'); t = S['en'][k]
                if t >= P1.LAG and not np.isnan(adr) and adr > 0:
                    j = int(np.searchsorted(S['en'], t - P1.LAG, side='right')) - 1
                    if j >= 0: E = dr * (S['c'][k] - S['c'][j]) / adr
                fail1 = float('nan') if k + 1 >= len(S['c']) else float(dr * (S['c'][k + 1] - (Sh if dr == 1 else Sl)) <= 0)
                ev.append(dict(date=d, track=r['track'], k=k, t=float(t), dir=dr, E=E, adr=adr, stop=float(2.5 * etr[i]), wick=float(wick), hour=int(Fm.hour_et(np.array([t]))[0]), roc=float(r['roc']), fail1=fail1, dur1=float(S['en'][k + 1] - S['en'][k]) if k + 1 < len(S['c']) else float('nan')))
            durs = (S['en'] - S['st']); rth = (S['st'] >= Fm.OPEN) & (S['en'] <= close); inc = np.diff(S['c'])
            ac1 = float(np.corrcoef(inc[rth[1:]][:-1], inc[rth[1:]][1:])[0, 1]) if rth.sum() > 100 else float('nan')
            sess.append(dict(date=d, med_dur_rth=float(np.median(durs[rth])) if rth.any() else float('nan'), ac1=ac1, adr=adr, stop_over_adr=float(np.median([2.5 * etr[n0 + r['k']] for r in rows if r['track'] == 'RTH']) / adr) if adr and any(r['track'] == 'RTH' for r in rows) else float('nan')))
            en_c = Pc['en']; flat_rth = int(np.where(en_c <= close - 300.0)[0].max()); flat_gbx = int(np.where(en_c <= 55790.0)[0].max())
            for tr, lo, hi, flat in (('RTH', 56100.0, close - 600.0, flat_rth), ('GBX', 1800.0, 55500.0, flat_gbx)):
                idx = [n0 + k for k in range(len(S['c'])) if lo <= S['en'][k] <= hi and k >= Fm.WARM]
                if not idx: continue
                for a in RNG.choice(idx, size=min(PER[tr], len(idx)), replace=False):
                    dr = int(RNG.choice([-1, 1])); x = arms(Pc, etr, int(a), dr, flat)
                    if x: rb.append(dict(date=d, track=tr, hour=int(Fm.hour_et(np.array([en_c[a]]))[0]), H=x['H'][0], R=x['R'][0], R2=x['R2'][0], hold_H=x['H'][1], hold_R=x['R'][1], hold_R2=x['R2'][1], give_R=x['R'][2], give_R2=x['R2'][2], to_flat=x['to_flat']))
        for name, T in tsp.items(): hist[name].append(T)
        prevS = S
    return ev, sess, rb

def main():
    files, scored68 = P1.primary_files()
    out = {}
    for name, (fl, want) in {'primary': (files, scored68), 'replication': (sorted(p for p in glob.glob(os.path.join(Fm.BARS, '*.bars.tsv')) if os.path.basename(p)[:10] <= Fm.LAST_EXPLORE), None)}.items():
        ev, sess, rb = chain(fl, want); out[name] = (ev, sess, rb); print(name, len(ev), len(sess), len(rb))
    with open(os.path.join(OUTD, 'context_exit_events_20261109.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['corpus', 'date', 'track', 'k', 't', 'dir', 'E', 'adr', 'stop', 'wick', 'hour', 'roc', 'fail1', 'dur1']); w.writeheader()
        for nm in out:
            for e in out[nm][0]: w.writerow({'corpus': nm, **{k: e[k] for k in w.fieldnames if k != 'corpus'}})
    with open(os.path.join(OUTD, 'context_exit_sessions_20261109.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['corpus', 'date', 'med_dur_rth', 'ac1', 'adr', 'stop_over_adr']); w.writeheader()
        for nm in out:
            for s in out[nm][1]: w.writerow({'corpus': nm, **s})
    with open(os.path.join(OUTD, 'context_exit_randombars_20261109.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['corpus', 'date', 'track', 'hour', 'H', 'R', 'R2', 'hold_H', 'hold_R', 'hold_R2', 'give_R', 'give_R2', 'to_flat']); w.writeheader()
        for nm in out:
            for s in out[nm][2]: w.writerow({'corpus': nm, **s})

if __name__ == '__main__': main()
