#!/bin/bash
set -e

export PGPASSWORD=trader123
PGCMD="psql -h localhost -U trader -d trading_journal -v ON_ERROR_STOP=1"
LOG="/home/mmoniz/trading-journal/scripts/migration_$(date +%Y%m%d_%H%M%S).log"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

log "=== price_bars Partitioning Migration ==="

# Step 1: Create partitioned table
log "Step 1: Creating partitioned table with monthly partitions..."
$PGCMD <<'EOF'
DROP TABLE IF EXISTS price_bars_new CASCADE;

CREATE TABLE price_bars_new (
  id          BIGSERIAL,
  symbol      TEXT           NOT NULL,
  contract    TEXT           NOT NULL,
  ts          TIMESTAMP WITHOUT TIME ZONE NOT NULL,
  open        NUMERIC(12,4)  NOT NULL,
  high        NUMERIC(12,4)  NOT NULL,
  low         NUMERIC(12,4)  NOT NULL,
  close       NUMERIC(12,4)  NOT NULL,
  volume      INTEGER        NOT NULL DEFAULT 0,
  num_trades  INTEGER        NOT NULL DEFAULT 0,
  bid_volume  INTEGER        NOT NULL DEFAULT 0,
  ask_volume  INTEGER        NOT NULL DEFAULT 0,
  PRIMARY KEY (contract, ts)
) PARTITION BY RANGE (ts);

