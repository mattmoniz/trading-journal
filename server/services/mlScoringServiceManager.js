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
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const SCORING_SERVICE_PY = path.join(REPO_ROOT, 'scripts', 'ml_meta_labeling', 'scoring_service.py');
const PYTHON_BIN = path.join(REPO_ROOT, 'venv', 'bin', 'python3');
export const ML_SCORING_SERVICE_PORT = 8899;
export const ML_SCORING_SERVICE_URL = `http://127.0.0.1:${ML_SCORING_SERVICE_PORT}`;

const RESTART_DELAY_MS = 5000;
const GIVE_UP_RETRY_MS = 5 * 60 * 1000;
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

// 2026-10-18: a stale scoring_service.py left over from a previous server process (re-parented to init, still LISTENing on
// the port but no longer answering) made every freshly spawned scorer die with EADDRINUSE; after MAX_RAPID_RESTARTS the manager
// gave up for good, so the ML VETO gate failed closed (force-SHADOW) for every live candidate with nothing to recover it.
// Before every spawn, kill anything on OUR port whose command line is scoring_service.py (never any other process).
export function reapStaleScorers(port = ML_SCORING_SERVICE_PORT) {
  let out = '';
  try { out = execFileSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8', timeout: 3000 }); } catch { return; }
  for (const m of out.matchAll(/pid=(\d+)/g)) {
    const pid = Number(m[1]);
    if (!pid || pid === process.pid || (child && child.pid === pid)) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      if (!cmd.includes('scoring_service.py')) { console.error(`[mlScoringServiceManager] port ${port} is held by pid ${pid} which is NOT scoring_service.py -- leaving it alone: ${cmd.slice(0, 120)}`); continue; }
      process.kill(pid, 'SIGKILL');
      console.error(`[mlScoringServiceManager] killed stale scoring_service.py pid ${pid} holding port ${port}`);
    } catch (e) { console.error(`[mlScoringServiceManager] could not inspect/kill pid ${pid}: ${e.message}`); }
  }
}

function spawnChild() {
  if (child) return; // a stale timer must never start a second scorer (DeepSeek review 2026-10-19, latent today: startMlScoringService is called once at boot)
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  reapStaleScorers();
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
      console.error(`[mlScoringServiceManager] ${MAX_RAPID_RESTARTS}+ restarts in 60s -- backing off ${GIVE_UP_RETRY_MS / 60000} min then trying again (was: gave up permanently, 2026-10-18). The ML VETO gate fails closed (force-SHADOW) for every candidate until a scorer is healthy. Check scripts/ml_meta_labeling/scoring_service.py directly.`);
      recentRestarts = [];
      restartTimer = setTimeout(spawnChild, GIVE_UP_RETRY_MS);
      return;
    }
    restartTimer = setTimeout(spawnChild, RESTART_DELAY_MS);
  });
}

// A process that is alive but no longer answering never triggers the exit handler above, so
// it would sit wedged forever while every live Globex candidate fails closed. The watchdog
// polls /health and kills the child after consecutive failures; the exit handler then respawns it.
const WATCHDOG_INTERVAL_MS = 15000;
const WATCHDOG_FAIL_THRESHOLD = 3;
const WATCHDOG_KILL_WINDOW_MS = 30 * 60 * 1000;
const WATCHDOG_MAX_KILLS_IN_WINDOW = 4;
let watchdogTimer = null;
let consecutiveHealthFailures = 0;
let lastHealthOkAtMs = null;
let lastHealthCheckOk = null; // null until the first check has run
const watchdogKillTimes = [];

/** For the live-flags banner (2026-10-18): the ML VETO gate fails closed, so an unhealthy scorer silently turns every live candidate into SHADOW. */
export function getMlScoringStatus() {
  return { healthy: lastHealthCheckOk, childAlive: !!child, consecutiveHealthFailures, secondsSinceHealthy: lastHealthOkAtMs ? Math.round((Date.now() - lastHealthOkAtMs) / 1000) : null };
}

async function checkHealthOnce() {
  try {
    const res = await fetch(`${ML_SCORING_SERVICE_URL}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    consecutiveHealthFailures = 0; lastHealthCheckOk = true; lastHealthOkAtMs = Date.now();
  } catch (e) {
    consecutiveHealthFailures++; lastHealthCheckOk = false;
    console.error(`[mlScoringServiceManager] health check failed (${consecutiveHealthFailures}/${WATCHDOG_FAIL_THRESHOLD}): ${e.message}`);
    if (consecutiveHealthFailures >= WATCHDOG_FAIL_THRESHOLD && child) {
      const now = Date.now();
      while (watchdogKillTimes.length && now - watchdogKillTimes[0] > WATCHDOG_KILL_WINDOW_MS) watchdogKillTimes.shift();
      if (watchdogKillTimes.length >= WATCHDOG_MAX_KILLS_IN_WINDOW) {
        console.error(`[mlScoringServiceManager] watchdog killed the scorer ${WATCHDOG_MAX_KILLS_IN_WINDOW} times in 30min -- giving up. The ML gate fails closed until the server is restarted and the scorer is checked directly.`);
        return;
      }
      watchdogKillTimes.push(now);
      console.error('[mlScoringServiceManager] service is alive but unresponsive -- killing it so it respawns');
      consecutiveHealthFailures = 0;
      child.kill('SIGKILL');
    }
  }
}

/** Call once at server startup, same convention as sierraChart's startConnectionManager(). */
let exitHookInstalled = false;
export function startMlScoringService() {
  if (child) return;
  if (!exitHookInstalled) { exitHookInstalled = true; process.once('exit', () => { if (child) { try { child.kill('SIGKILL'); } catch { /* already gone */ } } }); } // no orphan scorer when the server exits (index.js's SIGTERM/SIGINT handlers call process.exit)
  spawnChild();
  if (!watchdogTimer) watchdogTimer = setInterval(checkHealthOnce, WATCHDOG_INTERVAL_MS);
}

export function stopMlScoringService() {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (child) { child.kill('SIGKILL'); child = null; } // SIGKILL: a wedged scorer can ignore SIGTERM
}
