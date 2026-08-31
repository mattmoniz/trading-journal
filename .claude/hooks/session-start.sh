#!/usr/bin/env bash
# SessionStart hook — injects startup context and common shortcuts into every new session.

REPO="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

export WATCHER_STATUS SERVER_STATUS SERVER_PORT_PID SERVER_MAIN_PID ALERT_COUNT LAST_ALERT
WATCHER_STATUS=$(systemctl --user is-active trading-journal-watcher.service 2>/dev/null || echo "unknown")
SERVER_STATUS=$(systemctl --user is-active trading-journal-server.service 2>/dev/null || echo "unknown")
# PID-identity check (added 2026-08-09, after SERVER_STATUS above sat printing "activating"
# for 4 real days -- see docs/DECISIONS_LOG.md -- as a bare, unstyled status line nobody
# (including Claude, at the actual start of the incident-discovery session) registered as
# significant. Two things now get surfaced loudly below instead of quietly: (a) SERVER_STATUS
# itself, whenever it isn't exactly "active"; (b) whether the process actually holding port
# 3002 right now is the SAME pid systemd thinks is its MainPID -- catches an orphaned
# ./start.sh dev session serving in place of the managed process even in the (normal, common)
# case where SERVER_STATUS still reads "active" because systemd successfully started once and
# just never got the port back.
SERVER_PORT_PID=$(ss -ltnp 2>/dev/null | grep ':3002 ' | grep -oP 'pid=\K[0-9]+' | head -1)
SERVER_MAIN_PID=$(systemctl --user show trading-journal-server.service -p MainPID --value 2>/dev/null)
# Duplicate-supervisor detector (added 2026-08-18, see docs/DECISIONS_LOG.md's 2026-08-18
# entry): the PID-identity check above catches ONE orphaned process silently serving in
# place of systemd, but not multiple simultaneous nodemon supervisors piled up from
# separate sessions each fighting over port 3002 (5 found live the day this was added,
# from a mix of a stale restart.sh session and bare `npm run server` calls -- neither had
# any single-instance protection at the time). start.sh/restart.sh/`npm run server` now
# all share one takeover path (scripts/lib/server-lifecycle.sh) that should prevent this
# going forward, but this stays as a loud backstop in case something still bypasses it.
export DUPLICATE_SERVER_COUNT DUPLICATE_SERVER_PIDS
DUPLICATE_SERVER_PIDS=$(pgrep -f "node_modules/.bin/nodemon server/index.js" 2>/dev/null | tr '\n' ' ')
DUPLICATE_SERVER_COUNT=$(echo "$DUPLICATE_SERVER_PIDS" | wc -w)
ALERT_COUNT=0
LAST_ALERT=""
if [ -f "$REPO/scratch/gemini_alerts.txt" ]; then
  ALERT_COUNT=$(grep -c "^\[" "$REPO/scratch/gemini_alerts.txt" 2>/dev/null || echo 0)
  LAST_ALERT=$(tail -1 "$REPO/scratch/gemini_alerts.txt" 2>/dev/null || echo "")
fi

