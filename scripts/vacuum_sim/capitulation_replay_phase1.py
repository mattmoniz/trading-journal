"""ROW 30 REPLAY, PHASE 1 (outcome-blind). For every setup row of the system in the explore corpus (2023-03-07..2025-05-16) and the 2026 depth-era window (2026-06-15..2026-10-09):
did a same-direction, EXTENDED (E_t in the top tercile of earlier events, expanding window across both corpora) vacuum thrust (ROC10 onset, the live detector's code) occur INSIDE the row's own life (fired_at < thrust bar end <= resolved_at)?
Reads fired_at/resolved_at only; NO P&L and no forward price of any signal. Never touches 2025-05-17..2026-06-14 (sealed) or >= 2026-10-12 (asserted). Rows come from scratch/capitulation_replay_20261109/rows.json
(scripts/vacuum_sim/export_setup_rows_cap_replay.mjs). Usage: ../../venv/bin/python capitulation_replay_phase1.py"""
import os, sys, json, datetime, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import features as Fm, context_exit_phase1 as P1
OUTD = os.path.join(Fm.ROOT, 'scratch', 'capitulation_replay_20261109'); lines = []
def say(s=''): print(s); lines.append(s)

def wall(date, t):
    """ET naive datetime of a bar end: the session of trade date D starts 18:00 ET the previous calendar day; t = seconds since that start."""
    d0 = datetime.datetime.fromisoformat(date) - datetime.timedelta(days=1) + datetime.timedelta(hours=18)
    return d0 + datetime.timedelta(seconds=float(t))

def build_events():
    rf = sorted(p for p in __import__('glob').glob(os.path.join(Fm.BARS, '*.bars.tsv')) if os.path.basename(p)[:10] <= Fm.LAST_EXPLORE)
    e1, s1, _ = P1.run_chain(rf, 'replication'); files, scored68 = P1.primary_files(); e2, s2, _ = P1.run_chain(files, 'primary', scored68)
    for e in e1: e['corpus'] = 'EXPLORE'
    for e in e2: e['corpus'] = 'G2026'
    ev = e1 + e2; P1.classify(ev)
    assert all(e['date'] <= '2026-10-09' and not ('2025-05-17' <= e['date'] <= '2026-06-14') for e in ev)
    say(f'sessions scored: explore {len(s1)} ({s1[0]}..{s1[-1]}), 2026 {len(s2)} ({s2[0]}..{s2[-1]}); events {len(ev)}; flags {dict(collections.Counter(e["flag"] for e in ev))}')
    return ev

def side_of(st): return -1 if '_SHORT' in st else 1

def main():
    ev = build_events(); rows = json.load(open(os.path.join(OUTD, 'rows.json')))
    assert all(r['td'] <= '2026-10-09' and not ('2025-05-17' <= r['td'] <= '2026-06-14') for r in rows)
    byd = {1: [], -1: []}
    for i, e in enumerate(ev): byd[e['dir']].append((wall(e['date'], e['t']), i))
    for d in byd: byd[d].sort()
    import bisect
    keys = {d: [x[0] for x in byd[d]] for d in byd}
    res = []
    for r in rows:
        f = datetime.datetime.fromisoformat(r['f']); rs = datetime.datetime.fromisoformat(r['rs']); d = side_of(r['setup_type'])
        if rs <= f: continue
        life = (rs - f).total_seconds(); lo = bisect.bisect_right(keys[d], f); hi = bisect.bisect_right(keys[d], rs)
        cand = [ev[byd[d][k][1]] | dict(ts=byd[d][k][0]) for k in range(lo, hi)]
        ext = [c for c in cand if c['flag'] == 'EXT']
        rt = 'RTH' if (f.hour * 60 + f.minute >= 570 and f.hour < 16) else 'GLOBEX'
        first = ext[0] if ext else None
        res.append(dict(id=r['id'], bc=r['bet_class'] or 'NULL', corpus='EXPLORE' if r['td'] <= '2025-05-16' else 'G2026', origin=r['origin_status'], rtrack=rt, td=r['td'], life_min=life / 60.0, any=len(cand) > 0, ext=first is not None,
                        frac=((first['ts'] - f).total_seconds() / life) if first else None, left_min=((rs - first['ts']).total_seconds() / 60.0) if first else None, sig=(first['date'], first['t']) if first else None, sigtrack=first['track'] if first else None))
    json.dump(res, open(os.path.join(OUTD, 'replay_phase1_rows.json'), 'w'))
    say(f'\nrows joined {len(res)} (cluster-primary, resolved, ACTIVE/SHADOW/BACKFILL, post-close flood rows excluded); a "signalled" row has >= 1 same-direction EXTENDED vacuum thrust inside (fired_at, resolved_at]')
    say('Floor test (D1 Phase 1): >= 20 independent signalled events on >= 10 days per cell. "indep" = distinct vacuum thrusts (rows sharing a thrust count once).')
    groups = collections.defaultdict(list)
    for x in res:
        groups[(x['bc'], x['corpus'])].append(x); groups[(x['bc'], 'ALL')].append(x); groups[('ALL', x['corpus'])].append(x)
    say(f'\n{"bet_class":24s}{"corpus":9s}{"rows":>6s}{"any":>6s}{"signalled":>10s}{"%":>6s}{"indep":>6s}{"days":>5s}{"top5d%":>7s}{"frac@sig p25/50/75":>22s}{"left_min p25/50/75":>22s}{"floor":>6s}')
    out = []
    for k in sorted(groups, key=lambda k: (-len(groups[k]), k)):
        g = groups[k]
        if len(g) < 30 and k[0] != 'ALL': continue
        s = [x for x in g if x['ext']]; ind = {tuple(x['sig']) for x in s}; days = collections.Counter(x['td'] for x in s)
        top5 = 100 * sum(v for _, v in days.most_common(5)) / max(len(s), 1)
        q = lambda a, p: np.quantile(a, p) if len(a) else float('nan')
        fr = [x['frac'] for x in s]; lm = [x['left_min'] for x in s]
        ok = len(ind) >= 20 and len(days) >= 10
        say(f'{k[0]:24s}{k[1]:9s}{len(g):6d}{sum(x["any"] for x in g):6d}{len(s):10d}{100 * len(s) / len(g):6.1f}{len(ind):6d}{len(days):5d}{top5:7.1f}   {q(fr, .25):.2f}/{q(fr, .5):.2f}/{q(fr, .75):.2f}   {q(lm, .25):6.1f}/{q(lm, .5):6.1f}/{q(lm, .75):6.1f}{"  PASS" if ok else "  below"}')
        out.append(dict(bc=k[0], corpus=k[1], rows=len(g), any=sum(x['any'] for x in g), signalled=len(s), indep=len(ind), days=len(days), top5=top5, floor=ok))
    say('\nBy row track x bet class (ALL corpora): signalled rows / rows')
    for bc in sorted({x['bc'] for x in res}):
        a = [x for x in res if x['bc'] == bc]
        if len(a) < 30: continue
        say(f'  {bc:24s}' + '  '.join(f'{t}: {sum(x["ext"] for x in a if x["rtrack"] == t)}/{sum(1 for x in a if x["rtrack"] == t)}' for t in ('RTH', 'GLOBEX')))
    open(os.path.join(OUTD, 'replay_phase1_output.txt'), 'w').write('\n'.join(lines)); json.dump(out, open(os.path.join(OUTD, 'replay_phase1_summary.json'), 'w'), indent=1)

if __name__ == '__main__': main()
