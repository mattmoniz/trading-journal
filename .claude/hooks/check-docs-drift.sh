#!/usr/bin/env bash
# Stop hook: three checks, none block.
# 1) Structural files changed without a matching ARCHITECTURE.md/CLAUDE.md update
#    (working tree AND unpushed commits — see note below on why both matter).
# 2) Hardcoded threshold anti-patterns in acd.js / caseEngine.js.
# 3) (folded into #1's message) explicit persistence self-check — CLAUDE.md rules
#    and cross-session auto-memory, not just docs/OPEN_THREADS.md.

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

warnings=()

# ── 1. Docs drift + persistence self-check ─────────────────────────────────────
# A working-tree-only diff goes silent the instant something is committed, even if
# that commit itself never touched docs. Found 2026-07-18: committed
# server/services/regimeClassificationService.js in isolation; the working tree went
# clean immediately after, so this check (as it existed then) had nothing left to
# see, and CLAUDE.md didn't get its matching rule until the user asked directly two
# turns later. Widened to also scan the unpushed commit range (git status alone
# can't see a change that's already committed but not yet pushed) so a commit that
# skips docs still gets flagged at the very next Stop, not just before the commit.
changed_files="$(git status --porcelain 2>/dev/null | awk '{ $1=""; print substr($0,2) }')"
upstream="$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null)"
if [ -n "$upstream" ]; then
  unpushed_files="$(git diff --name-only "$upstream"...HEAD 2>/dev/null)"
else
  unpushed_files=""
fi
changed_files="$(printf '%s\n%s\n' "$changed_files" "$unpushed_files" | sed '/^$/d' | sort -u)"

if [ -n "$changed_files" ]; then
  structural_patterns='^server/routes/[^/]+\.js$|^server/services/[^/]+\.js$|^server/index\.js$|^server/schema\.sql$|^src/components/dashboard/[^/]+\.jsx$|^src/views/[^/]+\.jsx$|^src/App\.jsx$|^start\.sh$|^stop\.sh$'
  structural_changed="$(echo "$changed_files" | grep -E "$structural_patterns")"
  docs_changed="$(echo "$changed_files" | grep -E '^(ARCHITECTURE\.md|CLAUDE\.md|docs/HARDCODED_CONSTANTS\.md)$')"
  if [ -n "$structural_changed" ] && [ -z "$docs_changed" ]; then
    file_list="$(echo "$structural_changed" | tr '\n' ',' | sed 's/,$//' | sed 's/,/, /g')"
    warnings+=("PERSISTENCE SELF-CHECK — structural files changed ($file_list) with no ARCHITECTURE.md/CLAUDE.md update in the working tree OR unpushed commits. Answer explicitly, don't skip: (1) Did anything this session turn out surprising, hard-to-find, or confirm/correct an approach? If yes, it needs a CLAUDE.md rule now — docs/OPEN_THREADS.md alone won't do, that file tracks unfinished work and a resolved lesson can quietly age out of it. (2) Does anything belong in the cross-session auto-memory system (/home/mmoniz/.claude/projects/-home-mmoniz-trading-journal/memory/) — a user preference, a workflow correction, a project fact? A 'no' to both is fine — but it has to be an answer, not a step that got skipped.")
  fi
fi

# ── 2. Hardcoded threshold anti-patterns ───────────────────────────────────────
# Scans acd.js and caseEngine.js for patterns that historically introduced
# hardcoded trading thresholds. None of these should appear without a _opt /
# _suppressedSetups / performance_audit reference on the same line.
# Pattern definitions shared with scripts/git-hooks/pre-commit — see that file for
# single-source-of-truth rationale.
source "$(git rev-parse --show-toplevel)/scripts/hardcoded-threshold-patterns.sh"

ACD="server/routes/acd.js"
CE="server/services/caseEngine.js"

hardcoded_hits=()

for f in "$ACD" "$CE"; do
  [ -f "$f" ] || continue

  hits=$(grep -nE "$PATTERN_A" "$f" 2>/dev/null | grep -v "$PATTERN_A_EXCLUDE")
  [ -n "$hits" ] && hardcoded_hits+=("$f — $PATTERN_A_LABEL: $hits")

  hits=$(grep -nE "$PATTERN_B" "$f" 2>/dev/null | grep -iE "$PATTERN_B_FILTER" | grep -v "$PATTERN_B_EXCLUDE")
  [ -n "$hits" ] && hardcoded_hits+=("$f — $PATTERN_B_LABEL: $hits")

  hits=$(grep -nE "$PATTERN_C" "$f" 2>/dev/null | grep -v "$PATTERN_C_EXCLUDE")
  [ -n "$hits" ] && hardcoded_hits+=("$f — $PATTERN_C_LABEL: $hits")

  hits=$(grep -nE "$PATTERN_D" "$f" 2>/dev/null | grep -v "$PATTERN_D_EXCLUDE")
  [ -n "$hits" ] && hardcoded_hits+=("$f — $PATTERN_D_LABEL: $hits")
done

# Pattern E scans broadly (not just acd.js/caseEngine.js) — found 2026-07-16 in a
# frontend modal and a table tooltip, neither of which the above file scope covers.
# server/config/instruments.js / src/constants/contract.js are the canonical definition
# files (SUPPOSED to contain "$20/pt") and excluded by path, same reasoning as pre-commit.
# See hardcoded-threshold-patterns.sh for why this one isn't scoped like the others.
while IFS= read -r -d '' f; do
  case "$f" in
    server/config/instruments.js|src/constants/contract.js) continue ;;
  esac
  hits=$(grep -nE "$PATTERN_E" "$f" 2>/dev/null | grep -v "$PATTERN_E_EXCLUDE")
  [ -n "$hits" ] && hardcoded_hits+=("$f — $PATTERN_E_LABEL: $hits")
done < <(find server src -type f \( -name '*.js' -o -name '*.jsx' \) -print0 2>/dev/null)

if [ ${#hardcoded_hits[@]} -gt 0 ]; then
  joined=$(printf ' | %s' "${hardcoded_hits[@]}")
  warnings+=("HARDCODED THRESHOLD ALERT — review before ending: ${joined:3}")
fi

# ── Output ─────────────────────────────────────────────────────────────────────
[ ${#warnings[@]} -eq 0 ] && exit 0

message="$(printf '%s\n' "${warnings[@]}")"
escaped="$(printf '%s' "$message" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\n/\\n/g')"
printf '{"systemMessage": "%s"}\n' "$escaped"
exit 0
