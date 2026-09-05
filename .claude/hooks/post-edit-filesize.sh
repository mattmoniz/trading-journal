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
# Fires when the file is a statistical outlier for its cohort (modified z-score > 3.5 --
# Iglewicz & Hoaglin's standard robust-outlier cutoff, not invented here) AND EITHER:
#   1. This edit's growth since the last commit is itself >= the cohort's own median
#      file size -- i.e., you just added roughly a whole typical file's worth of new
#      content in one go, OR
#   2. CUMULATIVE growth since this file was last flagged (tracked in
#      .claude/hooks/.filesize_baselines.json, a small persisted JSON map) has crossed
#      CUMULATIVE_GROWTH_THRESHOLD lines. Added 2026-09-05 after acd.js grew from ~13990
#      to ~14030+ lines across an entire session's worth of small, well-scoped commits
#      (each individually far below the cohort median, so check #1 above never once
#      fired) -- the exact "grows a little every session, forever, unnoticed" pattern
#      this hook was originally built to catch, but couldn't, because per-edit growth
#      and cumulative growth are different questions and only the first was checked.
#      Baseline resets to the current line count every time this fires, so it's a
#      recurring "another chunk has accumulated" nudge, not a one-time alarm.
# Advisory only (additionalContext, not a block) -- "unless they need to be" means this
# is a judgment call, not a hard rule; acd.js is already a known, deliberate exception
# for its EXISTING size (see ARCHITECTURE.md's own "largest route file" note) -- this
# hook's job is only to keep further growth a deliberate choice, not silent creep.

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

# Cumulative-growth fallback (see header comment #2) -- only consulted when the
# single-edit check above didn't already fire, so a genuinely big single addition
# still gets the richer "cohort median" message rather than this one.
CUMULATIVE_FIRED=0
if [ "$GROWTH_ENOUGH" != "1" ]; then
  CUMULATIVE_GROWTH_THRESHOLD=150
  BASELINE_FILE="$REPO/.claude/hooks/.filesize_baselines.json"
  [ -f "$BASELINE_FILE" ] || echo '{}' > "$BASELINE_FILE"
  BASELINE_LINES="$(jq -r --arg f "$REL" '.[$f] // empty' "$BASELINE_FILE" 2>/dev/null)"
  if [ -z "$BASELINE_LINES" ]; then
    # First time this file's been seen by this check -- seed the baseline rather than
    # firing immediately (would otherwise spuriously fire for every existing outlier
    # the very first time this feature runs, regardless of any real recent growth).
    jq --arg f "$REL" --argjson n "$CUR_LINES" '.[$f] = $n' "$BASELINE_FILE" > "$BASELINE_FILE.tmp" && mv "$BASELINE_FILE.tmp" "$BASELINE_FILE"
  else
    CUM_GROWTH=$((CUR_LINES - BASELINE_LINES))
    if [ "$CUM_GROWTH" -ge "$CUMULATIVE_GROWTH_THRESHOLD" ]; then
      CUMULATIVE_FIRED=1
      jq --arg f "$REL" --argjson n "$CUR_LINES" '.[$f] = $n' "$BASELINE_FILE" > "$BASELINE_FILE.tmp" && mv "$BASELINE_FILE.tmp" "$BASELINE_FILE"
      MSG="$REL has grown by $CUM_GROWTH lines (now $CUR_LINES) since it was last flagged -- no single edit was big enough to trip the per-edit check, but the slow accumulation crossed $CUMULATIVE_GROWTH_THRESHOLD lines. A statistical outlier against its $SIBLING_N sibling files in $DIR (cohort median $MEDIAN lines). Per CLAUDE.md's 'default new acd.js logic to server/services/' convention: was any of what you just added genuinely self-contained (a new setup detector, calibration reader, shadow-tagger) that could have gone in server/services/ instead? If it deliberately belongs together, that's fine -- just a real decision, not creep nobody chose."
    fi
  fi
fi

if [ "$GROWTH_ENOUGH" != "1" ] && [ "$CUMULATIVE_FIRED" != "1" ]; then
  exit 0
fi

if [ -z "$MSG" ]; then
  MSG="$REL just grew to $CUR_LINES lines (+$GROWTH since the last commit), a statistical outlier against its $SIBLING_N sibling files in $DIR (cohort median $MEDIAN lines). Worth a moment: is this genuinely one cohesive thing, or does it want to be split? If it deliberately belongs together (like acd.js's Level Fade Engine), that's fine -- just a real decision, not size creep nobody chose."
fi

jq -n --arg ctx "$MSG" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}'
exit 0
