"""ROW 34 PHASE 1 (outcome-blind; look 224). Per bet class x row track: share of rows with a same-direction ANY / EXTENDED vacuum thrust inside (fired_at, resolved_at], independent first thrusts, days, top-5-day share,
share of the life elapsed at the first thrust, and the geometry a thrust-bar entry would face: distance fired-entry -> thrust-bar close in ADR20 units, and the share already at/through the row's t1 or past its stop at that close (an entry there with the old levels is not tradable).
Reads fired_at/resolved_at, price_at_detection/stop_level/t1_level and bar closes only: NO P&L, no resolution price. Sealed windows asserted untouched by the builders. Usage: ../../venv/bin/python row34_phase1.py"""
import os, sys, json, bisect, datetime, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import features as Fm, context_exit_phase1 as P1
import capitulation_replay_phase1 as C
import capitulation_replay_lib as L_
ev = L_.build_events(); D = C.OUTD
rows = json.load(open(os.path.join(D, 'rows.json'))); lv = {r['id']: r for r in json.load(open(os.path.join(D, 'row_levels.json')))}
byd = {1: [], -1: []}
for i, e in enumerate(ev): byd[e['dir']].append((C.wall(e['date'], e['t']), i))
for d in byd: byd[d].sort()
keys = {d: [x[0] for x in byd[d]] for d in byd}
lines = []
def say(s=''): print(s); lines.append(s)
res = []
for r in rows:
    f = datetime.datetime.fromisoformat(r['f']); rs = datetime.datetime.fromisoformat(r['rs']); d = C.side_of(r['setup_type'])
    if rs <= f: continue
    life = (rs - f).total_seconds(); lo = bisect.bisect_right(keys[d], f); hi = bisect.bisect_right(keys[d], rs)
    cand = [ev[byd[d][k][1]] | dict(ts=byd[d][k][0]) for k in range(lo, hi)]
    tr = 'RTH' if (f.hour * 60 + f.minute >= 570 and f.hour < 16) else 'GLOBEX'
    L = lv.get(r['id']); out = dict(id=r['id'], bc=r['bet_class'] or 'NULL', corpus='EXPLORE' if r['td'] <= '2025-05-16' else 'G2026', rtrack=tr, td=r['td'], origin=r['origin_status'])
    for kind in ('any', 'ext'):
        c = [x for x in cand if (kind == 'any' or x['flag'] == 'EXT')]
        if not c: out[kind] = None; continue
        x = c[0]; g = None
        if L and None not in (L['p0'], L['stp'], L['t1']):
            tgt = d * (L['t1'] - L['p0']); stp = d * (L['p0'] - L['stp']); mv = d * (x['c'] - L['p0'])
            if tgt > 0 and stp > 0 and x.get('adr') and x['adr'] > 0: g = dict(mv_adr=mv / x['adr'], prog=mv / tgt, thru_t1=mv >= tgt, past_stop=mv <= -stp)
        out[kind] = dict(id=(x['date'], x['t']), frac=(x['ts'] - f).total_seconds() / life, left_min=(rs - x['ts']).total_seconds() / 60.0, geo=g)
    res.append(out)
json.dump(res, open(os.path.join(D, 'row34_phase1_rows.json'), 'w'))
say(f'rows {len(res)} (cluster-primary, resolved, ACTIVE/SHADOW/BACKFILL, post-close flood rows excluded). "indep" = distinct first thrusts. Floor: >= 20 independent on >= 10 days.')
q = lambda a, p: float(np.quantile(a, p)) if len(a) else float('nan')
def block(kind):
    say(f'\n=== {kind.upper()} thrust ===')
    say(f'{"bet_class":22s}{"track":7s}{"corpus":9s}{"rows":>6s}{"thr":>6s}{"%":>6s}{"indep":>6s}{"days":>5s}{"top5d%":>7s}{"frac p50":>9s}{"|mv|ADR p50":>12s}{"thru t1%":>9s}{"past stp%":>10s}{"geo N":>6s}{"floor":>7s}')
    for bc in ('VALUE_FADE', 'GLOBEX_LEVEL', 'CONTINUATION_LEGACY', 'FAILED_SWEEP_REVERSAL'):
        for tr in ('RTH', 'GLOBEX', 'ALL'):
            for co in ('ALL', 'EXPLORE', 'G2026'):
                g = [x for x in res if x['bc'] == bc and (tr == 'ALL' or x['rtrack'] == tr) and (co == 'ALL' or x['corpus'] == co)]
                if len(g) < 30: continue
                s = [x for x in g if x[kind]]; ind = {x[kind]['id'] for x in s}; days = collections.Counter(x['td'] for x in s)
                top5 = 100 * sum(v for _, v in days.most_common(5)) / max(len(s), 1)
                geo = [x[kind]['geo'] for x in s if x[kind]['geo']]
                ok = len(ind) >= 20 and len(days) >= 10
                say(f'{bc:22s}{tr:7s}{co:9s}{len(g):6d}{len(s):6d}{100*len(s)/len(g):6.1f}{len(ind):6d}{len(days):5d}{top5:7.1f}{q([x[kind]["frac"] for x in s], .5):9.2f}{q([abs(y["mv_adr"]) for y in geo], .5):12.3f}{100*np.mean([y["thru_t1"] for y in geo]) if geo else float("nan"):9.1f}{100*np.mean([y["past_stop"] for y in geo]) if geo else float("nan"):10.1f}{len(geo):6d}{"  PASS" if ok else "  below":>7s}')
block('any'); block('ext')
open(os.path.join(D, 'row34_phase1_output.txt'), 'w').write('\n'.join(lines))
