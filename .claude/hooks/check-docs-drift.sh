#!/usr/bin/env bash
# Stop hook: four checks, none block.
# 1) Structural files changed more recently than the last ARCHITECTURE.md/CLAUDE.md
#    update, by real commit-ordering (working tree AND unpushed commits, compared via
#    last-touch epoch timestamps, not just "was either touched somewhere in range" —
#    see the note above that section for the full reasoning and its own test history).
# 2) Hardcoded threshold anti-patterns A-E (whole-file) in acd.js/caseEngine.js/broadly.
# 3) (folded into #1's message) explicit persistence self-check — CLAUDE.md rules
#    and cross-session auto-memory, not just docs/OPEN_THREADS.md.
# 4) Patterns F/G (CumPL-diff violation, JS-toISOString date bug), diff-only across
#    server/scripts — see the note above that section for why this one is diff-only
#    while #2 is whole-file.

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

# Real commit-ordering, not just presence-in-range (fixed 2026-07-18, was previously a
# known, flagged limitation): "was CLAUDE.md/ARCHITECTURE.md touched somewhere in the
# unpushed range" isn't the same claim as "docs are current for the LATEST structural
# change" -- a docs commit followed by more undocumented structural commits would have
# read as "covered" under the old check. Fixed by comparing actual last-touch points:
# for each changed structural file and for the docs files, find the epoch timestamp of
# whichever is more recent -- an uncommitted working-tree change (i.e. right now, always
# the latest possible point) or the most recent commit that touched it within the
# unpushed range. A structural file is flagged only if ITS last-touch point is strictly
# after the docs' collective last-touch point (the max across CLAUDE.md/ARCHITECTURE.md/
# docs/HARDCODED_CONSTANTS.md) -- so a docs update earlier in the same session no longer
# silently "covers" a structural change made after it.
last_touch_epoch() {
  local f="$1"
  if [ -n "$(git status --porcelain -- "$f" 2>/dev/null)" ]; then
    date +%s
    return
  fi
  if [ -n "$upstream" ]; then
    local t
    t="$(git log -1 --format=%ct "$upstream..HEAD" -- "$f" 2>/dev/null)"
    [ -n "$t" ] && { echo "$t"; return; }
  fi
  echo 0
}

if [ -n "$changed_files" ]; then
  structural_patterns='^server/routes/[^/]+\.js$|^server/services/[^/]+\.js$|^server/index\.js$|^server/schema\.sql$|^src/components/dashboard/[^/]+\.jsx$|^src/views/[^/]+\.jsx$|^src/App\.jsx$|^start\.sh$|^stop\.sh$'
  structural_changed="$(echo "$changed_files" | grep -E "$structural_patterns")"

  docs_epoch=0
  for d in ARCHITECTURE.md CLAUDE.md docs/HARDCODED_CONSTANTS.md; do
    e="$(last_touch_epoch "$d")"
    [ "$e" -gt "$docs_epoch" ] && docs_epoch="$e"
  done

  stale_files=()
  if [ -n "$structural_changed" ]; then
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      fe="$(last_touch_epoch "$f")"
      [ "$fe" -gt "$docs_epoch" ] && stale_files+=("$f")
    done <<< "$structural_changed"
  fi

  if [ ${#stale_files[@]} -gt 0 ]; then
    file_list="$(printf '%s, ' "${stale_files[@]}")"
    file_list="${file_list%, }"
    warnings+=("PERSISTENCE SELF-CHECK — structural files changed more recently than the last ARCHITECTURE.md/CLAUDE.md update ($file_list). Answer explicitly, don't skip: (1) Did anything this session turn out surprising, hard-to-find, or confirm/correct an approach? If yes, it needs a CLAUDE.md rule now — docs/OPEN_THREADS.md alone won't do, that file tracks unfinished work and a resolved lesson can quietly age out of it. (2) Does anything belong in the cross-session auto-memory system (/home/mmoniz/.claude/projects/-home-mmoniz-trading-journal/memory/) — a user preference, a workflow correction, a project fact? A 'no' to both is fine — but it has to be an answer, not a step that got skipped.")
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

# Patterns F/G (CumPL-diff violation, JS-toISOString trading-day-date bug) — added
# 2026-07-18 in a rule-prominence audit that found both had zero hook backing. Unlike
# A-E above, these scan the DIFF (unpushed commits + working tree, reusing $upstream
# from check 1), not the whole file — a whole-file scan found 15/20 pre-existing hits
# respectively, which would make this hook spam the same legacy findings every single
# session. Diff-only means only a genuinely NEW instance introduced this session/branch
# fires. Fixing/auditing the pre-existing hits is real, separate work (not done here).
fg_targets="$(printf '%s\n%s\n' \
  "$(git status --porcelain 2>/dev/null | awk '{ $1=""; print substr($0,2) }')" \
  "$([ -n "$upstream" ] && git diff --name-only "$upstream"...HEAD 2>/dev/null)" \
  | sed '/^$/d' | sort -u | grep -E '^(server|scripts)/.*\.(js|mjs)$')"

for f in $fg_targets; do
  [ -f "$f" ] || continue
  case "$f" in
    server/routes/dailyLogs.js|server/routes/stats.js|server/routes/dll.js) f_skip=1 ;;
    *) f_skip=0 ;;
  esac
  diff_added="$(git diff "$upstream"...HEAD -- "$f" 2>/dev/null | grep -E '^\+[^+]'; git diff HEAD -- "$f" 2>/dev/null | grep -E '^\+[^+]')"
  [ -z "$diff_added" ] && continue

  if [ "$f_skip" = 0 ]; then
    m=$(echo "$diff_added" | grep -E "$PATTERN_F" | grep -v "$PATTERN_F_EXCLUDE")
    [ -n "$m" ] && hardcoded_hits2+=("$f — new $PATTERN_F_LABEL: $m")
  fi

  case "$f" in
    scripts/archive/*) ;;
    *)
      m=$(echo "$diff_added" | grep -E "$PATTERN_G" | grep -v "$PATTERN_G_EXCLUDE")
      [ -n "$m" ] && hardcoded_hits2+=("$f — new $PATTERN_G_LABEL: $m")
      ;;
  esac
done

if [ ${#hardcoded_hits2[@]} -gt 0 ]; then
  joined2=$(printf ' | %s' "${hardcoded_hits2[@]}")
  warnings+=("NEW HARDCODED ANTI-PATTERN (this session) — review before ending: ${joined2:3}")
fi

# ── Output ─────────────────────────────────────────────────────────────────────
[ ${#warnings[@]} -eq 0 ] && exit 0

# Found 2026-07-18 (while verifying this session's own additions): the hand-rolled sed
# escaping here (s/\\/\\\\/g; s/"/\\"/g; s/\n/\\n/g, dating to commit de3e407,
# 2026-07-09) has always mishandled warnings containing REAL embedded newlines (e.g. a
# multi-line grep hit spanning several source lines, which several Pattern E hits do) --
# sed processes line-by-line and can't collapse an actual newline inside a value with a
# plain s/\n/.../ substitution (that only works on a literal 2-char "\n" already in the
# text, not a real line break, without first N-joining lines). Produced invalid JSON
# (jq: "Invalid string: control characters...") whenever that happened, silently --
# nothing surfaces a Stop hook's own malformed output to anyone. jq -n --arg handles
# all of this correctly by construction (proper JSON string escaping, real newlines
# included), so build the message that way instead of by hand.
message="$(printf '%s\n' "${warnings[@]}")"
jq -n --arg msg "$message" '{systemMessage: $msg}'
exit 0
