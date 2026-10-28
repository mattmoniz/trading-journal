"""Regression for the scid_reader.TradeMerger refactor: read_ticks output hash on a few real days must not change. Usage: venv/bin/python test_scid_reader_equiv.py [--save|--check]"""
import sys, os, json, hashlib, datetime
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tick_microstructure'))
import scid_reader as sr
import extract_cells_20261020 as X
DAYS = ['2025-03-12', '2024-09-17', '2023-06-14']
REF = os.path.join(X.ROOT, 'scratch', 'scid_reader_equiv_ref.json')
def day_hash(d):
    dd = datetime.date.fromisoformat(d); best = None
    for code in X.candidate_codes(X.CAL[d]):
        for p in X.scid_paths(code):
            if X._sniff_layout(p, dd) != 'std': continue
            h = hashlib.sha256(); n = 0
            for t in sr.read_ticks(p, start_date=dd, end_date=dd):
                h.update(f'{t.ts_utc.isoformat()}|{t.price!r}|{t.size}|{t.num_sub_trades}|{t.aggressor}\n'.encode()); n += 1
            if n > 1000: return h.hexdigest(), n
    return None, 0
if __name__ == '__main__':
    cur = {d: day_hash(d) for d in DAYS}
    if '--save' in sys.argv: json.dump(cur, open(REF, 'w')); print('saved', cur)
    else:
        ref = json.load(open(REF)); ok = all(list(ref[d]) == list(cur[d]) for d in DAYS)
        print('EQUAL' if ok else 'DIFFERENT', {d: (cur[d][1], ref[d][1]) for d in DAYS}); sys.exit(0 if ok else 1)
