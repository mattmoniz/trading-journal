#!/usr/bin/env bash
# Shared hardcoded-threshold regex patterns — single source of truth, sourced by both:
#   .claude/hooks/check-docs-drift.sh (Stop hook: whole-file scan, session-end, advisory)
#   scripts/git-hooks/pre-commit      (git hook: staged-diff scan, commit-time, blocking)
# A new anti-pattern only needs to be added here once instead of in both places.

# Pattern A: hardcoded suppression set literal (e.g. new Set(['OR_HIGH_FADE', ...]))
PATTERN_A='new Set\(\['
PATTERN_A_EXCLUDE='_suppressedSetups\|_dowSuppressToday\|DAY_TYPE_CONDITIONAL\|SHADOW_SETUP\|displayPrimary\|SHADOW_SETUP_TYPES\|IB_SWEEP_TYPES'
PATTERN_A_LABEL='hardcoded Set literal (suppression list?)'

# Pattern B: hardcoded array of setup-type strings (e.g. mondaySkip = ['OR_HIGH_FADE',...])
# Requires the array to open directly on a quoted string literal — narrowed 2026-07-15
# after a false positive: `const firedDates = [...new Set(setupsRes.rows...)]` matched
# because PATTERN_B_FILTER's `setup` substring matched inside the unrelated variable name
# `setupsRes`, and the old PATTERN_B ('=\s*\[' alone) matches any array/spread opener, not
# just a hardcoded string-literal list. Verified: still matches `mondaySkip = ['OR_HIGH_FADE',
# 'IB_BEARISH']`; no longer matches spread/computed arrays like `[...new Set(...)]`.
PATTERN_B='=\s*\[\s*['"'"'"]'
PATTERN_B_FILTER='fade|suppress|skip|monday|setup'
PATTERN_B_EXCLUDE='IB_SWEEP_TYPES\|STOP_RANGE\|DOW_NAMES'
PATTERN_B_LABEL='hardcoded setup-type array'

# Pattern C: bare numeric STOP/TARGET assignment without _opt reference or Fallback annotation
PATTERN_C='const (STOP|TARGET) = [0-9]'
PATTERN_C_EXCLUDE='_opt\|Fallback\|// sweep\|DEFAULT_\|STOP_RANGE\|MIN_STOP'
PATTERN_C_LABEL='hardcoded STOP/TARGET constant (use _opt or add // Fallback comment)'

# Pattern D: day-of-week ternary with a numeric trading threshold (e.g. isMonday ? 60 : 90)
# Exclude: time-of-day minute checks (630=10:30, 960=4pm, 570=9:30), bar counts, date math
PATTERN_D='is(Monday|Dow|Tue|Wed|Thu|Fri)\s*\?.*[0-9]{2,}'
PATTERN_D_EXCLUDE='// data-derived\|etMinNow\|630\|960\|570\|629\|T12:00\|getDay\|post-IB\|10:30\|padEnd\|toFixed'
PATTERN_D_LABEL='DOW-conditional numeric trading threshold (use SETUP_STATUS_DOW pipeline instead)'

# Pattern E: wrong $/pt constant. This journal trades MNQ ($2/pt) — CLAUDE.md already
# documents this exact mistake happening TWICE independently (a backend script using
# PT=5/COMM=5, copied into 6 more scripts before being caught; and, found 2026-07-16, a
# frontend modal hardcoding * 5 for risk/reward labels while the SAME setup card's real
# resolved P&L used the correct $2/pt right next to it — plus a third file's tooltip text
# separately claiming "$20/pt", matching standard NQ instead of MNQ). Unlike patterns A-D,
# this is NOT scoped to acd.js/caseEngine.js — the frontend instance proves this bug can
# land anywhere a point distance gets turned into a dollar figure. Two sub-patterns: a
# multiplication against a points-shaped variable, and a literal "$N/pt" string mention.
PATTERN_E='([Pp]ts?|[Pp]oints?)\s*\*\s*(5|10|20)\b|\$(5|10|20)/pt'
# NQ session open->close x $20/pt (PlaybookView.jsx) reviewed 2026-07-16 and kept as a
# deliberate exclusion, not a bug: it's a purely observational/non-tradeable stat (its
# own text says so explicitly) intentionally described at NQ's real scale, since
# price_bars_primary only stores symbol='NQ' bars (MNQ isn't separately tracked there).
PATTERN_E_EXCLUDE='MNQ_DOLLARS_PER_POINT\|PNL_PER_POINT\|NQ session open'
PATTERN_E_LABEL='wrong $/pt constant (MNQ is $2/pt — see CLAUDE.md hard rule, src/constants/contract.js, or PNL_PER_POINT in acd.js)'
