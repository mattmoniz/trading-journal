#!/bin/bash
# Nightly per-second order-book summary (docs/DEPTH_LOGGING_FORWARD_20261104.md; user 2026-11-04 'Yes to both'). Called from scripts/run_daily_calibration.sh (8:20 PM ET Mon-Fri, after the 16:00 RTH close).
# For today and the two previous weekdays (catch-up) it runs scripts/depth_persec_20261021.mjs on that trade date's Sierra .depth file (the largest NQ file of the date in either Sierra data folder) and keeps the RTH per-second
# summary (best bid / ask, resting size at the best and within 10 and 40 ticks each side) in scratch/depth_persec_20261021/DATE.CONTRACT.tsv. FORWARD-ONLY (from 2026-11-04): the depth sessions of 2026-06-15 to 2026-11-03 sit inside the
# sealed hold-out era and are not mined. Outcome-blind (never reads a trade or a P&L), idempotent (an existing file is kept only if it was written after 16:05 ET of its date, so a partial file of an early run is rebuilt),
# a failed day is logged and never fails the daily job. The raw 1 GB a day files are NOT touched or deleted here.
cd /home/mmoniz/trading-journal
FORWARD_START="2026-11-04"
OUT="scratch/depth_persec_20261021"
TODAY="${DEPTH_TODAY:-$(TZ=America/New_York date +%F)}"      # DEPTH_TODAY is only for testing
for back in 0 1 2; do
  D=$(date -d "$TODAY - $back day" +%F)
  DOW=$(date -d "$D" +%u)
  if [ "$DOW" -gt 5 ] || [[ "$D" < "$FORWARD_START" ]]; then echo "depth_persec: skip $D (weekend or before the forward start $FORWARD_START)"; continue; fi
  F=$(ls -S /mnt/c/SierraChart-DTC/Data/MarketDepthData/NQ*."$D".depth /mnt/c/SierraChart/Data/MarketDepthData/NQ*."$D".depth 2>/dev/null | head -1)
  if [ -z "$F" ]; then echo "depth_persec: $D no .depth file found (Sierra not recording that day?)"; continue; fi
  TAG=$(basename "$F" | cut -d. -f1)
  OUTF="$OUT/$D.$TAG.tsv"
  if [ -f "$OUTF" ] && [ "$(stat -c %Y "$OUTF")" -ge "$(TZ=America/New_York date -d "$D 16:05" +%s)" ]; then echo "depth_persec: $D already complete ($OUTF)"; continue; fi
  rm -f "$OUTF"
  /usr/bin/node scripts/depth_persec_20261021.mjs --one "$D" "$F" "$TAG" || echo "depth_persec: $D FAILED (exit $?), will be retried by the next nightly run"
done
echo "depth_persec: summaries on disk since the forward start: $(ls $OUT/2026-1[12]-*.tsv $OUT/2026-1[12]-*.tsv 2>/dev/null | sort -u | awk -F/ '{print $NF}' | awk -F. '{print $1}' | awk '$0 >= "'$FORWARD_START'"' | sort -u | wc -l)"
exit 0