# Recent SERVER_DOWN/SERVER_DOWN_PERSISTENT alerts (added 2026-08-09). Confirmed directly
# against the real 2026-08-05->08-07 outage: trading-journal-watcher.service's error watcher
# DID fire 10 real SERVER_DOWN/SERVER_DOWN_PERSISTENT alerts during that window -- the
# detection mechanism worked. The gap was visibility: those alerts sat in a 2000+-line file
# with only the single most-recent line ever surfaced (LAST_ALERT above), so they got buried
# under whatever unrelated Gemini alert happened to log next. This scans the last 3 days
# specifically for this one alert TYPE and surfaces a dedicated count/list, the same
# "don't rely on one bare summary line" fix already applied to SERVER_STATUS above.
export RECENT_SERVER_DOWN_ALERTS
RECENT_SERVER_DOWN_ALERTS=""
if [ -f "$REPO/scratch/gemini_alerts.txt" ]; then
  CUTOFF_TS=$(date -d '3 days ago' +%s 2>/dev/null || echo 0)
  RECENT_SERVER_DOWN_ALERTS=$(grep "SERVER_DOWN" "$REPO/scratch/gemini_alerts.txt" 2>/dev/null | awk -v cutoff="$CUTOFF_TS" '
    match($0, /\[([0-9]+\/[0-9]+\/[0-9]+), ([0-9]+:[0-9]+:[0-9]+)/, m) {
      cmd = "date -d \"" m[1] " " m[2] "\" +%s 2>/dev/null"
      cmd | getline ts
      close(cmd)
      if (ts >= cutoff) print
    }
  ' 2>/dev/null | tail -20)
fi

# Check mining script staleness — query performance_audit for last run_date per signal_type
export MINING_STATUS
MINING_STATUS=$(PGPASSWORD=trader123 psql -h localhost -U trader -d trading_journal -t -A -F'|' 2>/dev/null <<'SQLEOF'
SELECT
  signal_type,
  MAX(run_date)::text AS last_run,
  CURRENT_DATE - MAX(run_date) AS days_ago
FROM performance_audit
WHERE signal_type IN (
  'SESSION_BIAS','DAY_TYPE_ALPHA','CONTEXT_ANALYSIS',
  'SETUP_ANTICIPATION','OPTIMAL_STOP','PERMISSION_SLIP',
  'PULSE_SCORE_AUDIT','SETUP_STATUS'
)
GROUP BY signal_type
ORDER BY days_ago DESC;
SQLEOF
)

# Check pipeline coverage — any setup_type that has resolved trades in the last 30 days
# but NO SETUP_STATUS row dated within 8 days means it was added without running the pipeline.
export UNCOVERED_SETUPS
UNCOVERED_SETUPS=$(PGPASSWORD=trader123 psql -h localhost -U trader -d trading_journal -t -A -F'|' 2>/dev/null <<'SQLEOF'
SELECT a.setup_type
FROM (
  SELECT DISTINCT setup_type
  FROM active_setups
  WHERE trade_date >= CURRENT_DATE - 30
    AND resolution IN ('TARGET_HIT','STOP_HIT')
) a
WHERE NOT EXISTS (
  SELECT 1 FROM performance_audit
  WHERE signal_type = 'SETUP_STATUS'
    AND signal_name = a.setup_type
    AND run_date >= CURRENT_DATE - 8
);
SQLEOF
)

# Check for orphaned git worktrees — isolation:"worktree" Agent dispatches only get
# auto-cleaned by the harness if the agent made NO changes; otherwise a human/session
# has to explicitly resolve (merge/commit or discard) it. Nothing else in this repo's
# workflow surfaces an orphaned one, so it can sit silently for weeks (found 2026-07-16:
# a 2026-07-01 worktree with ~3,100 uncommitted lines went unnoticed until stumbled on
# by accident during an unrelated dead-code check).
export STRAY_WORKTREES
STRAY_WORKTREES=$(git -C "$REPO" worktree list --porcelain 2>/dev/null | awk -v main="$REPO" '
  /^worktree / { path=$2 }
  /^branch / { if (path != main) print path "|" $2 }
')

# Check RESEARCH_CLAIM ledger (scripts/record_claim.mjs) for claims past their
# next_recheck_due date — the same staleness idea as SETUP_STATUS above, but for
# exploratory/research findings instead of setup calibration.
export OVERDUE_CLAIMS
OVERDUE_CLAIMS=$(PGPASSWORD=trader123 psql -h localhost -U trader -d trading_journal -t -A -F'|' 2>/dev/null <<'SQLEOF'
SELECT p.signal_name, (p.notes::json->>'next_recheck_due') as next_recheck_due, (p.notes::json->>'status') as status
FROM performance_audit p
WHERE p.signal_type = 'RESEARCH_CLAIM'
  AND p.run_date = (SELECT MAX(run_date) FROM performance_audit p2 WHERE p2.signal_type='RESEARCH_CLAIM' AND p2.signal_name = p.signal_name)
  AND (p.notes::json->>'next_recheck_due')::date < CURRENT_DATE
ORDER BY (p.notes::json->>'next_recheck_due')::date;
SQLEOF
)

# OPEN_DECISION watch — 2026-07-17, user request: "anything that needs to be reevaluated
# should [be] flagged with something and actively monitored. Nothing can be buried."
# Sibling mechanism to RESEARCH_CLAIM above (scripts/flag_decision.mjs), deliberately a
# separate signal_type since a pending product/architecture decision (wire in or delete
# this feature? merge this branch?) has no statistical content and no "staleness" the way
# a research finding does -- it just sits PENDING until a human actually decides. Printed
# every session, unconditionally, until resolved via `node scripts/flag_decision.mjs
# --resolve <slug> '<resolution>'` -- that's the whole point, nothing gets to age out
# silently the way the 5 unrendered dashboard cards or the 55-commits-behind main branch
# did before anyone happened to notice them.
export OPEN_DECISIONS
OPEN_DECISIONS=$(PGPASSWORD=trader123 psql -h localhost -U trader -d trading_journal -t -A -F"$(printf '\t')" 2>/dev/null <<'SQLEOF'
WITH latest AS (
  SELECT DISTINCT ON (signal_name) signal_name, notes::jsonb as notes
  FROM performance_audit
  WHERE signal_type = 'OPEN_DECISION'
  ORDER BY signal_name, run_date DESC
)
-- replace() flattens embedded newlines in decision_text to spaces -- psql's -t -A output
-- is one ROW per line, so a multi-paragraph decision_text (this tool deliberately writes
-- rich, multi-paragraph context, not one-liners) would otherwise be misread as several
-- fake separate decisions by this hook's line-based parsing. Full multi-line text is still
-- available via `node scripts/flag_decision.mjs --list`, which reads via real JSON parsing
-- and has no such limit -- this flattening is only for the terminal summary. Found
-- 2026-07-17: this bug inflated the session-start count from the real 11 to a fake 41.
SELECT signal_name, replace(replace(notes->>'decision_text', E'\r', ' '), E'\n', ' '),
  (CURRENT_DATE - (notes->>'first_flagged_date')::date) as age_days,
  COALESCE(notes->>'priority', 'MEDIUM') as priority
FROM latest
WHERE notes->>'status' = 'PENDING'
ORDER BY
  CASE COALESCE(notes->>'priority', 'MEDIUM') WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END ASC,
  (notes->>'first_flagged_date')::date ASC;
SQLEOF
)

# Untracked-instrument watch — 2026-07-16, user request: "if you detect new products…
# this table needs to be updated." server/config/instruments.js / src/constants/
# contract.js are the single source of truth for $/pt math (see the DTM/pattern-E work
# above the same session — a wrong $/pt constant has independently drifted into this
# codebase 3+ times). Extracts the root symbol from trades.symbol (strips the trailing
# month-code+year, e.g. MNQZ4 -> MNQ) and flags any root that isn't a key in
# INSTRUMENTS, so a genuinely new instrument being traded gets noticed at the start of
# the very next session instead of silently defaulting to wrong/missing $/pt math
# somewhere the way MNQ/NQ's constant did.
export UNTRACKED_SYMBOLS
UNTRACKED_SYMBOLS=$(PGPASSWORD=trader123 psql -h localhost -U trader -d trading_journal -t -A 2>/dev/null <<'SQLEOF'
-- 'MNQ','NQ' here must match INSTRUMENTS' keys in server/config/instruments.js /
-- src/constants/contract.js exactly -- this SQL can't import that JS module directly,
-- so if a new instrument is ever added there, add its root here too (and vice versa:
-- if this ever flags a real new symbol, that's the signal to add it to both JS files).
SELECT DISTINCT regexp_replace(symbol, '[A-Z][0-9]+$', '') as root
FROM trades
WHERE regexp_replace(symbol, '[A-Z][0-9]+$', '') NOT IN ('MNQ', 'NQ')
ORDER BY root;
SQLEOF
)

# trade_feedback setup_id coverage — 2026-07-16. The execution-quality audit
# (docs/OPEN_THREADS.md, RESEARCH_CLAIM execution_quality_audit_blocked_on_attribution)
# concluded fill/slippage and stop/target-discipline can't be measured because
# trade_feedback (the table built specifically to link a real trade to a fired setup)
# had 0 rows with setup_id populated -- the UI component to populate it (TradeFeedbackBar)
# existed but was never mounted. Fixed same day (wired into App.jsx's LiveSessionPanel).
# This check is the other half of closing that loop: once real data exists, say so, so a
# future session actually goes back and re-runs the audit instead of the row count sitting
# unnoticed the same way the component itself sat unmounted.
export FEEDBACK_COVERAGE
FEEDBACK_COVERAGE=$(PGPASSWORD=trader123 psql -h localhost -U trader -d trading_journal -t -A -F'|' 2>/dev/null <<'SQLEOF'
SELECT COUNT(*) FILTER (WHERE setup_id IS NOT NULL), COUNT(*) FROM trade_feedback;
SQLEOF
)

# Fragile DAY_TYPE_MANAGED bucket watch — built 2026-07-16 after the IB_BULLISH regression
# (docs/OPEN_THREADS.md): IB_BULLISH silently un-suppressed from SUPPRESS back to a live
# status on 2026-07-15 because ITS OWN TREND bucket ticked from EV=-$16.24 to EV=-$2.94
# (N=33) -- still negative, still thin, but just barely above the -$5 SUPPRESS_MAX_EV bar,
# so the code's own logic correctly (per its threshold) let it through. A pure
# recompute-and-compare consistency check would NOT have caught this -- the stored value
# matched what the code would derive; the code's own bar was just too blunt for a
# borderline bucket. Nobody noticed for two days because nothing surfaced it. This section
# doesn't re-judge SUPPRESS/live status (that stays backtest_setup_status.mjs's job) -- it
# just makes every DAY_TYPE_MANAGED type's bucket breakdown impossible to miss at the start
# of every session, and calls out any bucket that's the ONLY thing keeping the type off
# SUPPRESS while sitting within $10 of the bar or under N=50 -- both signs of "technically
# passing, not actually trustworthy yet."
export DTM_WATCH
DTM_WATCH=$(PGPASSWORD=trader123 psql -h localhost -U trader -d trading_journal -t -A -F'|' 2>/dev/null <<'SQLEOF'
WITH latest AS (
  SELECT DISTINCT ON (signal_name) signal_name, recommendation, ev_per_trade, sample_size, notes::jsonb as notes
  FROM performance_audit
  WHERE signal_type='SETUP_STATUS'
    AND notes ~ '^\{' AND notes ~ '\}$'
    AND notes::jsonb ? 'day_type_breakdown'
    AND recommendation != 'SUPPRESS'
  ORDER BY signal_name, run_date DESC
)
SELECT l.signal_name, l.ev_per_trade, l.sample_size,
  b->>'day_type' as day_type, (b->>'n')::int as n, (b->>'ev')::float as ev
FROM latest l, jsonb_array_elements(l.notes->'day_type_breakdown') b
ORDER BY l.signal_name, (b->>'ev')::float DESC;
SQLEOF
)

# OPTIMAL_STOP real-population clustering watch — built 2026-08-30 after a user question ("does
# anything look funny with stops and targets") led to finding IB_BULLISH's live stop/target is
# calibrated from real N=60 that's 89.2% concentrated in just 5 calendar dates (8 distinct dates
# total). Critically, DTM_WATCH above CANNOT see this: SETUP_STATUS's own rigor field describes
# the BLENDED (real+BACKFILL) population (141 distinct dates, 32.9% top5 -- looks fine), while the
# real clustering lives only on the narrower, real-only population OPTIMAL_STOP's sweep actually
# runs on. A setup can look stable in one place and be riding on a handful of days in the other.
# Same "impossible to miss every session" pattern as DTM_WATCH -- does not re-judge or suppress
# anything, just surfaces what's already computed and currently buried.
export OPTSTOP_CLUSTER_WATCH
OPTSTOP_CLUSTER_WATCH=$(PGPASSWORD=trader123 psql -h localhost -U trader -d trading_journal -t -A -F'|' 2>/dev/null <<'SQLEOF'
WITH latest_stop AS (
  -- notes::jsonb excludes rows that don't parse as valid JSON (found live 2026-08-30:
  -- FLOOR_R1_FADE_LONG has a historical row with a second object literally string-concatenated
  -- onto the first, from a 2026-08-09 "noiseFloorRevert" annotation bug -- a single such row
  -- would otherwise abort this entire query's cast, not just skip itself). Flagged separately
  -- (OPEN_DECISION optstop_notes_malformed_json_concatenation) for someone to clean up the
  -- underlying data; this filter just keeps this watch itself from going dark because of it.
  SELECT DISTINCT ON (signal_name) signal_name, notes::jsonb as notes
  FROM performance_audit WHERE signal_type='OPTIMAL_STOP' AND notes IS NOT NULL AND notes ~ '^\s*\{.*\}\s*$' AND notes !~ '\}\s*\{'
  ORDER BY signal_name, run_date DESC
),
latest_status AS (
  SELECT DISTINCT ON (signal_name) signal_name, recommendation
  FROM performance_audit WHERE signal_type='SETUP_STATUS'
  ORDER BY signal_name, run_date DESC
)
SELECT ls.signal_name, (ls.notes->'rigor'->>'top5DayPct'),
  (ls.notes->'rigor'->>'distinctDates'), (ls.notes->'circuitBreaker'->>'tripped'),
  (ls.notes->'circuitBreaker'->>'lastRecalibratedN')
FROM latest_stop ls
JOIN latest_status st ON st.signal_name = ls.signal_name AND st.recommendation NOT IN ('SUPPRESS')
WHERE (ls.notes->'rigor'->>'clustered') = 'true'
   OR ((ls.notes->'rigor'->>'top5DayPct')::float >= 70)
ORDER BY (ls.notes->'rigor'->>'top5DayPct')::float DESC;
SQLEOF
)

# SHADOW validation watch — built 2026-07-17 after Opus Audit #3 found the closed loop that
# should prove suppression decisions are correct didn't exist: `active_setups.status` gets
# overwritten to RESOLVED/EXPIRED on resolution, permanently destroying whether a trade fired
# ACTIVE (real) or SHADOW (suppressed, background-only). Fixed with an immutable
# `origin_status` column (set once at insert, never touched by any resolution UPDATE) plus a
# one-time backfill (BACKFILL for synthetic historical rows, reconstructed via point-in-time
# SETUP_STATUS for 2026-07-09+, UNKNOWN before that -- no SETUP_STATUS snapshot history exists
# further back to reconstruct against). This section is the actual closed loop: for every
# setup_type currently SUPPRESS/THIN_N, what did its real forward SHADOW trades do AFTER the
# decision that suppressed it? Same "put the fragile state in front of a human every session"
# pattern as DTM_WATCH above -- don't let a wrong suppression sit unnoticed the way IB_BULLISH
# did. N will be thin for a long time (origin_status only tracks forward from 2026-07-17) --
# that's expected and reported honestly, not hidden.
export SHADOW_VALIDATION
SHADOW_VALIDATION=$(PGPASSWORD=trader123 psql -h localhost -U trader -d trading_journal -t -A -F'|' 2>/dev/null <<'SQLEOF'
WITH latest_suppress AS (
  SELECT DISTINCT ON (signal_name) signal_name, recommendation, run_date
  FROM performance_audit
  WHERE signal_type='SETUP_STATUS' AND recommendation IN ('SUPPRESS','THIN_N')
  ORDER BY signal_name, run_date DESC
)
SELECT ls.signal_name, ls.recommendation, ls.run_date,
  COUNT(a.id) as n,
  COUNT(*) FILTER (WHERE a.actual_pnl > 0) as wins,
  COALESCE(ROUND(AVG(a.actual_pnl)::numeric, 2), 0) as ev
FROM latest_suppress ls
LEFT JOIN active_setups a ON a.setup_type = ls.signal_name AND a.origin_status='SHADOW'
  AND a.trade_date > ls.run_date AND a.actual_pnl IS NOT NULL
GROUP BY ls.signal_name, ls.recommendation, ls.run_date
HAVING COUNT(a.id) > 0
ORDER BY COUNT(a.id) DESC;
SQLEOF
)

# Target-method promotion/demotion watch — 2026-07-19. update_optimal_stops.mjs now has two
# target-selection paths (EV-sweep vs. the corrected-resim methodology in
# targetCalibrationService.js), and by design it re-evaluates every setup_type from scratch
# on every scheduled run with no memory of prior status -- a setup that stops clearing the
# guardrails automatically falls back, one that starts clearing them automatically promotes.
# That's the mechanism; this is the VISIBILITY layer for it -- since run_date is preserved
# per-day (not overwritten across days), diff today's latest row against the immediately
# prior distinct run_date's row for each setup_type and flag any method change so a
# promotion/demotion is never just a silent diff nobody notices, same "put the fragile state
# in front of a human every session" pattern as DTM_WATCH/SHADOW_VALIDATION above.
export TARGET_METHOD_WATCH
TARGET_METHOD_WATCH=$(PGPASSWORD=trader123 psql -h localhost -U trader -d trading_journal -t -A -F'|' 2>/dev/null <<'SQLEOF'
WITH ranked AS (
  SELECT signal_name, run_date,
    CASE WHEN notes ~ '"method":"corrected-resim"' THEN 'corrected-resim' ELSE 'ev-sweep' END as method,
    ROW_NUMBER() OVER (PARTITION BY signal_name ORDER BY run_date DESC) as rn
  FROM performance_audit
  WHERE signal_type='OPTIMAL_STOP'
),
latest AS (SELECT signal_name, run_date, method FROM ranked WHERE rn=1),
prior AS (SELECT signal_name, run_date, method FROM ranked WHERE rn=2)
SELECT l.signal_name, l.method as latest_method, p.method as prior_method, l.run_date::text, p.run_date::text
FROM latest l
LEFT JOIN prior p ON p.signal_name = l.signal_name
WHERE l.method = 'corrected-resim' OR p.method = 'corrected-resim'
ORDER BY (l.method != COALESCE(p.method, l.method)) DESC, l.signal_name;
SQLEOF
)

# Corrected-target-but-suppressed watch — 2026-07-19. Found while checking whether
# backtest_setup_status.mjs (the live SUPPRESS/PROMOTE pipeline, separate from
# update_optimal_stops.mjs) has the same bugs the target-calibration fix addressed. It
# doesn't (it uses real actual_pnl directly, already commission-exact, no truncated-MFE
# candidate sweep) -- but there's a real, structural consequence instead: actual_pnl for
# historical trades reflects whatever target was live AT THE TIME, so a setup whose target
# just got corrected (often substantially wider) has its SUPPRESS/PROMOTE decision computed
# against STALE, pre-correction history. Confirmed concretely: PD_LOW_FADE_LONG is currently
# SUPPRESSED (EV=-$15.01 under its old 60pt target) despite its corrected 143pt target
# showing one of the largest walk-forward improvements of all 19 (+$3,480, trade count
# 11->74) -- it just can't prove that recovery yet because its suppressed SHADOW trades
# need time to accumulate under the new target (confirmed liveStats._opt is read for BOTH
# ACTIVE and SHADOW candidates in acd.js, so this DOES self-heal via the existing SHADOW
# VALIDATION / PROMOTE mechanism above -- just not instantly, gated by the same N>=15
# anti-fabrication floor as everything else). This section makes that lag visible instead
# of leaving it to be rediscovered by accident.
export CORRECTED_BUT_SUPPRESSED
CORRECTED_BUT_SUPPRESSED=$(PGPASSWORD=trader123 psql -h localhost -U trader -d trading_journal -t -A -F'|' 2>/dev/null <<'SQLEOF'
WITH corrected AS (
  SELECT DISTINCT ON (signal_name) signal_name, optimal_stop, optimal_target
  FROM performance_audit
  WHERE signal_type='OPTIMAL_STOP' AND notes ~ '"method":"corrected-resim"'
  ORDER BY signal_name, run_date DESC
),
status AS (
  SELECT DISTINCT ON (signal_name) signal_name, recommendation, ev_per_trade, sample_size
  FROM performance_audit
  WHERE signal_type='SETUP_STATUS'
  ORDER BY signal_name, run_date DESC
)
SELECT c.signal_name, s.recommendation, s.ev_per_trade, s.sample_size, c.optimal_target
FROM corrected c JOIN status s ON s.signal_name = c.signal_name
WHERE s.recommendation IN ('SUPPRESS','THIN_N') OR (s.recommendation='ACTIVE' AND s.ev_per_trade < 5)
ORDER BY (s.recommendation IN ('SUPPRESS','THIN_N')) DESC, s.ev_per_trade ASC;
SQLEOF
)

# Doc size growth watch — 2026-07-31. CLAUDE.md and docs/OPEN_THREADS.md are both read at
# the start of every session (per this hook's own "IMPORTANT" line below), so their size is
# a direct, recurring per-session token cost. Found the same day this was built:
# OPEN_THREADS.md had grown to 856KB/~214K tokens uncommitted, unnoticed because nothing
# ever surfaced its growth — archived via scripts/archive_open_threads.mjs the same session.
# Threshold is growth-since-last-commit (not a flat KB number) so a big archiving/trim commit
# resets the baseline to zero automatically, matching post-edit-filesize.sh's own
# "grew by X since last commit" convention rather than inventing a new fixed cutoff.
export DOC_SIZE_INFO
DOC_SIZE_INFO=""
for f in CLAUDE.md docs/OPEN_THREADS.md; do
  if [ -f "$REPO/$f" ]; then
    CUR=$(wc -c < "$REPO/$f" | tr -d ' ')
    HEAD_SIZE=$(git -C "$REPO" show "HEAD:$f" 2>/dev/null | wc -c | tr -d ' ')
    [ -z "$HEAD_SIZE" ] && HEAD_SIZE=0
    DOC_SIZE_INFO="${DOC_SIZE_INFO}${f}|${CUR}|${HEAD_SIZE}"$'\n'
  fi
done

# test_invariants.mjs FAIL watch — 2026-07-17. Wired into run_daily_calibration.sh the same
# day (previously manual-only: "run after any change touching acd.js..."), which meant a
# real invariant break (e.g. check [6]'s UNCALIBRATED_SHADOW_TYPES staleness) could sit
# undetected in scratch/daily_calibration.log indefinitely unless someone happened to open
# it. Extracts just the MOST RECENT day's calibration block (the log accumulates every
# weekday run in one file) and greps it for FAIL lines, so a break surfaces here instead of
# silently in a log nobody reads — same "nothing gets buried" philosophy as OPEN_DECISIONS.
export INVARIANT_FAILURES
INVARIANT_FAILURES=""
if [ -f "$REPO/scratch/daily_calibration.log" ]; then
  LAST_RUN_BLOCK=$(tac "$REPO/scratch/daily_calibration.log" | awk '/=== Daily calibration: /{print; exit} {print}' | tac)
  # Match test_invariants.mjs's exact fail() output ("  FAIL  <msg>") -- a naive grep for
  # "FAIL" also matches unrelated log lines like "FAILED_AUCTION_LONG" (a setup_type name
  # from backtest_setup_status.mjs's own output earlier in the same block), which would
  # have produced false-positive 🔴s every single day. Caught by testing against the real
  # log before shipping, not assumed correct from reading the pattern alone.
  INVARIANT_FAILURES=$(echo "$LAST_RUN_BLOCK" | grep -E "^  FAIL  " || true)
fi

node - <<'JSEOF'
const s = process.env.SERVER_STATUS || 'unknown';
const portPid = process.env.SERVER_PORT_PID || '';
const mainPid = process.env.SERVER_MAIN_PID || '';
// mainPid is '0' (not empty) when the unit isn't running at all -- only a genuine,
// nonzero mismatch against whatever's actually holding the port counts as the "wrong
// process is serving" signal; an unbound port with mainPid=0 is just "server is down",
// already covered by the s !== 'active' check below.
const pidMismatch = portPid && mainPid && mainPid !== '0' && portPid !== mainPid;
const dupServerCount = parseInt(process.env.DUPLICATE_SERVER_COUNT || '0', 10);
const dupServerPids = (process.env.DUPLICATE_SERVER_PIDS || '').trim();
const recentServerDownRaw = process.env.RECENT_SERVER_DOWN_ALERTS || '';
const recentServerDownLines = recentServerDownRaw.split('\n').filter(Boolean);
const w = process.env.WATCHER_STATUS || 'unknown';
const n = process.env.ALERT_COUNT || '0';
const last = process.env.LAST_ALERT || '';
const miningRaw = process.env.MINING_STATUS || '';
const uncoveredRaw = process.env.UNCOVERED_SETUPS || '';
const overdueClaimsRaw = process.env.OVERDUE_CLAIMS || '';
const openDecisionsRaw = process.env.OPEN_DECISIONS || '';
const strayWorktreesRaw = process.env.STRAY_WORKTREES || '';
const dtmRaw = process.env.DTM_WATCH || '';
const optstopClusterRaw = process.env.OPTSTOP_CLUSTER_WATCH || '';
const shadowValRaw = process.env.SHADOW_VALIDATION || '';
const targetMethodRaw = process.env.TARGET_METHOD_WATCH || '';
const correctedSuppressedRaw = process.env.CORRECTED_BUT_SUPPRESSED || '';
const feedbackCoverageRaw = process.env.FEEDBACK_COVERAGE || '0|0';
const [feedbackWithSetupId, feedbackTotal] = feedbackCoverageRaw.split('|').map(n => parseInt(n, 10) || 0);
const untrackedSymbols = (process.env.UNTRACKED_SYMBOLS || '').split('\n').filter(Boolean);
const invariantFailures = (process.env.INVARIANT_FAILURES || '').split('\n').filter(Boolean);
const docSizeRows = (process.env.DOC_SIZE_INFO || '').split('\n').filter(Boolean).map(l => {
  const [file, cur, head] = l.split('|');
  return { file, cur: parseInt(cur, 10) || 0, head: parseInt(head, 10) || 0 };
});
const GROWTH_FLAG_PCT = 0.15; // matches post-edit-filesize.sh's "significant single-session growth" spirit
const docSizeLines = docSizeRows.map(({ file, cur, head }) => {
  const kb = (cur / 1024).toFixed(1);
  const tokens = Math.round(cur / 4).toLocaleString();
  const pctGrowth = head > 0 ? (cur - head) / head : 0;
  const flag = head > 0 && pctGrowth > GROWTH_FLAG_PCT;
  return { file, kb, tokens, pctGrowth, flag };
});

// Parse mining staleness rows: "signal_type|last_run|days_ago"
const miningLines = miningRaw.split('\n').filter(Boolean).map(line => {
  const [sig, date, days] = line.split('|');
  const d = parseInt(days, 10);
  const icon = d <= 8 ? '✅' : d <= 14 ? '⚠️ STALE' : '🔴 OVERDUE';
  return `  ${icon.padEnd(12)} ${(sig||'').padEnd(22)} last: ${date||'never'} (${d}d ago)`;
});
const miningStale = miningRaw.split('\n').filter(Boolean).some(line => {
  const days = parseInt(line.split('|')[2], 10);
  return days > 8;
});

// Pipeline coverage: setup types with no fresh SETUP_STATUS row
const uncovered = uncoveredRaw.split('\n').filter(Boolean);

// RESEARCH_CLAIM ledger: claims past their next_recheck_due date
const overdueClaims = overdueClaimsRaw.split('\n').filter(Boolean).map(line => {
  const [slug, dueDate, status] = line.split('|');
  return `  ${(slug||'').padEnd(35)} due ${dueDate||'?'} (${status||'?'})`;
});

// OPEN_DECISION watch: pending product/architecture decisions, sorted HIGH->MEDIUM->LOW
// priority then oldest-first within each tier (added 2026-07-17, same request that built
// this whole tool -- "give them a sense of priority"), with age since first flagged so a
// genuinely-ignored-too-long one stands out over time. Age computed in SQL (CURRENT_DATE -
// date), not JS Date() -- this codebase's own hard rule against naive local-timezone date
// arithmetic (see CLAUDE.md's parseDateTime writeup).
const openDecisionsParsed = openDecisionsRaw.split('\n').filter(Boolean).map(line => {
  const [slug, decisionText, ageDays, priority] = line.split('\t');
  return { slug, decisionText: decisionText || '', ageDays: ageDays || '?', priority: priority || 'MEDIUM' };
});
const openDecisions = openDecisionsParsed.map(d =>
  `  [${d.priority}] [${d.ageDays}d] ${d.slug}\n      ${d.decisionText}`
);
// HIGH-priority queue cap (2026-08-05, user request: "worth a cap -- if everything's HIGH,
// the ordering does no work"). Query is already sorted HIGH->MEDIUM->LOW then oldest-first
// (see the SQL above), so this is a pure display cap, not a re-sort -- HIGH always prints in
// full since that's the whole point of the tier, but MEDIUM/LOW beyond a small cap collapse
// to a count so the section doesn't just become a second OPEN_THREADS.md wall of text. If the
// HIGH tier itself is overloaded, that's a distinct, louder problem (a triage prompt, not a
// display issue) -- see HIGH_QUEUE_CAP below.
const HIGH_QUEUE_CAP = 8; // matches the threshold already used in flag_decision.mjs's own nudge
const MED_LOW_DISPLAY_CAP = 5;
const highDecisions = openDecisionsParsed.filter(d => d.priority === 'HIGH');
const medLowDecisions = openDecisionsParsed.filter(d => d.priority !== 'HIGH');
const openDecisionsCapped = [
  ...highDecisions.map(d => `  [${d.priority}] [${d.ageDays}d] ${d.slug}\n      ${d.decisionText}`),
  ...medLowDecisions.slice(0, MED_LOW_DISPLAY_CAP).map(d => `  [${d.priority}] [${d.ageDays}d] ${d.slug}\n      ${d.decisionText}`),
  ...(medLowDecisions.length > MED_LOW_DISPLAY_CAP
    ? [`  ... and ${medLowDecisions.length - MED_LOW_DISPLAY_CAP} more MEDIUM/LOW pending -- node scripts/flag_decision.mjs --list for the full set`]
    : []),
];
const highQueueOverloaded = highDecisions.length > HIGH_QUEUE_CAP;

// Orphaned worktrees: any worktree besides the main repo checkout
const strayWorktrees = strayWorktreesRaw.split('\n').filter(Boolean).map(line => {
  const [path, branch] = line.split('|');
  return `  ${path} (${branch||'?'})`;
});

// DAY_TYPE_MANAGED bucket watch: group rows by signal_name, flag any type whose ONLY
// bucket(s) clearing the -$5 bar are fragile (within $10 of the bar, or N<50).
const dtmRowsByType = {};
for (const line of dtmRaw.split('\n').filter(Boolean)) {
  const [type, blendedEv, blendedN, dayType, n, ev] = line.split('|');
  if (!dtmRowsByType[type]) dtmRowsByType[type] = { blendedEv: parseFloat(blendedEv), blendedN: parseInt(blendedN, 10), buckets: [] };
  dtmRowsByType[type].buckets.push({ dayType, n: parseInt(n, 10), ev: parseFloat(ev) });
}
const dtmLines = [];
let dtmFragile = 0;
for (const [type, data] of Object.entries(dtmRowsByType)) {
  const goodBuckets = data.buckets.filter(b => b.ev >= -5);
  const fragileGood = goodBuckets.filter(b => b.ev < 5 || b.n < 50);
  const isFragile = goodBuckets.length > 0 && fragileGood.length === goodBuckets.length;
  if (isFragile) dtmFragile++;
  const bucketStr = data.buckets.map(b => `${b.dayType} N=${b.n} EV=$${b.ev.toFixed(2)}${fragileGood.some(f => f.dayType === b.dayType) ? ' ⚠️' : ''}`).join(', ');
  dtmLines.push(`  ${isFragile ? '⚠️ ' : '   '}${type.padEnd(15)} blended EV=$${data.blendedEv.toFixed(2)} N=${data.blendedN}  [${bucketStr}]`);
}

// OPTIMAL_STOP clustering watch: any currently-live setup_type whose REAL calibration sample
// (not the blended one DTM_WATCH already shows) is concentrated in a handful of dates.
const optstopClusterLines = [];
for (const line of optstopClusterRaw.split('\n').filter(Boolean)) {
  const [type, top5Pct, distinctDates, tripped, lastN] = line.split('|');
  const trippedFlag = tripped === 'true' ? ' [circuit breaker currently frozen -- would move further without it]' : '';
  optstopClusterLines.push(`  ⚠️ ${type.padEnd(24)} real N=${lastN}, ${top5Pct}% of it from just its top 5 dates (${distinctDates} distinct dates total)${trippedFlag}`);
}

// SHADOW validation: for every currently-SUPPRESS/THIN_N setup_type, what did its real
// forward SHADOW trades do since the decision? N<20 is expected for a long time (tracking
// only starts 2026-07-17) -- reported honestly as "accumulating," not hidden or padded.
const shadowValLines = [];
let shadowDisagree = 0, shadowAgree = 0;
for (const line of shadowValRaw.split('\n').filter(Boolean)) {
  const [type, rec, runDate, n, wins, ev] = line.split('|');
  const nInt = parseInt(n, 10), evF = parseFloat(ev), winsInt = parseInt(wins, 10);
  const wr = nInt > 0 ? (winsInt / nInt * 100).toFixed(1) : '0.0';
  let flag = '';
  if (nInt >= 20 && evF > 0) { flag = ' 🔴 DISAGREES with suppression — forward SHADOW EV is positive, re-examine'; shadowDisagree++; }
  else if (nInt >= 20 && evF < -5) { flag = ' ✅ confirms suppression'; shadowAgree++; }
  else { flag = ` (N<20, still accumulating — need ${20 - nInt} more)`; }
  shadowValLines.push(`  ${type.padEnd(30)} ${rec.padEnd(8)} since ${runDate}: N=${nInt} WR=${wr}% EV=$${evF.toFixed(2)}${flag}`);
}

// Target-method promotion/demotion watch: any setup_type currently using corrected-resim,
// or that JUST STOPPED using it (a real demotion) or JUST STARTED (a real promotion).
const tmLines = [];
let tmPromotions = 0, tmDemotions = 0, tmSteady = 0;
for (const line of targetMethodRaw.split('\n').filter(Boolean)) {
  const [type, latestMethod, priorMethod, latestDate, priorDate] = line.split('|');
  if (!priorMethod) { tmLines.push(`  ${type.padEnd(30)} ${latestMethod} (first run using this methodology, no prior run to compare)`); continue; }
  if (latestMethod === priorMethod) { tmSteady++; tmLines.push(`  ${type.padEnd(30)} ${latestMethod} (steady since ${priorDate})`); continue; }
  if (latestMethod === 'corrected-resim') { tmPromotions++; tmLines.push(`  ⬆️  ${type.padEnd(28)} PROMOTED to corrected-resim (was ev-sweep as of ${priorDate})`); }
  else { tmDemotions++; tmLines.push(`  ⬇️  ${type.padEnd(28)} DEMOTED to ev-sweep (was corrected-resim as of ${priorDate}) — its own guardrails no longer pass, re-read before trusting the old ev-sweep number`); }
}

// Corrected-target-but-blocked-by-stale-suppression watch: setups whose target was just
// validated/corrected but whose SUPPRESS/PROMOTE decision still reflects pre-correction
// history. SUPPRESS/THIN_N = fully blocked (fires SHADOW only); borderline ACTIVE = at
// real risk of flipping to SUPPRESS on the next weekly run despite the fix.
const csLines = [];
let csBlocked = 0, csBorderline = 0;
for (const line of correctedSuppressedRaw.split('\n').filter(Boolean)) {
  const [type, rec, ev, n, newTarget] = line.split('|');
  const evF = parseFloat(ev);
  if (rec === 'SUPPRESS' || rec === 'THIN_N') {
    csBlocked++;
    csLines.push(`  🔴 ${type.padEnd(28)} ${rec.padEnd(9)} EV=$${evF.toFixed(2)} N=${n} — fully blocked from live firing despite a validated new target=${newTarget}pt; will only recover once enough SHADOW trades accumulate under the new target (see SHADOW VALIDATION)`);
  } else {
    csBorderline++;
    csLines.push(`  ⚠️  ${type.padEnd(28)} ACTIVE    EV=$${evF.toFixed(2)} N=${n} — borderline, at risk of SUPPRESS on stale pre-correction history despite new target=${newTarget}pt`);
  }
}

const lines = [
  '=== SESSION START PROTOCOL ===',
  '',
  'IMPORTANT: Read CLAUDE.md and docs/OPEN_THREADS.md before doing anything.',
  'OPEN_THREADS.md has pending work, unconfirmed proposals, and stale stats.',
  '',
  '=== SYSTEM STATUS ===',
  `Trading journal server : ${s}${s !== 'active' ? '  <-- NOT "active", see the 🔴 alert below' : ''}`,
  `Error watcher service  : ${w}`,
  `Gemini alert count     : ${n} lines in scratch/gemini_alerts.txt`,
  last ? `Last alert             : ${last}` : '',
  '',
  `=== MINING SCRIPTS STATUS ${miningStale ? '⚠️  (STALE — re-run needed)' : '(all fresh)'}  ===`,
  ...miningLines,
  miningStale ? '\nACTION: Run stale scripts or check cron logs in scratch/session_bias.log / scratch/weekly_backtests.log' : '',
  '',
  uncovered.length > 0
    ? `🔴 PIPELINE COVERAGE GAP — setup types with trades in last 30d but NO fresh SETUP_STATUS row:\n  ${uncovered.join(', ')}\n  ACTION: run node scripts/backtest_setup_status.mjs && node scripts/update_optimal_stops.mjs`
    : '✅ Pipeline coverage: all active setup types have fresh SETUP_STATUS rows',
  '',
  overdueClaims.length > 0
    ? `🔴 RESEARCH_CLAIM LEDGER — ${overdueClaims.length} claim(s) past their recheck date:\n${overdueClaims.join('\n')}\n  ACTION: re-verify each against its source, then node scripts/record_claim.mjs --add '{...}' with the refreshed numbers`
    : '✅ RESEARCH_CLAIM ledger: no claims currently overdue for recheck',
  '',
  openDecisions.length > 0
    ? `🟡 OPEN DECISIONS — ${openDecisions.length} pending (${highDecisions.length} HIGH), oldest first (nothing gets buried until resolved):\n${openDecisionsCapped.join('\n')}\n  ACTION: resolve one via node scripts/flag_decision.mjs --resolve <slug> '<resolution text>', or discuss with the user`
    : '✅ No open decisions pending.',
  highQueueOverloaded
    ? `⚠️  HIGH-priority queue is overloaded: ${highDecisions.length} pending HIGH decisions (cap: ${HIGH_QUEUE_CAP}). Past this point HIGH stops meaning "the next thing to look at" and starts meaning "everything" -- the ordering does no work. Triage before flagging new HIGH items: resolve what's actually done, or re-flag genuinely-non-urgent ones at MEDIUM.`
    : '',
  '',
  strayWorktrees.length > 0
    ? `🔴 ORPHANED WORKTREE(S) — ${strayWorktrees.length} besides the main checkout:\n${strayWorktrees.join('\n')}\n  ACTION: investigate (git -C <path> status / git log), then commit+merge or discard — don't let it sit`
    : '✅ No orphaned worktrees',
  '',
  // Added 2026-08-09 -- see docs/DECISIONS_LOG.md's 2026-08-09 entry. A 4-day outage of the
  // managed server sat undetected because the ONLY existing surface for this (the bare
  // "Trading journal server : activating" line above) was easy to read past -- it happened
  // at the very start of the session that eventually found the incident, and even a careful
  // read-through missed its significance. This block is the loud version: fires whenever
  // SERVER_STATUS isn't exactly "active", OR whenever something other than systemd's own
  // MainPID is holding port 3002 (the "an orphaned dev session is silently standing in"
  // case, which can be true even while SERVER_STATUS still reads "active" from a stale
  // successful start much earlier).
  (s !== 'active' || pidMismatch)
    ? `🔴 TRADING JOURNAL SERVER NOT HEALTHY -- ${s !== 'active' ? `systemd reports "${s}", not "active"` : `port 3002 is held by PID ${portPid}, not systemd's managed PID ${mainPid} -- an orphaned process (likely ./start.sh left running) is serving in its place`}.\n  ACTION: check \`systemctl --user status trading-journal-server.service\` and \`journalctl --user -u trading-journal-server.service -n 50\` before assuming a simple restart fixes it -- if something else is still holding port 3002, a restart will just crash-loop again. Kill the stray process (or run ./stop.sh, which also kills the managed service -- restart it after) first.`
    : '',
  '',
  dupServerCount > 1
    ? `🔴 DUPLICATE SERVER SUPERVISORS -- ${dupServerCount} separate nodemon processes running server/index.js at once (PIDs: ${dupServerPids}). Only one can hold port 3002 -- the rest crash-loop against it and each other forever, which is exactly what tripped trading-journal-server.service into a permanent 'failed' state on 2026-08-18.\n  ACTION: check \`ss -tlnp | grep 3002\` to find which PID actually holds the port, then \`kill -9\` every other one in the list above. start.sh/restart.sh/\`npm run server\` all share one takeover path now (scripts/lib/server-lifecycle.sh) that's supposed to prevent this -- if you're seeing this, something bypassed all three (e.g. \`nodemon server/index.js\` run directly instead of through \`npm run server\`).`
    : '',
  '',
  recentServerDownLines.length > 0
    ? `🔴 SERVER_DOWN alerts in the last 3 days (${recentServerDownLines.length} line(s), from trading-journal-watcher.service -- the detection mechanism works, it's real downtime, not a false alarm):\n${recentServerDownLines.map(l => '  ' + l).join('\n')}\n  ACTION: don't dismiss as noise even if the server looks fine right now -- this is exactly how the 2026-08-05->08-09 outage sat undetected for 4 days (docs/DECISIONS_LOG.md). Check whether each gap is explained (a deliberate ./start.sh takeover, a deploy) or a real recurring problem.`
    : '',
  '',
  dtmLines.length > 0
    ? `${dtmFragile > 0 ? '⚠️ ' : '✅'} DAY_TYPE_MANAGED WATCH — live per-day-type-carve-out types, not gated by the standard SUPPRESS check:\n${dtmLines.join('\n')}${dtmFragile > 0 ? `\n  ${dtmFragile} type(s) have ⚠️ flagged buckets — only reason not SUPPRESSed is a bucket within $10 of the bar or N<50. Re-read before trusting; this is exactly how IB_BULLISH regressed 2026-07-15 (docs/OPEN_THREADS.md).` : ''}`
    : '',
  '',
  optstopClusterLines.length > 0
    ? `⚠️ OPTIMAL_STOP CLUSTERING WATCH — live setup_type(s) whose REAL calibration sample is concentrated in a handful of dates (invisible to DAY_TYPE_MANAGED WATCH above, which only sees the blended population):\n${optstopClusterLines.join('\n')}\n  A "stable" live stop/target here may just mean a circuit breaker is freezing it, not that the calibration is actually trustworthy at this breadth. Re-read before trusting; found 2026-08-30 (OPEN_DECISION optstop_sweep_implausible_rr_thin_samples).`
    : '',
  '',
  shadowValLines.length > 0
    ? `${shadowDisagree > 0 ? '🔴' : '📊'} SHADOW VALIDATION — real forward outcomes for currently-suppressed setup_types (the actual closed loop, built 2026-07-17):\n${shadowValLines.join('\n')}${shadowDisagree > 0 ? `\n  ${shadowDisagree} type(s) DISAGREE with their own suppression — forward SHADOW data at N≥20 shows positive EV. Re-examine before trusting the SUPPRESS label.` : shadowAgree > 0 ? `\n  ${shadowAgree} type(s) confirmed by forward data (N≥20, EV<-$5) — suppression is validated, not just asserted.` : ''}`
    : '📊 SHADOW VALIDATION: no forward SHADOW trades yet (origin_status tracking only started 2026-07-17) — nothing to validate yet, check back as data accumulates.',
  '',
  tmLines.length > 0
    ? `${tmDemotions > 0 ? '⚠️ ' : '📈'} TARGET METHOD WATCH — corrected-resim vs. ev-sweep target selection, re-evaluated fresh every scheduled run (built 2026-07-19):\n${tmLines.join('\n')}${tmDemotions > 0 ? `\n  ${tmDemotions} demotion(s) this run — a setup that was using the corrected methodology no longer clears its guardrails. This is the relegation mechanism working as intended, not a bug — but check WHY before assuming the old ev-sweep number is trustworthy.` : ''}${tmPromotions > 0 ? `\n  ${tmPromotions} promotion(s) this run — a setup newly cleared every guardrail (more data, or an anchor/candidate shift).` : ''}`
    : '📈 TARGET METHOD WATCH: no setup_type currently uses the corrected-resim methodology (or update_optimal_stops.mjs hasn\'t run since it was wired in 2026-07-19).',
  '',
  csLines.length > 0
    ? `${csBlocked > 0 ? '🔴' : '⚠️ '} CORRECTED-TARGET-BUT-SUPPRESSED WATCH — setups with a validated new target still blocked by pre-correction suppression history (built 2026-07-19):\n${csLines.join('\n')}${csBlocked > 0 ? `\n  ${csBlocked} fully blocked, ${csBorderline} borderline. Self-heals via SHADOW trades accumulating under the new target (see SHADOW VALIDATION above) -- do not manually override, N>=15 recovery floor is deliberate. Just don't be surprised these setups look "unprofitable" — check here first.` : `\n  ${csBorderline} borderline ACTIVE type(s) at real risk of flipping SUPPRESS on stale history despite a validated new target.`}`
    : '✅ CORRECTED-TARGET-BUT-SUPPRESSED WATCH: no corrected-target setup is currently blocked or borderline in SETUP_STATUS.',
  '',
  feedbackWithSetupId >= 20
    ? `🟢 TRADE_FEEDBACK COVERAGE — ${feedbackWithSetupId} rows now have setup_id populated (N≥20 floor cleared). ACTION: re-run the execution-quality audit (fill/slippage, stop/target discipline) — was blocked on this exact gap, see RESEARCH_CLAIM execution_quality_audit_blocked_on_attribution.`
    : `📊 trade_feedback setup_id coverage: ${feedbackWithSetupId}/${feedbackTotal} rows linked to a fired setup (N≥20 needed before the execution-quality audit can re-run — see RESEARCH_CLAIM execution_quality_audit_blocked_on_attribution).`,
  '',
  untrackedSymbols.length > 0
    ? `🔴 UNTRACKED INSTRUMENT(S) — ${untrackedSymbols.join(', ')} appear in trades but are NOT in server/config/instruments.js / src/constants/contract.js's INSTRUMENTS table. ACTION: add real $/pt + commission for ${untrackedSymbols.join(', ')} to both files before trusting any dollar figure involving them, and add the root(s) to this hook's own SQL whitelist.`
    : '✅ No untracked instruments — every symbol root in trades matches a known INSTRUMENTS entry.',
  '',
  invariantFailures.length > 0
    ? `🔴 test_invariants.mjs FAILED in the most recent daily calibration run:\n${invariantFailures.join('\n')}\n  ACTION: run node scripts/test_invariants.mjs directly to see full context, then fix the underlying drift.`
    : '✅ test_invariants.mjs: no FAILs in the most recent daily calibration run.',
  '',
  docSizeLines.length > 0
    ? `${docSizeLines.some(d => d.flag) ? '⚠️ ' : '📄'} DOC SIZE WATCH — auto-loaded every session:\n${docSizeLines.map(d => `  ${d.file.padEnd(24)} ${d.kb}KB (~${d.tokens} tokens)${d.head > 0 ? `  [${d.pctGrowth >= 0 ? '+' : ''}${(d.pctGrowth * 100).toFixed(0)}% since last commit]` : '  [untracked/new]'}${d.flag ? '  ⚠️ grown >15% uncommitted — consider archiving/trimming before it compounds' : ''}`).join('\n')}`
    : '',
  '',
  '=== COMMON REQUESTS (things you frequently ask for) ===',
  '',
  "1. CHECK TODAY'S FIRED SETUPS",
  "   curl -s http://localhost:3002/api/setups/today | node -e \"const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); (d.setups||[]).forEach(s=>console.log(s.status?.padEnd(10), s.setup_type?.padEnd(30), s.fired_at?.slice(11,16), s.resolution||''));\"",
  '',
  '2. SEND A TASK TO GEMINI',
  '   Write task to scratch/claude_request.md (include AUTONOMOUS header + read docs/ANTIGRAVITY_CONSTRAINTS.md)',
  '   Then run: ./scripts/invoke_gemini.sh          (15min default)',
  '         or: ./scripts/invoke_gemini.sh 30m      (heavy backtests)',
  '   Output: scratch/antigravity_response.md',
  '   Gemini DB: localhost / gemini_readonly / gemini_ro_2026 / trading_journal (read-only)',
  '',
  '3. CHECK GEMINI ERROR ALERTS',
  '   tail -20 scratch/gemini_alerts.txt',
  '',
  '4. RESTART SERVICES',
  '   systemctl --user restart trading-journal-server.service',
  '   systemctl --user restart trading-journal-watcher.service',
  '',
  '5. MC OPTIMIZER (OPEN_THREADS: needs all-account dataset, never PRO-only)',
  '   node scripts/monte_carlo_optimizer.js',
  '   WARNING: Never let Gemini write to scratch/mc_trades.json',
  '',
  '6. RESTART FULL APP (server + frontend)',
  '   ./start.sh',
  '',
  '7. WEEKLY BACKTEST RE-RUN (or manual)',
  '   node scripts/backtest_unified.js && node scripts/level_fade_audit.mjs && node scripts/audit_mae_mfe.mjs && node scripts/backfill_mae_mfe.mjs && node scripts/update_optimal_stops.mjs',
  '',
  '8. COMPUTE LEVELS FOR TODAY',
  '   node scripts/compute_levels.js',
].join('\n');

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: lines
  }
}));
JSEOF
