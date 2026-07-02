/**
 * AUTONOMOUS — Gemini error watcher for trading-journal
 *
 * Polls the app every 60 seconds for:
 *   1. /api/health — server up/down
 *   2. /api/errors/recent?since=<ISO> — server-side errors (500s, client crashes)
 *      recorded by the in-memory ring buffer in server/index.js
 *
 * Writes NEW alerts to scratch/gemini_alerts.txt so Claude can read them at
 * the start of the next session or on demand.
 *
 * Run with:   node scratch/gemini_error_watcher.mjs
 * Stop with:  Ctrl-C  (or TaskStop if inside an Agent)
 *
 * Does NOT write duplicate alerts for the same error within a 10-minute window.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ALERTS_FILE = path.join(ROOT, 'scratch', 'gemini_alerts.txt');
const SERVER_URL = 'http://localhost:3002';
const POLL_MS = 60_000;

// Track the last time we polled so we only request new errors
let lastPollTime = new Date(Date.now() - POLL_MS).toISOString();

// Dedup: suppress identical error messages within 10 min
const recentKeys = new Map();
const DEDUP_MS = 10 * 60 * 1000;

function nowStr() {
  return new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
}

function writeAlert(type, message) {
  const key = `${type}:${message.slice(0, 120)}`;
  const last = recentKeys.get(key) || 0;
  if (Date.now() - last < DEDUP_MS) return;
  recentKeys.set(key, Date.now());

  const line = `[${nowStr()} ET] [${type}] ${message}\n`;
  fs.appendFileSync(ALERTS_FILE, line, 'utf8');
  console.error(`ALERT WRITTEN: ${line.trim()}`);
}

async function checkHealth() {
  try {
    const res = await fetch(`${SERVER_URL}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) writeAlert('HEALTH_FAIL', `HTTP ${res.status} from /api/health`);
  } catch (e) {
    writeAlert('SERVER_DOWN', `Cannot reach ${SERVER_URL} — ${e.message}`);
  }
}

async function checkErrors() {
  try {
    const url = `${SERVER_URL}/api/errors/recent?since=${encodeURIComponent(lastPollTime)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    const { errors } = await res.json();
    for (const e of (errors || [])) {
      writeAlert(e.type || 'ERROR', `${e.message}${e.detail ? ' | ' + e.detail.slice(0, 150) : ''}`);
    }
  } catch (_) {
    // server unreachable — checkHealth() will catch it
  }
}

async function poll() {
  const pollStart = new Date().toISOString();
  await checkHealth();
  await checkErrors();
  lastPollTime = pollStart; // advance window after each successful poll
}

// Write a startup marker
fs.appendFileSync(ALERTS_FILE,
  `\n=== Gemini error watcher started ${nowStr()} ET (PID ${process.pid}) ===\n`,
  'utf8'
);

console.log(`Trading-journal error watcher running. Polling every ${POLL_MS / 1000}s.`);
console.log(`Alerts → ${ALERTS_FILE}`);
console.log(`Server → ${SERVER_URL}`);

// Run immediately, then on interval
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
