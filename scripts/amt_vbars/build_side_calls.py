"""Builds the blind side-call set (PREREG_SIDE_CALLS.md frozen 2026-11-01). Writes scratch/side_calls_20261101/moments.json (goes into the page, NO outcome, NO tell flag) and key.json (kept out of the page).
Usage: ../../venv/bin/python build_side_calls.py"""
import json, os
import numpy as np, pandas as pd
import vbars as V
import run_expansion_horizons as H
OUT = '/home/mmoniz/trading-journal/scratch/side_calls_20261101'; SEED = 20261101; NT, NC, MAXBARS, MINHIST = 40, 20, 240, 120

def clock(sec):   # seconds since the 18:00 ET session open -> minute of the ET day
    return int((18 * 60 + sec / 60.0) % 1440)

def moment(S, i, cl):
    lo = max(0, i - MAXBARS + 1); end, start = S['end'], S['start']; rel = lambda x: round(float(x - cl), 2)
    bars = [[rel(S['o'][j]), rel(S['h'][j]), rel(S['l'][j]), rel(S['c'][j]), int(S['ask'][j] - S['bid'][j]), clock(start[j])] for j in range(lo, i + 1)]
    on = end < V.RTH_OPEN; ib = (end >= V.RTH_OPEN) & (end < V.RTH_OPEN + 3600); ib_done = end[i] >= V.RTH_OPEN + 3600
    lines = dict(onh=rel(S['h'][on].max()), onl=rel(S['l'][on].min()), ibh=rel(S['h'][ib].max()) if ib_done and ib.any() else None, ibl=rel(S['l'][ib].min()) if ib_done and ib.any() else None)
    m = S['vi'] <= i; price = np.round(S['vp'][m] * 0.25); pb = {}
    for p, v in zip(price, S['vv'][m]): pb[p] = pb.get(p, 0.0) + v
    hi_ = max(b[1] for b in bars); lo_ = min(b[2] for b in bars)
    prof = sorted((rel(p), int(v)) for p, v in pb.items() if lo_ - 15 <= p - cl <= hi_ + 15)
    poc = max(pb.items(), key=lambda kv: kv[1])[0]
    return dict(bars=bars, lines=lines, prof=prof, poc=rel(poc))

def main():
    rng = np.random.default_rng(SEED); sess, atr = H.sessions()
    df = pd.read_csv('decision_points_explore.csv'); df['moving'] = df.moving.astype(str).str.lower().eq('true')
    pts = df.groupby(['date', 'i']).agg(nmax=('ncomp', 'max'), mov=('moving', 'any'), tdir=('dir', lambda s: 0)).reset_index()
    tdirs = df[df.ncomp == 5].groupby(['date', 'i']).dir.apply(list).to_dict()
    pts = pts[(pts.i >= MINHIST) & pts.date.isin(atr.keys())]
    tell = pts[pts.nmax == 5].sample(frac=1, random_state=SEED); ctrl = pts[(pts.nmax < 5) & pts.mov].sample(frac=1, random_state=SEED + 1)
    def pick(pool, k):
        out, per = [], {}
        for r in pool.itertuples():
            ps = per.setdefault(r.date, [])
            if len(ps) >= 2 or any(abs(r.i - x) < 60 for x in ps): continue
            ps.append(r.i); out.append(r)
            if len(out) == k: break
        return out
    chosen = [(r, True) for r in pick(tell, NT)] + [(r, False) for r in pick(ctrl, NC)]
    order = list(rng.permutation(len(chosen))); moments, key = [], {}
    for k, ix in enumerate(order):
        r, is_tell = chosen[ix]; S = sess[r.date]; i = int(r.i); a = atr[r.date]; cl = float(S['c'][i]); id_ = 'S' + str(k + 1).zfill(2)
        m = moment(S, i, cl); m['id'] = id_; moments.append(m)
        ex = {W: H.excursions(S, a, i, 1, W) for W in (900, 1800, 3600)}; exs = {W: H.excursions(S, a, i, -1, W) for W in (3600,)}
        key[id_] = dict(date=r.date, i=i, tell=bool(is_tell), tell_dirs=[int(x) for x in tdirs.get((r.date, r.i), [])], atr=a,
                        fwd_long={str(W // 60): (None if v is None else v[2]) for W, v in ex.items()}, brk_long=None if ex[3600] is None else bool(ex[3600][3]), brk_short=None if exs[3600] is None else bool(exs[3600][3]),
                        mfe_long=None if ex[3600] is None else ex[3600][0], mae_long=None if ex[3600] is None else ex[3600][1])
    os.makedirs(OUT, exist_ok=True); json.dump(moments, open(f'{OUT}/moments.json', 'w'), separators=(',', ':')); json.dump(key, open(f'{OUT}/key.json', 'w'))
    txt = open(f'{OUT}/moments.json').read()
    print(f"moments {len(moments)}: tell {sum(v['tell'] for v in key.values())}, control {sum(not v['tell'] for v in key.values())}; payload {len(txt) / 1024:.0f} KB; distinct dates {len({v['date'] for v in key.values()})}")
    print('leak check, payload contains any of date/tell/fwd/key terms:', [w for w in ('date', 'tell', 'fwd', 'brk', 'mfe', 'atr', '"i"') if w in txt])
    print('bars per moment min/max:', min(len(m['bars']) for m in moments), max(len(m['bars']) for m in moments), '| profile bins max', max(len(m['prof']) for m in moments))

if __name__ == '__main__': main()
