#!/usr/bin/env bash
# Invoke Gemini (agy CLI) with the task in scratch/claude_request.md
# Usage: ./scripts/invoke_gemini.sh [--timeout 30m]
# Output is written to scratch/antigravity_response.md
# Claude calls this directly via Bash tool.
#
# IMPORTANT for Claude: call this with the Bash tool's own `run_in_background: true`.
# Do NOT also append a shell `&` — stacking both loses harness tracking of the real
# agy process (the wrapper returns instantly after backgrounding it), so a "completed"
# notification fires while agy is still working, and reading antigravity_response.md
# at that point shows partial/misleading output. (Found 2026-07-13: this double-
# backgrounding also let two agy processes run concurrently against the same output
# file, corrupting it with interleaved writes — see the lock below.)

set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"
REQUEST="$REPO/scratch/claude_request.md"
RESPONSE="$REPO/scratch/antigravity_response.md"
LOCKFILE="$REPO/scratch/.invoke_gemini.lock"
TIMEOUT="${1:-15m}"

if [ ! -f "$REQUEST" ]; then
  echo "ERROR: $REQUEST not found" >&2
  exit 1
fi

# Refuse to start a second run against the same output file — a prior session let two
# agy processes write to antigravity_response.md concurrently and corrupted it with
# interleaved output.
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  echo "ERROR: another invoke_gemini.sh run is already in progress (lockfile: $LOCKFILE)." >&2
  echo "Wait for it to finish, or check 'ps aux | grep agy' if you believe it's stale." >&2
  exit 1
fi

echo "[invoke_gemini] Starting at $(date '+%H:%M:%S') — timeout $TIMEOUT"
echo "[invoke_gemini] Task: $(head -3 "$REQUEST" | tail -1)"

# Clear previous response before writing new one
> "$RESPONSE"

# cd into the repo (and pass --add-dir as a belt-and-suspenders pin) so agy resolves
# relative paths like docs/ANTIGRAVITY_CONSTRAINTS.md directly instead of falling back
# to a full `find /` filesystem scan (observed 2026-07-13, ~10-15s wasted per call).
cd "$REPO"
agy --add-dir "$REPO" --print "$(cat "$REQUEST")" --print-timeout "$TIMEOUT" > "$RESPONSE" 2>&1

echo "[invoke_gemini] Done at $(date '+%H:%M:%S') — $(wc -l < "$RESPONSE") lines written"
