"""Row 46 PHASE 1 (outcome-blind COUNTS only): how many tell runners (reached a gate of x ADR20) would carry a flow-exhaustion trigger (Argon CTAPE, rolling-percentile version)?
Reads the stored V1 MFE (no P&L), the 500V bars (columns bid/ask as Fm.load_full names them). Trigger events counted from the first bar the open excursion reaches the gate, up to 60 bars (an UPPER BOUND: the V1 exit bar is not stored).
Trigger at completed bar t: opposing net delta over bars t-2..t (trade direction D; delta = ask - bid) >= rolling q-percentile of the same quantity over the previous 5 sessions' bars, AND D*(C_t - C_{t-3}) <= 0, AND bar duration >= rolling 75th percentile of duration over the same 5 sessions.
Usage: ulimit -v 3000000; python3 scripts/vacuum_sim/runner_flow_count.py"""
import os, sys, csv, glob, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import globex_roc3_test as G
Fm = G.Fm
adr = {r['date']: float(r['adr20']) for r in csv.DictReader(open(os.path.join(G.ROOT, 'scratch', 'globex_roc3_20261110', 'events.csv'))) if r['adr20'] not in ('', 'nan')}
T = [r for r in csv.DictReader(open(os.path.join(G.ROOT, 'scratch', 'tell_context_20261103', 'tell_floor_target_rows.csv'))) if r['date'] in adr and r['v1_mfe'] not in ('', 'nan')]
print(f'tell explore entries with an ADR20 and a stored MFE: {len(T)} on {len({r["date"] for r in T})} days')
GATES = (0.15, 0.25, 0.35, 0.50)
for g in GATES:
    s = [r for r in T if float(r['v1_mfe']) >= g * adr[r['date']]]
    print(f'  reach {g:.2f} ADR20: {len(s)} trades ({len(s) / len(T):.0%}) on {len({r["date"] for r in s})} days')
files = sorted(p for p in glob.glob(os.path.join(Fm.BARS, '*.bars.tsv')) if os.path.basename(p)[:10] <= Fm.LAST_EXPLORE)
idx = {os.path.basename(p)[:10]: k for k, p in enumerate(files)}; cache = {}
def sess(k):
    if k not in cache:
        S = Fm.load_full(files[k]); cache[k] = S
        for old in [x for x in cache if x < k - 8]: del cache[old]
    return cache[k]
def opp3(S, d):
    dl = S['ask'] - S['bid']; x = np.maximum(0.0, -d * dl); return np.convolve(x, np.ones(3), 'valid')   # value i is bars i..i+2
cnt = collections.defaultdict(lambda: [0, set()]); matched = 0; unmatched = 0
for r in T:
    d = int(r['dir']); date = r['date']; k = idx.get(date)
    if k is None or k < 5: continue
    S = sess(k)
    if S is None: continue
    j = np.where(np.abs(S['st'] - float(r['ehr'])) < 1.0)[0]
    if len(j) == 0: unmatched += 1; continue
    ei = int(j[0]); matched += 1; entry = float(S['o'][ei]); mfe = float(r['v1_mfe'])
    prior = [sess(q) for q in range(k - 5, k)]; prior = [p for p in prior if p is not None]
    if not prior: continue
    pop = np.concatenate([opp3(p, d) for p in prior]); pdur = np.concatenate([p['en'] - p['st'] for p in prior])
    dcut = float(np.percentile(pdur, 75)); o3 = opp3(S, d); n = len(S['c'])
    for q in (80, 90):
        oc = float(np.percentile(pop, q))
        for g in (0.25, 0.35):
            if mfe < g * adr[date]: continue
            reach = next((t for t in range(ei, n) if d * (S['c'][t] - entry) >= g * adr[date]), None)
            if reach is None: continue
            for t in range(max(reach, ei + 3), min(reach + 60, n)):
                if o3[t - 2] >= oc and d * (S['c'][t] - S['c'][t - 3]) <= 0 and (S['en'][t] - S['st'][t]) >= dcut:
                    cnt[(q, g)][0] += 1; cnt[(q, g)][1].add(date); break
print(f'\nbar match for the entry bar: matched {matched}, unmatched {unmatched}')
print('trades with >= 1 trigger after reaching the gate (upper bound), by (opposing-delta percentile, runner gate):')
for key in sorted(cnt): print(f'  pct {key[0]}, gate {key[1]:.2f} ADR20: {cnt[key][0]} trades on {len(cnt[key][1])} days  (power gate: >= 100 events on >= 60 days)')
