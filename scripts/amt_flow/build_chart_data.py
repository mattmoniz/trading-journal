"""Builds the multi-day trade chart page from the explore-set trade CSVs. Output: <out_html> (self-contained). Usage: ../../venv/bin/python build_chart_data.py <out_html>"""
import sys, json, pathlib
import numpy as np, pandas as pd
import flow as F, engine as E, tpo
from amt_s1 import overnight_ranges
H = pathlib.Path(__file__).parent; SPLIT = '2025-05-16'
FILES = {('vol', 'spec'): 'volume', ('tpo', 'spec'): 'tpo', ('vol', 'atr2'): 'vol_atr2', ('tpo', 'atr2'): 'tpo_atr2'}

def r2(x): return None if x is None or (isinstance(x, float) and np.isnan(x)) else round(float(x), 2)

def main(out):
    raw = E.load_sessions(); allS = E.build_eligible(raw); ex = [s for s in allS if s['d'] <= SPLIT]; ks = sorted(raw); on = overnight_ranges(end='2026-10-27')
    trades, summary, counts = {}, {}, {}
    for (z, st), tag in FILES.items():
        for k in ('A', 'B'):
            df = pd.read_csv(H / f'trades_{k}_signal_{tag}_explore.csv'); key = f'{z}|{st}|{k}'
            p = df.net.to_numpy(); w = p[p > 0]; l = p[p <= 0]
            summary[key] = dict(n=int(len(df)), wr=round(100 * float(np.mean(p > 0)), 1), pf=round(float(w.sum() / abs(l.sum())), 2), mean=round(float(p.mean()), 2), total=round(float(p.sum()), 0))
            tgt = F.A_TGT if k == 'A' else F.B_TGT
            trades[key] = [[r.date, int(r.dir), int(r.ei), int(r.xi), r2(r.entry), r2(r.entry + r.dir * r.pts), r.reason, r2(r.net), r2(r.pts), r2(r.stop0), r2(r.entry + r.dir * tgt)] for r in df.itertuples()]
            if (z, st) == ('vol', 'atr2'):
                for d, c in df.groupby('date').size().items(): counts[d] = counts.get(d, 0) + int(c)
    dates = [s['d'] for s in ex]; best = []
    for i in range(len(dates) - 4):
        win = dates[i:i + 5]
        if all((pd.Timestamp(win[j + 1]) - pd.Timestamp(win[j])).days <= 5 for j in range(4)): best.append((sum(counts.get(d, 0) for d in win), i))
    best.sort(reverse=True); chosen = []
    for sc, i in best:
        if all(abs(i - j) >= 5 for _, j in chosen): chosen.append((sc, i))
        if len(chosen) == 8: break
    chosen.sort(key=lambda x: x[1]); wins = []; by = {s['d']: s for s in ex}
    for sc, i in chosen:
        days = []
        for d in dates[i:i + 5]:
            s = by[d]; r = on.loc[d] if d in on.index else None; s['onh'], s['onl'] = (float(r.hi), float(r.lo)) if (r is not None and r.n >= 500) else (None, None)
            p = tpo.tpo_profile(raw[ks[ks.index(d) - 1]], row=1.0); t = dict(s); t['vah'], t['val'] = p['vah'], p['val']
            a = s['a']; ib = slice(0, 60)
            days.append(dict(d=d, o=[r2(x) for x in a['o']], h=[r2(x) for x in a['h']], l=[r2(x) for x in a['l']], c=[r2(x) for x in a['c']],
                             lv=dict(pdVAH=r2(s['vah']), pdVAL=r2(s['val']), tVAH=r2(p['vah']), tVAL=r2(p['val']), ONH=r2(s['onh']), ONL=r2(s['onl']), IBH=r2(np.nanmax(a['h'][ib])), IBL=r2(np.nanmin(a['l'][ib]))),
                             zones=dict(vol=[[r2(q[0]), r2(q[1]), q[2]] for q in F.build_zones(s)], tpo=[[r2(q[0]), r2(q[1]), q[2]] for q in F.build_zones(t)])))
        wins.append(dict(label=f"{pd.Timestamp(dates[i]).strftime('%b %d')} to {pd.Timestamp(dates[i + 4]).strftime('%b %d, %Y')}", ntr=sc, days=days))
    tpl = (H / 'trade_chart_template.html').read_text()
    html = tpl.replace('/*DATA*/null', json.dumps(dict(windows=wins, trades=trades, summary=summary), separators=(',', ':')))
    pathlib.Path(out).write_text(html); print(f'wrote {out} ({len(html) / 1e6:.2f} MB), windows {[w["label"] for w in wins]}')

if __name__ == '__main__':
    main(sys.argv[1])
