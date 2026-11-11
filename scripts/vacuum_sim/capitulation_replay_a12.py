"""ROW 30 A12 (docs/CAPITULATION_PROTECTED_ARM_PREREG_20261109.md): protected hold P0 (stop to breakeven when the row's own t1 is reached, no target, to expiry) and HP (P0 plus exit at the first extended same-direction thrust).
Counted (family of 2, Holm 0.10) on W1 = the 2026 real rows: P_R2_RTH and P_R1_RTH = ITT mean HP - A over ALL RTH-fired boundary / pivot rows with a valid t1. W2 = 2023-25 BACKFILL (A synthetic) replication. Roll / stitching rows excluded (A10.4).
Modes: --prep (price paths only, no P&L read) | --go (look 'cap_a12_register_20261109')."""
import os, sys, json, datetime, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import capitulation_replay_lib as L_
GO = '--go' in sys.argv; PREP = '--prep' in sys.argv
if GO == PREP: sys.exit('usage: --prep | --go')
ev = L_.build_events(); D = L_.D; idx = L_.EventIndex(ev); virt = L_.virt
CFG = [('W1 2026 real rows', 'a6_rows.json', 'a10_tags.json', 'a10_minute_bars.tsv', 'a6_pnl.json', datetime.datetime(2026, 10, 9, 23, 59)),
       ('W2 2023-25 BACKFILL', 'a11_rows.json', 'a11_tags.json', 'a11_minute_bars.tsv', 'a11_pnl.json', datetime.datetime(2025, 5, 16, 23, 59))]
def boot(vals, days, B=4000, seed=21):
    rg = np.random.default_rng(seed); ud = sorted(set(days)); by = {d: [v for v, dd in zip(vals, days) if dd == d] for d in ud}; out = []
    for _ in range(B):
        pick = rg.choice(len(ud), size=len(ud)); out.append(np.mean([v for i in pick for v in by[ud[i]]]))
    return np.array(out)
def trimmed(v, p=.25): a = np.sort(v); k = int(len(a) * p); return float(np.mean(a[k:len(a) - k])) if len(a) - 2 * k > 0 else float(np.mean(a))
def drop_best(vals, days): bd = max(set(days), key=lambda d: sum(v for v, dd in zip(vals, days) if dd == d)); return float(np.mean([v for v, dd in zip(vals, days) if dd != bd]))
def build(name, rows_f, tags_f, tsv, pnl_f, end):
    rows = json.load(open(os.path.join(D, rows_f))); tags = json.load(open(os.path.join(D, tags_f))); sim = L_.HoldSim(os.path.join(D, tsv)); skip = L_.roll_skip_dates(os.path.join(D, tsv))
    if name.startswith('W2'): rows = [r for r in rows]
    R, drop = L_.build_hold_rows(idx, rows, tags, sim, end=end, skip=skip); out = []; bad = 0
    for x in R:
        if x['t1'] is None or x['side'] * (x['t1'] - x['p0']) <= 0 or not x['adr']: bad += 1; continue
        s = sim.prot(x['f'], x['side'], x['p0'], x['stp'], x['exp'], x['t1'])
        if s is None: bad += 1; continue
        kind, tp, ppx, armed = s; x['pkind'] = kind; x['armed'] = armed; x['ptime'] = tp; x['ppx'] = ppx
        cand = idx.window(x['side'], x['f'], tp); ext = [c for c in cand if c['flag'] == 'EXT' and not L_.reopen(c['ts']) and c['o1'] == c['o1']]; x['firstP'] = ext[0] if ext else None
        out.append(x)
    pnl = {r['id']: r['pnl'] for r in json.load(open(os.path.join(D, pnl_f)))} if GO else {}
    return out, sim, bad, drop, pnl
def arms(x, pnl):
    x['A'] = pnl.get(x['id']); x['C0'] = virt(x, x['c0px']); x['P0'] = virt(x, x['ppx']); x['H'] = virt(x, x['first']['o1']) if x['first'] else x['C0']
    x['HP'] = virt(x, x['firstP']['o1']) if x['firstP'] else x['P0']
