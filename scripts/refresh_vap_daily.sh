#!/usr/bin/env bash
# Nightly tick volume-at-price refresh (2026-10-26): keeps volume_at_price_daily / volume_at_price_days current (see server/services/tickVolumeProfile.js).
# Dumps the database's per-session volume (reconciliation target), builds the last 4 calendar days from the Sierra tick files (skips dates already built; a date whose tick
# volume does not match the database within 3 percent is NOT written and is reported), then loads. Idempotent. Research data only: nothing live reads it yet.
cd /home/mmoniz/trading-journal || exit 1
node scripts/dump_db_session_volume.mjs > /dev/null 2>&1 || { echo "VAP refresh: db volume dump failed" >&2; exit 1; }
START=$(date +%F -d "4 days ago"); END=$(date +%F)
python3 scripts/tick_microstructure/build_vap_daily_20261026.py "$START" "$END" | grep -v " ok \| exists" | grep -v "no-db-volume" | sed 's/^/VAP refresh: /' >&2
node scripts/load_vap_daily.mjs "$START" "$END" 2>&1 | tail -1
python3 scripts/tick_microstructure/build_vap_30m_20261026.py "$START" "$END" | grep -v " ok \| exists\|no-daily-file" | sed 's/^/VAP 30m refresh: /' >&2
node scripts/load_vap_30m.mjs "$START" "$END" 2>&1 | tail -1
python3 scripts/tick_microstructure/build_vap_30m_ba_20261026.py "$START" "$END" | grep -v " ok \| exists\|no-daily-file" | sed 's/^/VAP bid-ask refresh: /' >&2
node scripts/load_vap_30m_ba.mjs "$START" "$END" 2>&1 | tail -1
node -e "import('./server/db.js').then(async ({query})=>{const r=await query(\"SELECT MAX(trade_date)::text d, (CURRENT_DATE - MAX(trade_date)) age FROM volume_at_price_days\");console.log('VAP refresh: newest loaded trade date',JSON.stringify(r.rows[0]));process.exit(0)})" 2>/dev/null | tail -1
