#!/bin/bash
# (Re)creates the scratch schema `harness` inside trading_journal for the order-path tests (scripts/test_order_path_harness.mjs).
# READS the live schema with pg_dump (schema only, no rows), rewrites public. -> harness., and loads it. Never writes to `public`.
# The tests run with search_path=harness (scripts/lib/orderPathHarnessEnv.mjs). Drop it any time: DROP SCHEMA harness CASCADE;
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
export PGPASSWORD="$DB_PASSWORD"
P="psql -h ${DB_HOST:-localhost} -U $DB_USER -d $DB_NAME -q -v ON_ERROR_STOP=1"
pg_dump -h "${DB_HOST:-localhost}" -U "$DB_USER" -d "$DB_NAME" -s \
  -t order_placements -t active_setups -t gated_candidates -t order_placements_updates -t sierra_chart_reconciliation_log -t order_placements_invariant_baseline \
  | sed 's/public\./harness./g' > /tmp/order_path_harness_schema.sql
$P -c "DROP SCHEMA IF EXISTS harness CASCADE; CREATE SCHEMA harness;"
$P -f /tmp/order_path_harness_schema.sql > /dev/null
echo "harness schema ready: $($P -Atc "select count(*) from information_schema.tables where table_schema='harness'") tables"
