#!/bin/bash
# Log rotation for the unbounded scratch/ logs (Fable audit F29, 2026-11-10): catch-up log 82 MB, alert file 46 MB, watcher log 9 MB and growing without limit.
# For each file over MAX_MB: gzip a dated copy into scratch/logs_archive/, truncate in place (the writers append with >> / O_APPEND, so truncation is safe), and re-seed
# the newest KEEP_LINES lines so a reader that tails the file still sees recent history. Keeps the 6 newest archives per file. Idempotent; prints what it did.
#   scripts/rotate_logs.sh            rotate files over the limit      scripts/rotate_logs.sh --dry-run   only report
# Weekly from the crontab (Sunday 03:00). Undo: remove the crontab line; archives are plain .gz files in scratch/logs_archive/.
cd "$(dirname "$0")/.." || exit 1
MAX_MB=${ROTATE_MAX_MB:-20}; KEEP_LINES=${ROTATE_KEEP_LINES:-5000}; DRY=0; [ "$1" = "--dry-run" ] && DRY=1
DIR=${ROTATE_DIR:-scratch}; ARCH="$DIR/logs_archive"; mkdir -p "$ARCH"
FILES=(gemini_alerts.txt catchup_price_bars.log gemini_watcher.log price_bars_freshness.log order_lifecycle_health.log daily_calibration.log weekly_backtests.log context_analysis.log session_bias.log confluence_backtest.log)
stamp=$(date +%Y%m%d)
for f in "${FILES[@]}"; do
  p="$DIR/$f"; [ -f "$p" ] || continue
  mb=$(( $(stat -c %s "$p") / 1048576 ))
  if [ "$mb" -lt "$MAX_MB" ]; then echo "keep   $f (${mb} MB)"; continue; fi
  if [ $DRY -eq 1 ]; then echo "would rotate $f (${mb} MB)"; continue; fi
  tmp=$(mktemp); tail -n "$KEEP_LINES" "$p" > "$tmp"
  gzip -c "$p" > "$ARCH/$f.$stamp.gz" && : > "$p" && cat "$tmp" >> "$p"
  rm -f "$tmp"
  ls -1t "$ARCH/$f".*.gz 2>/dev/null | tail -n +7 | xargs -r rm -f
  echo "rotated $f (${mb} MB -> $(( $(stat -c %s "$p") / 1024 )) KB; archive $f.$stamp.gz)"
done
