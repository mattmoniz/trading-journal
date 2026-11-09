"""Convert the full-day up/down-tick minute files written by scripts/tick_microstructure/extract_updown_minutes_20261104.py (ts, up_vol, down_vol, unclassified_vol, volume, close) into the per-date RTH cache
that ticks_live.load() reads (scratch/structure_model_20261105/ticks/DATE.csv: m, up, dn, vol; m = minute since 09:30). Idempotent: an existing cache file is never overwritten.
Usage: venv/bin/python scripts/structure_model/import_ticks_cache.py [--out CACHE_DIR] DIR [DIR ...]   (default CACHE_DIR = the live nightly cache; the sealed replay uses its own so the live cache is never touched)   (e.g. scratch/updown_1m_sealed_20261108 scratch/updown_1m_20261104)"""
import os, sys, csv, glob
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import ticks_live as TL
args = sys.argv[1:]; OUTD = TL.OUT
if args[:1] == ['--out']: OUTD = os.path.abspath(args[1]); os.makedirs(OUTD, exist_ok=True); args = args[2:]
made = skipped = 0
for src in args:
    for fp in sorted(glob.glob(os.path.join(src, '????-??-??.csv'))):
        d = os.path.basename(fp)[:10]; out = os.path.join(OUTD, d + '.csv')
        if os.path.exists(out): skipped += 1; continue
        rows = {}
        for r in csv.DictReader(open(fp)):
            if r['ts'][:10] != d: continue
            m = int(r['ts'][11:13]) * 60 + int(r['ts'][14:16]) - 570
            if 0 <= m < 390: rows[m] = (int(r['up_vol']), int(r['down_vol']), int(r['volume']))
        if not rows: continue
        with open(out + '.tmp', 'w', newline='') as f:
            w = csv.writer(f); w.writerow(['m', 'up', 'dn', 'vol'])
            for m in sorted(rows): w.writerow([m, *rows[m]])
        os.replace(out + '.tmp', out); made += 1
print(f'cache files written {made}, already present {skipped}')
