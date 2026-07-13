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
PATTERN_B='=\s*\['
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
