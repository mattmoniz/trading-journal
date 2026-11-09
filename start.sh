#!/bin/bash

# Self-heal the pre-commit hook symlink (.git/hooks/ isn't tracked by git, so a fresh
# clone won't have it — this makes it reappear on the next ./start.sh instead of
# silently missing forever).
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ ! -e "$REPO_ROOT/.git/hooks/pre-commit" ]; then
  ln -sf ../../scripts/git-hooks/pre-commit "$REPO_ROOT/.git/hooks/pre-commit"
fi

# shellcheck source=scripts/lib/server-lifecycle.sh
source "$REPO_ROOT/scripts/lib/server-lifecycle.sh"

echo "Starting Trading Journal..."

stop_systemd_server

trap handback_on_exit EXIT INT TERM

echo "Checking app ports (${APP_PORTS[*]})..."
cleanup_ports

# Ensure PostgreSQL is running
if ! pg_isready -q; then
    echo "PostgreSQL not running — start it with: sudo service postgresql start"
    exit 1
fi

# Argon liquidity-vacuum LIVE SHADOW daemon (docs/ARGON_VACUUM_LIVE_SHADOW_DESIGN_20261108.md): watch only, places no orders, single instance (flock), detached, so it outlives this script. Idempotent: a no-op when already running.
"$REPO_ROOT/scripts/argon_vacuum_live/run.sh" start >/dev/null 2>&1 || true

echo "Frontend:  http://localhost:5173"
echo "Backend:   http://localhost:3002/api"
echo "Press Ctrl+C to stop"
echo ""

start_health_monitor &
HEALTH_MONITOR_PID=$!

# Tells the nested `npm run server` -> dev-server-guard.sh (invoked via concurrently below)
# that this top-level script already did the takeover/trap/health-monitor -- see the guard
# script's own check.
export SERVER_GUARD_PARENT_MANAGED=1
npm start
