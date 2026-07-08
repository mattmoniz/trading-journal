#!/bin/bash
cd /home/mmoniz/trading-journal
echo "=== Weekly backtest run: $(date) ==="
/usr/bin/node scripts/backtest_day_type_alpha.js
/usr/bin/node scripts/update_optimal_stops.mjs
/usr/bin/node scripts/backtest_pulse_score.mjs