-- Monthly partitions 2022-12 through 2027-12
CREATE TABLE price_bars_2022_12 PARTITION OF price_bars_new FOR VALUES FROM ('2022-12-01') TO ('2023-01-01');
CREATE TABLE price_bars_2023_01 PARTITION OF price_bars_new FOR VALUES FROM ('2023-01-01') TO ('2023-02-01');
CREATE TABLE price_bars_2023_02 PARTITION OF price_bars_new FOR VALUES FROM ('2023-02-01') TO ('2023-03-01');
CREATE TABLE price_bars_2023_03 PARTITION OF price_bars_new FOR VALUES FROM ('2023-03-01') TO ('2023-04-01');
CREATE TABLE price_bars_2023_04 PARTITION OF price_bars_new FOR VALUES FROM ('2023-04-01') TO ('2023-05-01');
CREATE TABLE price_bars_2023_05 PARTITION OF price_bars_new FOR VALUES FROM ('2023-05-01') TO ('2023-06-01');
CREATE TABLE price_bars_2023_06 PARTITION OF price_bars_new FOR VALUES FROM ('2023-06-01') TO ('2023-07-01');
CREATE TABLE price_bars_2023_07 PARTITION OF price_bars_new FOR VALUES FROM ('2023-07-01') TO ('2023-08-01');
CREATE TABLE price_bars_2023_08 PARTITION OF price_bars_new FOR VALUES FROM ('2023-08-01') TO ('2023-09-01');
CREATE TABLE price_bars_2023_09 PARTITION OF price_bars_new FOR VALUES FROM ('2023-09-01') TO ('2023-10-01');
CREATE TABLE price_bars_2023_10 PARTITION OF price_bars_new FOR VALUES FROM ('2023-10-01') TO ('2023-11-01');
CREATE TABLE price_bars_2023_11 PARTITION OF price_bars_new FOR VALUES FROM ('2023-11-01') TO ('2023-12-01');
CREATE TABLE price_bars_2023_12 PARTITION OF price_bars_new FOR VALUES FROM ('2023-12-01') TO ('2024-01-01');
CREATE TABLE price_bars_2024_01 PARTITION OF price_bars_new FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
CREATE TABLE price_bars_2024_02 PARTITION OF price_bars_new FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');
CREATE TABLE price_bars_2024_03 PARTITION OF price_bars_new FOR VALUES FROM ('2024-03-01') TO ('2024-04-01');
CREATE TABLE price_bars_2024_04 PARTITION OF price_bars_new FOR VALUES FROM ('2024-04-01') TO ('2024-05-01');
CREATE TABLE price_bars_2024_05 PARTITION OF price_bars_new FOR VALUES FROM ('2024-05-01') TO ('2024-06-01');
CREATE TABLE price_bars_2024_06 PARTITION OF price_bars_new FOR VALUES FROM ('2024-06-01') TO ('2024-07-01');
CREATE TABLE price_bars_2024_07 PARTITION OF price_bars_new FOR VALUES FROM ('2024-07-01') TO ('2024-08-01');
CREATE TABLE price_bars_2024_08 PARTITION OF price_bars_new FOR VALUES FROM ('2024-08-01') TO ('2024-09-01');
CREATE TABLE price_bars_2024_09 PARTITION OF price_bars_new FOR VALUES FROM ('2024-09-01') TO ('2024-10-01');
CREATE TABLE price_bars_2024_10 PARTITION OF price_bars_new FOR VALUES FROM ('2024-10-01') TO ('2024-11-01');
CREATE TABLE price_bars_2024_11 PARTITION OF price_bars_new FOR VALUES FROM ('2024-11-01') TO ('2024-12-01');
CREATE TABLE price_bars_2024_12 PARTITION OF price_bars_new FOR VALUES FROM ('2024-12-01') TO ('2025-01-01');
CREATE TABLE price_bars_2025_01 PARTITION OF price_bars_new FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
CREATE TABLE price_bars_2025_02 PARTITION OF price_bars_new FOR VALUES FROM ('2025-02-01') TO ('2025-03-01');
CREATE TABLE price_bars_2025_03 PARTITION OF price_bars_new FOR VALUES FROM ('2025-03-01') TO ('2025-04-01');
CREATE TABLE price_bars_2025_04 PARTITION OF price_bars_new FOR VALUES FROM ('2025-04-01') TO ('2025-05-01');
CREATE TABLE price_bars_2025_05 PARTITION OF price_bars_new FOR VALUES FROM ('2025-05-01') TO ('2025-06-01');
CREATE TABLE price_bars_2025_06 PARTITION OF price_bars_new FOR VALUES FROM ('2025-06-01') TO ('2025-07-01');
CREATE TABLE price_bars_2025_07 PARTITION OF price_bars_new FOR VALUES FROM ('2025-07-01') TO ('2025-08-01');
CREATE TABLE price_bars_2025_08 PARTITION OF price_bars_new FOR VALUES FROM ('2025-08-01') TO ('2025-09-01');
CREATE TABLE price_bars_2025_09 PARTITION OF price_bars_new FOR VALUES FROM ('2025-09-01') TO ('2025-10-01');
CREATE TABLE price_bars_2025_10 PARTITION OF price_bars_new FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');
CREATE TABLE price_bars_2025_11 PARTITION OF price_bars_new FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');
CREATE TABLE price_bars_2025_12 PARTITION OF price_bars_new FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');
CREATE TABLE price_bars_2026_01 PARTITION OF price_bars_new FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE price_bars_2026_02 PARTITION OF price_bars_new FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE price_bars_2026_03 PARTITION OF price_bars_new FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE price_bars_2026_04 PARTITION OF price_bars_new FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE price_bars_2026_05 PARTITION OF price_bars_new FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE price_bars_2026_06 PARTITION OF price_bars_new FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE price_bars_2026_07 PARTITION OF price_bars_new FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE price_bars_2026_08 PARTITION OF price_bars_new FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE price_bars_2026_09 PARTITION OF price_bars_new FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE price_bars_2026_10 PARTITION OF price_bars_new FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE price_bars_2026_11 PARTITION OF price_bars_new FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE price_bars_2026_12 PARTITION OF price_bars_new FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE price_bars_2027_01 PARTITION OF price_bars_new FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE price_bars_2027_02 PARTITION OF price_bars_new FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE price_bars_2027_03 PARTITION OF price_bars_new FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE price_bars_2027_04 PARTITION OF price_bars_new FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE price_bars_2027_05 PARTITION OF price_bars_new FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE price_bars_2027_06 PARTITION OF price_bars_new FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE price_bars_2027_07 PARTITION OF price_bars_new FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');
CREATE TABLE price_bars_2027_08 PARTITION OF price_bars_new FOR VALUES FROM ('2027-08-01') TO ('2027-09-01');
CREATE TABLE price_bars_2027_09 PARTITION OF price_bars_new FOR VALUES FROM ('2027-09-01') TO ('2027-10-01');
CREATE TABLE price_bars_2027_10 PARTITION OF price_bars_new FOR VALUES FROM ('2027-10-01') TO ('2027-11-01');
CREATE TABLE price_bars_2027_11 PARTITION OF price_bars_new FOR VALUES FROM ('2027-11-01') TO ('2027-12-01');
CREATE TABLE price_bars_2027_12 PARTITION OF price_bars_new FOR VALUES FROM ('2027-12-01') TO ('2028-01-01');
EOF
log "Partitioned table created."

