#!/usr/bin/env bash
# Recomputes level_prices for the dates in scratch/level_repair_dates_20261027.txt with the production script (scripts/compute_levels.js <date>, an upsert). Backup of the whole table before this ran:
# level_prices_repair_backup_20261027 (see docs/DB_BACKUP_CATALOG.md). Sequential (each date is about 20 seconds). Re-run scripts/audit_level_prices_integrity_20261027.mjs afterwards.
cd /home/mmoniz/trading-journal || exit 1
n=0; while read -r d; do [ -z "$d" ] && continue; node scripts/compute_levels.js "$d" > /dev/null 2>&1 && echo "$d ok" || echo "$d FAILED"; n=$((n+1)); done < scratch/level_repair_dates_20261027.txt
echo "done $n"
