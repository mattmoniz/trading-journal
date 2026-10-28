"""500-contract volume-bar builder, incremental. SINGLE source of the bar rule for both the batch extractor (scripts/tick_microstructure/extract_volbars_20261028.py) and the live tell detector.
The rule is the research rule (docs/AMT_TELL_LIVE_PROJECT_SPEC_20261028.md section 3): one session = 18:00 ET of the previous calendar day through 17:00 ET of the trade date; bars close at EXACTLY 500
contracts and a trade that overflows is SPLIT (the remainder opens the next bar and keeps the trade's aggressor side) -- overflow='split' -- or, for the Stage-0 sensitivity reading, kept whole in the closing bar -- overflow='whole'.
The first bar starts at the session's first trade, the last bar of a finished session is partial. start/end are seconds since the 18:00 open (RTH open = 55800)."""
import collections
import numpy as np

VB = 500
TICK = 0.25


def session_sec(ts_et, dd):
    """Seconds since the 18:00 ET open of trade date dd for a tick at ts_et (a datetime in America/New_York), or None when the tick is outside session dd
    (the session is the previous calendar day from 18:00 through the trade date's 17:00). Wall-clock arithmetic exactly as the research extractor did it."""
    m = ts_et.hour * 60 + ts_et.minute
    dts = ts_et.date()
    prev_ord = dd.toordinal() - 1
    if dts.toordinal() == prev_ord and m >= 1080: return (ts_et.hour * 3600 + ts_et.minute * 60 + ts_et.second + ts_et.microsecond / 1e6) - 64800
    if dts == dd and m < 1020: return 86400 - 64800 + ts_et.hour * 3600 + ts_et.minute * 60 + ts_et.second + ts_et.microsecond / 1e6      # microseconds added last, as the batch extractor did
    return None


def _new_bar(sec):
    return dict(start=sec, end=sec, o=None, h=-1e18, l=1e18, c=None, v=0, bid=0.0, ask=0.0, n=0, vap=collections.defaultdict(lambda: [0, 0.0, 0.0]))


class SessionBars:
    """Feed one session's logical trades in time order with feed(); completed bars accumulate in .done, the bar still filling is .cur."""

    def __init__(self, overflow='split'):
        if overflow not in ('split', 'whole'): raise ValueError(overflow)
        self.overflow = overflow; self.done = []; self.cur = None

    def feed(self, sec, price, size, aggressor):
        """One logical trade. Returns the number of bars this trade completed."""
        size = int(size); px = round(price, 2); first = True; completed = 0
        while size > 0:
            if self.cur is None: self.cur = _new_bar(sec)
            cur = self.cur
            take = size if self.overflow == 'whole' else min(size, VB - cur['v'])
            if cur['o'] is None: cur['o'] = px
            cur['h'] = max(cur['h'], px); cur['l'] = min(cur['l'], px); cur['c'] = px; cur['end'] = sec; cur['v'] += take
            b = a = 0.0
            if aggressor == 'SELL': b = take
            elif aggressor == 'BUY': a = take
            cur['bid'] += b; cur['ask'] += a; cur['n'] += 1 if first else 0; first = False
            c = cur['vap'][px]; c[0] += take; c[1] += b; c[2] += a
            size -= take
            if cur['v'] >= VB: self.done.append(cur); self.cur = None; completed += 1
        return completed

    def all_bars(self):
        """[(bar, complete_flag)] exactly as the batch extractor wrote them: the still-filling bar (if it has volume) is the last, flagged incomplete."""
        out = [(b, True) for b in self.done]
        if self.cur is not None and self.cur['v'] > 0: out.append((self.cur, False))
        return out


def session_arrays(bars, d):
    """The dict vbars.load_session builds from the .bars.tsv/.vap.tsv files, built from (bar, complete) pairs in memory, with the same text round trip the files apply
    (start/end to 3 decimals, bid/ask to 1 decimal) so a live decision sees the numbers a replay from the files would."""
    n = len(bars)
    idx = np.arange(n); start = np.empty(n); end = np.empty(n); o = np.empty(n); h = np.empty(n); l = np.empty(n); c = np.empty(n); vol = np.empty(n); bid = np.empty(n); ask = np.empty(n); comp = np.empty(n, bool)
    vi = []; vp = []; vv = []
    for i, (b, cm) in enumerate(bars):
        start[i] = float(f"{b['start']:.3f}"); end[i] = float(f"{b['end']:.3f}"); o[i] = b['o']; h[i] = b['h']; l[i] = b['l']; c[i] = b['c']; vol[i] = b['v']
        bid[i] = float(f"{b['bid']:.1f}"); ask[i] = float(f"{b['ask']:.1f}"); comp[i] = cm
        for px, v in sorted(b['vap'].items()): vi.append(i); vp.append(px); vv.append(v[0])
    return dict(d=d, idx=idx, start=start, end=end, o=o, h=h, l=l, c=c, vol=vol, bid=bid, ask=ask, comp=comp,
                vi=np.array(vi, dtype=int), vp=np.round(np.array(vp) / TICK).astype(int), vv=np.array(vv, dtype=float))


def write_session_files(bars, bars_path, vap_path):
    """Write (bar, complete) pairs in the research file format (.bars.tsv: idx start end open high low close vol bid ask ntrades complete; .vap.tsv: idx price vol bid ask) atomically.
    Returns the sha256 of both files' content (the integrity hash stored with the session)."""
    import hashlib, os
    h = hashlib.sha256()
    with open(bars_path + '.tmp', 'w') as f, open(vap_path + '.tmp', 'w') as g:
        for i, (b, comp) in enumerate(bars):
            line = f"{i}\t{b['start']:.3f}\t{b['end']:.3f}\t{b['o']}\t{b['h']}\t{b['l']}\t{b['c']}\t{b['v']}\t{b['bid']:.1f}\t{b['ask']:.1f}\t{b['n']}\t{int(comp)}\n"
            f.write(line); h.update(line.encode())
            for px, v in sorted(b['vap'].items()):
                line = f"{i}\t{px}\t{v[0]}\t{v[1]:.1f}\t{v[2]:.1f}\n"; g.write(line); h.update(line.encode())
    os.replace(bars_path + '.tmp', bars_path); os.replace(vap_path + '.tmp', vap_path)
    return h.hexdigest()
