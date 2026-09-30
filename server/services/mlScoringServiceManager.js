// Owns the ONE long-lived Python ML scoring subprocess (scripts/ml_meta_labeling/
// scoring_service.py) for this server process -- same ownership/supervision pattern as
// sierraChart/connectionManager.js owning the one DtcClient (a single long-lived child
// process, restarted on crash, everything else talks to it through this module rather
// than spawning its own). Built 2026-09-29 per DeepSeek's design critique: score_one.py's
// ~3.3s-per-call cost is Python interpreter/import startup, not inference -- a persistent
// process pays that exactly once, at boot, instead of per live-gate check.
//
// If the service fails to start or crashes repeatedly, this module does NOT throw or
// crash the main server -- server/services/mlLiveVetoGate.js's own health check + timeout
// handles an unreachable service by failing closed (force-SHADOW), per the critique's
// fail-closed reasoning (a missed TAKE costs ~$1.50/trade forgone; a missed VETO costs
// ~$10.63/trade realized -- a ~7:1 asymmetry that makes "don't fire live when unsure" the
// cheap side to be wrong on).
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const SCORING_SERVICE_PY = path.join(REPO_ROOT, 'scripts', 'ml_meta_labeling', 'scoring_service.py');
const PYTHON_BIN = path.join(REPO_ROOT, 'venv', 'bin', 'python3');
export const ML_SCORING_SERVICE_PORT = 8899;
export const ML_SCORING_SERVICE_URL = `http://127.0.0.1:${ML_SCORING_SERVICE_PORT}`;

const RESTART_DELAY_MS = 5000;
const MAX_RAPID_RESTARTS = 5; // matches the general spirit of a restart-burst guard --
// if the process crash-loops (e.g. a real Python syntax/import error), stop respawning
// instead of hammering the same failure every 5s forever; a loud, one-time log beats a
// silent infinite loop, and the gate already fails closed with no service running.

let child = null;
let restartTimer = null;
let recentRestarts = [];

function recordRestartAndCheckBurst() {
  const now = Date.now();
  recentRestarts = recentRestarts.filter((t) => now - t < 60000);
  recentRestarts.push(now);
  return recentRestarts.length > MAX_RAPID_RESTARTS;
}

function spawnChild() {
  child = spawn(PYTHON_BIN, [SCORING_SERVICE_PY, String(ML_SCORING_SERVICE_PORT)], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (buf) => process.stdout.write(`[ml-scoring-service] ${buf}`));
  child.stderr.on('data', (buf) => process.stderr.write(`[ml-scoring-service] ${buf}`));
  child.on('exit', (code, signal) => {
    console.error(`[mlScoringServiceManager] scoring_service.py exited (code=${code}, signal=${signal})`);
    child = null;
    if (recordRestartAndCheckBurst()) {
      console.error(`[mlScoringServiceManager] ${MAX_RAPID_RESTARTS}+ restarts in 60s -- giving up. The ML VETO gate will fail closed (force-SHADOW) for every candidate until this is fixed and the server is restarted. Check scripts/ml_meta_labeling/scoring_service.py directly.`);
      return;
    }
    restartTimer = setTimeout(spawnChild, RESTART_DELAY_MS);
  });
}

/** Call once at server startup, same convention as sierraChart's startConnectionManager(). */
export function startMlScoringService() {
  if (child) return;
  spawnChild();
}

export function stopMlScoringService() {
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (child) { child.kill(); child = null; }
}
