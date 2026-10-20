"""Nightly forward-test tick extraction for one completed RTH session (read-only on the Sierra files).
Usage: extract_forward_day.py DATE DB_RTH_VOLUME   -> writes scratch/forward_ticks/{orders,stuffed,persec}/DATE.tsv in the SAME formats as the 2023-2026 archives
(orders: side t0 size vwap prints, merged same-side prints <= 1 ms, size >= 70; stuffed: see extract_stuffed_20261020.py; persec: second buy_aggr sell_aggr).
The tick file is chosen among the live Sierra files (NQ[HMUZ]yy.scid in the DTC install, plus the older NQ[HMUZ]y.CME.scid names in both installs) as the one whose RTH volume matches DB_RTH_VOLUME within 3 percent; if none does, nothing is written and the exit code is 3 (the monitor then excludes that day from the tick-based rules and says so).
Prices are corrected when a file stores them at 1/100."""
import sys, os, glob, json
sys.path.insert(0, os.path.dirname(__file__))
import extract_stuffed_20261020 as X
ROOT = X.ROOT; FWD = os.path.join(ROOT, 'scratch', 'forward_ticks')
def candidates():
    bases = ['/mnt/c/SierraChart-DTC/Data', '/mnt/c/SierraChart/Data']; out = []
    for b in bases:
        for p in glob.glob(f'{b}/NQ[HMUZ][0-9][0-9].scid') + glob.glob(f'{b}/NQ[HMUZ][0-9].CME.scid'): out.append((os.path.getmtime(p), p))
    return [p for _, p in sorted(out, reverse=True)]
def orders_rows(tk, size=70):
    rows = []; cur = None
    for s, px, sz, ag, u in tk:
        if cur is not None and ag == cur[0] and ag in ('BUY', 'SELL') and (u - cur[5]).total_seconds() * 1e6 <= 1000:
            cur[2] += sz; cur[3] += px * sz; cur[4] += 1; cur[5] = u
        else:
            if cur is not None and cur[2] >= size: rows.append(cur)
            cur = [ag, s, sz, px * sz, 1, u]
    if cur is not None and cur[2] >= size: rows.append(cur)
    return [[o[0][0], f'{o[1]:.3f}', o[2], f'{o[3] / o[2]:.2f}', o[4]] for o in rows]
def persec_rows(tk):
    agg = {}
    for s, px, sz, ag, u in tk:
        i = int(s); c = agg.get(i) or agg.setdefault(i, [0, 0])
        if ag == 'BUY': c[0] += sz
        elif ag == 'SELL': c[1] += sz
    return [[i, agg[i][0], agg[i][1]] for i in sorted(agg)]
def write(kind, d, rows):
    os.makedirs(os.path.join(FWD, kind), exist_ok=True); fp = os.path.join(FWD, kind, d + '.tsv')
    with open(fp + '.tmp', 'w') as f:
        for r in rows: f.write('\t'.join(str(x) for x in r) + '\n')
    os.replace(fp + '.tmp', fp)
if __name__ == '__main__':
    d, dbvol = sys.argv[1], float(sys.argv[2]); chosen = None; seen = []
    for p in candidates():
        try: tk = X.ticks_for(p, d)
        except Exception as e: seen.append((os.path.basename(p), 'ERR ' + str(e))); continue
        tot = sum(x[2] for x in tk); seen.append((os.path.basename(p), tot))
        if dbvol > 0 and tk and abs(tot - dbvol) <= 0.03 * dbvol: chosen = (p, tk); break
    if chosen is None: print(json.dumps({'date': d, 'ok': False, 'dbvol': dbvol, 'tried': seen})); sys.exit(3)
    p, tk = chosen; write('orders', d, orders_rows(tk)); write('stuffed', d, X.stuffed_rows(tk)); write('persec', d, persec_rows(tk))
    print(json.dumps({'date': d, 'ok': True, 'file': os.path.basename(p), 'ticks': len(tk), 'volume': sum(x[2] for x in tk), 'dbvol': dbvol}))
