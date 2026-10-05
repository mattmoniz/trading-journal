"""Persistent ML meta-labeling scoring service -- the live-gate integration DeepSeek's
2026-09-29 design critique recommended (see docs/OPEN_THREADS.md's same-day entry for the
full critique). Exists specifically to eliminate the ~3.3s-per-candidate cost of spawning a
fresh Python subprocess (score_one.py) for every live gate check -- that cost is almost
entirely interpreter/pandas/lightgbm import overhead, not inference, so a long-lived
process that loads the model ONCE pays it exactly once at startup instead of per-candidate.

Deliberately stdlib-only (no Flask, per the critique -- requirements.txt has no web
framework and this doesn't need one): a plain ThreadingHTTPServer on 127.0.0.1, JSON
in/out. Threaded so a slow request (there shouldn't be any -- inference is microseconds)
can't block a concurrent health check.

Checkpoint-freshness (the real failure mode the critique flagged for ANY persistent
scorer): re-reads `ml_models.is_checkpoint` on EVERY /score request (one cheap indexed
SELECT) and only reloads the joblib bundle from disk if model_version actually changed --
never trusts an in-memory cache across the weekly promote_weekly_checkpoint.py rotation.
This is the same per-request freshness guarantee score_one.py already has; the only thing
this service changes is WHERE the expensive part (loading the bundle) happens, never
whether the check is fresh.

Endpoints:
  GET  /health -> {status: 'ok', model_version: <str or null>}
  POST /score  body: {features: {...}, is_rth: bool} -> {probability, verdict, model_version}
       Missing/mismatched feature keys -> HTTP 422 {error: '...'} (never a silent wrong score).

Run manually for testing: venv/bin/python3 scripts/ml_meta_labeling/scoring_service.py [port]
In production this is spawned and supervised by server/services/mlScoringServiceManager.js
(matches the DTC connectionManager.js precedent -- Node owns the child process lifecycle).
"""
import sys
import os
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(__file__))
from db import get_connection
from score import load_model, score_candidate

DEFAULT_PORT = 8899

_lock = threading.Lock()
_state = {'model_version': None, 'bundle': None, 'approval_threshold': None,
          'approval_threshold_rth': None, 'approval_threshold_globex': None}


def _get_checkpoint_row():
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("""
        SELECT model_version, model_path, approval_threshold, approval_threshold_rth, approval_threshold_globex
        FROM ml_models ORDER BY is_checkpoint DESC, trained_at DESC LIMIT 1
    """)
    row = cur.fetchone()
    conn.close()
    return row


def _ensure_current_model():
    """Re-checks the checkpoint on every call (cheap: one indexed SELECT) and reloads the
    joblib bundle only if model_version changed. Returns the current state dict, or raises
    if no model exists at all yet."""
    row = _get_checkpoint_row()
    if row is None:
        raise RuntimeError('no trained model in ml_models yet')
    model_version, model_path, thr, thr_rth, thr_globex = row
    with _lock:
        if _state['model_version'] != model_version:
            previous = _state['model_version']
            bundle = load_model(model_path)
            _state['model_version'] = model_version
            _state['bundle'] = bundle
            _state['approval_threshold'] = float(thr)
            _state['approval_threshold_rth'] = float(thr_rth) if thr_rth is not None else float(thr)
            _state['approval_threshold_globex'] = float(thr_globex) if thr_globex is not None else float(thr)
            print(f'[scoring_service] loaded model_version={model_version} (was {previous})', file=sys.stderr)
        return dict(_state)


class Handler(BaseHTTPRequestHandler):
    timeout = 10  # a stalled client or request must not hold its thread forever
    def log_message(self, fmt, *args):
        print(f'[scoring_service] {self.address_string()} {fmt % args}', file=sys.stderr)

    def _send_json(self, code, payload):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path != '/health':
            self._send_json(404, {'error': 'not found'})
            return
        try:
            state = _ensure_current_model()
            self._send_json(200, {'status': 'ok', 'model_version': state['model_version']})
        except Exception as e:
            self._send_json(503, {'status': 'error', 'error': str(e)})

    def do_POST(self):
        if self.path != '/score':
            self._send_json(404, {'error': 'not found'})
            return
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length) or b'{}')
        except Exception as e:
            self._send_json(400, {'error': f'invalid JSON body: {e}'})
            return

        features = body.get('features')
        is_rth = bool(body.get('is_rth'))
        if not isinstance(features, dict):
            self._send_json(422, {'error': "'features' must be an object"})
            return

        try:
            state = _ensure_current_model()
        except Exception as e:
            self._send_json(503, {'error': f'no model available: {e}'})
            return

        threshold = state['approval_threshold_rth'] if is_rth else state['approval_threshold_globex']
        try:
            result = score_candidate(state['bundle'], features, threshold)
        except ValueError as e:
            # score_candidate raises on a genuinely missing feature key -- never a silent
            # wrong score (score.py's own documented contract). 422, not 500: this is a
            # caller-input problem, not a service fault.
            self._send_json(422, {'error': str(e)})
            return

        self._send_json(200, {**result, 'model_version': state['model_version']})


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    # Load once at startup so the first real request isn't the one paying the import cost --
    # this also fails fast and loud if there's no trained model at all, rather than
    # discovering that on the first live Globex fire of the night.
    try:
        state = _ensure_current_model()
        print(f'[scoring_service] ready on 127.0.0.1:{port}, model_version={state["model_version"]}', file=sys.stderr)
    except Exception as e:
        print(f'[scoring_service] WARNING: no model loaded at startup ({e}) -- will retry per-request', file=sys.stderr)

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.serve_forever()


if __name__ == '__main__':
    main()
