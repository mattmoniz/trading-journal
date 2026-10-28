"""One trading session of the live tell detector for ONE bar rule (split or whole). Shared by the sidecar and by the parity harness, so the harness exercises the production code path.
Feed logical trades in file order with feed_trade(); evaluate() replays the research simulate on the bars so far."""
import datetime, statistics
import numpy as np
import core
from barbuilder import SessionBars, session_sec

SCALE_SAMPLE = 300         # the batch extractor sniffed the 1/100 price scaling from the first 300 ticks (median < 1000 -> x100)


class LiveSession:
    def __init__(self, d, rule, prior_stats):
        self.d = d; self.dd = datetime.date.fromisoformat(d); self.rule = rule; self.prior = prior_stats
        self.sb = SessionBars(rule); self.scale = None; self._buf = []; self.bar_start_utc = []; self.bar_end_utc = []; self.first_tick_utc = None; self.last_tick_utc = None
        self.n_trades = 0; self.contracts = 0; self.rth_min = {}; self.trigger_count = 0

    # ---- feeding -------------------------------------------------------------------------------------------------
    def feed_trade(self, t):
        """One logical trade (scid_reader.Trade). Returns True when this trade created a new forming bar (the moment a decision made on the last completed bar can be acted on)."""
        sec = session_sec(t.ts_et, self.dd)
        if sec is None: return False
        if self.scale is None:                      # buffer until the scale is known, then replay the buffer in order
            self._buf.append((t, sec))
            if len(self._buf) < SCALE_SAMPLE: return False
            self.scale = 100.0 if statistics.median([x.price for x, _ in self._buf]) < 1000 else 1.0
            buf, self._buf = self._buf, []; trig = False
            for x, s in buf: trig |= self._apply(x, s)
            return trig
        return self._apply(t, sec)

    def finish_scale_detection(self):
        """For a session with fewer than SCALE_SAMPLE trades so far (start of the week), decide with what is there; returns True if it fed any buffered trade."""
        if self.scale is not None or not self._buf: return False
        self.scale = 100.0 if statistics.median([x.price for x, _ in self._buf]) < 1000 else 1.0
        buf, self._buf = self._buf, []; trig = False
        for x, s in buf: trig |= self._apply(x, s)
        return trig

    def _apply(self, t, sec):
        m = t.ts_et.hour * 60 + t.ts_et.minute; price = t.price * self.scale if self.scale != 1.0 else t.price
        self.n_trades += 1; self.contracts += int(t.size)
        if t.ts_et.date() == self.dd and 570 <= m < 960: self.rth_min[m] = self.rth_min.get(m, 0) + int(t.size)
        if self.first_tick_utc is None: self.first_tick_utc = t.ts_utc
        self.last_tick_utc = t.ts_utc
        before = len(self.sb.done); had_cur = self.sb.cur is not None; started_before = before + int(had_cur)
        self.sb.feed(sec, price, t.size, t.aggressor)
        for _ in range(len(self.sb.done) + int(self.sb.cur is not None) - started_before): self.bar_start_utc.append(t.ts_utc)      # a bar's start/end instants (real UTC, for the persisted timestamps)
        for _ in range(len(self.sb.done) - before): self.bar_end_utc.append(t.ts_utc)
        new_forming = self.sb.cur is not None and ((not had_cur) or len(self.sb.done) > before)
        if new_forming: self.trigger_count += 1
        return new_forming

    @property
    def rth_contracts(self):
        return sum(self.rth_min.values())

    # ---- evaluating ----------------------------------------------------------------------------------------------
    def last_complete_end(self):
        return self.sb.done[-1]['end'] if self.sb.done else None

    def evaluate(self, force=False, final=False):
        """Replay the research simulate on the session so far (final=True once the session's data has ended: a trade still running is booked closed at the last close, as the research does). Returns dict(books={V1:[..],V3:[..]}, rep=..., n_done=...) or None when no decision is possible yet (before the entry window, no baseline)."""
        le = self.last_complete_end()
        if le is None: return None
        if not force and le < core.EARLIEST_ENTRY: return None          # signals need a completed bar ending in the entry window; nothing can exist earlier
        bars = self.sb.all_bars(); ctx = core.build_ctx(bars, self.d, self.prior)
        if ctx is None: return None
        books, rep = core.replay(ctx, final=final)
        for b, trs in books.items():
            for t in trs: t['details'] = core.decision_details(ctx, t)
        return dict(books=books, rep=rep, n_done=len(self.sb.done), ctx=ctx)

    def finished_bars(self):
        return self.sb.all_bars()
