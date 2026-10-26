#!/usr/bin/env bash
# Nightly ES (E-mini S&P) 1-minute bar refresh (2026-10-26, user: "do the fix ... I have a live feed for ES as well going").
# Keeps price_bars_es / es_front_calendar current from the live Sierra DTC-folder tick files so the frozen ES-confirmation lead
# (OPEN_DECISION es_confirming_fade_lead_needs_forward_test_20261026) can be scored on new days. Observation/research data only:
# nothing live reads price_bars_es. Reuses the SAME builder and loader that built the history (build_1m_bars_from_scid.py, load_es_bars.mjs).
#   - Contracts = every ES[HMUZ]yy.scid in the DTC folder written in the last 3 days (so a new quarter is picked up by itself at the roll).
#   - Window = from 2 days before that contract's newest stored bar (7 days back if it has none) through today; the loader is idempotent.
#   - The newest minute in the file may still be forming, so the last CSV row is dropped (the next run re-adds it complete).
# Plain prices (price_scale 1, plausibility 3000-9000 after scaling, as in scratch/es_bars/build_2026.sh).
cd /home/mmoniz/trading-journal || exit 1
DATA="${SIERRA_ES_DATA_DIR:-/mnt/c/SierraChart-DTC/Data}"
OUT=scratch/es_bars_refresh
mkdir -p "$OUT" && rm -f "$OUT"/ES*.csv
found=0
for f in $(find "$DATA" -maxdepth 1 -name 'ES[HMUZ][0-9][0-9].scid' -mtime -3 | sort); do
  base=$(basename "$f" .scid)            # ESZ26
  contract="${base:0:3}${base:4:1}"      # ESZ6 (one-digit year, the table's convention)
  last=$(node -e "import('./server/db.js').then(async ({query})=>{const r=await query(\"SELECT COALESCE((MAX(ts)::date - 2)::text, (CURRENT_DATE - 7)::text) d FROM price_bars_es WHERE contract='$contract'\");console.log(r.rows[0].d);process.exit(0)})" 2>/dev/null | tail -1)
  [ -z "$last" ] && { echo "ES refresh: could not read last stored date for $contract" >&2; exit 1; }
  end=$(date +%F -d tomorrow)
  python3 scripts/tick_microstructure/build_1m_bars_from_scid.py "$f" "$last" "$end" "$OUT/$contract.csv" 1 3000 9000 || { echo "ES refresh: build failed for $contract" >&2; exit 1; }
  head -n -1 "$OUT/$contract.csv" > "$OUT/$contract.tmp" && mv "$OUT/$contract.tmp" "$OUT/$contract.csv"
  found=$((found+1))
done
[ "$found" -eq 0 ] && { echo "ES refresh: no ES .scid file in $DATA written in the last 3 days (is Sierra running with the ES chart/feed?)" >&2; exit 1; }
node scripts/load_es_bars.mjs --csv-dir "$OUT" || exit 1
node -e "import('./server/db.js').then(async ({query})=>{const r=await query(\"SELECT contract, MAX(ts)::text last, (NOW()::timestamp - MAX(ts)) age FROM price_bars_es GROUP BY 1 ORDER BY MAX(ts) DESC LIMIT 1\");console.log('ES refresh: newest stored bar',JSON.stringify(r.rows[0]));process.exit(0)})" 2>/dev/null | tail -1
