#!/usr/bin/env bash
# PreCompact hook (auto only): alerts when context auto-compacts.
# This is a concrete signal of context bloat - large/duplicate file reads,
# long pasted transcripts, etc. The full context is reprocessed every turn,
# so a bloated context burns usage limits faster even before compaction hits.

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

log_dir=".claude/logs"
mkdir -p "$log_dir"
log_file="$log_dir/context-compactions.log"
today="$(date -u +%Y-%m-%d)"
ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "$ts auto-compact" >> "$log_file"

count_today="$(grep -c "$today" "$log_file" 2>/dev/null || echo 0)"

message="Context auto-compacted (#$count_today today). This is what burns usage limits fastest - the full context is reprocessed every turn. If this keeps happening, try /clear between unrelated tasks, /context to see what's taking up space, or ask me to stop rereading large files."

escaped="$(printf '%s' "$message" | sed 's/\\/\\\\/g; s/"/\\"/g')"
printf '{"systemMessage": "%s"}\n' "$escaped"
exit 0
