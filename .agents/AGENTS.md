# Agent Workspace Rules & Context

Read `docs/ANTIGRAVITY_CONSTRAINTS.md` at the start of every session — it has the hard rules (no static thresholds, CumPL diff P&L, N≥20, no lookahead, read-only DB).

---

## Persistent Watcher Systems

This project has two persistent watcher systems. At session start, verify their status:

### 1. System Error Watcher (`scratch/gemini_error_watcher.mjs`)
- **Purpose:** Three-layer detection every 60s — ring buffer + persistent file + proactive endpoint polling. Writes alerts to `scratch/gemini_alerts.txt`. Auto-restarts the server if down or degraded.
- **Managed by systemd** — do NOT start it manually with `nohup`. Starting it yourself creates duplicate processes.
- **Health Check:**
  ```bash
  systemctl --user is-active trading-journal-watcher.service
  ```
- **If inactive, restart via systemd only:**
  ```bash
  systemctl --user start trading-journal-watcher.service
  ```
- **Check recent alerts:**
  ```bash
  tail -20 /home/mmoniz/trading-journal/scratch/gemini_alerts.txt
  ```

#### Alert types and what to do
| Type | Meaning | Your action |
|---|---|---|
| `SERVER_DOWN` | Server unreachable | Watcher auto-restarts — check `SERVER_RESTARTED` or `SERVER_DOWN_PERSISTENT` that follows |
| `SERVER_RESTARTED` | Watcher restarted server successfully | Log and monitor |
| `SERVER_DOWN_PERSISTENT` | Server still down after restart | Escalate — report to Claude |
| `SERVER_DEGRADED` | ≥3/6 key endpoints returned 500, restart triggered | Investigate which endpoints failed; read relevant route files |
| `SERVER_ERROR` | A route returned HTTP 500 (interceptor caught it) | Investigate the named route; document findings in `scratch/antigravity_response.md` |
| `CLIENT_ERROR` | React ErrorBoundary crash posted to `/api/client-error` | Report component name + error message |
| `ENDPOINT_500` | Proactive probe found a specific endpoint 500ing | Read that route file and document the error |
| `HEALTH_FAIL` | `/api/health` non-200 | Report and monitor |

**Do NOT modify route code.** That's Claude's scope. Your job on any error alert: investigate → document → report.

### 2. Claude Request Watcher (`scratch/check_watcher.mjs`)
- **Purpose:** Detects when Claude has written a new task to `scratch/claude_request.md` by MD5 hash comparison. Run via cron every 5 minutes.
- **Health Check:** `crontab -l | grep check_watcher`
- **If not in crontab, add it:**
  ```bash
  (crontab -l 2>/dev/null; echo "*/5 * * * * /usr/bin/node /home/mmoniz/trading-journal/scratch/check_watcher.mjs >> /home/mmoniz/trading-journal/scratch/gemini_watcher.log 2>&1") | crontab -
  ```

---

## Communication Protocol (Claude ↔ Gemini)

1. **Claude writes** a task to `scratch/claude_request.md` (always includes the AUTONOMOUS header)
2. **Claude invokes Gemini directly** via `./scripts/invoke_gemini.sh` (runs `agy --print < scratch/claude_request.md`)
3. **Gemini executes**, writes ALL output to `scratch/antigravity_response.md`
4. **Claude reads** and validates the response

The `check_watcher.mjs` / cron approach is a fallback — Claude now wakes Gemini directly via the `agy` CLI.

---

## Key File Locations

| File | Purpose |
|---|---|
| `scratch/claude_request.md` | Claude → Gemini task queue |
| `scratch/antigravity_response.md` | Gemini → Claude output |
| `scratch/gemini_alerts.txt` | Error watcher alerts (read by Claude at session start) |
| `scratch/gemini_watcher.log` | Watcher process stdout/stderr |
| `scratch/gemini_watcher.pid` | PID of watcher (for manual reference only — systemd owns the process) |
| `scratch/.claude_request_last_hash` | MD5 of last-seen claude_request.md (used by check_watcher.mjs) |
| `docs/ANTIGRAVITY_CONSTRAINTS.md` | Hard rules — load at every session start |

---

## Chrome/Browser Extension Warnings (MetaMask, etc.)
- **Ignore `contentscript.js` errors:** Warnings containing `ObjectMultiplex`, `app-init-liveness`, `background-liveness`, or `MaxListenersExceededWarning` on `contentscript.js` are injected by browser extensions (like MetaMask) and are **not** bugs in the application. Do **not** attempt to modify project code to fix them.

## Vite Dev Server Proxy Wedging (Port 3000)
- **Proxy socket wedging:** If the backend (port 3002) restarts or goes offline briefly, Vite's proxy connection pool on port 3000 can get stuck. It will continue returning `500 (Internal Server Error)` (with `ECONNREFUSED` / `socket hang up` body) to the browser even after the backend is back up.
- **Resolution procedure:**
  1. Kill all stray processes binding to port 3000 (`lsof -t -i :3000 | xargs kill -9`).
  2. Start a fresh Vite instance: `npm run client` (in the background).