S = [('R2_RTH', lambda x: x['b'] and x['rtrack'] == 'RTH'), ('R1_RTH', lambda x: x['p'] and x['rtrack'] == 'RTH'), ('R2_GBX', lambda x: x['b'] and x['rtrack'] == 'GBX'), ('R1_GBX', lambda x: x['p'] and x['rtrack'] == 'GBX'),
     ('untagged RTH', lambda x: not x['p'] and not x['b'] and x['rtrack'] == 'RTH'), ('untagged GBX', lambda x: not x['p'] and not x['b'] and x['rtrack'] == 'GBX'), ('ALL RTH', lambda x: x['rtrack'] == 'RTH'), ('ALL', lambda x: True)]
DATA = {}
for name, rf, tf, tsv, pf, end in CFG:
    R, sim, bad, drop, pnl = build(name, rf, tf, tsv, pf, end); DATA[name] = (R, sim, pnl)
    print(f'\n##### {name}: rows with a valid t1 {len(R)} (no usable t1 / path {bad}; dropped by A10.4 etc. {dict(drop)})')
    print(f'  P0 exits: {dict(collections.Counter(x["pkind"] for x in R))}; armed (target reached) {sum(x["armed"] for x in R)} = {100*sum(x["armed"] for x in R)/max(len(R),1):.1f}%; extended thrust before the P0 exit {sum(1 for x in R if x["firstP"])}')
    for nm, f in S[:4]:
        g = [x for x in R if f(x)]; print(f'  {nm:14s} rows {len(g):5d} days {len({x["td"] for x in g}):4d} armed {sum(x["armed"] for x in g):4d} thrust-before-exit {sum(1 for x in g if x["firstP"]):4d}')
if PREP: sys.exit(0)
bc_ = L_.BarCache(); res = {}
def itt(g, a, b):
    return [x[a] - x[b] for x in g]
for name in DATA:
    R, sim, pnl = DATA[name]
    for x in R: arms(x, pnl)
    DATA[name] = ([x for x in R if x['A'] is not None], sim, pnl)
def static_T(R, sim, f):
    """walk-forward static target: median excursion (ADR20 units) of strictly earlier days' HP exits of the stratum, >= 10 earlier; T = original stop + that target, expiry otherwise"""
    g = sorted([x for x in R if f(x)], key=lambda x: x['td']); exc = [(x['td'], x['side'] * ((x['firstP']['o1'] if x['firstP'] else x['ppx']) - x['p0']) / x['adr']) for x in g]; used = []
    for x in g:
        e = [v for d, v in exc if d < x['td']]
        if len(e) < 10: continue
        s = sim.c0(x['f'], x['side'], x['p0'], x['stp'], x['exp'], tgt=x['p0'] + x['side'] * float(np.median(e)) * x['adr'])
        if s is None: continue
        x['T'] = virt(x, s[2]); used.append(x)
    return used
print('\n=== MDE (W1, ITT HP - A) ===')
R, sim, pnl = DATA['W1 2026 real rows']
for nm, f in S[:2]:
    v = itt([x for x in R if f(x)], 'HP', 'A')
    if len(v) > 3: sd = float(np.std(v, ddof=1)); mde = 2.49 * sd / np.sqrt(len(v)); print(f'P_{nm}: rows {len(v)}, SD {sd:.1f} $, MDE (row level, day clustering ignored) {mde:.1f} $ = {mde/2:.1f} pt = {mde/2/474:.4f} ADR20')
