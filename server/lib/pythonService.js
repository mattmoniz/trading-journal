// Generic supervisor for ONE long-lived Python child that answers GET /health on a local port. Same pattern as amtTellServiceManager.js / mlScoringServiceManager.js (single child, restart-burst guard,
// stale-process reaper limited to OUR script, health watchdog) extracted so a new service does not add a third near-copy; the two older managers still carry their own copies (migration noted in
// docs/OPEN_THREADS.md). A wedged child is killed so it respawns; the services built on it are stateless replays of an external file, so nothing is lost by a restart.
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PYTHON_BIN = path.join(REPO_ROOT, 'venv', 'bin', 'python3');
const RESTART_DELAY_MS = 5000, GIVE_UP_RETRY_MS = 5 * 60 * 1000, MAX_RAPID_RESTARTS = 5, WATCHDOG_INTERVAL_MS = 15000, WATCHDOG_FAIL_THRESHOLD = 4;
const WATCHDOG_KILL_WINDOW_MS = 30 * 60 * 1000, WATCHDOG_MAX_KILLS_IN_WINDOW = 4;

/** @param {{name:string, script:string, port:number, args?:string[], logPrefix:string}} cfg  script is relative to the repo root. Returns {start, stop, status}. */
export function createPythonService({ name, script, port, args = [], logPrefix }) {
  const scriptPath = path.join(REPO_ROOT, script), healthUrl = `http://127.0.0.1:${port}/health`;
  let child = null, restartTimer = null, watchdogTimer = null, recent = [], fails = 0, lastHealth = null, lastOk = null, lastOkAt = null, exitHook = false;
  const kills = [];
  const tag = `[${name}]`;

  function reapStale() {
    let out = '';
    try { out = execFileSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8', timeout: 3000 }); } catch { return; }
    for (const m of out.matchAll(/pid=(\d+)/g)) {
      const pid = Number(m[1]); if (!pid || pid === process.pid || (child && child.pid === pid)) continue;
      try {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
        if (!cmd.includes(script)) { console.error(`${tag} port ${port} is held by pid ${pid} which is NOT ${script} -- leaving it alone: ${cmd.slice(0, 120)}`); continue; }
        process.kill(pid, 'SIGKILL'); console.error(`${tag} killed stale ${script} pid ${pid} holding port ${port}`);
      } catch (e) { console.error(`${tag} could not inspect/kill pid ${pid}: ${e.message}`); }
    }
  }
  function spawnChild() {
    if (child) return; if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    reapStale();
    child = spawn(PYTHON_BIN, [scriptPath, '--port', String(port), ...args], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (b) => process.stdout.write(b)); child.stderr.on('data', (b) => process.stderr.write(`${logPrefix}:err] ${b}`));
    child.on('exit', (code, signal) => {
      console.error(`${tag} child exited (code=${code}, signal=${signal})`); child = null; lastOk = false;
      const now = Date.now(); recent = recent.filter((t) => now - t < 60000); recent.push(now);
      if (recent.length > MAX_RAPID_RESTARTS) { console.error(`${tag} ${MAX_RAPID_RESTARTS}+ restarts in 60s -- backing off ${GIVE_UP_RETRY_MS / 60000} min`); recent = []; restartTimer = setTimeout(spawnChild, GIVE_UP_RETRY_MS); return; }
      restartTimer = setTimeout(spawnChild, RESTART_DELAY_MS);
    });
  }
  async function checkHealth() {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) }); if (!res.ok) throw new Error(`HTTP ${res.status}`);
      lastHealth = await res.json(); fails = 0; lastOk = true; lastOkAt = Date.now();
    } catch (e) {
      fails++; lastOk = false;
      if (fails === 1 || fails % 10 === 0) console.error(`${tag} health check failed (${fails}/${WATCHDOG_FAIL_THRESHOLD}): ${e.message}`);
      if (fails >= WATCHDOG_FAIL_THRESHOLD && child) {
        const now = Date.now(); while (kills.length && now - kills[0] > WATCHDOG_KILL_WINDOW_MS) kills.shift();
        if (kills.length >= WATCHDOG_MAX_KILLS_IN_WINDOW) { console.error(`${tag} watchdog killed the child ${WATCHDOG_MAX_KILLS_IN_WINDOW} times in 30 min -- giving up until the server restarts.`); return; }
        kills.push(now); fails = 0; console.error(`${tag} child is alive but unresponsive -- killing it so it respawns`); child.kill('SIGKILL');
      }
    }
  }
  return {
    start() {
      if (child) return; if (!fs.existsSync(scriptPath)) { console.error(`${tag} ${scriptPath} not found -- not starting`); return; }
      if (!exitHook) { exitHook = true; process.once('exit', () => { if (child) { try { child.kill('SIGKILL'); } catch { /* already gone */ } } }); }
      spawnChild(); if (!watchdogTimer) watchdogTimer = setInterval(checkHealth, WATCHDOG_INTERVAL_MS);
    },
    stop() { if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; } if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; } if (child) { child.kill('SIGKILL'); child = null; } },
    status() {
      const loopAgeSec = lastHealth?.loopAt ? Math.round(Date.now() / 1000 - lastHealth.loopAt) : null; let problem = null;
      if (!child) problem = 'the process is not running'; else if (lastOk === false) problem = `not answering (${fails} failed health checks)`; else if (loopAgeSec != null && loopAgeSec > 120) problem = `loop has not run for ${loopAgeSec}s`;
      else if ((lastHealth?.errors || 0) >= 20) problem = `${lastHealth.errors} errors (${lastHealth.lastError || 'see log'})`;
      else if ((lastHealth?.parityFailures || 0) > 0) problem = `${lastHealth.parityFailures} shadow parity failure(s): book A no longer reproduces the tell`;
      else if ((lastHealth?.stuck || 0) > 0) problem = `${lastHealth.stuck} fire(s) are waiting for bars they never reached (reader stuck)`;
      return { childAlive: !!child, healthy: lastOk, secondsSinceHealthy: lastOkAt ? Math.round((Date.now() - lastOkAt) / 1000) : null, state: lastHealth?.state ?? null, session: lastHealth?.session ?? null, rows: lastHealth?.rows ?? null, pending: lastHealth?.pending ?? null, stuck: lastHealth?.stuck ?? null, watcher: lastHealth?.watcher ?? null, parityFailures: lastHealth?.parityFailures ?? null, loopAgeSec, errors: lastHealth?.errors ?? null, lastError: lastHealth?.lastError ?? null, problem };
    },
  };
}
