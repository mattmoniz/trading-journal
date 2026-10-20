"""DESCRIPTIVE (not a test): 2026-10-20 POC-gated (AGREE) roster run-up vs give-back, with real tick order flow (NQZ26.scid).
Per 15-min bucket: price change, total delta, big-order (merged same-side prints <=1 ms apart, >=70 contracts) buy/sell counts and net, and the roster's closed P&L.
Roster rows come from scratch/roster_20261020.json (scratch/dump_roster_1020.mjs). Today's session is partial; nothing here is a pre-registered result."""
import sys, os, json, csv, collections, datetime
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'tick_microstructure'))
import extract_cells_20261020 as E
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
D = '2026-10-20'; BIG = 70
(cells, orders), tot = E.cells_for_path('/mnt/c/SierraChart-DTC/Data/NQZ26.scid', D, keep_all=True)
orders = [o for o in orders if o[2] >= BIG]                      # [side, ET sec of day, size, price*size, nprints, ts_utc]
permin = collections.defaultdict(lambda: [0, 0, 0])
for (m, p), v in cells.items(): permin[m][0] += v[0]; permin[m][1] += v[1]; permin[m][2] += v[2]       # total, bid(aggressive sell), ask(aggressive buy)
close = {}
for row in csv.reader(open('/mnt/c/SierraChart-DTC/Data/NQZ26-BarData.txt')):
    if row[0].strip() == D.replace('-0', '-') or row[0].strip() == D:
        t = row[1].strip(); close[int(t[:2]) * 60 + int(t[3:5])] = float(row[5])
roster = json.load(open(os.path.join(ROOT, 'scratch', 'roster_20261020.json')))
def sec(t): h, m, s = map(int, t.split(':')); return h * 3600 + m * 60 + s
last_min = max(permin); print('ticks through', last_min // 60, last_min % 60, 'ET; RTH volume so far', tot, '; big orders (>=%d):' % BIG, len(orders))
def window(a, b):                                  # minutes [a, b)
    tv = sum(permin[m][0] for m in range(a, b) if m in permin); bid = sum(permin[m][1] for m in range(a, b) if m in permin); ask = sum(permin[m][2] for m in range(a, b) if m in permin)
    ob = [o for o in orders if a * 60 <= o[1] < b * 60]; bb = [o for o in ob if o[0][0] == 'B']; bs = [o for o in ob if o[0][0] == 'S']
    c0 = close.get(a - 1) or close.get(a); c1 = close.get(b - 1)
    return dict(dpx=(c1 - c0) if c0 and c1 else None, vol=tv, delta=ask - bid, nbuy=len(bb), nsell=len(bs), bigbuy=sum(o[2] for o in bb), bigsell=sum(o[2] for o in bs), bigshare=(sum(o[2] for o in ob) / tv if tv else 0))
def pnl(a, b, agree=True): return sum(x['pnl'] for x in roster if a * 60 <= sec(x['r']) < b * 60 and (x['g']['agree'] == agree))       # closed P&L by RESOLVE time (how the live P&L curve moved)
def n(a, b, agree=True): return sum(1 for x in roster if a * 60 <= sec(x['r']) < b * 60 and (x['g']['agree'] == agree))
print('\n15-min buckets (ET): price chg | total delta | big buys/sells (count) | big net vol | big share of vol | AGREE roster: trades closed, closed P&L (by RESOLVE time)')
cum = 0
for a in range(570, last_min + 1, 15):
    b = min(a + 15, last_min + 1); w = window(a, b); p = pnl(a, b); cum += p
    print(f"{a // 60}:{a % 60:02d}  dpx {'n/a' if w['dpx'] is None else round(w['dpx'], 1):>7}  delta {w['delta']:>7}  big {w['nbuy']:>2}/{w['nsell']:<2}  bignet {w['bigbuy'] - w['bigsell']:>6}  share {w['bigshare']:.2f}  | AGREE n {n(a, b):>2} pnl {p:>8.0f} cum {cum:>7.0f}")
print('\nPhase comparison:')
for nm, a, b in (('run-up 9:30-10:22', 570, 622), ('give-back 10:22-13:20', 622, 800), ('after 13:20', 800, last_min + 1)):
    w = window(a, b); mins = b - a
    print(f"{nm}: price {w['dpx']}, delta {w['delta']} ({w['delta'] / mins:.1f}/min), big buys {w['nbuy']} sells {w['nsell']}, big net {w['bigbuy'] - w['bigsell']} ({(w['bigbuy'] - w['bigsell']) / mins:.1f}/min), big share {w['bigshare']:.2f} | AGREE closed {n(a, b)} trades, P&L {pnl(a, b):.0f}; DISAGREE closed {n(a, b, False)}, P&L {pnl(a, b, False):.0f}")
print('\nAGREE trades by fire time: direction-aligned big-order net volume in the 15 minutes BEFORE the fire (positive = big orders were on our side)')
rows = []
for x in roster:
    if not x['g']['agree']: continue
    f = sec(x['f']); a = (f - 900); long = x['g']['tradeDirection'] == 'LONG'
    ob = [o for o in orders if a <= o[1] < f]; net = sum(o[2] if o[0][0] == 'B' else -o[2] for o in ob) * (1 if long else -1)
    mb = int(f // 60) ; d15 = sum(permin[m][2] - permin[m][1] for m in range(mb - 15, mb) if m in permin) * (1 if long else -1)
    rows.append((f, x['st'], long, x['pnl'], net, d15))
def summ(nm, R):
    if not R: print(nm, 'none'); return
    w = [r for r in R if r[3] > 0]; l = [r for r in R if r[3] < 0]; m = lambda A, k: sum(r[k] for r in A) / len(A) if A else float('nan')
    print(f"{nm}: n {len(R)} pnl {sum(r[3] for r in R):.0f} | winners n {len(w)}: aligned big net {m(w, 4):.0f}, aligned total delta {m(w, 5):.0f} | losers n {len(l)}: aligned big net {m(l, 4):.0f}, aligned total delta {m(l, 5):.0f}")
summ('AGREE before 10:22', [r for r in rows if r[0] < 622 * 60]); summ('AGREE 10:22-13:20', [r for r in rows if 622 * 60 <= r[0] < 800 * 60]); summ('AGREE after 13:20', [r for r in rows if r[0] >= 800 * 60])