def lead(R, sim, f, floor_rows=100, floor_days=40, label=''):
    g = [x for x in R if f(x)]; v = itt(g, 'HP', 'A'); days = [x['td'] for x in g]
    if len(v) < 5: print(f'  {label}: too few rows'); return None
    bt = boot(v, days); m = float(np.mean(v)); p = float((bt <= 0).mean()); fl = len(v) >= floor_rows and len(set(days)) >= floor_days; tm = trimmed(v); db = drop_best(v, days)
    used = static_T(R, sim, f); hpt = float(np.mean([x['HP'] - x['T'] for x in used])) if used else float('nan')
    gates = dict(lower_bound=bool(np.quantile(bt, .05) > 0), trimmed=bool(tm > 0), drop_best_day=bool(db > 0), beats_static_target=bool(hpt > 0))
    print(f'  {label}: rows {len(v)} days {len(set(days))} ITT HP - A {m:+.1f} $ CI90 [{np.quantile(bt, .05):+.1f}, {np.quantile(bt, .95):+.1f}] p {p:.3f}{"" if fl else "  (BELOW FLOOR 100 rows / 40 days)"}; trimmed25 {tm:+.1f}; drop best day {db:+.1f}; HP - T (static target, {len(used)} rows) {hpt:+.1f}; gates {gates}')
    return p, fl, all(gates.values()), gates
print('\n=== COUNTED (W1), family of 2 ===')
ps = []
for nm, f in S[:2]:
    r = lead(R, sim, f, label=f'P_{nm}')
    ps.append((f'P_{nm}',) + (r[:3] if r else (1.0, False, False)))
order = sorted(ps, key=lambda t: t[1]); alive = True; ok = {}
for i, (n, p, fl, g) in enumerate(order): alive = alive and fl and p <= 0.10 / (len(order) - i); ok[n] = alive and g
print('Holm 0.10 then gates:', {n: dict(p=round(p, 3), floor=fl, gates=g, LEAD=ok[n]) for n, p, fl, g in ps})
print('\n=== W2 replication (A synthetic): same statistics, same gates; REPLICATES = same sign, lower bound > 0, trimmed > 0 ===')
R2, sim2, pnl2 = DATA['W2 2023-25 BACKFILL']
for nm, f in S[:2]:
    g = [x for x in R2 if f(x)]; v = itt(g, 'HP', 'A'); days = [x['td'] for x in g]
    if len(v) < 5: print(f'  P_{nm}: too few rows'); continue
    bt = boot(v, days); print(f'  P_{nm}: rows {len(v)} days {len(set(days))} ITT HP - A {np.mean(v):+.1f} CI90 [{np.quantile(bt, .05):+.1f}, {np.quantile(bt, .95):+.1f}] p {float((bt <= 0).mean()):.3f}; trimmed25 {trimmed(v):+.1f}; REPLICATES {bool(np.mean(v) > 0 and np.quantile(bt, .05) > 0 and trimmed(v) > 0)}')
print('\n=== DESCRIPTIVE ITT tables (mean per row, dollars) ===')
for name in DATA:
    Rr = DATA[name][0]; print(f'\n{name}'); print(f'{"stratum":14s}{"rows":>6s}{"armed":>6s}{"A":>8s}{"C0":>8s}{"P0":>8s}{"H":>8s}{"HP":>8s}   {"HP - A [CI90]":>24s}   {"HP - H":>8s}{"P0 - C0":>9s}{"P0 - A":>8s}')
    for nm, f in S:
        g = [x for x in Rr if f(x)]
        if len(g) < 5: continue
        days = [x['td'] for x in g]; ha = itt(g, 'HP', 'A'); b = boot(ha, days, 1500)
        print(f'{nm:14s}{len(g):6d}{sum(x["armed"] for x in g):6d}{np.mean([x["A"] for x in g]):8.1f}{np.mean([x["C0"] for x in g]):8.1f}{np.mean([x["P0"] for x in g]):8.1f}{np.mean([x["H"] for x in g]):8.1f}{np.mean([x["HP"] for x in g]):8.1f}   {np.mean(ha):+8.1f} [{np.quantile(b,.05):+7.1f},{np.quantile(b,.95):+7.1f}]   {np.mean(itt(g,"HP","H")):+8.1f}{np.mean(itt(g,"P0","C0")):+9.1f}{np.mean(itt(g,"P0","A")):+8.1f}')
