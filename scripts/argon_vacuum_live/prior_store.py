"""Prior-session store for the Argon live shadow (docs/ARGON_VACUUM_LIVE_SHADOW_DESIGN_20261108.md). The shadow's trailing-20-session priors need each prior session's RTH 500-contract split bars. Sources, in order:
(1) our own store scratch/argon_vacuum_live/priors/DATE.bars.tsv, (2) the live tell sidecar's saved bars scratch/amt_tell_live/DATE.split.bars.tsv (same file format, validated by that sidecar),
(3) the 2026-11-03 extract scratch/volbars500_holdout_20261103/DATE.bars.tsv, ONLY for dates >= FLOOR_DATE, (4) a rebuild from the tick files (bootstrap.build_sessions, accepted only when its RTH volume matches the DB within 3 percent).
FLOOR_DATE = 2026-10-12 keeps every prior inside the post-confound era and OUTSIDE the sealed window of this family (2025-05-19..2026-10-09): no sealed-era bar is ever read here."""
import os, sys, shutil, datetime
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'amt_tell_live')); sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tick_microstructure')); sys.path.insert(0, os.path.join(ROOT, 'scripts'))
import bootstrap, barbuilder
import argon_vacuum_blind_funnel as M
PRI = os.path.join(ROOT, 'scratch', 'argon_vacuum_live', 'priors'); os.makedirs(PRI, exist_ok=True)
TELL = os.path.join(ROOT, 'scratch', 'amt_tell_live'); HOLD = os.path.join(ROOT, 'scratch', 'volbars500_holdout_20261103')
FLOOR_DATE = '2026-10-12'
assert FLOOR_DATE > '2026-10-09'

def _locate(ds, conn, log):
    mine = os.path.join(PRI, f'{ds}.bars.tsv')
    if os.path.exists(mine): return mine
    for src in (os.path.join(TELL, f'{ds}.split.bars.tsv'), os.path.join(HOLD, f'{ds}.bars.tsv') if ds >= FLOOR_DATE else None):
        if src and os.path.exists(src): shutil.copyfile(src, mine + f'.tmp{os.getpid()}'); os.replace(mine + f'.tmp{os.getpid()}', mine); log(f'[priors] {ds}: copied {os.path.relpath(src, ROOT)}'); return mine
    sess, ok, info = bootstrap.build_sessions(conn, ds, ['split'])
    if sess is None or not ok: log(f'[priors] {ds}: rebuild failed or unvalidated ({info})'); return None
    barbuilder.write_session_files(sess['split'].finished_bars(), mine, os.path.join(PRI, f'{ds}.vap.tsv')); log(f'[priors] {ds}: rebuilt from ticks {info}'); return mine

def ensure_priors(conn, d, log=print, need=M.K_PRIOR):
    """The `need` most recent qualifying (N_rth>=60) sessions strictly before trade date d, oldest first, none earlier than FLOOR_DATE. Returns (sessions, missing_note)."""
    out = []
    disk = {f[:10] for f in os.listdir(PRI) if f.endswith('.bars.tsv') and len(f) > 18}      # dates already stored on disk join the DB's list (the DB calendar can lag the evening a session closes)
    dates = sorted({str(x) for x in bootstrap.completed_session_dates(conn, d, need + 12)} | {x for x in disk if FLOOR_DATE <= x < d}, reverse=True)
    for ds in dates:
        if ds < FLOOR_DATE or ds >= d: continue
        p = _locate(ds, conn, log)
        S = M.load_day(p) if p else None
        if S is not None: out.append(S)
        if len(out) >= need: break
    out.reverse()
    return out, (None if len(out) >= need else f'only {len(out)} qualifying sessions since {FLOOR_DATE}, need {need}')
