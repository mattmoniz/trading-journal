#!/usr/bin/env bash
# Invoke DeepSeek (via the `cline` CLI, provider=deepseek) with the task in
# scratch/claude_request_deepseek.md. Mirrors scripts/invoke_gemini.sh's conventions
# exactly (model-tier guard, lockfile, cwd pinning, dedicated request/response files) --
# built 2026-08-02 after confirming `cline` is a real, working non-interactive CLI on this
# machine (`cline --auto-approve true -t <seconds> "<prompt>"`, config at ~/.cline,
# currently deepseek-v4-pro per ~/.cline/data/globalState.json's actModeApiModelId --
# switched 2026-09-10 from deepseek-v4-pro to deepseek-flash (DeepSeek V4.1 Flash) on the
# strength of DeepSeek's own API docs at the time, then switched BACK to deepseek-v4-pro
# on 2026-09-13 at the user's explicit request after DeepSeek reversed its own rollback
# plan and did not end up deprecating v4-pro in favor of Flash 4.1 -- don't re-attempt the
# 2026-09-10 switch without the user asking again, since the premise it was based on no
# longer holds. Thinking mode is on persistently in ~/.cline/data/settings/providers.json's
# deepseek.settings.reasoning ({"enabled": true, "effort": "high"}) -- HIGH, not max, per
# the same 2026-09-13 request (previously "max" under the Flash config) -- matching the
# API's own {"thinking": {"type": "enabled"}, "reasoning_effort": "high"} request body per
# the Thinking Mode guide -- not passed per-invocation here, so don't add a --thinking flag
# below unless the persisted default is deliberately being overridden for one run.
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

# Refuse to run on an unexpected model -- same standing lesson as invoke_gemini.sh's
# guard (found live 2026-07-31: an unrelated tool's "assistant" backend had silently
# drifted off its intended model with nothing catching it). Deliberately pinned to the
# CURRENT intended model rather than a tier-name substring match (was "*pro*" before
# 2026-09-10, broke that day when the temporary switch to deepseek-flash happened since
# "flash" doesn't contain "pro"; reverted to "deepseek-v4-pro" 2026-09-13 alongside the
# real settings switch back -- see file header). Deliberate override:
# ALLOW_UNEXPECTED_MODEL=1 ./scripts/invoke_deepseek.sh
EXPECTED_MODEL="deepseek-v4-pro"
if [ -f "$GLOBAL_STATE" ]; then
  CURRENT_MODEL="$(python3 -c "import json; print(json.load(open('$GLOBAL_STATE')).get('actModeApiModelId','unknown'))" 2>/dev/null || echo unknown)"
  if [ "$CURRENT_MODEL" != "$EXPECTED_MODEL" ] && [ "${ALLOW_UNEXPECTED_MODEL:-0}" != "1" ]; then
    echo "ERROR: cline's active model is '$CURRENT_MODEL', expected '$EXPECTED_MODEL'." >&2
    echo "Fix: cline auth deepseek -m $EXPECTED_MODEL, or override with ALLOW_UNEXPECTED_MODEL=1 if deliberate." >&2
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
