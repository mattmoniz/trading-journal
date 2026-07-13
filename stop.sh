#!/bin/bash

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

echo "Stopping Trading Journal..."
echo "Checking app ports (${APP_PORTS[*]})..."
cleanup_ports

# Hand port 3002 back to the systemd-managed server (start.sh stops it on dev-session
# start — see the comment there). Without this, the app just goes dark until someone
# manually restarts the service or runs ./start.sh again.
if systemctl --user is-enabled --quiet trading-journal-server.service 2>/dev/null; then
  echo "Restarting trading-journal-server.service..."
  systemctl --user start trading-journal-server.service
fi

echo "Done."
