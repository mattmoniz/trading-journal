#!/usr/bin/env bash
# READ-ONLY DeepSeek review (2026-10-07). Plan mode with auto-approve OFF: DeepSeek may read files and
# answer, but cannot execute commands or edit anything. Use this for any review of live-execution code.
# scripts/invoke_deepseek.sh (auto-approve ON) must NOT be used for reviews of broker-connected code.
# Usage: ./scripts/invoke_deepseek_review.sh [20m]   Output: scratch/deepseek_response.md
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
REQUEST="$REPO/scratch/claude_request_deepseek.md"
RESPONSE="$REPO/scratch/deepseek_response.md"
LOCK="$REPO/scratch/.invoke_deepseek.lock"
TIMEOUT="${1:-20m}"
case "$TIMEOUT" in *m) TIMEOUT_SECONDS=$(( ${TIMEOUT%m} * 60 )) ;; *s) TIMEOUT_SECONDS=${TIMEOUT%s} ;; *) TIMEOUT_SECONDS=$TIMEOUT ;; esac
exec 9>"$LOCK"
flock -n 9 || { echo "another DeepSeek run holds $LOCK -- refusing to start" >&2; exit 1; }
echo "[invoke_deepseek_review] read-only (plan mode, auto-approve off), timeout ${TIMEOUT_SECONDS}s, $(date)"
cline -p --auto-approve false -c "$REPO" -t "$TIMEOUT_SECONDS" "$(cat "$REQUEST")" > "$RESPONSE" 2>&1
echo "[invoke_deepseek_review] done $(date), response in $RESPONSE"
