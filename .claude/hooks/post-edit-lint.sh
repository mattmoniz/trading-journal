#!/usr/bin/env bash
# PostToolUse hook (Write|Edit): lint the just-touched file immediately.
#
# CLAUDE.md's "Check for frontend render errors before calling any frontend change
# done" rule (npm run lint:frontend / npm run build, born from the 2026-07-13 incident
# where 4 used-but-unimported components sat undetected until a live browser error) had
# zero automatic backing -- it only happened if Claude remembered to run it, usually only
# once, right before declaring a whole task finished. This closes that gap at the source:
# single-file eslint (~1s, confirmed via timing) runs after every touch to a linted file,
# not just at the end. Real errors get surfaced back into context (additionalContext) so
# they can be fixed before the user ever sees them, not just reported after the fact.
#
# Deliberately does NOT replace the full pre-"done" check (npm run build catches
# cross-file import/export breaks a single-file lint can't see; a live browser/Playwright
# check catches interaction bugs lint can't see either) -- this is the fast, real-time
# layer underneath that broader manual gate, not a substitute for it.

INPUT="$(cat)"
FILE="$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
[ -z "$FILE" ] && exit 0

REPO="$(git -C "$(dirname "$FILE")" rev-parse --show-toplevel 2>/dev/null)"
[ -z "$REPO" ] && exit 0
cd "$REPO" || exit 0

# Normalize to a repo-relative path regardless of whether the hook received an
# absolute or already-relative path.
case "$FILE" in
  "$REPO"/*) REL="${FILE#"$REPO"/}" ;;
  /*) exit 0 ;;  # absolute path outside this repo -- not ours to lint
  *) REL="$FILE" ;;
esac

[ -f "$REL" ] || exit 0

# Only files the flat eslint.config.js actually covers (server/scripts: no-undef only;
# src/: jsx-aware no-undef) -- linting anything else would just report "no config
# matched" noise, not a real finding. Unlike real pathname expansion, a bare '*' in a
# `case` pattern already matches across '/' (verified directly: 'server/*.js' matches
# both server/index.js AND server/routes/acd.js) -- no globstar/`**` needed, and `**`
# would actually be wrong here since it requires at least one directory segment,
# silently excluding top-level files like server/index.js.
case "$REL" in
  server/*.js|server/*.mjs) : ;;
  scripts/*.js|scripts/*.mjs) : ;;
  src/*.jsx|src/*.js) : ;;
  *) exit 0 ;;
esac

# --format json, not the default "stylish" formatter -- confirmed by direct testing
# that plain `eslint <file>` crashes outright in this environment ("TypeError:
# util.styleText is not a function", a Node/ESLint version mismatch inside eslint's own
# stylish formatter), which is evidently exactly why package.json's lint:frontend script
# already pipes `eslint --format json` through a small node parser instead of using
# eslint's own default output -- not a style choice, a required workaround here.
RAW="$(npx eslint --format json "$REL" 2>/dev/null)"
# jq -e fails (non-zero) on invalid/empty JSON, so a genuine crash (as opposed to eslint
# cleanly reporting 0 errors) surfaces as a distinct message instead of silently
# swallowing a broken hook.
if ! echo "$RAW" | jq -e . >/dev/null 2>&1; then
  jq -n --arg ctx "post-edit-lint.sh: eslint produced no valid JSON output for $REL -- the lint step itself may be broken, not necessarily the file. Investigate scripts/hardcoded-threshold-patterns.sh-style before assuming the edit is clean." \
    '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}'
  exit 0
fi

# messages[] only -- explicitly drop the "source" field, which embeds the entire file's
# text and would otherwise bloat additionalContext with content already in context.
FINDINGS="$(echo "$RAW" | jq -r '.[0].messages[]? | "  line \(.line):\(.column) [\(.ruleId // "error")] \(.message)"')"
[ -z "$FINDINGS" ] && exit 0

jq -n --arg file "$REL" --arg findings "$FINDINGS" \
  '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: ("eslint found a real issue in " + $file + " right after this edit -- fix it now, before continuing or calling anything done:\n" + $findings)}}'
exit 0
