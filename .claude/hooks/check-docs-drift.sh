#!/usr/bin/env bash
# Stop hook: two checks, neither blocks.
# 1) Structural files changed without a matching ARCHITECTURE.md/CLAUDE.md update.
# 2) Hardcoded threshold anti-patterns in acd.js / caseEngine.js.

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

warnings=()

# ── 1. Docs drift ──────────────────────────────────────────────────────────────
changed_files="$(git status --porcelain 2>/dev/null | awk '{ $1=""; print substr($0,2) }')"
if [ -n "$changed_files" ]; then
  structural_patterns='^server/routes/[^/]+\.js$|^server/services/[^/]+\.js$|^server/index\.js$|^server/schema\.sql$|^src/components/dashboard/[^/]+\.jsx$|^src/App\.jsx$'
  structural_changed="$(echo "$changed_files" | grep -E "$structural_patterns")"
  docs_changed="$(echo "$changed_files" | grep -E '^(ARCHITECTURE\.md|CLAUDE\.md|docs/HARDCODED_CONSTANTS\.md)$')"
  if [ -n "$structural_changed" ] && [ -z "$docs_changed" ]; then
    file_list="$(echo "$structural_changed" | tr '\n' ',' | sed 's/,$//' | sed 's/,/, /g')"
    warnings+=("Structural files changed ($file_list) but ARCHITECTURE.md/CLAUDE.md were not updated — review before ending.")
  fi
fi

# ── 2. Hardcoded threshold anti-patterns ───────────────────────────────────────
# Scans acd.js and caseEngine.js for patterns that historically introduced
# hardcoded trading thresholds. None of these should appear without a _opt /
# _suppressedSetups / performance_audit reference on the same line.
ACD="server/routes/acd.js"
CE="server/services/caseEngine.js"

hardcoded_hits=()

for f in "$ACD" "$CE"; do
  [ -f "$f" ] || continue

  # Pattern A: hardcoded suppression set literal  (e.g. new Set(['OR_HIGH_FADE', ...]))
  if grep -qE "new Set\(\['" "$f" 2>/dev/null; then
    hits=$(grep -nE "new Set\(\['" "$f" | grep -v '_suppressedSetups\|_dowSuppressToday\|DAY_TYPE_CONDITIONAL\|SHADOW_SETUP\|displayPrimary\|SHADOW_SETUP_TYPES\|IB_SWEEP_TYPES')
    [ -n "$hits" ] && hardcoded_hits+=("$f — hardcoded Set literal (suppression list?): $hits")
  fi

  # Pattern B: hardcoded array of setup-type strings (e.g. mondaySkip = ['OR_HIGH_FADE',...])
  if grep -qE "=\s*\['" "$f" 2>/dev/null; then
    hits=$(grep -nE "=\s*\['" "$f" | grep -iE 'fade|suppress|skip|monday|setup' | grep -v 'IB_SWEEP_TYPES\|STOP_RANGE\|DOW_NAMES')
    [ -n "$hits" ] && hardcoded_hits+=("$f — hardcoded setup-type array: $hits")
  fi

  # Pattern C: bare numeric assignment for STOP or TARGET without _opt reference or Fallback annotation
  if grep -qE 'const (STOP|TARGET) = [0-9]' "$f" 2>/dev/null; then
    hits=$(grep -nE 'const (STOP|TARGET) = [0-9]' "$f" | grep -v '_opt\|Fallback\|// sweep\|DEFAULT_\|STOP_RANGE\|MIN_STOP')
    [ -n "$hits" ] && hardcoded_hits+=("$f — hardcoded STOP/TARGET constant (use _opt or add // Fallback comment): $hits")
  fi

  # Pattern D: day-of-week ternary with numeric trading threshold values (e.g. isMonday ? 60 : 90)
  # Exclude: time-of-day minute checks (630=10:30, 960=4pm, 570=9:30), bar counts, date math
  if grep -qE 'is(Monday|Dow|Tue|Wed|Thu|Fri)\s*\?' "$f" 2>/dev/null; then
    hits=$(grep -nE 'is(Monday|Dow|Tue|Wed|Thu|Fri)\s*\?.*[0-9]{2,}' "$f" \
      | grep -v '// data-derived\|etMinNow\|630\|960\|570\|629\|T12:00\|getDay\|post-IB\|10:30\|padEnd\|toFixed')
    [ -n "$hits" ] && hardcoded_hits+=("$f — DOW-conditional numeric trading threshold (use SETUP_STATUS_DOW pipeline instead): $hits")
  fi
done

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
