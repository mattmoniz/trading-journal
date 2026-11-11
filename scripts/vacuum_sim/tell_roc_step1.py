"""STEP 1 (outcome-blind) of docs/TELL_VS_ROC_COINCIDENCE_PREREG_20261109.md (row 31, amendment A1). NO tell outcome column is read: only date, dir and end_sec of the scored entries (F present) of
scratch/tell_context_20261103/tell_floor_target_rows.csv. Thrust = the live detector's E0 onset (v2.events2). Flag = same-direction onset in [t - W, t] (causal). Exact base rates over candidate bars.
Usage: ../../venv/bin/python tell_roc_step1.py"""
import os, sys, glob, csv, json, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import features as Fm, v2
ENTRIES = os.path.join(Fm.ROOT, 'scratch', 'tell_context_20261103', 'tell_floor_target_rows.csv')
OUT = os.path.join(v2.OUT, 'tell_roc_step1_output.txt'); lines = []
DEC_LO, DEC_HI = 57600.0, 73800.0; BOOT = 4000
def say(s=''): print(s); lines.append(s)

def load_entries():
    by = collections.defaultdict(list)
    for r in csv.DictReader(open(ENTRIES)):
        if r['F'] == '': continue                                    # scored set of the floor-target prereg = rows that have a floor F (seed entries have none); only the PRESENCE of F is used, no outcome column is read
        if r['date'] > Fm.LAST_EXPLORE: continue
        by[r['date']].append(dict(date=r['date'], dir=int(r['dir']), t=float(r['end_sec']), risk=float(r['risk_pts']) if r['risk_pts'] else float('nan')))
    return by

def median_dur(hist_rth, hour):
    d = [T['en'] - T['st'] for T in hist_rth[-Fm.K_PRIOR:]]; h = [Fm.hour_et(T['en']) for T in hist_rth[-Fm.K_PRIOR:]]
    if len(d) < 15: return float('nan')
    v = np.concatenate([x[hh == hour] for x, hh in zip(d, h)]); return float(np.median(v)) if len(v) >= 50 else float('nan')

def flag_at(on_t, on_d, t, d, W):
    """same-direction thrust onset with end time in [t - W, t]"""
    m = (on_d == d) & (on_t <= t + 1e-9) & (on_t >= t - W); return bool(m.any())

def offset_bars(on_k, on_d, kbar, d, kW):
    """signed bar offset (onset bar - entry bar) of the nearest same-direction onset within +-kW bars, or None"""
    m = on_d == d; o = on_k[m] - kbar; o = o[np.abs(o) <= kW]
    return None if len(o) == 0 else int(o[np.argmin(np.abs(o))])

