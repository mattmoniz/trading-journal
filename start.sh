#!/bin/bash

# Self-heal the pre-commit hook symlink (.git/hooks/ isn't tracked by git, so a fresh
# clone won't have it — this makes it reappear on the next ./start.sh instead of
# silently missing forever).
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ ! -e "$REPO_ROOT/.git/hooks/pre-commit" ]; then
  ln -sf ../../scripts/git-hooks/pre-commit "$REPO_ROOT/.git/hooks/pre-commit"
fi

APP_PORTS=(3000 3001 3002 5173)

cleanup_ports() {
  local any=0
  for port in "${APP_PORTS[@]}"; do
    local pid
    pid=$(fuser "${port}/tcp" 2>/dev/null)
    if [ -n "$pid" ]; then
      local cmd
      cmd=$(ps -p "$pid" -o comm= 2>/dev/null || echo "unknown")
      echo "  Port $port in use by PID $pid ($cmd) — killing"
      fuser -k "${port}/tcp" 2>/dev/null
      any=1
    fi
  done
  [ "$any" -eq 0 ] && echo "  All app ports clear"

  pkill -9 -f "concurrently" 2>/dev/null
  pkill -9 -f "nodemon"      2>/dev/null
  pkill -9 -f "vite"         2>/dev/null
  pkill -9 -f "node server/index.js" 2>/dev/null
  sleep 1

  # Verify
  local stuck=0
  for port in "${APP_PORTS[@]}"; do
    if fuser "${port}/tcp" &>/dev/null; then
      echo "  WARNING: port $port still occupied after cleanup"
      stuck=1
    fi
  done
  [ "$stuck" -eq 0 ] && [ "$any" -gt 0 ] && echo "  All ports confirmed free"
}

echo "Starting Trading Journal..."

# Stop the systemd-managed server before touching ports. Killing its process alone
# (via cleanup_ports below) isn't enough -- systemd's Restart=on-failure resurrects it
# 5s later, which then hits EADDRINUSE against the dev server and crash-loops forever
# every 5s (found 2026-07-13: restart counter was at 9310 when this was diagnosed).
# systemctl stop actually tells the unit to stop trying, not just kills one process.
if systemctl --user is-active --quiet trading-journal-server.service 2>/dev/null; then
  echo "Stopping trading-journal-server.service (dev session takes over port 3002)..."
  systemctl --user stop trading-journal-server.service
fi

# Hand port 3002 back to systemd whenever this dev session ends, by any means --
# Ctrl+C, the script exiting, or (critically) the invoking process just being killed/
# abandoned outright, e.g. a background Claude Code Bash call whose session ends
# without ever running ./stop.sh. Found 2026-07-18: exactly that happened -- a prior
# session's `./start.sh` (nodemon+vite) was left running unsupervised all night,
# stopped the systemd unit on takeover per the comment above, then was never cleaned
# up -- so the app silently went dark the moment nodemon's own child eventually died,
# with nothing left to restart it (systemd had been told to stop, not crash, so its
# own Restart=on-failure never kicked in either). This trap is the structural fix:
# it fires on normal exit AND on SIGINT/SIGTERM, so an abandoned/killed session still
# hands the port back instead of leaving both supervisors dark.
recover_and_exit() {
  echo ""
  echo "Dev session ending -- handing port 3002 back to trading-journal-server.service"
  [ -n "$HEALTH_MONITOR_PID" ] && kill "$HEALTH_MONITOR_PID" 2>/dev/null
  pkill -9 -f "concurrently" 2>/dev/null
  pkill -9 -f "nodemon" 2>/dev/null
  pkill -9 -f "vite" 2>/dev/null
  pkill -9 -f "node server/index.js" 2>/dev/null
  systemctl --user start trading-journal-server.service 2>/dev/null
}
trap recover_and_exit EXIT INT TERM

echo "Checking app ports (${APP_PORTS[*]})..."
cleanup_ports

# Ensure PostgreSQL is running
if ! pg_isready -q; then
    echo "PostgreSQL not running — start it with: sudo service postgresql start"
    exit 1
fi

echo "Frontend:  http://localhost:5173"
echo "Backend:   http://localhost:3002/api"
echo "Press Ctrl+C to stop"
echo ""

# Background health-check monitor (2026-08-09). Found the trap above, while structurally
# correct, has a real blind spot: it only fires when THIS script's own process receives
# EXIT/INT/TERM -- it does NOT fire when `nodemon`'s own spawned child crashes but nodemon
# itself (and concurrently, and vite) stay alive. nodemon's documented behavior on a crash
# is "waiting for file changes before starting..." -- it does NOT keep retrying on its own,
# so a single crash (an uncaught exception, or a port race against systemd if something
# elsewhere restarts trading-journal-server.service while this session is still up) leaves
# port 3002 completely unserved, with every visible supervisor process (`ps`, even
# `systemctl --user status`-style checks on this script's own liveness) still looking
# healthy. Confirmed real: exactly this happened 2026-08-05 through 2026-08-09 -- the
# managed systemd service logged 114,824 consecutive EADDRINUSE failures against this
# exact failure mode, for 4 days, completely undetected. This monitor polls the actual
# port (not just "is the process alive") and self-heals via the same recovery path the
# EXIT trap uses -- treating "nodemon gave up and the port is dark" as equivalent to "the
# dev session ended," which is what it functionally is from the app's perspective.
health_monitor() {
  local grace=45     # seconds to allow for a normal cold start before the first check counts
  local interval=15  # seconds between checks once past the grace period
  local miss_limit=3 # consecutive misses (45s of real downtime) before treating it as dead
  local misses=0
  local ever_up=0
  sleep "$grace"
  while true; do
    if (exec 3<>"/dev/tcp/localhost/3002") 2>/dev/null; then
      exec 3>&- 2>/dev/null
      misses=0
      ever_up=1
    else
      misses=$((misses + 1))
      if [ "$ever_up" -eq 1 ] && [ "$misses" -ge "$miss_limit" ]; then
        echo ""
        echo "⚠ Dev server on :3002 has not responded for $((interval * miss_limit))s (nodemon likely crashed and gave up -- it does not auto-retry without a file change). Self-healing: handing the port back to trading-journal-server.service instead of leaving this session silently dark."
        kill -TERM $$ 2>/dev/null  # signal the parent shell (this script) -> fires recover_and_exit via the EXIT/INT/TERM trap
        exit 0
      elif [ "$ever_up" -eq 0 ] && [ "$misses" -ge $((miss_limit * 2)) ]; then
        echo ""
        echo "⚠ Dev server on :3002 never came up within $((grace + interval * misses))s of starting -- likely a real startup failure, not a transient race. Self-healing: handing the port back to trading-journal-server.service."
        kill -TERM $$ 2>/dev/null
        exit 0
      fi
    fi
    sleep "$interval"
  done
}
health_monitor &
HEALTH_MONITOR_PID=$!

npm start
