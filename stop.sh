#!/bin/bash

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/server-lifecycle.sh
source "$REPO_ROOT/scripts/lib/server-lifecycle.sh"

echo "Stopping Trading Journal..."
echo "Checking app ports (${APP_PORTS[*]})..."
cleanup_ports

# Hand port 3002 back to the systemd-managed server (start.sh stops it on dev-session
# start — see server-lifecycle.sh's stop_systemd_server()). Without this, the app just
# goes dark until someone manually restarts the service or runs ./start.sh again.
if systemctl --user is-enabled --quiet trading-journal-server.service 2>/dev/null; then
  echo "Restarting trading-journal-server.service..."
  systemctl --user start trading-journal-server.service
fi

echo "Done."
