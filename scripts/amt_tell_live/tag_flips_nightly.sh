#!/bin/bash
# Nightly outcome-blind delta-flip tagging of the live tell fires (scripts/amt_vbars/PREREG_FLIP_DISAGREE_FORWARD.md, frozen 2026-11-01). Called from scripts/run_daily_calibration.sh (8:20 PM ET, Mon-Fri,
# after the 17:00 ET session close and the sidecar's FINAL booking). Tags today and the two previous weekdays (idempotent upsert, so an outage or a late finalize is caught up), only for trade dates on or
# after the forward start. Read-only against live data; writes only amt_tell_flip_tags; never reads any outcome column. A failed day is logged and never fails the daily job.
cd /home/mmoniz/trading-journal
FORWARD_START="2026-11-02"
TODAY="${TAG_TODAY:-$(TZ=America/New_York date +%F)}"      # TAG_TODAY is only for testing
for back in 0 1 2; do
  D=$(date -d "$TODAY - $back day" +%F)
  DOW=$(date -d "$D" +%u)                                   # 1..5 = Mon..Fri
  if [ "$DOW" -gt 5 ] || [[ "$D" < "$FORWARD_START" ]]; then echo "tag_flips: skip $D (weekend or before the forward start $FORWARD_START)"; continue; fi
  ./venv/bin/python3 scripts/amt_tell_live/tag_flips_day.py "$D" || echo "tag_flips: $D FAILED (exit $?), will be retried by the next nightly run"
done
# count-only line (no outcome statistic is ever printed here, so nightly runs cannot cause optional stopping); says when a milestone is reached
/usr/bin/node scripts/report_flip_disagree_forward.mjs --count 2>&1 | tail -2
exit 0
