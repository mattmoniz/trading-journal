#!/usr/bin/env bash
# PostToolUse hook (Write|Edit): flag a file that's growing into an unnecessary
# monolith, relative to its own cohort's actual size distribution -- not against one
# fixed line-count picked in advance. User request 2026-07-18: "I want the system to
# decide when the file is too big. I dont want huge monolith files unless they need to
# be." Same "derive from a distribution, not a hardcoded number" philosophy CLAUDE.md's
# "No static thresholds" hard rule already applies to trading data, borrowed here for
# code structure instead.
#
# Cohort = sibling files in the same directory with the same extension (server/routes/,
# src/components/dashboard/, etc. -- these already read as natural architectural units
# in ARCHITECTURE.md's own tables). Outlier statistic = median + MAD (median absolute
# deviation), not mean + stdev -- confirmed by direct measurement this matters here:
# server/routes/ has acd.js at 7980 lines against a cohort median of ~260, which would
# blow out a mean/stdev-based threshold for every OTHER file in the same directory.
# MAD stays robust to that one legitimate, already-known outlier.
#
# Fires only when BOTH:
#   1. The file is currently a statistical outlier for its cohort (modified z-score
#      > 3.5 -- Iglewicz & Hoaglin's standard robust-outlier cutoff, not invented here).
#   2. This edit's growth since the last commit is itself >= the cohort's own median
#      file size -- i.e., you just added roughly a whole typical file's worth of new
#      content. This is what keeps it quiet on small incremental edits to an
#      already-known-huge, already-accepted file like acd.js (a 50-line addition to a
#      7980-line file is still an "outlier," but isn't NEW sprawl worth a nudge every
#      single time it's touched).
# Advisory only (additionalContext, not a block) -- "unless they need to be" means this
# is a judgment call, not a hard rule; acd.js is already a known, deliberate exception
# (see ARCHITECTURE.md's own "largest route file" note).

INPUT="$(cat)"
FILE="$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
[ -z "$FILE" ] && exit 0

REPO="$(git -C "$(dirname "$FILE")" rev-parse --show-toplevel 2>/dev/null)"
[ -z "$REPO" ] && exit 0
cd "$REPO" || exit 0

case "$FILE" in
  "$REPO"/*) REL="${FILE#"$REPO"/}" ;;
  /*) exit 0 ;;
  *) REL="$FILE" ;;
esac

[ -f "$REL" ] || exit 0

case "$REL" in
  server/*.js|server/*.mjs) ;;
  scripts/*.js|scripts/*.mjs) ;;
  src/*.jsx|src/*.js) ;;
  *) exit 0 ;;
esac

CUR_LINES=$(wc -l < "$REL")
# Below this, "monolith" concerns don't meaningfully apply regardless of cohort shape --
# a deliberately chosen floor for when the whole question is moot, not a threshold for
# "too big" itself (that part is still fully cohort-derived below).
[ "$CUR_LINES" -lt 300 ] && exit 0

DIR="$(dirname "$REL")"
EXT="${REL##*.}"
BASENAME="$(basename "$REL")"

SIBLING_COUNTS="$(find "$DIR" -maxdepth 1 -type f -name "*.$EXT" ! -name "$BASENAME" -exec wc -l {} \; 2>/dev/null | awk '{print $1}')"
SIBLING_N=$(echo "$SIBLING_COUNTS" | grep -c '[0-9]')
# Too few siblings to derive a meaningful distribution from -- skip rather than judge
# one file against a sample of 1-3.
[ "$SIBLING_N" -lt 4 ] && exit 0

STATS="$(echo "$SIBLING_COUNTS" | awk -v cur="$CUR_LINES" '
{ a[NR]=$1 }
END {
  n = NR
  asort(a)
  med = (n % 2 == 1) ? a[(n+1)/2] : (a[n/2] + a[n/2+1]) / 2
  for (i = 1; i <= n; i++) { d[i] = a[i] - med; if (d[i] < 0) d[i] = -d[i] }
  asort(d)
  mad = (n % 2 == 1) ? d[(n+1)/2] : (d[n/2] + d[n/2+1]) / 2
  print med, mad
}')"
MEDIAN="$(echo "$STATS" | awk '{print $1}')"
MAD="$(echo "$STATS" | awk '{print $2}')"

# MAD=0 (unlikely but possible with a very uniform, small cohort) would divide by zero --
# fall back to a plain 3x-median multiplier for that edge case only.
IS_OUTLIER="$(awk -v cur="$CUR_LINES" -v med="$MEDIAN" -v mad="$MAD" 'BEGIN {
  if (mad > 0) { z = 0.6745 * (cur - med) / mad; print (z > 3.5) ? 1 : 0 }
  else { print (cur > med * 3) ? 1 : 0 }
}')"
[ "$IS_OUTLIER" != "1" ] && exit 0

HEAD_LINES="$(git show "HEAD:$REL" 2>/dev/null | wc -l)"
[ -z "$HEAD_LINES" ] && HEAD_LINES=0
GROWTH=$((CUR_LINES - HEAD_LINES))

GROWTH_ENOUGH="$(awk -v g="$GROWTH" -v med="$MEDIAN" 'BEGIN { print (g >= med) ? 1 : 0 }')"
[ "$GROWTH_ENOUGH" != "1" ] && exit 0

MSG="$REL just grew to $CUR_LINES lines (+$GROWTH since the last commit), a statistical outlier against its $SIBLING_N sibling files in $DIR (cohort median $MEDIAN lines). Worth a moment: is this genuinely one cohesive thing, or does it want to be split? If it deliberately belongs together (like acd.js's Level Fade Engine), that's fine -- just a real decision, not size creep nobody chose."

jq -n --arg ctx "$MSG" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}'
exit 0
