#!/bin/bash
# Tests all endpoints that query price_bars after partitioning migration

BASE="http://localhost:3001"
PASS=0
FAIL=0
LOG="/home/mmoniz/trading-journal/scripts/endpoint_test_$(date +%Y%m%d_%H%M%S).log"

check() {
  local label="$1"
  local url="$2"
  local expect="$3"  # optional string to grep for in response

  resp=$(curl -s --max-time 15 "$url")
  status=$?

  if [ $status -ne 0 ]; then
    echo "FAIL [$label] — curl error (timeout or connection refused)" | tee -a "$LOG"
    FAIL=$((FAIL+1))
    return
  fi

  if echo "$resp" | grep -q '"error"'; then
    echo "FAIL [$label] — response contains error: $(echo $resp | head -c 200)" | tee -a "$LOG"
    FAIL=$((FAIL+1))
    return
  fi

  if [ -n "$expect" ] && ! echo "$resp" | grep -q "$expect"; then
    echo "FAIL [$label] — expected '$expect' not found in response" | tee -a "$LOG"
    FAIL=$((FAIL+1))
    return
  fi

  echo "PASS [$label]" | tee -a "$LOG"
  PASS=$((PASS+1))
}

echo "=== Endpoint Tests Post-Migration ===" | tee -a "$LOG"
echo "Started: $(date)" | tee -a "$LOG"
echo "" | tee -a "$LOG"

# Core live-data endpoints
check "Live status (antigravity)" "$BASE/api/antigravity-edges/status" "coilingStatus"
check "Key levels" "$BASE/api/acd/key-levels" ""
check "Vol backtest stats" "$BASE/api/acd/vol-backtest-stats" ""

# Price bar endpoints
check "Price bars recent" "$BASE/api/price-bars/NQ?limit=10" "symbol"
check "Price bars date" "$BASE/api/price-bars/NQ?date=$(date +%Y-%m-%d)" ""

# ACD / session endpoints
check "ACD daily log" "$BASE/api/acd/daily-log" ""
check "ACD levels" "$BASE/api/acd/levels" ""

# Confluence / backtest
check "Confluence setups" "$BASE/api/confluence/setups" ""
check "Edge stats" "$BASE/api/edges/stats" ""

# Tearsheet / analytics
check "Tearsheet summary" "$BASE/api/tearsheet/summary" ""
check "Weekly stats" "$BASE/api/weekly/stats" ""

# Auction read
check "Auction read" "$BASE/api/auction-read/today" ""

# Setups
check "Setups active" "$BASE/api/setups/active" ""

# Wyckoff
check "Wyckoff analysis" "$BASE/api/wyckoff/latest" ""

echo "" | tee -a "$LOG"
echo "=== Results: $PASS passed, $FAIL failed ===" | tee -a "$LOG"
echo "Log: $LOG" | tee -a "$LOG"

# Exit non-zero if any failures
[ $FAIL -eq 0 ]
