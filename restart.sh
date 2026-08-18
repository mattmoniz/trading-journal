#!/bin/bash

# Thin wrapper around start.sh (2026-08-18). Used to duplicate start.sh's cleanup_ports()
# logic by hand and had silently drifted out of sync with it -- missing the "stop systemd
# first" step (without it, systemd's Restart=on-failure resurrects the just-killed managed
# process 5s later and crash-loops against this script's own dev server) and missing the
# EXIT-trap/health-monitor handback entirely, so an abandoned restart.sh session left port
# 3002 with no path back to the systemd-managed server. "Stop + start in one command" is
# exactly what start.sh already does on every invocation (it unconditionally tears down
# and re-takes the port), so delegating here removes the duplicate-script drift risk for
# good rather than re-fixing it a second time.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "Restarting Trading Journal..."
exec "$REPO_ROOT/start.sh"
