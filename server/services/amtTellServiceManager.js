// Owns the ONE long-lived Python sidecar (scripts/amt_tell_live/sidecar.py) of the live node-ladder tell detector (docs/AMT_TELL_LIVE_PROJECT_SPEC_20261028.md), Stage 1 = watch only.
// Same ownership/supervision pattern as mlScoringServiceManager.js (single child, restart-burst guard, stale-process reaper limited to OUR script, health watchdog): the sidecar tails the live Sierra tick
// file, replays the research tell evaluator on every new 500-contract bar and writes amt_tell_trades. It places no orders. If it is down the only loss is that no tells are logged, which is shown as a
// banner on quick-check.html (a missing detector must be visible, not silent) -- the rest of the server is unaffected.
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const SIDECAR_PY = path.join(REPO_ROOT, 'scripts', 'amt_tell_live', 'sidecar.py');
const PYTHON_BIN = path.join(REPO_ROOT, 'venv', 'bin', 'python3');
export const AMT_TELL_PORT = 8898;
const HEALTH_URL = `http://127.0.0.1:${AMT_TELL_PORT}/health`;

const RESTART_DELAY_MS = 5000;
const GIVE_UP_RETRY_MS = 5 * 60 * 1000;
const MAX_RAPID_RESTARTS = 5;
const WATCHDOG_INTERVAL_MS = 15000;
const WATCHDOG_FAIL_THRESHOLD = 4;            // the sidecar answers /health from its own thread, so a wedged process is a real failure, but a long catch-up replay gets some slack
const WATCHDOG_KILL_WINDOW_MS = 30 * 60 * 1000;
const WATCHDOG_MAX_KILLS_IN_WINDOW = 4;

let child = null;
let restartTimer = null;
let recentRestarts = [];
let watchdogTimer = null;
let consecutiveHealthFailures = 0;
let lastHealth = null;          // last parsed /health body
let lastHealthOkAtMs = null;
let lastHealthCheckOk = null;
const watchdogKillTimes = [];

function recordRestartAndCheckBurst() {
  const now = Date.now();
  recentRestarts = recentRestarts.filter((t) => now - t < 60000);
  recentRestarts.push(now);
  return recentRestarts.length > MAX_RAPID_RESTARTS;
}

/** Kill anything LISTENing on our port whose command line is our sidecar (a leftover from a previous server process); never touch any other process. */
export function reapStaleSidecars(port = AMT_TELL_PORT) {
  let out = '';
  try { out = execFileSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8', timeout: 3000 }); } catch { return; }
  for (const m of out.matchAll(/pid=(\d+)/g)) {
    const pid = Number(m[1]);
    if (!pid || pid === process.pid || (child && child.pid === pid)) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      if (!cmd.includes('amt_tell_live/sidecar.py')) { console.error(`[amtTellServiceManager] port ${port} is held by pid ${pid} which is NOT the tell sidecar -- leaving it alone: ${cmd.slice(0, 120)}`); continue; }
      process.kill(pid, 'SIGKILL');
      console.error(`[amtTellServiceManager] killed stale tell sidecar pid ${pid} holding port ${port}`);
    } catch (e) { console.error(`[amtTellServiceManager] could not inspect/kill pid ${pid}: ${e.message}`); }
  }
}

function spawnChild() {
  if (child) return;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  reapStaleSidecars();
  child = spawn(PYTHON_BIN, [SIDECAR_PY, '--port', String(AMT_TELL_PORT)], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (buf) => process.stdout.write(buf));          // the sidecar prefixes its own lines with [amt-tell]
  child.stderr.on('data', (buf) => process.stderr.write(`[amt-tell:err] ${buf}`));
  child.on('exit', (code, signal) => {
    console.error(`[amtTellServiceManager] sidecar exited (code=${code}, signal=${signal})`);
    child = null; lastHealthCheckOk = false;
    if (recordRestartAndCheckBurst()) {
      console.error(`[amtTellServiceManager] ${MAX_RAPID_RESTARTS}+ restarts in 60s -- backing off ${GIVE_UP_RETRY_MS / 60000} min then trying again. No tells are logged until the sidecar is healthy; check scripts/amt_tell_live/sidecar.py directly.`);
      recentRestarts = [];
      restartTimer = setTimeout(spawnChild, GIVE_UP_RETRY_MS);
      return;
    }
    restartTimer = setTimeout(spawnChild, RESTART_DELAY_MS);
  });
}

