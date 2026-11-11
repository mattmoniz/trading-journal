"""Row 44 audit (descriptive, post-hoc, never counted; Argon Q12): is the reversed speed lead a split-bar / latency artefact, and are RTH climaxes contaminated by pre-open bars inside the rolling windows? Rebuilds the row 44 events (same rolling cutoffs; parity asserted)."""
import os, sys, csv, glob, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import capitulation_speed as CS
CR, G, Fm, v2, SH = CS.CR, CS.G, CS.Fm, CS.v2, CS.SH
def run():
    ev = CR.load_flags(); by_date = collections.defaultdict(list)
    for e in ev: by_date[e['date']].append(e)
    files = sorted(p for p in glob.glob(os.path.join(Fm.BARS, '*.bars.tsv')) if os.path.basename(p)[:10] <= Fm.LAST_EXPLORE)
    hist = {'RTH': [], 'GBX': []}; prevS = None; rows = []; ph = {'RTH': [], 'GBX': []}
    for p in files:
        S = Fm.load_full(p)
        if S is None: continue
        tsp = Fm.track_split(S); close = Fm.EARLY_CLOSE if S['date'] in Fm.EARLY else Fm.CLOSE; newp = collections.defaultdict(list)
        if S['date'] in by_date:
            prs = {n: Fm.priors_of(hist[n][-Fm.K_PRIOR:]) for n in ('RTH', 'GBX')}
            P, n0, reset = v2.continuous(prevS, S); n = len(P['c']); Fm.L_ROC = 10; F = v2.feats(P, n0, reset, prs, close); etr = Fm.ema(F['tr']); en, st, o, h, l, c = P['en'], P['st'], P['o'], P['h'], P['l'], P['c']
            rth0 = n0 + int(np.argmax(S['st'] >= Fm.OPEN)) if (S['st'] >= Fm.OPEN).any() else None
            for e in by_date[S['date']]:
                s = int(e['dir']); a = n0 + int(e['k']); tr = e['track']; lim = G.LIM if tr == 'GBX' else close - 300.0
                pw = F['pace'][max(a - 4, n0):a + 1]
                if np.all(np.isnan(pw)): continue
                pace5 = float(np.nanmin(pw)); newp[tr].append(pace5)
                cut = float(np.percentile(ph[tr][-CS.KEEP:], 100 / 3)) if len(ph[tr][-CS.KEEP:]) >= CS.MINH else None
                if cut is None: continue
                r = dict(date=S['date'], track=tr, fast=int(pace5 <= cut), dir=s, dur_a=float(F['dur'][a]), dur_min5=float(np.nanmin(F['dur'][max(a - 4, n0):a + 1])), bars_since_open=(a - rth0) if (tr == 'RTH' and rth0 is not None) else None)
                r['gap1'] = float(st[a + 1] - en[a]) if a + 1 < n else None
                def entry_from(j):          # j = the first bar whose Open is the entry; signal bar for calc_outcome is j-1
                    if j is None or j - 1 <= a - 1 or j >= n: return None
                    oc = SH.calc_outcome(en, o, h, l, c, j - 1, s, float(etr[j - 1]), lim, n, n0=n0); return None if oc is None or isinstance(oc, tuple) else oc['fwd']
                r['f0'] = entry_from(a + 1); r['f1'] = entry_from(a + 2)
                for name, dly in (('f7', 7.0), ('f15', 15.0)):
                    j = None
                    for q in range(a + 1, min(a + 60, n)):
                        if st[q] >= en[a] + dly: j = q; break
                    r[name] = entry_from(j)
                rows.append(r)
        for tr in ('RTH', 'GBX'): ph[tr] += newp[tr]
        for name, T in tsp.items(): hist[name].append(T)
        prevS = S
    return rows
rows = run(); R = [r for r in rows if r['track'] == 'RTH']
assert sum(r['fast'] for r in R) == 238 and len(R) == 676, (sum(r['fast'] for r in R), len(R))      # parity with row 44
print('parity with row 44: RTH 676 climaxes, 238 extreme-fast: OK')
def bm(vals, seed=7):
    r = G.boot_mean(vals, seed); return f'{r["mean"]:+.2f} [{r["lo"]:+.2f}, {r["hi"]:+.2f}] N {r["n"]}' if r else 'n/a'
print('\n1) SPLIT-BAR TIMESTAMPS: seconds between the climax bar close and the next bar open (0 = the next bar starts at the same instant, i.e. the same trade print / same second)')
for lab, sub in (('extreme-fast', [r for r in R if r['fast']]), ('not fast', [r for r in R if not r['fast']])):
    g = np.array([r['gap1'] for r in sub if r['gap1'] is not None]); d = np.array([r['dur_a'] for r in sub]); m5 = np.array([r['dur_min5'] for r in sub])
    print(f'  {lab:13s} N {len(sub):4d}: gap to next bar <= 0.05 s: {np.mean(g <= 0.05):.0%}; median gap {np.median(g):.2f} s; climax-bar duration < 0.5 s: {np.mean(d < 0.5):.0%}; fastest bar of the 5 < 0.5 s: {np.mean(m5 < 0.5):.0%}')
print('\n2) DELAYED ENTRY: CONTINUE pre-cost change over 30 bars from the delayed entry (exit 30 bars after the entry bar), signed with the move; extreme-fast vs not fast; difference with a day-blocked CI')
for key, lab in (('f0', 'Open[a+1] (as row 44)'), ('f1', 'Open[a+2] (1-bar delay)'), ('f7', 'first bar opening >= 7 s after the climax close'), ('f15', 'first bar opening >= 15 s after the close')):
    fa = [(r['date'], r[key]) for r in R if r['fast'] and r[key] is not None]; nf = [(r['date'], r[key]) for r in R if not r['fast'] and r[key] is not None]
    d = G.boot_diff(fa, nf, 11); print(f'  {lab:46s} fast {bm(fa)} | not fast {bm(nf)} | fast minus not fast {d["mean"]:+.2f} [{d["lo"]:+.2f}, {d["hi"]:+.2f}]')
print('\n3) SESSION-BOUNDARY CONTAMINATION: RTH climaxes by bars elapsed since the 09:30 open (the ROC10 Z needs about 59 bars; the 50-bar bands hold pre-open bars until then)')
for lab, f in (('< 59 bars since the open (pre-open bars still inside the windows)', lambda r: r['bars_since_open'] is not None and r['bars_since_open'] < 59), ('>= 59 bars (clean RTH-only windows)', lambda r: r['bars_since_open'] is not None and r['bars_since_open'] >= 59)):
    sub = [r for r in R if f(r)]; fa = [(r['date'], -r['f0']) for r in sub if r['fast'] and r['f0'] is not None]; nf = [(r['date'], -r['f0']) for r in sub if not r['fast'] and r['f0'] is not None]
    print(f'  {lab:62s} N {len(sub):3d} ({len(sub) / len(R):.0%} of RTH climaxes), extreme-fast {sum(r["fast"] for r in sub)}; exit value (minus the stay-in change) fast {bm(fa)} | not fast {bm(nf)}')
bso = [r['bars_since_open'] for r in R if r['bars_since_open'] is not None]; print(f'  median bars since the open at the climax: {np.median(bso):.0f}; share before bar 59: {np.mean(np.array(bso) < 59):.0%}')
