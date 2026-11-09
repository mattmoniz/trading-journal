import sys, json, datetime, collections
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_tell_live'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/tick_microstructure'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_vbars')
import numpy as np, tailer, session
D = '2026-11-03'; dd = datetime.date.fromisoformat(D)
ls = session.LiveSession(D, 'split', [])
tl = tailer.ScidTailer('/mnt/c/SierraChart-DTC/Data/NQZ26.scid', from_date=dd - datetime.timedelta(days=1))
while True:
    chunk = tl.poll(max_records=200000)
    if not chunk and tl.backlog_bytes() == 0: break
    for t in chunk: ls.feed_trade(t)
ls.finish_scale_detection()
G = collections.defaultdict(float); R = collections.defaultdict(float)
for b in ls.sb.done:
    tgt = G if b['end'] < 55800 else R
    for px, v in b['vap'].items(): tgt[round(px)] += v[0]          # whole-point bins
def va(P, frac=0.70):
    ks = sorted(P); arr = np.array([P[k] for k in ks]); poc = int(arr.argmax()); tot = arr.sum(); lo = hi = poc; got = arr[poc]
    while got < frac * tot:
        up = arr[hi + 1] + (arr[hi + 2] if hi + 2 < len(arr) else 0) if hi + 1 < len(arr) else -1
        dn = arr[lo - 1] + (arr[lo - 2] if lo - 2 >= 0 else 0) if lo - 1 >= 0 else -1
        if up >= dn and hi + 1 < len(arr): hi += 1; got += arr[hi]
        elif lo - 1 >= 0: lo -= 1; got += arr[lo]
        else: break
    return ks[poc], ks[lo], ks[hi], ks[0], ks[-1], tot
for n, P in (('GLOBEX', G), ('RTH', R)):
    poc, val, vah, lo, hi, tot = va(P); print(n, 'POC', poc, 'VAL', val, 'VAH', vah, 'range', lo, hi, 'contracts', int(tot))
# volume by whole point between the two value areas
allk = range(28240, 28400, 5)
print('pt  globex  rth')
for k in range(28250, 28400, 5):
    g = sum(G.get(x, 0) for x in range(k, k + 5)); r = sum(R.get(x, 0) for x in range(k, k + 5)); print(k, int(g), int(r))
json.dump(dict(G={int(k): v for k, v in G.items()}, R={int(k): v for k, v in R.items()}), open(sys.argv[1], 'w'))
