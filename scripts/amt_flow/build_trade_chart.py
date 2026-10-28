"""Builds the multi-mode trade chart page: order-flow setups (A/B), exhaustion reversals (E2/E1) and the revised Sweep and Absorb (scale-out), explore sessions only.
Usage: ../../venv/bin/python build_trade_chart.py <out_html>   (replaces build_chart_data.py)"""
import sys, json, pathlib, importlib.util
import numpy as np, pandas as pd
import flow as F, engine as E, tpo
from amt_s1 import overnight_ranges
H = pathlib.Path(__file__).parent; SPLIT = '2025-05-16'
FILES = {('vol', 'spec'): 'volume', ('tpo', 'spec'): 'tpo', ('vol', 'atr2'): 'vol_atr2', ('tpo', 'atr2'): 'tpo_atr2'}
def r2(x): return None if x is None or (isinstance(x, float) and np.isnan(x)) else round(float(x), 2)

def load_ctx():
    raw = E.load_sessions(); allS = E.build_eligible(raw); ex = [s for s in allS if s['d'] <= SPLIT]; ks = sorted(raw); on = overnight_ranges(end='2026-10-27')
    for s in ex:
        r = on.loc[s['d']] if s['d'] in on.index else None; s['onh'], s['onl'] = (float(r.hi), float(r.lo)) if (r is not None and r.n >= 500) else (None, None)
    return raw, ex, ks

def day_payload(s, raw, ks):
    a = s['a']; p = tpo.tpo_profile(raw[ks[ks.index(s['d']) - 1]], row=1.0); t = dict(s); t['vah'], t['val'] = p['vah'], p['val']; pv = raw[ks[ks.index(s['d']) - 1]]; ib = slice(0, 60)
    return dict(d=s['d'], o=[r2(x) for x in a['o']], h=[r2(x) for x in a['h']], l=[r2(x) for x in a['l']], c=[r2(x) for x in a['c']],
                lv=dict(pdVAH=r2(s['vah']), pdVAL=r2(s['val']), tVAH=r2(p['vah']), tVAL=r2(p['val']), POC=r2(s['poc']), pdH=r2(np.nanmax(pv['h'])), pdL=r2(np.nanmin(pv['l'])), ONH=r2(s['onh']), ONL=r2(s['onl']), IBH=r2(np.nanmax(a['h'][ib])), IBL=r2(np.nanmin(a['l'][ib]))),
                zones=dict(vol=[[r2(q[0]), r2(q[1]), q[2]] for q in F.build_zones(s)], tpo=[[r2(q[0]), r2(q[1]), q[2]] for q in F.build_zones(t)]))

def pick_windows(dates, counts, n=8):
    best = []
    for i in range(len(dates) - 4):
        win = dates[i:i + 5]
        if all((pd.Timestamp(win[j + 1]) - pd.Timestamp(win[j])).days <= 5 for j in range(4)): best.append((sum(counts.get(d, 0) for d in win), i))
    best.sort(reverse=True); chosen = []
    for sc, i in best:
        if all(abs(i - j) >= 5 for _, j in chosen): chosen.append((sc, i))
        if len(chosen) == n: break
    return sorted(chosen, key=lambda x: x[1])

def of_data(raw, ex, ks):
    trades, summary, counts = {}, {}, {}
    for (z, st), tag in FILES.items():
        for k in ('A', 'B'):
            df = pd.read_csv(H / f'trades_{k}_signal_{tag}_explore.csv'); key = f'{z}|{st}|{k}'; p = df.net.to_numpy(); w = p[p > 0]; l = p[p <= 0]
            summary[key] = dict(n=int(len(df)), wr=round(100 * float(np.mean(p > 0)), 1), pf=round(float(w.sum() / abs(l.sum())), 2), mean=round(float(p.mean()), 2))
            tgt = F.A_TGT if k == 'A' else F.B_TGT
            trades[key] = [[r.date, int(r.dir), int(r.ei), int(r.xi), r2(r.entry), r2(r.entry + r.dir * r.pts), r.reason, r2(r.net), r2(r.pts), r2(r.stop0), r2(r.entry + r.dir * tgt), int(r.ei) - 1] for r in df.itertuples()]
            if (z, st) == ('vol', 'atr2'):
                for d, c in df.groupby('date').size().items(): counts[d] = counts.get(d, 0) + int(c)
    dates = [s['d'] for s in ex]; by = {s['d']: s for s in ex}; wins = []
    for sc, i in pick_windows(dates, counts):
        wins.append(dict(label=f"{pd.Timestamp(dates[i]).strftime('%b %d')} to {pd.Timestamp(dates[i + 4]).strftime('%b %d, %Y')}", ntr=sc, days=[day_payload(by[d], raw, ks) for d in dates[i:i + 5]]))
    return dict(windows=wins, trades=trades, summary=summary)

