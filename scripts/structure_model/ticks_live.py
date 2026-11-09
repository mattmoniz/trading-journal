"""Per-minute RTH tick volume and up/down-tick volume for ONE trade date, from the Sierra tick (.scid) files, for the shadow range model (docs/STRUCTURE_SHADOW_MODEL_DESIGN_20261105.md). Sierra's trade-price rule (scripts/tick_microstructure/updown_tick_delta.py).
The day is accepted ONLY if the tick RTH volume matches the database RTH volume within 3 percent (the explore rule; the database volume is inflated on some mid-2025 dates, hr-070, so a mismatch means 'do not use this day', never 'impute'); the front-month file is chosen as the candidate that matches.
Writes scratch/structure_model_20261105/ticks/DATE.csv (m, up, dn, vol; m = minute since 09:30) and returns the arrays. Usage: venv/bin/python scripts/structure_model/ticks_live.py YYYY-MM-DD"""
import os, sys, glob, csv, datetime
import numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tick_microstructure')); sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')); OUT = os.path.join(REPO, 'scratch', 'structure_model_20261105', 'ticks'); os.makedirs(OUT, exist_ok=True)
from updown_tick_delta import minute_updown
from scid_reader import read_ticks
# SCOPE (2026-11-08, Opus review): this module is the FORWARD path only (recent contracts in the DTC folder, which is why the pattern is narrow: it must find tomorrow's contract, not 2023's). Tick files for every NQ contract since 2023 exist in
# /mnt/c/SierraChart/Data/*.CME.scid, but HISTORICAL dates go through the research extractor scripts/tick_microstructure/extract_updown_minutes_20261104.py (contract map, legacy layouts, the hr-070 high/low acceptance test) and
# scripts/structure_model/import_ticks_cache.py; do not widen this pattern, a second extraction path would diverge from the one the model was trained on.
CAND = sorted(glob.glob('/mnt/c/SierraChart-DTC/Data/NQ[HMUZ]2[0-9].scid'), key=lambda p: os.path.basename(p), reverse=True)


def db_rth_volume(conn, d):
    cur = conn.cursor(); cur.execute("SELECT COALESCE(SUM(volume), 0) FROM price_bars_primary WHERE symbol='NQ' AND ts >= %s::timestamp + interval '9 hours 30 minutes' AND ts < %s::timestamp + interval '16 hours'", (d, d)); return float(cur.fetchone()[0])


def scale_of(fp, day):
    for t in read_ticks(fp, start_date=day, end_date=day): return 100.0 if t.price < 1000 else 1.0        # the DTC folder stores plain prices (read_ticks divides by 100): multiply back
    return None


def load(d):
    fp = os.path.join(OUT, d + '.csv')
    if not os.path.exists(fp): return None
    a = {k: np.full(390, np.nan) for k in ('up', 'dn', 'vol')}
    for r in csv.DictReader(open(fp)): m = int(r['m']); a['up'][m] = float(r['up']); a['dn'][m] = float(r['dn']); a['vol'][m] = float(r['vol'])
    return a


def extract(conn, d, force=False):
    """Returns (arrays or None, note). Idempotent: an existing file is kept."""
    if not force and os.path.exists(os.path.join(OUT, d + '.csv')): return load(d), 'cached'
    day = datetime.date.fromisoformat(d); dbv = db_rth_volume(conn, d)
    if dbv <= 0: return None, 'no database RTH volume'
    best = None
    for fp in CAND:
        sc = scale_of(fp, day)
        if sc is None: continue
        a = {k: np.full(390, np.nan) for k in ('up', 'dn', 'vol')}
        for r in minute_updown(fp, day, day, sc):
            m = r['ts'].hour * 60 + r['ts'].minute - 570
            if r['ts'].date() == day and 0 <= m < 390: a['up'][m] = r['up_vol']; a['dn'][m] = r['down_vol']; a['vol'][m] = r['volume']
        tot = float(np.nansum(a['vol'])); err = abs(tot - dbv) / dbv
        if best is None or err < best[0]: best = (err, a, os.path.basename(fp))
        if err <= 0.03: break
    if best is None: return None, 'no tick file has that date'
    if best[0] > 0.03: return None, f'tick RTH volume differs from the database by {100 * best[0]:.1f}% (best file {best[2]}): day not used (hr-070)'
    with open(os.path.join(OUT, d + '.csv'), 'w', newline='') as f:
        w = csv.writer(f); w.writerow(['m', 'up', 'dn', 'vol'])
        for m in range(390):
            if not np.isnan(best[1]['vol'][m]): w.writerow([m, int(best[1]['up'][m]), int(best[1]['dn'][m]), int(best[1]['vol'][m])])
    return best[1], f'extracted from {best[2]} (volume within {100 * best[0]:.2f}% of the database)'


if __name__ == '__main__':
    sys.path.insert(0, os.path.join(REPO, 'scripts')); from ml_meta_labeling.db import get_connection
    conn = get_connection(); a, note = extract(conn, sys.argv[1]); print(sys.argv[1], note, '' if a is None else f'RTH ticks {int(np.nansum(a["vol"]))}, minutes {int((~np.isnan(a["vol"])).sum())}')
