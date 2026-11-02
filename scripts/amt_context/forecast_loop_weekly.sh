#!/bin/bash
# Weekly learning-loop step of the shadow forecast service (docs/FORECAST_SERVICE_20261102.md), called from scripts/run_weekly_backtests.sh (Sunday 22:30 ET).
# Prints forward-day COUNTS until the first look (day 40), then runs one non-overlapping look every 20 forward days. Read/write only forecast_models and research_looks (and flag_decision rows); no order, no live-path change, no restart.
# Memory-safe: one process, nice, 4 GB virtual-memory cap (the WSL machine has about 7 GB and shares it with the live server). A failure is reported and never blocks the other weekly steps.
cd /home/mmoniz/trading-journal
( ulimit -v 4000000; nice -n 15 ./venv/bin/python3 scripts/amt_context/forecast_loop.py "$@" ) || { echo "forecast_loop: FAILED (exit $?), will retry next week"; exit 1; }
