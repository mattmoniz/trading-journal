#!/usr/bin/env bash
# Shared hardcoded-threshold regex patterns — single source of truth, sourced by both:
#   .claude/hooks/check-docs-drift.sh (Stop hook: whole-file scan, session-end, advisory)
#   scripts/git-hooks/pre-commit      (git hook: staged-diff scan, commit-time, blocking)
# A new anti-pattern only needs to be added here once instead of in both places.

# Pattern A: hardcoded suppression set literal (e.g. new Set(['OR_HIGH_FADE', ...]))
PATTERN_A='new Set\(\['
# Widened 2026-09-05 after 3 confirmed false positives firing every single Stop hook run
# (whole-file scan, not diff-only, so pre-existing hits never stop re-alerting): (1)
# STOP_SWEEP_PAUSED (acd.js) is a deliberate, already-tracked temporary pause set, not a
# suppression anti-pattern — its own comment says as much and points at OPEN_DECISION
# stop_sweep_long_calibrated_target_pause_or_keep. (2) UNCALIBRATED_SHADOW_TYPES (acd.js's
# `shadowTypes = [...new Set([...liveShadowTypes, ...UNCALIBRATED_SHADOW_TYPES])]`) is the
# exact live-query-plus-short-reviewed-fallback pattern CLAUDE.md's own
# shadowsetuptypes-hardcoded-list-anti-pattern convention documents as the correct fix, not
# the bug it replaced — the fallback constant itself lives in server/config/setupTypes.js,
# reviewed by test_invariants.mjs check [6]. (3) caseEngine.js's `tfs = [...new
# Set([...lv.timeframes, ...])]` dedupes timeframe labels for level-stacking display, not a
# setup-type suppression list at all.
PATTERN_A_EXCLUDE='_suppressedSetups\|_dowSuppressToday\|DAY_TYPE_CONDITIONAL\|SHADOW_SETUP\|displayPrimary\|SHADOW_SETUP_TYPES\|IB_SWEEP_TYPES\|STOP_SWEEP_PAUSED\|UNCALIBRATED_SHADOW_TYPES\|lv\.timeframes'
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
# shadowRef excluded 2026-09-05: `/setups/history`'s `conditions = ["status != 'SHADOW'",
# \`setup_type != ALL(${shadowRef})\`]` is dynamic SQL WHERE-clause fragment building keyed
# off a bound parameter placeholder, not a hardcoded list of setup_type string literals —
# matched only because PATTERN_B_FILTER's `setup` substring appears inside the unrelated
# text "setup_type", same false-positive shape as the 2026-07-15 firedDates fix above.
PATTERN_B_EXCLUDE='IB_SWEEP_TYPES\|STOP_RANGE\|DOW_NAMES\|shadowRef'
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
# 3 more excludes added 2026-09-05, same false-positive shape: comment PROSE describing an
# ALREADY-FIXED historical wrong-$/pt bug (the real code right below each comment now
# correctly reads LIVE_INSTRUMENT/real price-level math), not a currently-wrong constant —
# setupBacktestService.js's SSOT-audit comment ("even real NQ") and monteCarloService.js's
# 2026-07-17-fixed writeup ("matches neither" / "constant matches" describe the bug that
# WAS there; "an internal points" describes the synthetic generators' deliberate,
# self-consistent points*5 placeholder unit, never real dollars — see that file's own
# comment for why it's excluded from the fix, not a live instance of it).
PATTERN_E_EXCLUDE='MNQ_DOLLARS_PER_POINT\|PNL_PER_POINT\|NQ session open\|even real NQ\|matches neither\|constant matches\|an internal points'
PATTERN_E_LABEL='wrong $/pt constant (MNQ is $2/pt — see CLAUDE.md hard rule, src/constants/contract.js, or PNL_PER_POINT in acd.js)'

# Pattern F: SUM(pnl)/SUM(t.pnl)/SUM(...FlatToFlat...) — the CumPL-diff hard rule's exact
# anti-pattern ("must use CumPL diff, not SUM(pnl) or SUM(FlatToFlat) — both overcount").
# Added 2026-07-18 after a rule-prominence audit found this had zero hook backing despite
# being one of CLAUDE.md's oldest hard rules. Diff-only (not whole-file) like Pattern E —
# a whole-file scan found 15 PRE-EXISTING hits across the codebase when this was written,
# several plausibly legitimate (single-day, non-cumulative uses; dll.js's SUM(pnl) fallback
# is explicitly documented as intentional, matching the hard rule's own stated exception:
# "Fallback: COALESCE(cum_daily_pnl, SUM(t.pnl), 0) when no CumPL data"). Fixing/auditing
# those 15 is real, separate work (flagged as an OPEN_DECISION, not done here) — this
# pattern's job is only to stop a 16th one from landing silently.
PATTERN_F='SUM\(\s*t?\.?pnl\s*\)|SUM\([^)]*FlatToFlat'
# Path-excluded in the two consumers (dailyLogs.js/stats.js are the correct CumPL-diff
# implementation itself; dll.js's SUM(pnl) is an explicitly documented single-day fallback
# matching the hard rule's own stated exception) — same reasoning as PATTERN_G_EXCLUDE above.
PATTERN_F_EXCLUDE='§NOMATCH§'
PATTERN_F_LABEL='SUM(pnl)/SUM(FlatToFlat) — CumPL-diff hard rule violation (overcounts; see CLAUDE.md P&L rule)'

# Pattern G: new Date().toISOString().slice(0,10) — the exact JS-UTC-vs-SQL-CURRENT_DATE
# trading-day-date bug CLAUDE.md documents hitting 3 separate scripts on 2026-07-14 alone.
# Added 2026-07-18, same rule-prominence audit as Pattern F. Also diff-only — a whole-file
# scan found 20 pre-existing hits (mostly in scripts/, several already in scripts/archive/
# and therefore dead). The .slice(0,10) requirement narrows this to the specific
# date-only-truncation signature the hard rule warns about, not toISOString() generally
# (which has many legitimate non-trading-day uses, e.g. logging a timestamp).
PATTERN_G='new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)'
# No content-level exclude applies here (unlike A-E) — scripts/archive/ is excluded by
# path in the two consumers instead, same mechanism Pattern E uses for instruments.js/
# contract.js. PATTERN_G_EXCLUDE is a sentinel that can never match real content, so
# `grep -v "$PATTERN_G_EXCLUDE"` is a no-op rather than silently dropping every line
# (an empty string would match everything, excluding all hits).
PATTERN_G_EXCLUDE='§NOMATCH§'
PATTERN_G_LABEL='new Date().toISOString().slice(0,10) for a trading-day date — use SQL CURRENT_DATE instead (JS UTC vs DB America/New_York mismatch, see CLAUDE.md)'
