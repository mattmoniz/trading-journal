#!/usr/bin/env bash
# Dry-recompute (compute_levels.js <date> --dry: prints, writes nothing) for every date in scratch/level_dry_dates_20261027.txt, 2 at a time, one output file per date in scratch/level_dry/.
# Compared against stored level_prices by scripts/diff_level_prices_dry_20261027.mjs. Read-only for level_prices.
cd /home/mmoniz/trading-journal || exit 1
cat scratch/level_dry_dates_20261027.txt | xargs -P 2 -I{} sh -c 'f=scratch/level_dry/{}.txt; [ -s "$f" ] && grep -q "DRY RUN" "$f" || node scripts/compute_levels.js {} --dry > "$f" 2>&1'
echo done
