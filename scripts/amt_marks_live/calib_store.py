"""Versioned calibration artifacts in performance_audit (signal_type MARKS_CTX_CALIB, 15 chars; signal_name VARCHAR(60)). Live code only READS the latest version; calibration scripts WRITE. The read uses the deduplicating query the repo requires (DISTINCT ON ... run_date DESC, id DESC)."""
import json, hashlib, datetime
SIGNAL_TYPE = 'MARKS_CTX_CALIB'

def params_hash(params): return hashlib.sha256(json.dumps(params, sort_keys=True, default=float).encode()).hexdigest()[:16]

def write(conn, name, params, train_end, code_sha, sample_size=None, run_date=None):
    if len(name) > 60: raise ValueError('signal_name is VARCHAR(60)')
    notes = json.dumps(dict(params=params, version=params_hash(params), train_end=str(train_end), code_sha=code_sha, written_by='calib_store.write'), default=float)
    run_date = run_date or datetime.date.today()
    with conn.cursor() as cur:
        cur.execute("""INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, notes) VALUES (%s, 0, %s, %s, %s, %s)
                       ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET sample_size = EXCLUDED.sample_size, notes = EXCLUDED.notes""", (run_date, SIGNAL_TYPE, name, sample_size, notes))

def latest(conn, name):
    """The newest version of one calibration (dedup + deterministic tie-break), as a dict, or None."""
    with conn.cursor() as cur:
        cur.execute("""SELECT DISTINCT ON (signal_name) signal_name, run_date, notes FROM performance_audit WHERE signal_type = %s AND signal_name = %s ORDER BY signal_name, run_date DESC, id DESC""", (SIGNAL_TYPE, name))
        r = cur.fetchone()
    if not r: return None
    n = r[2] if isinstance(r[2], dict) else json.loads(r[2]); return dict(name=r[0], run_date=r[1], **n)