# Step 2: Record current max ts before copy
MAX_TS=$($PGCMD -t -c "SELECT MAX(ts) FROM price_bars;" | tr -d ' \n')
log "Max ts before copy: $MAX_TS"

# Step 3: Copy all data
log "Step 2: Copying all rows (this takes 1-2 min)..."
$PGCMD -c "INSERT INTO price_bars_new (id, symbol, contract, ts, open, high, low, close, volume, num_trades, bid_volume, ask_volume) SELECT id, symbol, contract, ts, open, high, low, close, volume, num_trades, bid_volume, ask_volume FROM price_bars;"
log "Copy complete."

# Step 4: Rebuild indexes
log "Step 3: Building indexes on new table..."
$PGCMD <<'EOF'
CREATE INDEX idx_price_bars_new_symbol_ts   ON price_bars_new (symbol, ts);
CREATE INDEX idx_price_bars_new_symbol_date ON price_bars_new (symbol, (ts::date));
CREATE INDEX idx_price_bars_new_contract    ON price_bars_new (contract);
CREATE INDEX idx_price_bars_new_ts          ON price_bars_new (ts);
EOF
log "Indexes built."

# Step 5: Verify row counts
OLD_COUNT=$($PGCMD -t -c "SELECT COUNT(*) FROM price_bars;" | tr -d ' ')
NEW_COUNT=$($PGCMD -t -c "SELECT COUNT(*) FROM price_bars_new;" | tr -d ' ')
log "Row count check — old: $OLD_COUNT  new: $NEW_COUNT"
if [ "$OLD_COUNT" != "$NEW_COUNT" ]; then
  log "ERROR: Row count mismatch! Aborting. Old table untouched."
  exit 1
fi

# Step 6: Atomic rename + catch-up in one transaction
log "Step 4: Renaming tables (atomic)..."
$PGCMD <<EOF
BEGIN;
ALTER TABLE price_bars     RENAME TO price_bars_old;
ALTER TABLE price_bars_new RENAME TO price_bars;
-- Catch up any rows written to old table after our copy
INSERT INTO price_bars (id, symbol, contract, ts, open, high, low, close, volume, num_trades, bid_volume, ask_volume)
  SELECT id, symbol, contract, ts, open, high, low, close, volume, num_trades, bid_volume, ask_volume
  FROM price_bars_old
  WHERE ts > '$MAX_TS'
ON CONFLICT (contract, ts) DO NOTHING;
COMMIT;
EOF
log "Rename complete. price_bars is now partitioned."

# Step 7: Final verification
FINAL_COUNT=$($PGCMD -t -c "SELECT COUNT(*) FROM price_bars;" | tr -d ' ')
PARTITION_COUNT=$($PGCMD -t -c "SELECT COUNT(*) FROM pg_inherits WHERE inhparent = 'price_bars'::regclass;" | tr -d ' ')
log "Final count: $FINAL_COUNT rows across $PARTITION_COUNT partitions."

# Step 8: Confirm partition pruning works
$PGCMD -c "EXPLAIN (COSTS OFF) SELECT count(*) FROM price_bars WHERE ts::date = CURRENT_DATE;" | tee -a "$LOG"

log "=== Migration complete. Log: $LOG ==="
log "Old table preserved as price_bars_old — drop it after confirming app works."
