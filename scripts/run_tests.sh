#!/bin/bash
# `npm test` (Fable audit F27, 2026-11-10): the existing pure/read-only test scripts in one command, with a pass/fail summary and a non-zero exit on any failure.
# NOT included on purpose (they need the live system or are long): test_invariants.mjs (read-only DB audit; run it separately: node scripts/test_invariants.mjs) and any script that writes.
# The order-path scenarios need the scratch schema: ./scripts/setup_order_path_harness.sh (idempotent; run by this script when the schema is missing).
# Still missing (F27, not built): a golden detection replay for acd.js. Do not decompose acd.js before it exists (docs/FABLE_AUDIT_REVIEW_20261110.md).
cd "$(dirname "$0")/.."
TESTS=(
  test_globex_account_routing test_broker_guards test_unknown_order_race test_oco_submission test_market_entry_selection
  test_live_roster test_job_health test_cache_helpers test_date_helpers test_sql_day test_real_views test_replay_golden test_vacuum_live_orders test_turn_signal_orders test_amt_tell_orders test_order_path_harness
)
set -a; . ./.env; set +a
if ! PGPASSWORD="$DB_PASSWORD" psql -h "${DB_HOST:-localhost}" -U "$DB_USER" -d "$DB_NAME" -Atc "select 1 from information_schema.schemata where schema_name='harness'" | grep -q 1; then
  ./scripts/setup_order_path_harness.sh > /dev/null || { echo "could not create the harness schema"; exit 1; }
fi
pass=0; fail=0; failed=()
for t in "${TESTS[@]}"; do
  out=$(timeout 300 node "scripts/$t.mjs" 2>&1); rc=$?
  if [ $rc -eq 0 ]; then pass=$((pass+1)); echo "PASS  $t"; else fail=$((fail+1)); failed+=("$t"); echo "FAIL  $t (exit $rc)"; echo "$out" | tail -15 | sed 's/^/        /'; fi
done
echo; echo "$pass passed, $fail failed${failed:+: ${failed[*]}}"
[ $fail -eq 0 ]
