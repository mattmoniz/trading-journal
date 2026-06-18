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

echo "Starting Trading Journal..."
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
