# Shared single-instance + systemd-handoff lifecycle helpers for start.sh / restart.sh /
# the backend-only `npm run server` guard (scripts/dev-server-guard.sh). Not directly
# executable -- source it.
#
# Extracted 2026-08-18 after two real, independent gaps in this exact mechanism piled up
# 5 simultaneous nodemon supervisors fighting over port 3002 (one from a post-WSL-reboot
# restart.sh session, three from bare `npm run server` calls across separate Claude Code
# sessions) and tripped trading-journal-server.service into a permanent `failed` state
# mid-RTH: (1) restart.sh had silently drifted out of sync with start.sh -- it duplicated
# cleanup_ports() but never got the "stop systemd first" step start.sh's own comment
# explains is required (systemd's Restart=on-failure resurrects a merely-killed process 5s
# later and crash-loops against whatever just took the port), and had no EXIT trap or
# health monitor either, so an abandoned restart.sh session left port 3002 unrecoverable
# exactly like the pre-2026-07-18 start.sh bug this trap was built to fix. (2) `npm run
# server` (CLAUDE.md's own documented "just the backend" shortcut) went through none of
# this at all -- no systemd stop, no stale-process kill, no handback trap -- so every
# separate session that used it stacked another permanent nodemon supervisor with nothing
# ever cleaning up the previous one. One copy of the logic now, sourced by all three entry
# points, so a fix here can't miss any of them the way restart.sh's silent drift did.

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

  local stuck=0
  for port in "${APP_PORTS[@]}"; do
    if fuser "${port}/tcp" &>/dev/null; then
      echo "  WARNING: port $port still occupied after cleanup"
      stuck=1
    fi
  done
  [ "$stuck" -eq 0 ] && [ "$any" -gt 0 ] && echo "  All ports confirmed free"
}

# Stop the systemd-managed server before touching ports. Killing its process alone isn't
# enough -- systemd's Restart=on-failure resurrects it 5s later, which then hits EADDRINUSE
# against the dev server and crash-loops. systemctl stop actually tells the unit to stop
# trying, not just kills one process.
stop_systemd_server() {
  if systemctl --user is-active --quiet trading-journal-server.service 2>/dev/null; then
    echo "Stopping trading-journal-server.service (dev session takes over port 3002)..."
    systemctl --user stop trading-journal-server.service
  fi
}

# Hand port 3002 back to systemd whenever this dev session ends, by any means -- Ctrl+C,
# the script exiting, or the invoking process just being killed/abandoned outright (e.g. a
# background Claude Code Bash call whose session ends without ever running ./stop.sh).
# Caller must `trap handback_on_exit EXIT INT TERM` itself (a function can't install a trap
# for its caller's shell from inside a sourced file reliably across all callers), so this
# just defines the function; see start.sh/restart.sh/dev-server-guard.sh for the trap line.
handback_on_exit() {
  echo ""
  echo "Dev session ending -- handing port 3002 back to trading-journal-server.service"
  [ -n "$HEALTH_MONITOR_PID" ] && kill "$HEALTH_MONITOR_PID" 2>/dev/null
  pkill -9 -f "concurrently" 2>/dev/null
  pkill -9 -f "nodemon" 2>/dev/null
  pkill -9 -f "vite" 2>/dev/null
  pkill -9 -f "node server/index.js" 2>/dev/null
  systemctl --user start trading-journal-server.service 2>/dev/null
}

# Background health-check monitor. The EXIT trap alone only fires when THIS script's own
# process receives EXIT/INT/TERM -- it does NOT fire when nodemon's own spawned child
# crashes but nodemon itself stays alive (nodemon's documented behavior on a crash is
# "waiting for file changes before starting..." -- it does not keep retrying on its own).
# That leaves port 3002 completely unserved with every visible supervisor process still
# looking "alive". This polls the actual port and self-heals via the same recovery path.
start_health_monitor() {
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
        kill -TERM $$ 2>/dev/null  # signal the parent shell (this script) -> fires the EXIT/INT/TERM trap
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
