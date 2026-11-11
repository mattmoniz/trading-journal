"""Shared constants and helpers of the unified exit-lock family (docs/UNIFIED_EXIT_LOCK_PREREG_20261110.md); no heavy imports, so the tell script and the vacuum script can both use it."""
import os, csv, collections
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
LOCK_F, TELL_GATE, VAC_GATE = 0.5, 0.15, 1.5            # frozen in the prereg
SENS = (('gate067', 0.67 * TELL_GATE, 0.5), ('gate133', 1.33 * TELL_GATE, 0.5), ('f025', TELL_GATE, 0.25), ('f075', TELL_GATE, 0.75))
OUT = os.path.join(ROOT, 'scratch', 'unified_exit_lock_20261110'); os.makedirs(OUT, exist_ok=True)
def lock_price(d, entry, exc, f=LOCK_F):
    """Stop candidate that locks the fraction f of the best favourable excursion (exc >= 0)."""
    return entry + d * f * exc
def load_climaxes():
    """date -> list of (end_sec, dir, fast) of the row 44 climaxes (both tracks; burn-in events carry no fast flag and are absent)."""
    out = collections.defaultdict(list)
    for r in csv.DictReader(open(os.path.join(ROOT, 'scratch', 'capitulation_speed_20261110', 'events_speed.csv'))): out[r['date']].append((float(r['end_sec']), int(r['dir']), int(r['fast'])))
    return out
def load_adr():
    return {r['date']: float(r['adr20']) for r in csv.DictReader(open(os.path.join(ROOT, 'scratch', 'globex_roc3_20261110', 'events.csv'))) if r['adr20'] not in ('', 'nan')}
