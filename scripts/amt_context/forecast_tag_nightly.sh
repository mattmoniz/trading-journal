#!/bin/bash
# Nightly outcome-blind forecast tagging (docs/FORECAST_SERVICE_20261102.md). Called from scripts/run_daily_calibration.sh (8:20 PM ET Mon-Fri, after the 17:00 ET session close and the sidecar's FINAL booking), after tag_flips.
# Tags today and the two previous weekdays (idempotent upserts, so an outage or a late finalize is caught up), only for trade dates on or after the forward start. Read-only against live data; writes only
# forecast_points / forecast_tags; never reads P&L or any trade outcome. A failed day is logged and never fails the daily job. Prints COUNTS only (no skill statistic), so nightly runs cannot cause optional stopping.
cd /home/mmoniz/trading-journal
FORWARD_START="2026-11-02"
TODAY="${TAG_TODAY:-$(TZ=America/New_York date +%F)}"      # TAG_TODAY is only for testing
for back in 0 1 2; do
  D=$(date -d "$TODAY - $back day" +%F)
  DOW=$(date -d "$D" +%u)
  if [ "$DOW" -gt 5 ] || [[ "$D" < "$FORWARD_START" ]]; then echo "forecast_tag: skip $D (weekend or before the forward start $FORWARD_START)"; continue; fi
  ./venv/bin/python3 scripts/amt_context/forecast_tag_day.py "$D" || echo "forecast_tag: $D FAILED (exit $?), will be retried by the next nightly run"
done
/usr/bin/node scripts/amt_context/forecast_status.mjs 2>&1 | tail -3
exit 0
