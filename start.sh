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

npm start
