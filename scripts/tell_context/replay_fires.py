"""Replay one session's ticks into 500-contract bars (the tell's own builder) and print the context at the given fires.
Usage: replay_fires.py DATE SEC:DIR:ENTRY [SEC:DIR:ENTRY ...]   (SEC = signal-bar end in seconds since the 18:00 open, DIR = 1 or -1). Read-only; run with ulimit -v (hr-028)."""
import sys, os, json, datetime
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(ROOT, 'amt_tell_live')); sys.path.insert(0, os.path.join(ROOT, 'tick_microstructure')); sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, tailer, session
from context import context_at_fire


def bars_for(d, rule='split', path='/mnt/c/SierraChart-DTC/Data/NQZ26.scid'):
    dd = datetime.date.fromisoformat(d); ls = session.LiveSession(d, rule, [])
    tl = tailer.ScidTailer(path, from_date=dd - datetime.timedelta(days=1))
    while True:
        ch = tl.poll(max_records=200000)
        if not ch and tl.backlog_bytes() == 0: break
        for t in ch: ls.feed_trade(t)
    ls.finish_scale_detection(); return ls.sb.done


if __name__ == '__main__':
    d = sys.argv[1]; B = bars_for(d); end = np.array([b['end'] for b in B])
    for spec in sys.argv[2:]:
        sec, dr, entry = spec.split(':'); sec, dr, entry = float(sec), int(dr), float(entry)
        i = int(np.searchsorted(end, sec - 0.005, side='left')); bars = [dict(end=b['end'], h=b['h'], l=b['l'], c=b['c'], vap=b['vap']) for b in B[:i + 1]]
        print(json.dumps(context_at_fire(bars, entry, dr), default=lambda x: x.item() if hasattr(x, 'item') else str(x)))