def ex_data(raw, ex, ks):
    sp = importlib.util.spec_from_file_location('ex_run', str(H.parent / 'amt_exhaust' / 'run.py')); sys.path.insert(0, str(H.parent / 'amt_exhaust'))
    import exhaust as X
    m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m)
    sess = m.prepare(); out, _ = m.events_for(sess); by = m.enrich(sess, out); trades, summary, counts = {}, {}, {}
    for g in ('E2', 'E1', 'C2', 'NR'):
        rows = []; nets = []; f15 = []
        for e in out[g]:
            geo = e['geo']
            if not geo: continue
            rows.append([e['date'], int(e['d']), int(e['e']), int(geo['xi']), r2(geo['entry']), r2(geo['exit']), geo['reason'], r2(geo['net']), r2(geo['pts']), r2(geo['stop']), r2(geo['tgt']), int(e['t']), r2(e['ext']), r2(e['start']), int(e['k']), r2(e['F15'])])
            nets.append(geo['net']); f15.append(e['F15'])
        p = np.array(nets); w = p[p > 0]; l = p[p <= 0]
        trades['ex|' + g] = rows; summary['ex|' + g] = dict(n=len(rows), wr=round(100 * float(np.mean(p > 0)), 1), pf=round(float(w.sum() / abs(l.sum())), 2), mean=round(float(p.mean()), 2), f15=round(float(np.nanmean(f15)), 2))
        if g in ('E2', 'E1'):
            for r in rows: counts[r[0]] = counts.get(r[0], 0) + (3 if g == 'E2' else 1)
    exd = {s['d']: s for s in ex}; dates = [s['d'] for s in sess]; wins = []
    for sc, i in pick_windows(dates, counts):
        wins.append(dict(label=f"{pd.Timestamp(dates[i]).strftime('%b %d')} to {pd.Timestamp(dates[i + 4]).strftime('%b %d, %Y')}", ntr=sum(1 for r in trades['ex|E2'] if r[0] in dates[i:i + 5]), days=[day_payload(exd[d], raw, ks) for d in dates[i:i + 5]]))
    return dict(windows=wins, trades=trades, summary=summary)

def sw_data(raw, ex, ks):
    """Revised Sweep and Absorb (scripts/amt_sweep, 2 contracts: half off at +10, stop to breakeven, runner to VWAP or +25). The exit marker is the AVERAGE exit of the two contracts (entry + dir * pts); target = the first leg at +10."""
    SW = H.parent / 'amt_sweep'; T1 = 10.0; trades, summary, counts = {}, {}, {}
    for key, fn in (('S', 'trades_signal_explore.csv'), ('C', 'trades_control_explore.csv')):
        df = pd.read_csv(SW / fn); p = df.net.to_numpy(); w = p[p > 0]; l = p[p <= 0]
        summary['sw|' + key] = dict(n=int(len(df)), wr=round(100 * float(np.mean(p > 0)), 1), pf=round(float(w.sum() / abs(l.sum())), 2), mean=round(float(p.mean()), 2))
        trades['sw|' + key] = [[r.date, int(r.dir), int(r.ei), int(r.xi), r2(r.entry), r2(r.entry + r.dir * r.pts), r.reason, r2(r.net), r2(r.pts), r2(r.entry - r.dir * r.stop_dist), r2(r.entry + r.dir * T1), int(r.sig)] for r in df.itertuples()]
        if key == 'S':
            for d, c in df.groupby('date').size().items(): counts[d] = int(c)
    dates = [s['d'] for s in ex]; by = {s['d']: s for s in ex}; wins = []
    for sc, i in pick_windows(dates, counts):
        wins.append(dict(label=f"{pd.Timestamp(dates[i]).strftime('%b %d')} to {pd.Timestamp(dates[i + 4]).strftime('%b %d, %Y')}", ntr=sc, days=[day_payload(by[d], raw, ks) for d in dates[i:i + 5]]))
    return dict(windows=wins, trades=trades, summary=summary)

def bo_data(raw, ex, ks, of, exx):
    """Absorption (A, all four zone/stop variants) and exhaustion (E2, E1) on the SAME windows: windows are picked for the most exhaustion trades (weighted 12x) plus absorption trades, so both appear together."""
    A = of['trades']['vol|atr2|A']; E2 = exx['trades']['ex|E2']; counts = {}
    for r in A: counts[r[0]] = counts.get(r[0], 0) + 1
    for r in E2: counts[r[0]] = counts.get(r[0], 0) + 12
    dates = [s['d'] for s in ex][20:]; by = {s['d']: s for s in ex}; wins = []
    for sc, i in pick_windows(dates, counts):
        w = dates[i:i + 5]
        wins.append(dict(label=f"{pd.Timestamp(dates[i]).strftime('%b %d')} to {pd.Timestamp(dates[i + 4]).strftime('%b %d, %Y')}", ntr=sum(1 for r in A if r[0] in w) + sum(1 for r in E2 if r[0] in w), days=[day_payload(by[d], raw, ks) for d in w]))
    dset = {d['d'] for w in wins for d in w['days']}
    trades = {k: [r for r in v if r[0] in dset] for k, v in of['trades'].items() if k.endswith('|A')}
    trades.update({k: [r for r in v if r[0] in dset] for k, v in exx['trades'].items() if k in ('ex|E2', 'ex|E1')})
    summary = {k: v for k, v in of['summary'].items() if k.endswith('|A')}; summary.update({k: v for k, v in exx['summary'].items() if k in ('ex|E2', 'ex|E1')})
    return dict(windows=wins, trades=trades, summary=summary)

def main(out):
    raw, ex, ks = load_ctx(); of = of_data(raw, ex, ks); exx = ex_data(raw, ex, ks); data = dict(bo=bo_data(raw, ex, ks, of, exx), of=of, ex=exx, sw=sw_data(raw, ex, ks))
    html = (H / 'trade_chart_template.html').read_text().replace('/*DATA*/null', json.dumps(data, separators=(',', ':')))
    pathlib.Path(out).write_text(html); print('bo windows', [(w['label'], w['ntr']) for w in data['bo']['windows']]); print(f'wrote {out} ({len(html) / 1e6:.2f} MB); of windows {len(data["of"]["windows"])}, ex windows {[w["label"] + " (" + str(w["ntr"]) + ")" for w in data["ex"]["windows"]]}')

if __name__ == '__main__':
    main(sys.argv[1])
