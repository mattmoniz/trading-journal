#!/usr/bin/env bash
# Invoke Gemini (agy CLI) with the task in scratch/claude_request.md
# Usage: ./scripts/invoke_gemini.sh [--timeout 30m]
# Output is written to scratch/antigravity_response.md
# Claude calls this directly via Bash tool.

set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"
REQUEST="$REPO/scratch/claude_request.md"
RESPONSE="$REPO/scratch/antigravity_response.md"
TIMEOUT="${1:-15m}"

if [ ! -f "$REQUEST" ]; then
  echo "ERROR: $REQUEST not found" >&2
  exit 1
fi

echo "[invoke_gemini] Starting at $(date '+%H:%M:%S') — timeout $TIMEOUT"
echo "[invoke_gemini] Task: $(head -3 "$REQUEST" | tail -1)"

# Clear previous response before writing new one
> "$RESPONSE"

agy --print --print-timeout "$TIMEOUT" < "$REQUEST" > "$RESPONSE" 2>&1

echo "[invoke_gemini] Done at $(date '+%H:%M:%S') — $(wc -l < "$RESPONSE") lines written"
