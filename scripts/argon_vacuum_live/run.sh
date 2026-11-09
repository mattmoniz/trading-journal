#!/usr/bin/env bash
# Start/stop/status for the Argon live SHADOW detector (docs/ARGON_VACUUM_LIVE_SHADOW_DESIGN_20261108.md). Shadow only: places no orders. Single instance via flock in shadow.py.
# Usage: scripts/argon_vacuum_live/run.sh start|stop|status
cd "$(dirname "$0")/../.." || exit 1
LOG=scratch/argon_vacuum_live/shadow.log; mkdir -p scratch/argon_vacuum_live
case "$1" in
  start) if pgrep -f "^\./venv/bin/python3 -I scripts/argon_vacuum_live/shadow\.py" >/dev/null; then echo "already running"; exit 0; fi
         setsid nohup ./venv/bin/python3 -I scripts/argon_vacuum_live/shadow.py >> "$LOG" 2>&1 < /dev/null & disown; sleep 2; echo started; ;;
  stop)  pkill -f "^\./venv/bin/python3 -I scripts/argon_vacuum_live/shadow\.py" && echo stopped || echo "not running"; ;;
  status) pgrep -af "^\./venv/bin/python3 -I scripts/argon_vacuum_live/shadow\.py" | cut -c1-150; curl -s -m 3 localhost:8905/health | head -c 600; echo; ;;
  *) echo "usage: $0 start|stop|status"; exit 2; ;;
esac
