#!/usr/bin/env bash
# Invoke DeepSeek (via the `cline` CLI, provider=deepseek) with the task in
# scratch/claude_request_deepseek.md. Mirrors scripts/invoke_gemini.sh's conventions
# exactly (model-tier guard, lockfile, cwd pinning, dedicated request/response files) --
# built 2026-08-02 after confirming `cline` is a real, working non-interactive CLI on this
# machine (`cline --auto-approve true -t <seconds> "<prompt>"`, config at ~/.cline,
# currently deepseek-v4-pro per ~/.cline/data/globalState.json's actModeApiModelId).
#
# Usage: ./scripts/invoke_deepseek.sh [30m]   (same bare positional timeout as invoke_gemini.sh —
#   NOT --timeout 30m, matching the exact footgun already documented for that script)
# Output is written to scratch/deepseek_response.md
#
# IMPORTANT for Claude: call this with the Bash tool's own `run_in_background: true`, same
# reasoning as invoke_gemini.sh -- do not also append a shell `&`.
#
# Deliberately a SEPARATE request/response file pair and SEPARATE lockfile from Gemini's --
# the two can run concurrently without colliding, and scratch/deepseek_response.md is
# already the filename convention the user has been manually using for DeepSeek output
# tonight, so this doesn't introduce a new naming scheme.

set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"
REQUEST="$REPO/scratch/claude_request_deepseek.md"
RESPONSE="$REPO/scratch/deepseek_response.md"
LOCKFILE="$REPO/scratch/.invoke_deepseek.lock"
TIMEOUT_ARG="${1:-15m}"
GLOBAL_STATE="$HOME/.cline/data/globalState.json"

if [ ! -f "$REQUEST" ]; then
  echo "ERROR: $REQUEST not found" >&2
  exit 1
fi

# Convert "15m"/"30m"/"1h" style timeout into seconds for cline's -t flag (which takes
# raw seconds, unlike agy's --print-timeout which accepts the "15m" string directly).
case "$TIMEOUT_ARG" in
  *h) TIMEOUT_SECONDS=$(( ${TIMEOUT_ARG%h} * 3600 )) ;;
  *m) TIMEOUT_SECONDS=$(( ${TIMEOUT_ARG%m} * 60 )) ;;
  *s) TIMEOUT_SECONDS=${TIMEOUT_ARG%s} ;;
  ''|*[!0-9]*) echo "ERROR: unrecognized timeout '$TIMEOUT_ARG' (use e.g. 15m, 30m, 1h, 900s)" >&2; exit 1 ;;
  *) TIMEOUT_SECONDS="$TIMEOUT_ARG" ;;
esac

# Refuse to run on a non-Pro-tier model -- same standing lesson as invoke_gemini.sh's
# guard (found live 2026-07-31: an unrelated tool's "assistant" backend had silently
# drifted off its intended model with nothing catching it). Deliberate override:
# ALLOW_NONPRO=1 ./scripts/invoke_deepseek.sh
if [ -f "$GLOBAL_STATE" ]; then
  CURRENT_MODEL="$(python3 -c "import json; print(json.load(open('$GLOBAL_STATE')).get('actModeApiModelId','unknown'))" 2>/dev/null || echo unknown)"
  CURRENT_MODEL_LC="$(echo "$CURRENT_MODEL" | tr '[:upper:]' '[:lower:]')"
  if [[ "$CURRENT_MODEL_LC" != *"pro"* ]] && [ "${ALLOW_NONPRO:-0}" != "1" ]; then
    echo "ERROR: cline's active model is '$CURRENT_MODEL', not a Pro-tier model." >&2
    echo "Fix: cline auth deepseek -m deepseek-v4-pro, or override with ALLOW_NONPRO=1 if deliberate." >&2
    exit 1
  fi
  echo "[invoke_deepseek] Model: $CURRENT_MODEL"
fi

# Refuse to start a second run against the same output file (same corruption risk
# invoke_gemini.sh's lock already guards against for agy).
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  echo "ERROR: another invoke_deepseek.sh run is already in progress (lockfile: $LOCKFILE)." >&2
  echo "Wait for it to finish, or check 'ps aux | grep cline' if you believe it's stale." >&2
  exit 1
fi

echo "[invoke_deepseek] Starting at $(date '+%H:%M:%S') — timeout ${TIMEOUT_SECONDS}s"
echo "[invoke_deepseek] Task: $(head -3 "$REQUEST" | tail -1)"

> "$RESPONSE"

cd "$REPO"
cline --auto-approve true -c "$REPO" -t "$TIMEOUT_SECONDS" "$(cat "$REQUEST")" > "$RESPONSE" 2>&1

echo "[invoke_deepseek] Done at $(date '+%H:%M:%S') — $(wc -l < "$RESPONSE") lines written"
