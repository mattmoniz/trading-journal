#!/bin/bash

# Backend-only single-instance guard, invoked via `npm run server` (package.json).
# CLAUDE.md documents `npm run server` as the routine "just the backend" shortcut, but the
# bare `nodemon server/index.js` it used to run had none of start.sh's safety: no
# systemd-stop-first, no stale-instance kill, no handback-on-exit trap. Found 2026-08-18:
# three separate sessions ran it independently the same day, stacking three permanent
# nodemon supervisors that fought over port 3002 with each other and the systemd-managed
# instance, eventually tripping trading-journal-server.service into a permanent `failed`
# state mid-RTH. This wraps the exact same shared lifecycle logic start.sh/restart.sh/
# stop.sh use so the backend-only path can't drift out of sync with them again.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# start.sh (via `npm start`/`npm run dev` -> concurrently -> `npm run server`) already ran
# the full takeover + owns the top-level EXIT trap and health monitor -- skip re-running all
# of that a second time as a nested subprocess, which would fight its own parent's trap/
# monitor. SERVER_GUARD_PARENT_MANAGED is exported by start.sh right before `npm start`.
if [ -n "$SERVER_GUARD_PARENT_MANAGED" ]; then
  exec nodemon server/index.js
fi

# shellcheck source=lib/server-lifecycle.sh
source "$REPO_ROOT/scripts/lib/server-lifecycle.sh"

stop_systemd_server
cleanup_ports

trap handback_on_exit EXIT INT TERM

start_health_monitor &
HEALTH_MONITOR_PID=$!

nodemon server/index.js