def main():
    entries = load_entries(); n_ent = sum(len(v) for v in entries.values())
    files = sorted(p for p in glob.glob(os.path.join(Fm.BARS, '*.bars.tsv')) if os.path.basename(p)[:10] <= Fm.LAST_EXPLORE)
    hist = {'RTH': [], 'GBX': []}; prevS = None; rows = []; dropped = collections.Counter()
    for p in files:
        S = Fm.load_full(p)
        if S is None: continue
        d = S['date']; tsp = Fm.track_split(S); close = Fm.EARLY_CLOSE if d in Fm.EARLY else Fm.CLOSE; prs = {}
        for name in ('RTH', 'GBX'):
            prev = hist[name][-Fm.K_PRIOR:]
            if len(prev) >= Fm.K_PRIOR: prs[name] = Fm.priors_of(prev)
        if d in entries:
            if len(prs) < 2 or prevS is None: dropped['no priors / first session'] += len(entries[d])
            else:
                P, n0, reset = v2.continuous(prevS, S); F = v2.feats(P, n0, reset, prs, close)
                ev = [r for r in v2.events2(P, n0, F, close) if r['fam'] == 'E0']
                on_t = np.array([r['end'] for r in ev], float); on_d = np.array([r['dir'] for r in ev], int); on_k = np.array([r['k'] for r in ev], int)
                en = S['en']; pace = F['pace'][n0:]; hrs = Fm.hour_et(en)
                terc = np.where(np.isnan(pace), -1, np.where(pace <= 1 / 3, 0, np.where(pace <= 2 / 3, 1, 2)))
                cand_all = np.where((en >= DEC_LO) & (en <= DEC_HI))[0]
                disp2 = np.full(len(en), np.nan); disp2[2:] = S['c'][2:] - S['c'][:-2]
                el10 = np.full(len(en), np.nan); el10[10:] = en[10:] - en[:-10]                  # elapsed seconds of the last 10 bars at each bar
                for e in entries[d]:
                    kb = int(np.argmin(np.abs(en - e['t'])))
                    if abs(en[kb] - e['t']) > 1.5: dropped['no matching bar (1.5 s)'] += 1; continue
                    h = int(hrs[kb]); med = median_dur(hist['RTH'], h)
                    if np.isnan(med) or terc[kb] < 0: dropped['no W / no pace'] += 1; continue
                    W = 10.0 * med; dr = e['dir']
                    fl = flag_at(on_t, on_d, en[kb], dr, W)
                    cand = [k for k in cand_all if hrs[k] == h and k != kb]; c2 = [k for k in cand if terc[k] == terc[kb]]
                    if len(cand) < 5 or len(c2) < 5: dropped['too few candidate bars'] += 1; continue
                    p1 = float(np.mean([flag_at(on_t, on_d, en[k], dr, W) for k in cand])); p2 = float(np.mean([flag_at(on_t, on_d, en[k], dr, W) for k in c2]))
                    sd = dr * disp2[cand_all]; sd = sd[~np.isnan(sd)]; q1, q2 = np.quantile(sd, [1 / 3, 2 / 3]); tdisp = lambda v: 0 if v <= q1 else (1 if v <= q2 else 2)
                    c3 = [k for k in c2 if not np.isnan(disp2[k]) and tdisp(dr * disp2[k]) == tdisp(dr * disp2[kb])]
                    p3 = float(np.mean([flag_at(on_t, on_d, en[k], dr, W) for k in c3])) if (len(c3) >= 5 and not np.isnan(disp2[kb])) else float('nan')
                    ev10 = el10[cand_all]; ev10 = ev10[~np.isnan(ev10)]; e1, e2 = np.quantile(ev10, [1 / 3, 2 / 3]); tel = lambda v: 0 if v <= e1 else (1 if v <= e2 else 2)
                    c4 = [k for k in cand if not np.isnan(el10[k]) and not np.isnan(disp2[k]) and tel(el10[k]) == tel(el10[kb]) and tdisp(dr * disp2[k]) == tdisp(dr * disp2[kb])]
                    p4 = float(np.mean([flag_at(on_t, on_d, en[k], dr, W) for k in c4])) if (len(c4) >= 5 and not np.isnan(el10[kb]) and not np.isnan(disp2[kb])) else float('nan')
                    slow_c = [k for k in c2 if not np.isnan(el10[k])]
                    m_dir = on_d == dr; pre = bool(np.any(m_dir & (on_k >= kb - 10) & (on_k <= kb - 3))); imm = bool(np.any(m_dir & (on_k >= kb - 2) & (on_k <= kb)))   # precursor window [t-10, t-3] vs immediate [t-2, t], in bars (A3 of the prereg)
                    kW = int(round(W / max(np.median(np.diff(en)), 1e-6)))                          # W in bars at the session's median spacing (display only)
                    off = offset_bars(on_k, on_d, kb, dr, 15)
                    rows.append(dict(date=d, dir=dr, hour=h, flag=int(fl), pre=int(pre), imm=int(imm), p1=p1, p2=p2, p3=p3, p4=p4, el10=float(el10[kb]) if not np.isnan(el10[kb]) else float('nan'), cand_el10=float(np.median([el10[k] for k in slow_c])) if slow_c else float('nan'), risk=e['risk'], t=e['t'], off=off, W=W, kW=kW, terc=int(terc[kb])))
        for name, T in tsp.items(): hist[name].append(T)
        prevS = S
    say(f'tell entries in the scored set (F present, <= {Fm.LAST_EXPLORE}): {n_ent}; used {len(rows)}; dropped {dict(dropped)}')
    if not rows: return
    R = rows; dates = sorted({r['date'] for r in R}); say(f'dates {len(dates)}; W (seconds) median {np.median([r["W"] for r in R]):.0f}, p10 {np.quantile([r["W"] for r in R], .1):.0f}, p90 {np.quantile([r["W"] for r in R], .9):.0f}; W in bars median {np.median([r["kW"] for r in R]):.0f}')
    f = np.array([r['flag'] for r in R], float); p1 = np.array([r['p1'] for r in R]); p2 = np.array([r['p2'] for r in R]); dd = np.array([r['date'] for r in R])
    idx = {d: np.where(dd == d)[0] for d in dates}; rng = np.random.default_rng(20261109)
    def lift(ix, p): return f[ix].mean() / p[ix].mean() if p[ix].mean() > 0 else float('nan')
    allix = np.arange(len(R)); res = {}
    p3 = np.array([r['p3'] for r in R]); ok3 = ~np.isnan(p3); p4 = np.array([r['p4'] for r in R]); ok4 = ~np.isnan(p4)
    for name, p in (('Base 1 (date + hour)', p1), ('Base 2 (date + hour + pace tercile)', p2), ('Base 3 (date + hour + pace tercile + signed 2-bar displacement tercile; entries with >= 5 matching bars)', p3), ('Base 4 (date + hour + 10-bar elapsed-duration tercile + signed 2-bar displacement tercile; entries with >= 5 matching bars)', p4)):
        sel = allix if not name.startswith(('Base 3', 'Base 4')) else (allix[ok3] if name.startswith('Base 3') else allix[ok4]); sidx = {d: np.intersect1d(idx[d], sel) for d in dates}; L = lift(sel, p); bs = []
        for _ in range(BOOT):
            pick = rng.integers(0, len(dates), len(dates)); ix = np.concatenate([sidx[dates[j]] for j in pick]); bs.append(lift(ix, p) if len(ix) else float('nan'))
        bs = np.array(bs); lo90, lo95, hi95 = np.nanquantile(bs, .10), np.nanquantile(bs, .025), np.nanquantile(bs, .975); pone = float((1 + np.nansum(bs <= 1.0)) / (BOOT + 1))
        say(f'  {name} [N {len(sel)}]: tell entries flagged {f[sel].mean() * 100:.1f} percent vs base {p[sel].mean() * 100:.1f} percent -> lift {L:.3f}; day-blocked one-sided 90 percent lower bound {lo90:.3f}, 95 percent CI [{lo95:.3f}, {hi95:.3f}], one-sided p(lift <= 1) {pone:.4f}')
        res[name] = dict(lift=L, lo90=float(lo90), ci95=[float(lo95), float(hi95)], p=pone, flagged=float(f[sel].mean()), base=float(p[sel].mean()))
    say('\nBy side and by clock hour (descriptive, lift vs Base 2):')
    for lab, sel in (('LONG', [i for i, r in enumerate(R) if r['dir'] == 1]), ('SHORT', [i for i, r in enumerate(R) if r['dir'] == -1])) + tuple((f'hour {h}', [i for i, r in enumerate(R) if r['hour'] == h]) for h in sorted({r['hour'] for r in R})):
        ix = np.array(sel); say(f'  {lab:8s} N {len(ix):5d}  flagged {f[ix].mean() * 100:5.1f} percent  base2 {p2[ix].mean() * 100:5.1f} percent  lift {lift(ix, p2):.3f}')
    say('\nBy pace tercile of the signal bar (0 fast, 1 mid, 2 slow; descriptive): ')
    for t in (0, 1, 2):
        ix = np.array([i for i, r in enumerate(R) if r['terc'] == t]);
        if len(ix): say(f'  tercile {t} N {len(ix):5d}  flagged {f[ix].mean() * 100:5.1f} percent  base2 {p2[ix].mean() * 100:5.1f} percent  lift {lift(ix, p2):.3f}')
    bins = [('<= -11', -15, -11), ('-10..-6', -10, -6), ('-5..-1', -5, -1), ('0', 0, 0), ('+1..+5', 1, 5), ('+6..+10', 6, 10), ('+11..+15', 11, 15)]
    offs = [r['off'] for r in R]; say(f'\nLead/lag of the nearest same-direction onset within +-15 bars, in bars (negative = the onset came BEFORE the tell decision bar; descriptive, both sides shown but only the past side is usable live):')
    say(f'  none within +-15: {100 * sum(o is None for o in offs) / len(offs):.1f} percent')
    for lab, a, b in bins: say(f'  {lab:9s} {100 * sum((o is not None and a <= o <= b) for o in offs) / len(offs):5.1f} percent')
    import csv as _csv
    rk = np.array([r['risk'] for r in R]); okr = ~np.isnan(rk); fl = f.astype(bool)
    say('\nBalance of ENTRY GEOMETRY (stop distance in points, from the entries file; no P&L) between thrust-flagged and unflagged tell entries:')
    say(f'  stop distance mean flagged {rk[okr & fl].mean():.1f} vs unflagged {rk[okr & ~fl].mean():.1f} (ratio {rk[okr & fl].mean() / rk[okr & ~fl].mean():.3f}); median {np.median(rk[okr & fl]):.1f} vs {np.median(rk[okr & ~fl]):.1f}; correlation(flag, stop) {np.corrcoef(f[okr], rk[okr])[0, 1]:+.3f}')
    hr_ = np.array([r['hour'] for r in R]); say('  share of entries by ET hour, flagged vs unflagged: ' + '; '.join(f'{h}h {100 * np.mean(hr_[fl] == h):.0f}/{100 * np.mean(hr_[~fl] == h):.0f}' for h in sorted(set(hr_))))
    for h in sorted(set(hr_)):
        m = okr & (hr_ == h); 
        if (m & fl).sum() > 5 and (m & ~fl).sum() > 5: say(f'    hour {h}: stop mean flagged {rk[m & fl].mean():.1f} vs unflagged {rk[m & ~fl].mean():.1f}')
    with open(os.path.join(v2.OUT, 'tell_roc_step1_entries_20261109.csv'), 'w', newline='') as fh:
        w = _csv.writer(fh); w.writerow(['date', 't', 'dir', 'hour', 'flag', 'pre', 'imm', 'p1', 'p2', 'p3', 'p4', 'stop']); [w.writerow([r['date'], r['t'], r['dir'], r['hour'], r['flag'], r['pre'], r['imm'], f"{r['p1']:.4f}", f"{r['p2']:.4f}", '' if np.isnan(r['p3']) else f"{r['p3']:.4f}", '' if np.isnan(r['p4']) else f"{r['p4']:.4f}", r['risk']]) for r in R]
    tc = np.array([r['terc'] for r in R]); say('\nBase 4 lift by pace tercile of the single decision bar (Argon: the slow-bar surge should vanish if it is a stall artefact):')
    for t in (0, 1, 2):
        ix = np.array([i for i in range(len(R)) if R[i]['terc'] == t and ok4[i]])
        if len(ix): say(f'  tercile {t} N {len(ix):5d}  flagged {f[ix].mean() * 100:5.1f} percent  base4 {p4[ix].mean() * 100:5.1f} percent  lift {f[ix].mean() / p4[ix].mean():.3f}')
    sl = np.array([i for i in range(len(R)) if R[i]['terc'] == 2]); e10 = np.array([R[i]['el10'] for i in sl]); c10 = np.array([R[i]['cand_el10'] for i in sl])
    say(f'  slow-tercile entries: median elapsed seconds of the last 10 bars {np.nanmedian(e10):.1f} vs median over candidate bars of the same hour and pace tercile {np.nanmedian(c10):.1f}')
    verdict = 'LEAD (CI lower bound > 1 vs Base 2)' if res['Base 2 (date + hour + pace tercile)']['lo90'] > 1.0 else 'NOT SHOWN vs the pace-matched control'
    say(f'\nT1 verdict (one-sided 90 percent lower bound of the lift over Base 2 > 1): {verdict}')
    json.dump(dict(n=len(R), dates=len(dates), dropped=dict(dropped), res=res, verdict=verdict), open(os.path.join(v2.OUT, 'tell_roc_step1.json'), 'w'), indent=1)
    open(OUT, 'w').write('\n'.join(lines) + '\n')

if __name__ == '__main__': main()
