# Agent Workspace Rules & Context

Read `docs/ANTIGRAVITY_CONSTRAINTS.md` at the start of every session — it has the hard rules (no static thresholds, CumPL diff P&L, N≥20, no lookahead, read-only DB).

---

## Persistent Watcher Systems

This project has two persistent watcher systems. At session start, verify their status:

### 1. System Error Watcher (`scratch/gemini_error_watcher.mjs`)
- **Purpose:** Polls server health and error ring buffer every 60s, writes alerts to `scratch/gemini_alerts.txt`.
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
