#!/usr/bin/env bash
# Blocks a commit that STAGES CLAUDE.md over its cap (added 2026-11-01 after it reached 539 KB / ~135k tokens and a nightly WARN in test_invariants [14] was ignored for months;
# a warning someone has to read is not a guard, a blocked commit is). CLAUDE.md is an INDEX: one short line per rule, the full text lives in docs/CLAUDE_MD_ARCHIVE/ and is added with
#   python3 scripts/claude_md_add_rule.py <hard_rules|conventions|collaboration> "<one line, <=200 chars>" --full <file|->
# Limits: 40960 bytes, 300 lines, and no index line (a "- " line under Hard rules / Conventions / Collaboration / Where to look) longer than 330 chars.
# Override for a deliberate, reviewed exception only: ALLOW_CLAUDE_MD_GROWTH=1 git commit ...  (state the reason in the commit message).
# Usage: called from scripts/git-hooks/pre-commit (checks the STAGED blob when CLAUDE.md is staged); `check-claude-md-size.sh <file>` checks a file directly (used by the tests).
MAX_BYTES=40960; MAX_LINES=300; MAX_LINE=330
[ "$ALLOW_CLAUDE_MD_GROWTH" = "1" ] && exit 0
FILE="$1"
if [ -n "$FILE" ]; then reader() { cat "$FILE"; }
else git diff --cached --name-only 2>/dev/null | grep -qx 'CLAUDE.md' || exit 0; reader() { git show :CLAUDE.md; }; fi
bytes=$(reader | wc -c); lines=$(reader | wc -l)
long=$(reader | awk -v m=$MAX_LINE '/^## /{sec=($0 ~ /Hard rules|Conventions|Collaboration|Where to look/)} sec && /^- / && length($0)>m {c++; if (n<3) {ex[n++]=substr($0,1,90)}} END{print c+0; for(i=0;i<n;i++) print ex[i]}')
nlong=$(echo "$long" | head -1)
if [ "$bytes" -gt "$MAX_BYTES" ] || [ "$lines" -gt "$MAX_LINES" ] || [ "$nlong" -gt 0 ]; then
  echo "BLOCKED: CLAUDE.md is an index with a hard cap (now ${bytes} bytes / ${lines} lines, ${nlong} index lines over ${MAX_LINE} chars; caps ${MAX_BYTES} / ${MAX_LINES})."
  echo "Put the full text in docs/CLAUDE_MD_ARCHIVE/ and keep ONE short line here:"
  echo "  python3 scripts/claude_md_add_rule.py <hard_rules|conventions|collaboration> \"<one line, <=200 chars>\" --full <file|->"
  echo "Research results and incident narratives are NOT CLAUDE.md entries: use scripts/record_claim.mjs, scripts/flag_decision.mjs or docs/OPEN_THREADS.md."
  echo "$long" | tail -n +2 | sed 's/^/  long line: /'
  echo "Deliberate reviewed exception: ALLOW_CLAUDE_MD_GROWTH=1 git commit ... (say why in the commit message)."
  exit 1
fi
exit 0
