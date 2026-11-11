"""ROW 30 REPLAY R1 (VALUE_FADE) / R2 (GLOBEX_LEVEL), amendment A5 (docs/CAPITULATION_EXIT_SHADOW_PREREG_20261109.md). EXPLORE LEAD, not a verdict.
d = (virtual exit dollars at the NEXT 500V bar open after the first same-direction EXTENDED thrust strictly inside (fired_at, resolved_at), side*(o_next - price_at_detection)*2 - 2) - actual_pnl (dollars, repo cost $2 = 1.0 pt),
averaged over the SIGNALLED stratum (rows sharing one thrust collapse to one event, cv-025), day-blocked bootstrap, Holm 0.10 over R1+R2. Placebo = RISK-SET: for each signalled row i, control rows j of the same class and row track with no extended
same-direction thrust up to the same elapsed seconds and still open then; same virtual exit at the next 500V open after that moment. Modes: --prep (no P&L read: counts and control availability), --go (reads row_pnl.json; look first).
Windows: explore 2023-03-07..2025-05-16 and 2026-06-15..2026-10-09 only (asserted)."""
import os, sys, json, bisect, datetime, collections, glob
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import features as Fm, context_exit_phase1 as P1
import capitulation_replay_phase1 as C
GO = '--go' in sys.argv; PREP = '--prep' in sys.argv
if GO == PREP: sys.exit('usage: --prep | --go')
ND, SEED_RNG, B, HOLM = 20, 20261109, 4000, 0.10
import capitulation_replay_lib as L_
ev = L_.build_events(); D = L_.D; idx = L_.EventIndex(ev)
rows = json.load(open(os.path.join(D, 'rows.json'))); lv = {r['id']: r for r in json.load(open(os.path.join(D, 'row_levels.json')))}
reopen = L_.reopen
R = []
for r in rows:
    f = datetime.datetime.fromisoformat(r['f']); rs = datetime.datetime.fromisoformat(r['rs']); d = C.side_of(r['setup_type'])
    if rs <= f or r['bet_class'] not in ('VALUE_FADE', 'GLOBEX_LEVEL'): continue
    L = lv.get(r['id'])
    if not L or L['p0'] is None: continue
    cand = idx.window(d, f, rs)          # strictly before resolved_at (A5 item 3)
    ext = [c for c in cand if c['flag'] == 'EXT' and not reopen(c['ts']) and c['o1'] == c['o1']]
    first = ext[0] if ext else None
    R.append(dict(id=r['id'], bc=r['bet_class'], td=r['td'], f=f, rs=rs, side=d, p0=L['p0'], origin=r['origin_status'], corpus='EXPLORE' if r['td'] <= '2025-05-16' else 'G2026',
                  rtrack='RTH' if (f.hour * 60 + f.minute >= 570 and f.hour < 16) else 'GLOBEX', first=first, firstext_time=(ext[0]['ts'] if ext else None)))
tot = collections.Counter((x['bc'], x['corpus'], bool(x['first'])) for x in R)
print('rows', len(R), dict(tot))
rng = np.random.default_rng(SEED_RNG)
sig = [x for x in R if x['first']]
ctrl_n = L_.make_ctrl(idx, sig, R, lambda x: (x['bc'], x['rtrack']), rng, ND, eligible=lambda x, y: y['corpus'] == x['corpus'])
print('signalled rows', len(sig), 'risk-set controls available (min/median/max)', min(ctrl_n), int(np.median(ctrl_n)), max(ctrl_n), 'signalled rows with 0 controls', sum(1 for n in ctrl_n if n == 0))
for bc in ('VALUE_FADE', 'GLOBEX_LEVEL'):
    for co in ('EXPLORE', 'G2026'):
        g = [x for x in sig if x['bc'] == bc and x['corpus'] == co]; ind = {(x['first']['date'], x['first']['t']) for x in g}
        print(f'  {bc:13s}{co:8s} signalled rows {len(g):4d} independent thrusts {len(ind):4d} days {len({x["td"] for x in g}):4d}')
if PREP: sys.exit(0)
# ---------------- --go: reads P&L ----------------
pnl = {r['id']: r['pnl'] for r in json.load(open(os.path.join(D, 'row_pnl.json')))}
sig = [x for x in sig if pnl.get(x['id']) is not None]
bc_ = L_.BarCache(); exit_open = bc_.exit_open
virt = L_.virt
for x in sig:
    x['d'] = virt(x, x['first']['o1']) - pnl[x['id']]; dp = []
    for y, tx in sorted(x['ctrl'], key=lambda c: c[0]['td']):
        px = exit_open(y['td'], tx)
        if px is not None and pnl.get(y['id']) is not None: dp.append(virt(y, px) - pnl[y['id']])
    x['dp'] = float(np.mean(dp)) if dp else None; x['ndp'] = len(dp)
