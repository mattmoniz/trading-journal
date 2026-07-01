#!/usr/bin/env bash
# Stop hook: informational nudge if structural code changed this session
# without a matching ARCHITECTURE.md/CLAUDE.md update. Never blocks.

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

changed_files="$(git status --porcelain 2>/dev/null | awk '{ $1=""; print substr($0,2) }')"
[ -z "$changed_files" ] && exit 0

structural_patterns='^server/routes/[^/]+\.js$|^server/services/[^/]+\.js$|^server/index\.js$|^server/schema\.sql$|^src/components/dashboard/[^/]+\.jsx$|^src/App\.jsx$'

structural_changed="$(echo "$changed_files" | grep -E "$structural_patterns")"
[ -z "$structural_changed" ] && exit 0

docs_changed="$(echo "$changed_files" | grep -E '^(ARCHITECTURE\.md|CLAUDE\.md)$')"
[ -n "$docs_changed" ] && exit 0

file_list="$(echo "$structural_changed" | tr '\n' ',' | sed 's/,$//' | sed 's/,/, /g')"
message="Structural files changed ($file_list) but ARCHITECTURE.md/CLAUDE.md were not updated this session - review whether docs need updating before ending."

# Escape backslashes and double quotes for JSON string safety (filenames are the only variable input).
escaped="$(printf '%s' "$message" | sed 's/\\/\\\\/g; s/"/\\"/g')"

printf '{"systemMessage": "%s"}\n' "$escaped"
exit 0