async function checkHealthOnce() {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    lastHealth = await res.json();
    consecutiveHealthFailures = 0; lastHealthCheckOk = true; lastHealthOkAtMs = Date.now();
  } catch (e) {
    consecutiveHealthFailures++; lastHealthCheckOk = false;
    if (consecutiveHealthFailures === 1 || consecutiveHealthFailures % 10 === 0) console.error(`[amtTellServiceManager] health check failed (${consecutiveHealthFailures}/${WATCHDOG_FAIL_THRESHOLD}): ${e.message}`);
    if (consecutiveHealthFailures >= WATCHDOG_FAIL_THRESHOLD && child) {
      const now = Date.now();
      while (watchdogKillTimes.length && now - watchdogKillTimes[0] > WATCHDOG_KILL_WINDOW_MS) watchdogKillTimes.shift();
      if (watchdogKillTimes.length >= WATCHDOG_MAX_KILLS_IN_WINDOW) {
        console.error(`[amtTellServiceManager] watchdog killed the sidecar ${WATCHDOG_MAX_KILLS_IN_WINDOW} times in 30min -- giving up until the server restarts.`);
        return;
      }
      watchdogKillTimes.push(now);
      console.error('[amtTellServiceManager] sidecar is alive but unresponsive -- killing it so it respawns (it replays the session from the tick file, nothing is lost)');
      consecutiveHealthFailures = 0;
      child.kill('SIGKILL');
    }
  }
}

/** Status for the live-flags banner and the Tell tab. `problem` is a plain-English string when the detector should be running but is not healthy, else null. */
export function getAmtTellStatus({ expectedRunning = true } = {}) {
  const loopAgeSec = lastHealth?.loopAt ? Math.round(Date.now() / 1000 - lastHealth.loopAt) : null;
  let problem = null;
  if (expectedRunning) {
    if (!child) problem = 'the sidecar process is not running';
    else if (lastHealthCheckOk === false) problem = `the sidecar is not answering (${consecutiveHealthFailures} failed health checks)`;
    else if (lastHealthCheckOk === null) problem = null;            // just started, first check pending
    else if (lastHealth?.tickStale) problem = 'the Sierra tick file has stopped growing';
    else if (loopAgeSec != null && loopAgeSec > 120) problem = `the sidecar loop has not run for ${loopAgeSec}s`;
    else if ((lastHealth?.errors || 0) >= 20) problem = `the sidecar logged ${lastHealth.errors} errors (${lastHealth.lastError || 'see log'})`;
  }
  return {
    childAlive: !!child, healthy: lastHealthCheckOk, secondsSinceHealthy: lastHealthOkAtMs ? Math.round((Date.now() - lastHealthOkAtMs) / 1000) : null,
    state: lastHealth?.state ?? null, session: lastHealth?.session ?? null, contract: lastHealth?.contract ?? null, tickStale: !!lastHealth?.tickStale, loopAgeSec,
    lastEvalMs: lastHealth?.lastEvalMs ?? null, errors: lastHealth?.errors ?? null, lastError: lastHealth?.lastError ?? null, rules: lastHealth?.rules ?? null, backlog: lastHealth?.backlog ?? null, problem,
  };
}

let exitHookInstalled = false;
export function startAmtTellService() {
  if (child) return;
  if (!fs.existsSync(SIDECAR_PY)) { console.error(`[amtTellServiceManager] ${SIDECAR_PY} not found -- not starting`); return; }
  if (!exitHookInstalled) { exitHookInstalled = true; process.once('exit', () => { if (child) { try { child.kill('SIGKILL'); } catch { /* already gone */ } } }); }
  spawnChild();
  if (!watchdogTimer) watchdogTimer = setInterval(checkHealthOnce, WATCHDOG_INTERVAL_MS);
}

export function stopAmtTellService() {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (child) { child.kill('SIGKILL'); child = null; }
}