events = L_.events; mean = L_.mean; wins = L_.wins
def dbb(evs, stat, rg): return L_.dbb(evs, rg)
res = {}
print('\n=== MDE (from the SD of d; variance only, printed before the means) ===')
for bc, name in (('VALUE_FADE', 'R1'), ('GLOBEX_LEVEL', 'R2')):
    e = events([x for x in sig if x['bc'] == bc], 'd'); sd = float(np.std([a['v'] for a in e], ddof=1)); n = len(e); mde = 2.49 * sd / np.sqrt(n)
    print(f'{name} {bc}: events {n}, SD(d) {sd:.1f} $, MDE(80% power, one-sided .05, day-clustering ignored) {mde:.1f} $ = {mde/2:.1f} pt = {mde/2/474:.4f} ADR20 (ADR20 ~474 pt); co-025 bar 0.015 ADR20 = 7 pt')
print('\n=== RESULTS (explore lead) ===')
ps = []
for bc, name in (('VALUE_FADE', 'R1'), ('GLOBEX_LEVEL', 'R2')):
    g = [x for x in sig if x['bc'] == bc]; ge = [x for x in g if x['corpus'] == 'EXPLORE']; g26 = [x for x in g if x['corpus'] == 'G2026']
    E = events(ge, 'd'); bt = dbb(E, mean, np.random.default_rng(1)); m = mean(E); p = float((bt <= 0).mean())
    ps.append((name, p))
    vals = np.array([e['v'] for e in E]); infl = np.argsort(-(vals - m)); keep = np.delete(vals, infl[:2]); half = sorted({e['td'] for e in E})[len(E) and 0:]; days = sorted({e['td'] for e in E})
    h1 = [e for e in E if e['td'] <= days[len(days) // 2]]; h2 = [e for e in E if e['td'] > days[len(days) // 2]]
    loo = [mean([e for e in E if e['td'] != d]) for d in days]
    E26 = events(g26, 'd'); m26 = mean(E26) if E26 else float('nan')
    t26 = float('nan')
    if E26:
        b26 = dbb(E26, mean, np.random.default_rng(2)); t26 = m26 / b26.std(ddof=1) if b26.std() > 0 else float('nan')
    # placebo (risk-set): paired difference d_i - placebo_i
    for x in ge: x['pd'] = None if x['dp'] is None else x['d'] - x['dp']
    EP = events(ge, 'pd'); mp = mean(EP) if EP else float('nan'); bp = dbb(EP, mean, np.random.default_rng(3)) if EP else np.array([np.nan])
    print(f'{name} {bc}: EXPLORE events {len(E)} mean d {m:+.2f} $ ({m/2:+.2f} pt) CI90 [{np.quantile(bt, .05):+.2f}, {np.quantile(bt, .95):+.2f}] one-sided p {p:.3f}; winsor5 {wins(vals):+.2f}; drop-top2 {keep.mean():+.2f}; leave-one-day-out min {min(loo):+.2f}; halves {mean(h1):+.2f}/{mean(h2):+.2f}')
    print(f'   2026 stratum events {len(E26)} mean d {m26:+.2f} $, t {t26:.2f}; risk-set placebo paired diff (explore) {mp:+.2f} $ CI90 [{np.nanquantile(bp, .05):+.2f}, {np.nanquantile(bp, .95):+.2f}] on {len(EP)} events; signalled rows with a placebo {sum(1 for x in ge if x["dp"] is not None)}/{len(ge)}')
    # pre-emption buckets and portfolio line
    allrows = [x for x in R if x['bc'] == bc and x['corpus'] == 'EXPLORE']; print(f'   signal rate {len(ge)}/{len(allrows)} = {100*len(ge)/max(len(allrows),1):.1f}%; portfolio impact = rate x mean d = {len(ge)/max(len(allrows),1)*m:+.2f} $/row')
order = sorted(ps, key=lambda t: t[1]); k = len(order)
holm = {}; alive = True
for i, (n, p) in enumerate(order):
    alive = alive and p <= HOLM / (k - i); holm[n] = alive
print('\nHolm 0.10 (one-sided bootstrap p, explore stratum):', {n: (round(p, 3), holm[n]) for n, p in ps}, '\nThis is an EXPLORE LEAD; the gates (winsor, drop-top2, leave-one-day-out, halves, 2026 same sign and t >= 1.0, placebo) decide whether it is a lead; the forward C1/C2 stay the verdict.')
