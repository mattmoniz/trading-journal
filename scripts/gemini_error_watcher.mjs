/**
 * Trading-journal error watcher
 *
 * Three-layer detection every 60 seconds:
 *   1. /api/errors/recent     — in-memory ring buffer (fast, clears on restart)
 *   2. scratch/server_errors.jsonl — persistent file (survives restarts)
 *   3. Key endpoint probing   — directly tests 6 critical endpoints during market hours
 *
 * Auto-restart: if server is unreachable OR ≥3 key endpoints return 500,
 * attempts `systemctl --user restart trading-journal-server.service` (max once/5 min).
 *
 * Alerts → scratch/gemini_alerts.txt (10-min dedup per message)
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ALERTS_FILE = path.join(ROOT, 'scratch', 'gemini_alerts.txt');
const ERRORS_FILE = path.join(ROOT, 'scratch', 'server_errors.jsonl');
const SERVER_URL = 'http://localhost:3002';
const POLL_MS = 60_000;
const DEDUP_MS = 10 * 60 * 1000;
const RESTART_COOLDOWN_MS = 5 * 60 * 1000;

let lastPollTime = new Date(Date.now() - POLL_MS).toISOString();
let lastRestartTs = 0;

const recentKeys = new Map();

function nowStr() {
  return new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
}

function todayDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function isMarketHours() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const h = et.getHours();
  return h >= 6 && h < 18;
}

function writeAlert(type, message) {
  const key = `${type}:${message.slice(0, 120)}`;
  const last = recentKeys.get(key) || 0;
  if (Date.now() - last < DEDUP_MS) return;
  recentKeys.set(key, Date.now());

  const line = `[${nowStr()} ET] [${type}] ${message}\n`;
  fs.appendFileSync(ALERTS_FILE, line, 'utf8');
  console.error(`ALERT: ${line.trim()}`);
}

function tryRestartServer(reason) {
  if (Date.now() - lastRestartTs < RESTART_COOLDOWN_MS) return false;
  lastRestartTs = Date.now();
  try {
    execSync('systemctl --user restart trading-journal-server.service', { stdio: 'ignore', timeout: 15000 });
    return true;
  } catch (e) {
    writeAlert('RESTART_FAILED', `Could not restart server service: ${e.message}`);
    return false;
  }
}

async function checkHealth() {
  try {
    const res = await fetch(`${SERVER_URL}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) writeAlert('HEALTH_FAIL', `HTTP ${res.status} from /api/health`);
  } catch (e) {
    writeAlert('SERVER_DOWN', `Cannot reach ${SERVER_URL} — ${e.message}`);
    const restarted = tryRestartServer('server unreachable');
    if (restarted) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        await fetch(`${SERVER_URL}/api/health`, { signal: AbortSignal.timeout(5000) });
        writeAlert('SERVER_RESTARTED', 'Server was down — restarted via systemctl, now responding');
      } catch {
        writeAlert('SERVER_DOWN_PERSISTENT', 'Server still unreachable after restart attempt');
      }
    }
  }
}

async function checkRingBuffer() {
  try {
    const url = `${SERVER_URL}/api/errors/recent?since=${encodeURIComponent(lastPollTime)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    const { errors } = await res.json();
    for (const e of (errors || [])) {
      writeAlert(e.type || 'ERROR', `${e.message}${e.detail ? ' | ' + e.detail.slice(0, 150) : ''}`);
    }
  } catch (_) {
    // server unreachable — checkHealth() handles it
  }
}

function checkErrorFile() {
  if (!fs.existsSync(ERRORS_FILE)) return;
  try {
    const lines = fs.readFileSync(ERRORS_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const since = new Date(lastPollTime);
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (new Date(e.ts) > since) {
          writeAlert(e.type || 'FILE_ERROR', `${e.message}${e.detail ? ' | ' + e.detail.slice(0, 150) : ''}`);
        }
      } catch (_) {}
    }
  } catch (_) {}
}

async function checkKeyEndpoints() {
  if (!isMarketHours()) return;
  const today = todayDate();
  const endpoints = [
    `/api/morning-brief/forecast/${today}`,
    `/api/morning-brief/live-session-context/${today}`,
    `/api/antigravity/edges-context`,
    `/api/setups/today`,
    `/api/acd/setup-detection`,
    `/api/morning-brief/trade-alerts/${today}`,
  ];

  let failCount = 0;
  const failing = [];
  for (const ep of endpoints) {
    try {
      const res = await fetch(`${SERVER_URL}${ep}`, { signal: AbortSignal.timeout(5000) });
      if (res.status === 500) {
        failCount++;
        failing.push(ep);
        writeAlert('ENDPOINT_500', `GET ${ep} returned 500`);
      }
    } catch (_) {
      // server unreachable — checkHealth() handles it
    }
  }

  if (failCount >= 3) {
    const restarted = tryRestartServer('multiple endpoints degraded');
    if (restarted) {
      writeAlert('SERVER_DEGRADED', `${failCount}/6 key endpoints returned 500 — restarted server: ${failing.join(', ')}`);
    }
  }
}

async function poll() {
  const pollStart = new Date().toISOString();
  await checkHealth();
  await checkRingBuffer();
  checkErrorFile();
  await checkKeyEndpoints();
  lastPollTime = pollStart;
}

// Startup marker
fs.appendFileSync(ALERTS_FILE,
  `\n=== Gemini error watcher started ${nowStr()} ET (PID ${process.pid}) ===\n`,
  'utf8'
);

console.log(`Trading-journal error watcher running. Polling every ${POLL_MS / 1000}s.`);
console.log(`Alerts → ${ALERTS_FILE}`);
console.log(`Server → ${SERVER_URL}`);

poll();
const iv = setInterval(poll, POLL_MS);

// Clean up stale dedup keys every 30 min
setInterval(() => {
  const cutoff = Date.now() - DEDUP_MS;
  for (const [k, t] of recentKeys) {
    if (t < cutoff) recentKeys.delete(k);
  }
}, 30 * 60 * 1000);

process.on('SIGINT', () => {
  clearInterval(iv);
  fs.appendFileSync(ALERTS_FILE,
    `=== Gemini error watcher stopped ${nowStr()} ET ===\n`,
    'utf8'
  );
  process.exit(0);
});
