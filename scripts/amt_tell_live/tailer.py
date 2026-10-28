"""Incremental reader of a Sierra Chart .scid tick file for the live tell detector.
Decoding is the canonical one: raw 40-byte records -> scid_reader.TradeMerger (the same merge rule read_ticks uses). The tailer only ever consumes WHOLE records (a half-written record at the end of the file is left for
the next poll), keeps the TradeMerger state across polls, remembers its byte offset, and raises on a file that shrank or whose header changed (Sierra compaction/rewrite) instead of silently re-reading from the wrong place, and counts records whose timestamp goes backwards (.backwards)."""
import os, sys, struct, datetime
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tick_microstructure'))
import scid_reader as sr


class FileRewritten(RuntimeError):
    pass


class ScidTailer:
    def __init__(self, path, from_date=None):
        """from_date (datetime.date, ET): start at the first record whose ET date is >= from_date (binary search with the canonical backoff); None = from the first record."""
        self.path = path; self.merger = sr.TradeMerger(); self.records = 0; self.last_ts_utc = None; self.backwards = 0
        with open(path, 'rb') as f:
            hdr = f.read(56)
            if len(hdr) < 56: raise FileRewritten(f'{path}: header incomplete')
            self.header_size = struct.unpack('<I', hdr[4:8])[0]; self.hdr_sig = hdr[:12]
            rec = struct.unpack('<I', hdr[8:12])[0]
            if rec != sr.RECORD_SIZE: raise FileRewritten(f'{path}: header record size {rec}, expected {sr.RECORD_SIZE}')
            size = os.fstat(f.fileno()).st_size; n = (size - self.header_size) // sr.RECORD_SIZE
            idx = sr._seek_index_for_date(f, self.header_size, n, from_date) if from_date is not None else 0
        self.offset = self.header_size + idx * sr.RECORD_SIZE; self.file_size_seen = size

    def poll(self, max_records=2_000_000):
        """Read every complete record available now; returns the list of logical Trades they complete (may be empty)."""
        out = []
        with open(self.path, 'rb') as f:
            hdr = f.read(12); size = os.fstat(f.fileno()).st_size
            if hdr != self.hdr_sig: raise FileRewritten(f'{self.path}: header changed')
            if size < self.file_size_seen: raise FileRewritten(f'{self.path}: file shrank {self.file_size_seen} -> {size}')
            self.file_size_seen = size
            avail = (size - self.offset) // sr.RECORD_SIZE
            if avail <= 0: return out
            take = min(avail, max_records); f.seek(self.offset); buf = f.read(take * sr.RECORD_SIZE)
        n = len(buf) // sr.RECORD_SIZE
        for dt_us, o, h, l, c, numtr, totvol, bidvol, askvol in sr.RECORD_STRUCT.iter_unpack(buf[:n * sr.RECORD_SIZE]):
            dt_utc = sr.SCID_EPOCH + datetime.timedelta(microseconds=dt_us)
            if self.last_ts_utc is not None and dt_utc < self.last_ts_utc: self.backwards += 1      # counted, surfaced by the caller as an integrity alarm; records are consumed in file order exactly as the batch extractor did
            self.last_ts_utc = dt_utc; self.records += 1
            out.extend(self.merger.feed(dt_utc, o, h, l, c, numtr, totvol, bidvol, askvol))
        self.offset += n * sr.RECORD_SIZE
        return out

    def backlog_bytes(self):
        return max(0, os.stat(self.path).st_size - self.offset)
