#!/usr/bin/env bash
# Start/stop/status for the LIVE detector of the user's original expansion rule (scripts/vacuum_live/shadow.py). Shadow only: places no orders. Single instance (flock in shadow.py). Usage: run.sh start|stop|status
cd "$(dirname "$0")/../.." || exit 1
LOG=scratch/vacuum_live/shadow.log; mkdir -p scratch/vacuum_live; PAT='^\./venv/bin/python3 -I scripts/vacuum_live/shadow\.py'
case "$1" in
  start) if pgrep -f "$PAT" >/dev/null; then echo "already running"; exit 0; fi
         setsid nohup ./venv/bin/python3 -I scripts/vacuum_live/shadow.py >> "$LOG" 2>&1 < /dev/null & disown; sleep 2; echo started ;;
  stop)  pkill -f "$PAT" && echo stopped || echo "not running" ;;
  status) pgrep -af "$PAT" | cut -c1-150; curl -s -m 3 localhost:8906/health | head -c 700; echo ;;
  *) echo "usage: $0 start|stop|status"; exit 2 ;;
esac
